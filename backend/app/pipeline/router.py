"""
Pipeline 路由 — 全流程分析 API。
"""

import logging
from uuid import uuid4
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.db.models import Pipeline, Task, get_db, User
from app.auth.deps import get_current_user
from app.pipeline.executor import run_pipeline
from app.utils.r_bridge import call_r_engine

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])


class PipelineCreateRequest:
    """Pipeline 创建请求（字典化）"""
    def __init__(self, data: dict):
        self.project_id = data.get("project_id")
        self.params = data.get("params", {})  # 全 8 步参数
        self.marker_file_path = data.get("marker_file_path")  # marker_expr 的文件路径
        self.sample_groups = data.get("sample_groups", {})  # 样本分组信息


class PipelineResponse:
    """Pipeline 响应"""
    def __init__(self, pipeline: Pipeline):
        self.id = pipeline.id
        self.project_id = pipeline.project_id
        self.user_id = pipeline.user_id
        self.status = pipeline.status
        self.current_step = pipeline.current_step
        self.error_step = pipeline.error_step
        self.error_msg = pipeline.error_msg
        self.created_at = pipeline.created_at.isoformat() if pipeline.created_at else None
        self.started_at = pipeline.started_at.isoformat() if pipeline.started_at else None
        self.completed_at = pipeline.completed_at.isoformat() if pipeline.completed_at else None
        self.params = pipeline.params or {}
        # 关联的 task 列表（简化视图）
        self.tasks = [
            {
                "id": t.id,
                "step": t.step,
                "status": t.status,
                "progress": t.progress,
                "progress_message": t.progress_message,
                "result_path": t.result_path,
                "error_msg": t.error_msg,
                "created_at": t.created_at.isoformat() if t.created_at else None,
            }
            for t in pipeline.tasks
        ]

    def dict(self):
        return {
            "id": self.id,
            "project_id": self.project_id,
            "user_id": self.user_id,
            "status": self.status,
            "current_step": self.current_step,
            "params": self.params,
            "error_step": self.error_step,
            "error_msg": self.error_msg,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "tasks": self.tasks,
        }


@router.post("")
async def create_pipeline(
    data: dict,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    POST /api/pipeline

    创建并启动全流程分析。
    - 若 marker_file_path 存在，先同步执行 Phase A 解析，得到 cell_types
    - 写入 Pipeline 记录
    - 后台启动 run_pipeline 顺序执行 8 步

    Request body:
    {
      "project_id": 1,
      "params": {
        "qc": {...},
        "normalize": {...},
        ...
        "annotate": {...}
      },
      "marker_file_path": "/path/to/markers.xlsx"  (可选)
    }
    """
    try:
        project_id = data.get("project_id")
        params = data.get("params", {})
        marker_file_path = data.get("marker_file_path")
        sample_groups = data.get("sample_groups", {})

        # 将样本分组信息存入 params，供 executor 读取
        if sample_groups and isinstance(sample_groups, dict):
            params["sample_groups"] = sample_groups

        if not project_id or not isinstance(params, dict):
            raise HTTPException(status_code=400, detail="Missing project_id or params")

        # 内存准入预检(#42): 若全流程里任一步骤的估算内存 > 单任务上限, 早拒(否则会跑到一半 OOM 失败)。
        from app.db.models import Project as _Project
        from app.utils import admission
        from app.config import get_settings as _get_settings
        _proj = db.query(_Project).filter(_Project.id == project_id).first()
        if _proj and _proj.storage_path:
            _settings = _get_settings()
            _enabled = set(params.get("enabled_steps", [])) | {"qc", "normalize", "reduce", "cluster", "annotate"}
            for _st in _enabled:
                _w = admission.estimate_weight_gb(_st, _proj.storage_path)
                if _w > _settings.worker_mem_cap_gb:
                    raise HTTPException(
                        status_code=400,
                        detail=(f"数据过大：全流程 {_st} 步骤预计需 ~{_w:.0f}GB, 超过单任务内存上限 "
                                f"{_settings.worker_mem_cap_gb}GB。请拆分数据或联系管理员调大上限。"))

        # 检查项目权限（简化版本，实际应该更复杂）
        # 这里假设 user_id 等于当前 token 的 user_id

        # 配额检查（仅 super/admin）
        if user.total_quota and user.used_quota >= user.total_quota:
            raise HTTPException(
                status_code=403,
                detail="操作配额使用结束，无法继续进行。",
            )

        pipeline_id = str(uuid4())

        # 若有 marker 文件，先执行 Phase A（同步）
        if marker_file_path and params.get("marker_expr"):
            logger.info(f"Pipeline {pipeline_id}: parsing marker file {marker_file_path}")
            try:
                # 创建临时 task 运行 Phase A
                from app.utils.r_bridge import call_r_engine
                from app.db.models import Task, Project

                project = db.query(Project).filter(Project.id == project_id).first()
                if not project:
                    raise HTTPException(status_code=404, detail="Project not found")

                marker_task = Task(
                    id=str(uuid4()),
                    project_id=project_id,
                    user_id=user.id,
                    step="marker_expr",
                    status="pending",
                    params={"marker_file_path": marker_file_path},  # Phase A：不指定 cell_type
                )
                db.add(marker_task)
                db.commit()

                # 同步执行 Phase A
                import asyncio
                try:
                    asyncio.run(call_r_engine(
                        endpoint="marker_expr",
                        payload={"marker_file_path": marker_file_path},
                        task=marker_task,
                        db=db,
                    ))
                    db.refresh(marker_task)
                    success = marker_task.status == "completed"
                except Exception as e:
                    db.refresh(marker_task)
                    success = False
                    logger.warning(f"Pipeline {pipeline_id}: marker_expr Phase A failed: {e}")

                if success and marker_task.result_path:
                    # 从 result_path 解析 cell_types
                    import json
                    try:
                        with open(marker_task.result_path, "r") as f:
                            result_data = json.load(f)
                            cell_types = result_data.get("cell_types", [])
                            params["marker_expr"]["cell_types"] = cell_types
                            logger.info(f"Pipeline {pipeline_id}: parsed {len(cell_types)} cell types from marker file")
                    except Exception as e:
                        logger.warning(f"Failed to parse marker result: {e}")
                        params["marker_expr"]["cell_types"] = []
                else:
                    logger.warning(f"Pipeline {pipeline_id}: marker_expr Phase A failed")
                    params["marker_expr"]["cell_types"] = []

            except Exception as e:
                logger.error(f"Pipeline {pipeline_id}: marker file parsing error: {e}")
                raise HTTPException(status_code=400, detail=f"Marker file parsing failed: {str(e)}")

        skip_phase1 = data.get("skip_phase1", False)

        # 创建 Pipeline 记录
        pipeline = Pipeline(
            id=pipeline_id,
            project_id=project_id,
            user_id=user.id,
            params=params,
            status="paused" if skip_phase1 else "pending",
        )
        db.add(pipeline)
        db.commit()

        if skip_phase1:
            # 跳过 Phase 1，直接返回 paused 状态，前端进入 Phase2ParamPage
            return {
                "pipeline_id": pipeline_id,
                "status": "paused",
                "message": "Phase 1 skipped, ready for Phase 2 configuration"
            }

        # 后台启动流程执行
        background_tasks.add_task(run_pipeline, pipeline_id)

        return {
            "pipeline_id": pipeline_id,
            "status": "pending",
            "message": "Pipeline started, 8 steps will be executed in background"
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error creating pipeline: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{pipeline_id}")
async def get_pipeline(
    pipeline_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    GET /api/pipeline/{pipeline_id}

    获取 Pipeline 状态和关联的 tasks。
    """
    pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id).first()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")

    return PipelineResponse(pipeline).dict()


@router.post("/{pipeline_id}/resume")
async def resume_pipeline_endpoint(
    pipeline_id: str,
    data: dict = None,
    background_tasks: BackgroundTasks = BackgroundTasks(),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    POST /api/pipeline/{pipeline_id}/resume

    从暂停状态继续执行 Phase 2。
    Request body:
    {
      "params": {
        "markers": {...},
        "monocle": {...},
        "cellchat": {...},
        "infercnv": {...}
      },
      "enabled_steps": ["markers", "monocle"]
    }
    """
    pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id).first()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline not found")
    # Phase 2 access control
    if user.role in ("guest", "user"):
        raise HTTPException(
            status_code=403,
            detail="您的账户类型不支持 Phase 2 高级分析。请升级账户后重试。",
        )
    if pipeline.status not in ("paused", "failed", "completed"):
        raise HTTPException(
            status_code=400,
            detail=f"Pipeline 状态为 '{pipeline.status}'，无法继续（需要 'paused'、'failed' 或 'completed' 状态）",
        )
    # 从 failed/completed 恢复时，清除步骤参数以允许重新配置
    if pipeline.status in ("failed", "completed"):
        pipeline.current_step = None
        pipeline.error_step = None
        pipeline.error_msg = None

    # 配额检查（仅 super/admin）
    if user.total_quota and user.used_quota >= user.total_quota:
        raise HTTPException(
            status_code=403,
            detail="操作配额使用结束，无法继续进行。",
        )

    from app.pipeline.executor import resume_pipeline

    # 更新 Phase 2 参数
    if data:
        params_update = data.get("params", {})
        enabled_steps = data.get("enabled_steps", [])

        # 合并 Phase 2 参数到 pipeline.params
        current_params = dict(pipeline.params or {})
        for step, step_params in params_update.items():
            current_params[step] = step_params
        current_params["enabled_steps"] = enabled_steps
        pipeline.params = current_params
        db.commit()

        background_tasks.add_task(resume_pipeline, pipeline_id, enabled_steps)
    else:
        background_tasks.add_task(resume_pipeline, pipeline_id)

    return {"pipeline_id": pipeline_id, "status": "running", "message": "继续执行 Phase 2"}


@router.get("")
async def list_pipelines(
    project_id: Optional[int] = None,
    limit: int = 10,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """
    GET /api/pipeline?project_id=1&limit=10

    列出项目的 Pipeline 历史记录。
    """
    user_id = user.id

    query = db.query(Pipeline).filter(Pipeline.user_id == user_id)
    if project_id:
        query = query.filter(Pipeline.project_id == project_id)

    pipelines = query.order_by(desc(Pipeline.created_at)).limit(limit).all()

    return [PipelineResponse(p).dict() for p in pipelines]

@router.post("/{pipeline_id}/cancel")
async def cancel_pipeline(
    pipeline_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    取消正在运行的 pipeline。
    将 pipeline 状态设为 cancelled，并取消当前正在运行的 task。
    """
    pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id).first()
    if not pipeline:
        raise HTTPException(status_code=404, detail="Pipeline 不存在")

    if pipeline.status not in ("running", "pending"):
        raise HTTPException(
            status_code=400,
            detail=f"当前 pipeline 状态 '{pipeline.status}' 不可取消",
        )

    # 取消该 pipeline 下所有未结束的 task
    from app.db.models import Task
    running_tasks = (
        db.query(Task)
        .filter(
            Task.pipeline_id == pipeline_id,
            Task.status.in_(["pending", "running"]),
        )
        .all()
    )
    now = datetime.now(timezone.utc)
    for t in running_tasks:
        t.status = "cancelled"
        t.completed_at = now

    pipeline.status = "cancelled"
    db.commit()

    # ── 取消全链路 (#42 M3)：给重任务发 Redis kill 信号 → worker 轮询到即 kill -9 子进程，
    #    run_job 正在跑的当前步立刻中止(不必等步骤跑完)。Redis 不可用不阻塞取消(DB 已置 cancelled)。──
    try:
        import redis.asyncio as aioredis
        from app.config import get_settings
        settings = get_settings()
        r = aioredis.from_url(settings.redis_url)
        for t in running_tasks:
            await r.set(f"scc:cancel:{t.id}", "1", ex=600)  # worker 每秒轮询, 10min 足够; 别留 2h (bot #64)
        await r.aclose()
    except Exception as e:
        # Redis 不可用不阻塞取消(DB 已置 cancelled, 退化为步骤间停), 但别静默吞——留日志便于排查 (bot #64)
        logger.warning(f"[cancel] pipeline={pipeline_id} 发送 Redis 取消信号失败: {e}")

    return {"status": "cancelled", "pipeline_id": pipeline_id}
