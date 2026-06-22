"""
scCloud v2 — Redis → DB 进度同步器

订阅 Redis task:*:progress 频道，将 R 引擎的实时进度写入数据库。
解决「轮询通道看不到真实进度」的核心问题。

架构位置:
  R 引擎 --PUBLISH--> Redis --SUBSCRIBE--> ProgressSyncer --UPDATE--> MariaDB
                                       |
                           WebSocket Manager (并行, 不冲突)
"""

import asyncio
import json
import time
from typing import Dict

import redis.asyncio as aioredis

from app.config import get_settings
from app.db.models import SessionLocal, Task


class ProgressSyncer:
    """
    后台 Redis 订阅器。

    收到 R 引擎的 {task_id, progress, message} 消息后，
    更新对应 task 的 progress / progress_message 字段。

    节流策略: 同一 task 至少间隔 1 秒才写一次 DB，
    防止 R 高频 report 造成不必要的数据库压力。
    """

    # 同一 task 两次 DB 写入的最小间隔 (秒)
    THROTTLE_INTERVAL = 0.3

    def __init__(self):
        self._last_write: Dict[str, float] = {}

    async def run(self):
        """主循环 — 持续监听 Redis 并同步到 DB。"""
        settings = get_settings()
        while True:
            try:
                # socket_timeout=None: 否则 pubsub.listen() 的阻塞读会被默认 5s socket 超时掐断,
                # 陷入"连接→5s超时→重连"风暴, 既丢进度又与任务收尾抢 DB 行锁。
                r = aioredis.from_url(
                    settings.redis_url,
                    decode_responses=True,
                    socket_timeout=None,
                )
                pubsub = r.pubsub()
                await pubsub.psubscribe("task:*:progress")
                print("[ProgressSyncer] 已连接 Redis, 开始监听进度消息")

                async for message in pubsub.listen():
                    if message["type"] != "pmessage":
                        continue
                    try:
                        data = json.loads(message["data"])
                        task_id = data.get("task_id", "")
                        progress = data.get("progress", 0)
                        msg = data.get("message", "")
                        await self._sync_to_db(task_id, progress, msg)
                    except (json.JSONDecodeError, KeyError):
                        continue

            except Exception as e:
                print(f"[ProgressSyncer] Redis 连接异常: {e}, 5 秒后重试")
                await asyncio.sleep(5)

    async def _sync_to_db(
        self, task_id: str, progress: int, message: str
    ):
        """
        将进度写入数据库 (带节流)。

        跳过 progress >= 100 的消息 — 任务完成由 r_bridge.py 统一处理，
        避免与 call_r_engine 的 DB commit 产生竞态冲突。
        """
        if not task_id or progress >= 100:
            return

        now = time.monotonic()
        last = self._last_write.get(task_id, 0)
        if now - last < self.THROTTLE_INTERVAL:
            return

        self._last_write[task_id] = now

        # 使用独立 session 避免阻塞主线程
        db = SessionLocal()
        try:
            task = db.query(Task).filter(Task.id == task_id).first()
            if task and task.status in ("pending", "running"):
                task.progress = progress
                task.progress_message = message
                if task.status == "pending":
                    task.status = "running"
                db.commit()
        except Exception as e:
            db.rollback()
            print(f"[ProgressSyncer] DB 写入异常: {e}")
        finally:
            db.close()

        # 清理已完成 task 的节流缓存 (防内存泄漏)
        if progress >= 95:
            self._last_write.pop(task_id, None)
