"""
scCloud v2 — FastAPI 配置模块
从环境变量加载所有配置；敏感项也可由 *_FILE / Docker secrets 注入（entrypoint 已展开）。
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings


def _read_file(path: str | None) -> str | None:
    if not path:
        return None
    p = Path(path)
    if not p.is_file():
        return None
    return p.read_text(encoding="utf-8").strip()


class Settings(BaseSettings):
    """应用配置 — 全部从环境变量或 .env 文件读取。"""

    # ---- 数据库 (MariaDB) ----
    database_url: str = (
        "mysql+pymysql://sccloud_app:password@localhost:3306/sccloud_v2"
    )

    # ---- Redis ----
    redis_url: str = "redis://localhost:6379/0"

    # ---- JWT 认证 ----
    jwt_secret: str = "CHANGE_ME"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 15
    refresh_token_expire_days: int = 7

    # ---- R 计算引擎 ----
    r_engine_url: str = "http://localhost:8787"
    # 快请求专用引擎（plot_markers / cellchat_pathway 等只读重出图），避免被重任务(inferCNV 等)堵塞 (#42)
    r_engine_quick_url: str = "http://127.0.0.1:8788"
    # 重任务(#42 Phase2)走 Redis 队列 scc:heavyqueue + worker(run_job 独立进程)，并发=worker 副本数，
    # 不再用引擎池(已移除 r_engine_pool)。r_engine_url 仅留给少数直连调用(如 meta_csv 导出)。
    r_engine_timeout: int = 7200

    # ---- 重任务内存准入(admission control, #42) ----
    heavy_mem_reserve_gb: int = 60
    worker_mem_cap_gb: int = 500
    admission_wait_grace_sec: int = 180

    # ---- 文件存储 ----
    projects_root: str = "/data/projects"
    max_upload_size_gb: int = 30

    # ---- 部署 ----
    environment: str = "development"

    # ---- 首次空库自动创建管理员（users 表为空时生效）----
    bootstrap_admin_user: str = "admin"
    bootstrap_admin_password: str = "admin123"

    # ---- 数据保留（天） ----
    retention_guest_days: int = 1
    retention_user_days: int = 7
    retention_super_days: int = 30
    retention_admin_days: int = 200
    cleanup_interval_hours: int = 6

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


def _apply_secret_file_overrides(settings: Settings) -> Settings:
    """若 entrypoint 未展开，仍支持 JWT_SECRET_FILE / 等（本地开发）。"""
    jwt_file = _read_file(os.environ.get("JWT_SECRET_FILE"))
    if jwt_file:
        object.__setattr__(settings, "jwt_secret", jwt_file)

    boot_file = _read_file(os.environ.get("BOOTSTRAP_ADMIN_PASSWORD_FILE"))
    if boot_file:
        object.__setattr__(settings, "bootstrap_admin_password", boot_file)

    # DATABASE_URL / REDIS_URL 由 entrypoint 组装；此处仅当显式 FILE 且 URL 仍是默认时兜底
    return settings


@lru_cache()
def get_settings() -> Settings:
    """获取缓存的配置单例。"""
    return _apply_secret_file_overrides(Settings())
