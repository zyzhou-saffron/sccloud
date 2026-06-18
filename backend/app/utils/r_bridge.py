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

    try:
        # 快请求分流到独立 quick 引擎(8788)，其余走主引擎(8787) (#42)
        base_url = settings.r_engine_quick_url if endpoint in QUICK_STEPS else settings.r_engine_url
        r_url = f"{base_url}/{endpoint}"
        effective_timeout = timeout or float(settings.r_engine_timeout)
        last_error = None

        for attempt in range(2):  # max 1 retry
            try:
                logger.info(f"[call_r_engine] {endpoint} attempt={attempt+1}, timeout={effective_timeout}s")
                async with httpx.AsyncClient(
                    timeout=httpx.Timeout(
                        connect=10.0,
                        read=effective_timeout,
                        write=120.0,
                        pool=10.0,
                    )
                ) as client:
                    response = await client.post(r_url, json=payload)
                break
            except (httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.ReadError) as e:
                last_error = e
                if attempt == 0:
                    logger.warning(f"[call_r_engine] {endpoint} attempt {attempt+1} failed: {e}, retrying...")
                    task.progress_message = "连接中断，正在重试..."
                    db.commit()
                    continue
                raise

        if response.status_code != 200:
            # 尝试提取 R 引擎返回的原始错误消息
            try:
                err_body = response.json()
                r_msg = err_body.get("error", response.text)
            except Exception:
                r_msg = response.text
            raise Exception(r_msg)

        result = response.json()
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
        # 更新任务: 失败
        task.status = "failed"
        task.error_msg = str(e)[:1000]
        task.completed_at = datetime.now(timezone.utc)
        db.commit()
        raise


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
