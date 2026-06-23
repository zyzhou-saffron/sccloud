"""
Pipeline 执行引擎 — 分两阶段执行分析步骤。
Phase 1: qc → normalize → reduce → annotate（完成后暂停）
Phase 2: markers → monocle → cellchat → infercnv（串行执行）
"""

import asyncio
import logging
from datetime import datetime
from typing import Dict, Any, List

from sqlalchemy.orm import Session

from app.db.models import Pipeline, Task, engine, SessionLocal
from app.utils.r_bridge import call_r_engine

logger = logging.getLogger(__name__)

PIPELINE_PHASE1 = ["qc", "normalize", "reduce", "annotate"]
PIPELINE_PHASE2_ALL = ["markers", "enrich", "monocle", "cellchat", "wgcna", "infercnv"]
# Phase 2 步骤全部串行执行 — R Plumber 单线程，并行会导致内存溢出和进程崩溃
PARALLEL_PHASE2 = []
# 长耗时步骤的超时覆盖 (秒)
STEP_TIMEOUT_OVERRIDES = {
    "infercnv": 86400,  # 24 小时
    "cellchat": 14400,  # 4 小时
    "monocle": 21600,   # 6 小时
    "wgcna": 21600,     # 6 小时
}
# reduce 步骤内部依次执行 reduce + cluster 两个 R 引擎端点


async def _execute_step_independent(pipeline_id: str, step: str, step_params: Dict[str, Any]) -> bool:
    """
    独立执行单个步骤（使用独立的 db session），用于并行执行。
    返回是否成功。
    """
    db = SessionLocal()
    try:
        pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id).first()
        if not pipeline:
            logger.error(f"Pipeline {pipeline_id} not found in parallel step {step}")
            return False

        pipeline.current_step = step
        db.commit()

        logger.info(f"Pipeline {pipeline_id}: executing step {step} (parallel)")

        return await _execute_step(db, pipeline, step, step_params)
    except Exception as e:
        logger.exception(f"Pipeline {pipeline_id}: error in parallel step {step}: {e}")
        try:
            pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id).first()
            if pipeline:
                pipeline.status = "failed"
                pipeline.error_step = step
                pipeline.error_msg = str(e)
                db.commit()
        except Exception:
            pass
        return False
    finally:
        db.close()


async def _run_steps(pipeline_id: str, steps: List[str], db: Session, pipeline: Pipeline) -> bool:
    """
    执行一组步骤，返回是否全部成功。
    自动将 PARALLEL_PHASE2 中的步骤分组并行执行。
    """
    # 将步骤分为顺序组和并行组
    sequential_steps = [s for s in steps if s not in PARALLEL_PHASE2]
    parallel_steps = [s for s in steps if s in PARALLEL_PHASE2]

    # 先执行顺序步骤（失败后继续执行剩余步骤）
    failed_steps = []
    first_error_step = None
    first_error_msg = None
    for step in sequential_steps:
        r_steps = [step]
        if step == "reduce":
            r_steps = ["reduce", "cluster"]

        for r_step in r_steps:
            # 每步开始前检查是否已被用户「停止分析」取消（单线程引擎下，正在跑的那一步无法中途打断，
            # 但取消后不再启动后续步骤）
            db.refresh(pipeline)
            if pipeline.status == "cancelled":
                pipeline.current_step = None
                db.commit()
                logger.info(f"Pipeline {pipeline_id}: cancelled by user, stopping before step {r_step}")
                return False

            # 每步开始前检查配额（仅 super/admin）
            from app.db.models import User
            quota_user = db.query(User).filter(User.id == pipeline.user_id).first()
            if quota_user and quota_user.total_quota and quota_user.used_quota >= quota_user.total_quota:
                pipeline.status = "paused"
                pipeline.current_step = None
                pipeline.error_msg = "操作配额使用结束，无法继续进行。"
                db.commit()
                logger.warning(f"Pipeline {pipeline_id}: quota exhausted before step {r_step}, pausing")
                return False

            pipeline.current_step = r_step
            db.commit()

            logger.info(f"Pipeline {pipeline_id}: executing step {r_step}")

            try:
                step_params = dict(pipeline.params.get(r_step, {}))

                # QC step: inject sample_groups from pipeline top-level params
                if r_step == "qc":
                    sg = (pipeline.params or {}).get("sample_groups", {})
                    if sg and isinstance(sg, dict):
                        step_params["sample_groups"] = sg

                # markers 强制覆盖 cluster = "All"（运行前不知道 cluster 列表）
                if r_step == "markers":
                    step_params["cluster"] = "All"
                    # 动态设置 group_by：优先使用用户配置，其次检测 Group 列，最后回退 CellType
                    if "group_by" not in step_params:
                        pipeline_params = pipeline.params or {}
                        # 如果用户配置了样本分组，使用 Group 列
                        if pipeline_params.get("sample_groups"):
                            step_params["group_by"] = "Group"
                        else:
                            step_params["group_by"] = "CellType"

                ok = await _execute_step(db, pipeline, r_step, step_params)
                if not ok:
                    failed_steps.append(r_step)
                    if first_error_step is None:
                        first_error_step = r_step
                        db.refresh(pipeline)
                        first_error_msg = pipeline.error_msg or f"步骤 {r_step} 执行失败"
                    logger.warning(f"Pipeline {pipeline_id}: step {r_step} failed, continuing with next step")

            except Exception as e:
                logger.exception(f"Pipeline {pipeline_id}: error in step {r_step}: {e}")
                failed_steps.append(r_step)
                if first_error_step is None:
                    first_error_step = r_step
                    first_error_msg = str(e)
                logger.warning(f"Pipeline {pipeline_id}: step {r_step} raised exception, continuing with next step")

    # 并行执行剩余步骤
    if parallel_steps:
        logger.info(f"Pipeline {pipeline_id}: running parallel steps: {parallel_steps}")
        pipeline.current_step = ",".join(parallel_steps)
        db.commit()

        # 准备每个步骤的参数
        tasks_coros = []
        for step in parallel_steps:
            step_params = dict(pipeline.params.get(step, {}))
            tasks_coros.append(_execute_step_independent(pipeline_id, step, step_params))

        results = await asyncio.gather(*tasks_coros, return_exceptions=True)

        # 检查结果
        for step, result in zip(parallel_steps, results):
            if isinstance(result, Exception):
                logger.error(f"Pipeline {pipeline_id}: parallel step {step} raised: {result}")
                pipeline.status = "failed"
                pipeline.error_step = step
                pipeline.error_msg = str(result)
                db.commit()
                return False
            if not result:
                logger.error(f"Pipeline {pipeline_id}: parallel step {step} failed")
                db.refresh(pipeline)
                return False

        db.refresh(pipeline)
        logger.info(f"Pipeline {pipeline_id}: all parallel steps completed")

    # 检查是否有失败的步骤
    if failed_steps:
        pipeline.status = "failed"
        pipeline.error_step = first_error_step
        pipeline.error_msg = first_error_msg or f"步骤失败: {', '.join(failed_steps)}"
        db.commit()
        logger.error(f"Pipeline {pipeline_id}: failed steps: {failed_steps}")
        return False

    return True


async def run_pipeline(pipeline_id: str) -> None:
    """
    执行 Phase 1（qc → annotate），完成后暂停等待用户确认。
    """
    db = SessionLocal()
    try:
        pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id).first()
        if not pipeline:
            logger.error(f"Pipeline {pipeline_id} not found")
            return

        logger.info(f"Starting pipeline {pipeline_id} for project {pipeline.project_id}")
        pipeline.status = "running"
        pipeline.started_at = datetime.utcnow()
        db.commit()

        ok = await _run_steps(pipeline_id, PIPELINE_PHASE1, db, pipeline)
        if not ok:
            return  # 失败，流程停止

        # Phase 1 完成，暂停
        pipeline.status = "paused"
        pipeline.current_step = None
        # 标记项目已分析（用于 guest/user/super 上传限制）
        from app.db.models import Project
        project = db.query(Project).filter(Project.id == pipeline.project_id).first()
        if project and not project.has_analyzed:
            project.has_analyzed = True
        db.commit()
        logger.info(f"Pipeline {pipeline_id} paused after annotation (Phase 1 complete)")

    except Exception as e:
        logger.exception(f"Pipeline {pipeline_id} fatal error: {e}")
        try:
            pipeline.status = "failed"
            pipeline.error_msg = str(e)
            db.commit()
        except Exception:
            pass
    finally:
        db.close()


async def resume_pipeline(pipeline_id: str, phase2_steps: List[str] = None) -> None:
    """
    从 Phase 2 继续执行，直到全部完成。
    phase2_steps: 要执行的步骤列表，如 ["markers", "monocle"]。
                  若为 None，则从 pipeline.params["enabled_steps"] 读取。
    """
    db = SessionLocal()
    try:
        pipeline = db.query(Pipeline).filter(Pipeline.id == pipeline_id).first()
        if not pipeline:
            logger.error(f"Pipeline {pipeline_id} not found")
            return

        logger.info(f"Resuming pipeline {pipeline_id}")
        pipeline.status = "running"
        db.commit()

        # 确定 Phase 2 步骤
        if phase2_steps is None:
            enabled = pipeline.params.get("enabled_steps", [])
        else:
            enabled = phase2_steps
        # 始终按 PIPELINE_PHASE2_ALL 正确顺序排列
        phase2_steps = [s for s in PIPELINE_PHASE2_ALL if s in enabled]

        if not phase2_steps:
            phase2_steps = ["markers"]  # 默认至少跑 markers

        ok = await _run_steps(pipeline_id, phase2_steps, db, pipeline)
        if not ok:
            return

        # 全部完成
        pipeline.status = "completed"
        pipeline.completed_at = datetime.utcnow()
        pipeline.current_step = None
        db.commit()
        logger.info(f"Pipeline {pipeline_id} completed successfully")

    except Exception as e:
        logger.exception(f"Pipeline {pipeline_id} fatal error: {e}")
        try:
            pipeline.status = "failed"
            pipeline.error_msg = str(e)
            db.commit()
        except Exception:
            pass
    finally:
        db.close()


async def _execute_step(db: Session, pipeline: Pipeline, step: str, step_params: Dict[str, Any]) -> bool:
    """
    执行单个步骤，返回是否成功。
    """
    task_id = None
    try:
        # 创建 Task 记录
        from uuid import uuid4
        task_id = str(uuid4())
        task = Task(
            id=task_id,
            project_id=pipeline.project_id,
            user_id=pipeline.user_id,
            step=step,
            status="pending",
            params=step_params,
            pipeline_id=pipeline.id,
        )
        db.add(task)
        db.commit()

        # 调用 R 引擎（正确的函数签名）
        try:
            # 从 db 中获取 project 以获取 storage_path
            from app.db.models import Project
            project = db.query(Project).filter(Project.id == pipeline.project_id).first()
            if not project:
                raise Exception("Project not found")

            # 构造 payload（参考 tasks/router.py 的做法）
            # 确保项目目录可写（R 引擎以 uid 1000 运行）
            import os
            if project.storage_path and os.path.isdir(project.storage_path):
                os.chmod(project.storage_path, 0o777)

            payload = {
                "project_path": project.storage_path,
                "params": {
                    **(step_params or {}),
                    "task_id": task.id,
                },
            }

            await call_r_engine(
                endpoint=step,
                payload=payload,
                task=task,
                db=db,
                timeout=STEP_TIMEOUT_OVERRIDES.get(step),
            )
        except Exception as e:
            # call_r_engine 已更新 task.status = "failed" 和 task.error_msg
            db.refresh(task)
            pipeline.status = "failed"
            pipeline.error_step = step
            pipeline.error_msg = task.error_msg or str(e)
            db.commit()
            logger.error(f"Pipeline {pipeline.id}: step {step} failed: {pipeline.error_msg}")
            return False

        # 成功完成
        db.refresh(task)
        logger.info(f"Pipeline {pipeline.id}: step {step} completed successfully")

        # 递增操作配额（仅 super/admin）
        try:
            from app.db.models import User
            user = db.query(User).filter(User.id == pipeline.user_id).first()
            if user:
                user.used_quota = (user.used_quota or 0) + 1
                db.commit()
        except Exception:
            db.rollback()

        return True

    except Exception as e:
        logger.exception(f"Pipeline {pipeline.id}: error executing step {step}: {e}")
        pipeline.status = "failed"
        pipeline.error_step = step
        pipeline.error_msg = str(e)
        db.commit()
        return False
