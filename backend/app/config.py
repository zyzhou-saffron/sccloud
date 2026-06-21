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
    # 重任务(#42 Phase2)走 Redis 队列 scc:heavyqueue + worker(run_job 独立进程)，并发=worker 副本数，
    # 不再用引擎池(已移除 r_engine_pool)。r_engine_url 仅留给少数直连调用(如 meta_csv 导出)。
    r_engine_timeout: int = 7200

    # ---- 重任务内存准入(admission control, #42) ----
    # 重任务按估算内存权重从总预算里"预约"; 预算满则提交时拒("资源紧张请稍后重试"), 防止并发把 502GB 宿主 OOM。
    heavy_mem_budget_gb: int = 420   # 给重任务的总内存预算(502 宿主 − OS/DB/引擎 余量)
    worker_mem_cap_gb: int = 64      # 单 worker 封顶; 估算 > 此值的任务直接拒("数据过大")
    admission_wait_grace_sec: int = 180  # 预算暂满时等待多久再放弃(给排在前面的任务腾出空间)

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
