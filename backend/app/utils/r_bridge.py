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
QUICK_STEPS = {"plot_markers", "cellchat_pathway", "subset_cluster"}


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
    task_id = str(task.id)

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

        # 更新任务: 完成。
        # ⚠️ 重任务在队列里阻塞等待了分钟级，本协程持有的 db 连接此间可能已被 DB 端回收，
        # 直接用它 commit 会卡死(实测 commit 不返回)。故收尾改用全新 session(借新连接, pre_ping 探活)，
        # 与 ProgressSyncer 每次新建 session 能正常写库同理。
        _result_path = (result.get("result_path") if isinstance(result, dict) else None) or result_data_path
        # skip_if_cancelled: 用户点"停止"已置 DB=cancelled, 但 worker 若恰好正常算完会回 success →
        # 这里不能把 cancelled 覆盖回 completed(bot #64 Major)。_finalize_task 新 session 重查到 cancelled 即跳过。
        _finalize_task(task_id, status="completed", progress=100,
                       message="✅ 分析完成", result_path=_result_path, skip_if_cancelled=True)
        return result

    except Exception as e:
        # 同样用全新 session 收尾(队列长等待后原连接可能已失效)。中途被 kill 的任务已是 cancelled, 不覆盖。
        _finalize_task(task_id, status="failed", error_msg=str(e)[:1000],
                       skip_if_cancelled=True)
        raise


def _finalize_task(task_id, status, progress=None, message=None,
                   result_path=None, error_msg=None, skip_if_cancelled=False):
    """用**全新 session** 写任务终态。重任务收尾发生在队列分钟级等待之后, 原协程持有的连接可能已被
    DB 端回收, 直接 commit 会卡死; 新 session 借新连接(经 pool_pre_ping 探活)即可可靠落库。"""
    from app.db.models import SessionLocal
    fdb = SessionLocal()
    try:
        t = fdb.query(Task).filter(Task.id == task_id).first()
        if not t:
            return
        if skip_if_cancelled and t.status == "cancelled":
            return
        t.status = status
        if progress is not None:
            t.progress = progress
        if message is not None:
            t.progress_message = message
        if result_path is not None:
            t.result_path = result_path
        if error_msg is not None:
            t.error_msg = error_msg
        t.completed_at = datetime.now(timezone.utc)
        fdb.commit()
    except Exception as e:
        try:
            fdb.rollback()
        except Exception:
            pass
        logger.warning(f"[finalize] task={task_id} 写终态失败: {e}")
    finally:
        fdb.close()


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
    import asyncio
    import time as _t
    from app.utils import admission

    # ── 内存准入(admission control) ── 估算权重: 超单 worker 封顶 → 直接拒(再多并发也跑不动)
    weight = admission.estimate_weight_gb(endpoint, payload.get("project_path"))
    if weight > settings.worker_mem_cap_gb:
        raise Exception(
            f"数据过大：{endpoint} 预计需 ~{weight:.0f}GB, 超过单任务内存上限 "
            f"{settings.worker_mem_cap_gb}GB。请拆分数据, 或联系管理员调大 worker mem_limit。")

    # socket_timeout=None: 后端 redis.asyncio 默认对阻塞读有 5s 硬超时, 会把长 BRPOP 掐断 → 任务误判超时。
    r = aioredis.from_url(settings.redis_url, socket_timeout=None)
    reserved = False
    try:
        # 从总预算预约 weight(满则等 admission_wait_grace_sec 给前面任务腾位, 仍满 → 资源紧张)
        _dl = _t.monotonic() + settings.admission_wait_grace_sec
        while not await admission.try_reserve(
                r, str(task.id), weight, settings, settings.r_engine_timeout):
            if _t.monotonic() >= _dl:
                raise Exception("服务器资源紧张, 请稍后重试")
            # 等预算期间用户点了"停止" → 立刻退出, 别傻等到 grace 超时 (bot #64)。
            # cancel 端点先 commit DB=cancelled 再 SET scc:cancel, 故此键在即 DB 已 cancelled; 上层 except 保持 cancelled。
            if await r.exists(f"scc:cancel:{task.id}"):
                raise Exception("任务已被取消")
            try:  # 预算暂满时给前端反馈, 别让用户以为卡死
                task.progress_message = "排队等待内存资源..."
                db.commit()
            except Exception:
                pass
            await asyncio.sleep(3)
        reserved = True
        _bud = await admission.dynamic_budget_gb(r, settings)
        logger.info(f"[admission] task={task.id} {endpoint} 预约 {weight}GB / 动态预算 {_bud:.0f}GB")

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

        # 阻塞等结果; brpop 自身 timeout 控总时长, socket_timeout=None 保证不被 5s 掐断。
        popped = await r.brpop(f"scc:result:{task.id}", timeout=int(settings.r_engine_timeout))
        if not popped:
            raise Exception("worker 超时无响应(可能无空闲 worker 或子进程卡死)")
        raw = popped[1]
        result = json.loads(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
    finally:
        if reserved:
            await admission.release(r, str(task.id))
        try:
            await r.aclose()
        except Exception:
            pass

    def _msg(v):
        return v[0] if isinstance(v, list) and v else str(v)

    if isinstance(result, dict):
        # 被中途 kill: worker 回写 {status: cancelled} → 置 cancelled(全新 session, 同收尾), 让上层不覆盖
        if result.get("status") == "cancelled":
            _finalize_task(str(task.id), status="cancelled")
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
