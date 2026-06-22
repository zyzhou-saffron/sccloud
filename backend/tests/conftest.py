"""测试夹具：内存 SQLite(单连接共享) + fakeredis 异步客户端。"""
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def sqlite_session(monkeypatch):
    """把 app.db.models.SessionLocal 指到内存 SQLite。
    StaticPool 复用单连接 → :memory: 数据在多个 session 间共享(_finalize_task 内部会新建 session)。"""
    from app.db import models

    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    models.Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(models, "SessionLocal", TestSession)
    yield TestSession
    models.Base.metadata.drop_all(engine)


@pytest.fixture
async def fake_redis():
    fakeredis = pytest.importorskip("fakeredis")
    import fakeredis.aioredis as fa

    r = fa.FakeRedis()
    yield r
    try:
        await r.aclose()
    except Exception:
        pass
