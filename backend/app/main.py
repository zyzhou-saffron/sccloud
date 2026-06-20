import asyncio
import logging

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.db.models import Base, engine
from app.utils.progress_syncer import ProgressSyncer
from app.utils.data_cleanup import DataCleanup

# 全局清理服务实例（供 admin API 调用）
data_cleanup = DataCleanup()
logger = logging.getLogger(__name__)


def _run_alembic_upgrade():
    """启动时自动执行最新 alembic 迁移，保证生产 DB schema 与 model 一致。"""
    try:
        from alembic.config import Config
        from alembic import command

        alembic_cfg = Config("/app/alembic.ini")
        command.upgrade(alembic_cfg, "head")
        logger.info("[alembic] migrations upgraded to head")
    except Exception as e:
        # 记录但不阻塞启动；create_all 仍会尝试建表
        logger.warning(f"[alembic] upgrade failed: {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """应用生命周期 — 启动时执行迁移、创建数据库表并启动后台服务。"""
    _run_alembic_upgrade()
    Base.metadata.create_all(bind=engine)
    # 重任务改走 Redis 队列 + worker(#42 Phase2)，无需再初始化引擎池。
    # 启动 Redis → DB 进度同步器 (后台协程)
    syncer = ProgressSyncer()
    syncer_task = asyncio.create_task(syncer.run())
    # 启动数据清理服务 (后台协程)
    cleanup_task = asyncio.create_task(data_cleanup.run())
    yield
    syncer_task.cancel()
    cleanup_task.cancel()


# ===== 创建应用 =====

settings = get_settings()

app = FastAPI(
    title="scCloud v2 API",
    description="单细胞 RNA-seq 分析平台 API",
    version="2.0.0",
    lifespan=lifespan,
)

# ===== CORS 配置 =====

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",  # Next.js 开发服务器
        "http://frontend:3000",  # Docker 内部
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ===== 全局异常捕获：把未处理异常转成 JSON，避免前端收到 HTML "Internal Server Error" =====

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled exception: %s", exc)
    return JSONResponse(
        status_code=500,
        content={"detail": f"Internal server error: {str(exc)[:500]}"},
    )

# ===== 挂载路由 =====

from app.auth.router import router as auth_router  # noqa: E402
from app.projects.router import router as projects_router  # noqa: E402
from app.tasks.router import router as tasks_router  # noqa: E402
from app.convert.router import router as convert_router  # noqa: E402
from app.upload.router import router as upload_router  # noqa: E402
from app.ws.router import router as ws_router  # noqa: E402
from app.pipeline.router import router as pipeline_router  # noqa: E402
from app.admin.router import router as admin_router

app.include_router(auth_router)
app.include_router(projects_router)
app.include_router(tasks_router)
app.include_router(pipeline_router)
app.include_router(admin_router)
app.include_router(convert_router)
app.include_router(upload_router)
app.include_router(ws_router)


# ===== 健康检查 =====

@app.get("/api/health", tags=["系统"])
async def health_check():
    """健康检查端点 — Docker/Nginx 用于探活。"""
    import redis as redis_lib

    health = {"status": "ok", "version": "2.0.0"}

    # 检查数据库
    try:
        from sqlalchemy import text
        from app.db.models import SessionLocal
        db = SessionLocal()
        db.execute(text("SELECT 1"))
        db.close()
        health["db"] = "connected"
    except Exception as e:
        health["db"] = f"error: {e}"
        health["status"] = "degraded"

    # 检查 Redis
    try:
        r = redis_lib.from_url(settings.redis_url)
        r.ping()
        health["redis"] = "connected"
    except Exception as e:
        health["redis"] = f"error: {e}"
        health["status"] = "degraded"

    return health
