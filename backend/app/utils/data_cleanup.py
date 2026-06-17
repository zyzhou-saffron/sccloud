"""
scCloud v2 — 数据清理服务

定期检查并删除过期项目（数据库记录 + 磁盘文件）。
保留策略根据用户角色决定：
  guest → 1 天
  user  → 7 天
  super → 30 天
  admin → 30 天

判断依据：项目 created_at（创建时间），固定到期。
"""

import asyncio
import shutil
from datetime import datetime, timedelta, timezone

from app.config import get_settings
from app.db.models import Project, SessionLocal, User, get_retention_days


class DataCleanup:
    """定期清理过期项目的后台服务。"""

    async def run(self):
        settings = get_settings()
        interval = settings.cleanup_interval_hours * 3600
        print(f"[DataCleanup] 已启动, 每 {settings.cleanup_interval_hours} 小时检查一次")
        while True:
            await asyncio.sleep(interval)
            try:
                result = self._cleanup_expired_projects()
                if result["deleted"] > 0:
                    print(
                        f"[DataCleanup] 已清理 {result['deleted']} 个过期项目, "
                        f"释放 {result['freed_mb']:.1f} MB"
                    )
            except Exception as e:
                print(f"[DataCleanup] 清理异常: {e}")

    def _cleanup_expired_projects(self) -> dict:
        """查询过期项目并删除（DB + 磁盘）。返回统计信息。"""
        db = SessionLocal()
        deleted = 0
        freed_bytes = 0
        try:
            now = datetime.now(timezone.utc)
            projects = db.query(Project).join(User, Project.user_id == User.id).all()

            for p in projects:
                role = p.owner.role if p.owner else "user"
                retention_days = get_retention_days(role)
                deadline = p.created_at.replace(tzinfo=timezone.utc) + timedelta(days=retention_days)
                if now >= deadline:
                    # 删磁盘
                    if p.storage_path:
                        try:
                            import os
                            if os.path.isdir(p.storage_path):
                                freed_bytes += _dir_size(p.storage_path)
                                shutil.rmtree(p.storage_path, ignore_errors=True)
                                # 清理用户级空目录
                                parent = os.path.dirname(p.storage_path)
                                if os.path.isdir(parent) and not os.listdir(parent):
                                    os.rmdir(parent)
                        except OSError:
                            pass
                    # 删 DB（cascade 自动删 tasks/pipelines）
                    db.delete(p)
                    deleted += 1

            if deleted > 0:
                db.commit()
            return {"deleted": deleted, "freed_mb": freed_bytes / 1024 / 1024}
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def cleanup_now(self) -> dict:
        """手动触发一次清理（供管理员 API 调用）。"""
        return self._cleanup_expired_projects()

    def get_stats(self) -> dict:
        """获取即将过期和已过期的项目统计。"""
        db = SessionLocal()
        try:
            now = datetime.now(timezone.utc)
            projects = db.query(Project).join(User, Project.user_id == User.id).all()

            expired = 0
            expiring_soon = 0  # ≤2 天内过期
            for p in projects:
                role = p.owner.role if p.owner else "user"
                retention_days = get_retention_days(role)
                deadline = p.created_at.replace(tzinfo=timezone.utc) + timedelta(days=retention_days)
                remaining = (deadline - now).total_seconds() / 86400
                if remaining <= 0:
                    expired += 1
                elif remaining <= 2:
                    expiring_soon += 1

            return {"expired_pending": expired, "expiring_soon": expiring_soon}
        finally:
            db.close()


def _dir_size(path: str) -> int:
    """递归计算目录大小（字节）。"""
    import os
    total = 0
    for dirpath, _, filenames in os.walk(path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try:
                total += os.path.getsize(fp)
            except OSError:
                pass
    return total
