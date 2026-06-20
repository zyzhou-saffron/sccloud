"""
scCloud v2 — R 引擎桥接模块
FastAPI 通过 HTTP 调用 R Plumber API，异步非阻塞。
替代旧系统中的同步 R 调用 (导致 UI 阻塞的根源)。
"""

import json
import logging

logger = logging.getLogger(__name__)
import os
import uuid
from datetime import datetime, timezone

import httpx
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db.models import Task

# 走 quick 引擎(8788)的只读/重出图秒级请求，避免被重任务(inferCNV/WGCNA/cellchat/pipeline)堵塞 (#42)
QUICK_STEPS = {"plot_markers", "cellchat_pathway"}


async def call_r_engine(
    endpoint: str,
    payload: dict,
    task: Task,
    db: Session,
    timeout: float | None = None,
) -> dict:
    """
    异步调用 R Plumber API。

    流程:
    1. 更新 task 状态为 running
    2. POST 到 R 引擎对应端点
    3. 根据结果更新 task 状态为 completed/failed

    与旧系统的区别:
    - 旧: withProgress({ Sys.sleep(1) }) → 阻塞 Shiny 事件循环
    - 新: httpx.AsyncClient → 非阻塞，其他用户正常操作
    """
    settings = get_settings()

    # 更新任务状态
    task.status = "running"
    task.started_at = datetime.now(timezone.utc)
    db.commit()

    # ── 选执行路径(#42 Phase2 重构: 队列+worker 取代引擎池)──
    #   快请求(plot_markers/cellchat_pathway): 直接 HTTP 调 quick 引擎(8788)，秒级返回。
    #   重任务: 投进 Redis 队列 scc:heavyqueue → worker BRPOP → spawn 独立 run_job 进程
    #           (用 pr$call 原地复用现有 plumber 端点) → 干净可 kill、算完即退、内存全回收。
    #   并发度 = worker 副本数；结果不串台靠 scc:result:<task.id> 每任务独立键 + 各自协程 BRPOP。
    try:
        if endpoint in QUICK_STEPS:
            result = await _post_http(
                settings.r_engine_quick_url, endpoint, payload, timeout, settings, task, db
            )
        else:
            result = await _run_via_queue(endpoint, payload, task, db, settings)

        if isinstance(result, list):
            # R jsonlite wraps single-element dicts as [{...}]; extract dict candidates
            dict_candidates = [item for item in result if isinstance(item, dict)]
            if dict_candidates:
                result = dict_candidates[0]
            else:
                result = {"_raw": result, "status": "success"}

        # 保存完整结果数据到项目目录 (QC 表格等大数据)
        result_data_path = None
        if "project_path" in payload:
            project_dir = payload["project_path"]
            result_data_path = os.path.join(
                project_dir, f"{endpoint}_result.json"
            )
            try:
                with open(result_data_path, "w") as f:
                    json.dump(result, f, ensure_ascii=False)
            except Exception:
                result_data_path = None

        # annotate 步骤后注入 marker 基因数据
        if endpoint == "annotate" and "scatter_data" in result:
            try:
                from app.utils.marker_match import annotate_with_markers
                species = result.get("stats", {}).get("species", "Human")
                tissue = result.get("stats", {}).get("tissue")
                singler_labels = result.get("singler_labels", {})
                result["marker_table"] = annotate_with_markers(
                    result["scatter_data"], species, tissue, singler_labels
                )
                # 重写 JSON
                if result_data_path:
                    with open(result_data_path, "w") as f:
                        json.dump(result, f, ensure_ascii=False)
            except Exception:
                pass  # marker 注入失败不影响主流程

        # 更新任务: 完成
        task.status = "completed"
        task.progress = 100
        task.progress_message = "✅ 分析完成"
        # result_path 优先取 R 引擎返回值，否则用保存的 JSON 文件路径
        task.result_path = (result.get("result_path") if isinstance(result, dict) else None) or result_data_path
        task.completed_at = datetime.now(timezone.utc)
        db.commit()

        return result

    except Exception as e:
        # 中途被 kill 的任务 _run_via_queue 已置 cancelled 并 commit；此处 refresh 后不覆盖成 failed。
        try:
            db.refresh(task)
        except Exception:
            pass
        if task.status != "cancelled":
            task.status = "failed"
            task.error_msg = str(e)[:1000]
        task.completed_at = datetime.now(timezone.utc)
        db.commit()
        raise


async def _post_http(
    base_url: str,
    endpoint: str,
    payload: dict,
    timeout: float | None,
    settings,
    task: Task,
    db: Session,
) -> dict:
    """直接 HTTP 调某个 R 引擎端点(quick 引擎/秒级请求用)，返回解析后的 JSON。"""
    r_url = f"{base_url}/{endpoint}"
    effective_timeout = timeout or float(settings.r_engine_timeout)
    response = None
    for attempt in range(2):  # max 1 retry
        try:
            logger.info(f"[call_r_engine] {endpoint} attempt={attempt+1}, timeout={effective_timeout}s")
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(connect=10.0, read=effective_timeout, write=120.0, pool=10.0)
            ) as client:
                response = await client.post(r_url, json=payload)
            break
        except (httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.ReadError) as e:
            if attempt == 0:
                logger.warning(f"[call_r_engine] {endpoint} attempt 1 failed: {e}, retrying...")
                task.progress_message = "连接中断，正在重试..."
                db.commit()
                continue
            raise

    if response.status_code != 200:
        try:
            r_msg = response.json().get("error", response.text)
        except Exception:
            r_msg = response.text
        raise Exception(r_msg)
    return response.json()


async def _run_via_queue(
    endpoint: str,
    payload: dict,
    task: Task,
    db: Session,
    settings,
) -> dict:
    """把重任务投进 Redis 队列, 由 worker spawn 独立 run_job 进程(可 kill)执行, 阻塞等结果。(#42 Phase2)

    约定键:
      scc:heavyqueue       — 待办作业 JSON (LPUSH 入队 / worker BRPOP)
      scc:result:<task.id> — 该任务结果 (worker LPUSH / 此处 BRPOP, 每任务独立键 → 不串台)
      scc:cancel:<task.id> — 取消标志 (worker 轮询到即 kill -9 子进程; 由前端"停止"按钮 SET, M3 接)
    """
    import redis.asyncio as aioredis

    r = aioredis.from_url(settings.redis_url)
    try:
        job = {
            "step": endpoint,
            "project_path": payload.get("project_path"),
            "params": payload.get("params", {}),
            "task_id": str(task.id),
        }
        # 清掉上一轮可能残留的取消标志/结果, 避免误判
        await r.delete(f"scc:cancel:{task.id}", f"scc:result:{task.id}")
        await r.lpush("scc:heavyqueue", json.dumps(job))
        logger.info(f"[queue] task={task.id} step={endpoint} 已入队, 等 worker 执行...")

        # 后端 redis 阻塞读有 ~5s 硬超时(host 网络/库默认), 单个长 BRPOP 会被掐断 → 任务误判超时。
        # 故用 <5s 的短窗 BRPOP 轮询到总超时; 偶发 TimeoutError 重连后继续。worker 端本就是同款循环。
        import time as _time
        result_key = f"scc:result:{task.id}"
        deadline = _time.monotonic() + int(settings.r_engine_timeout)
        popped = None
        while _time.monotonic() < deadline:
            try:
                popped = await r.brpop(result_key, timeout=3)
            except Exception as e:
                logger.debug(f"[queue] task={task.id} brpop 短超时/抖动, 重连续等: {e}")
                try:
                    await r.aclose()
                except Exception:
                    pass
                r = aioredis.from_url(settings.redis_url)
                continue
            if popped:
                break
        if not popped:
            raise Exception("worker 超时无响应(可能无空闲 worker 或子进程卡死)")
        raw = popped[1]
        result = json.loads(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
    finally:
        try:
            await r.aclose()
        except Exception:
            pass

    def _msg(v):
        return v[0] if isinstance(v, list) and v else str(v)

    if isinstance(result, dict):
        # 被中途 kill: worker 回写 {status: cancelled} → 置 cancelled 并提交, 让上层 except 不覆盖成 failed
        if result.get("status") == "cancelled":
            task.status = "cancelled"
            task.completed_at = datetime.now(timezone.utc)
            db.commit()
            raise Exception("任务已被取消")
        # worker 级失败(run_job 崩溃/OOM, 无结果文件) → {status: error, error: ...}
        if result.get("status") == "error":
            raise Exception(_msg(result.get("message") or result.get("error") or "worker 执行失败"))
        # 端点抛错 → body 形如 {"error": "..."}(无 status); plumber 真实消息可能在 message
        if "error" in result and "status" not in result:
            raise Exception(_msg(result.get("message") or result.get("error")))

    return result


def create_task(
    db: Session,
    project_id: int,
    user_id: int,
    step: str,
    params: dict | None = None,
) -> Task:
    """
    创建分析任务记录。
    每个分析步骤都会在 tasks 表中留下记录，
    刷新页面后状态不会丢失 (解决 BUG-T2)。
    """
    task = Task(
        id=str(uuid.uuid4()),
        project_id=project_id,
        user_id=user_id,
        step=step,
        status="pending",
        params=params,
        progress=0,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task
