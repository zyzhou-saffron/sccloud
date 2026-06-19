"""
scCloud v2 — FastAPI 配置模块
从环境变量加载所有配置，不再硬编码任何敏感信息。
"""

from pydantic_settings import BaseSettings
from functools import lru_cache


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
    # 重任务引擎池(#42 Phase2)：逗号分隔的引擎 URL。backend 从 Redis 池借空闲引擎→并发=池大小。
    r_engine_pool: str = "http://127.0.0.1:8787,http://127.0.0.1:8791,http://127.0.0.1:8790"
    r_engine_timeout: int = 7200

    # ---- 文件存储 ----
    projects_root: str = "/data/projects"
    max_upload_size_gb: int = 30

    # ---- 部署 ----
    environment: str = "development"

    # ---- 数据保留（天） ----
    retention_guest_days: int = 1
    retention_user_days: int = 7
    retention_super_days: int = 30
    retention_admin_days: int = 30
    cleanup_interval_hours: int = 6

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"


@lru_cache()
def get_settings() -> Settings:
    """获取缓存的配置单例。"""
    return Settings()
