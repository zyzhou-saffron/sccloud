"""
scCloud v2 — 数据库连接和 ORM 模型
使用 SQLAlchemy 参数化查询，彻底消除 SQL 注入风险。
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    JSON,
    String,
    Text,
    create_engine,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Session,
    relationship,
    sessionmaker,
)

from app.config import get_settings
import uuid as uuid_lib


# ===== 数据库引擎 =====

def get_engine():
    """创建 SQLAlchemy 引擎 (MariaDB)。"""
    settings = get_settings()
    return create_engine(
        settings.database_url,
        pool_size=10,
        max_overflow=20,
        pool_recycle=3600,
        echo=(settings.environment == "development"),
    )


engine = get_engine()
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db() -> Session:
    """FastAPI 依赖注入 — 数据库会话。"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ===== ORM 基类 =====

class Base(DeclarativeBase):
    pass


# ===== 角色默认配置 =====
ROLE_DEFAULTS = {
    "guest": {"max_projects": 1, "total_quota": 10, "is_guest": True},
    "user":  {"max_projects": 1, "total_quota": 10, "is_guest": False},
    "super": {"max_projects": 5, "total_quota": 100, "is_guest": False},
    "admin": {"max_projects": 99, "total_quota": 99999, "is_guest": False},
}
VALID_ROLES = {"guest", "user", "super", "admin"}


# ===== 用户表 =====

class User(Base):
    """用户表 — 使用 bcrypt 密码哈希，不再用 SHA-1。"""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    email = Column(String(255), nullable=True)
    password_hash = Column(String(255), nullable=False)  # bcrypt 内置 salt
    is_guest = Column(Boolean, default=False)  # 游客临时用户标记
    role = Column(String(20), default="user")
    max_projects = Column(Integer, default=5)
    projects_created = Column(Integer, default=0)
    total_quota = Column(Integer, default=10)
    used_quota = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    # 关系
    projects = relationship("Project", back_populates="owner", cascade="all, delete-orphan")
    tasks = relationship("Task", back_populates="user")


# ===== 项目表 =====

class Project(Base):
    """项目表 — 外键用 user_id (非 username)，新增 species/status。"""

    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    description = Column(Text, nullable=True)
    species = Column(
        Enum("human", "mouse", name="species_type"),
        default="human",
    )
    storage_path = Column(String(512), nullable=True)
    status = Column(
        Enum("created", "uploading", "ready", "archived", name="project_status"),
        default="created",
    )
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )
    has_analyzed = Column(Boolean, default=False)

    # 关系
    owner = relationship("User", back_populates="projects")
    tasks = relationship("Task", back_populates="project", cascade="all, delete-orphan")


# ===== 任务表 (全新) =====

class Task(Base):
    """
    任务表 — 解决 BUG-T1 (进度追踪) 和 BUG-T2 (状态持久化)。
    每个分析步骤是一条 task 记录，刷新页面后状态不丢失。
    """

    __tablename__ = "tasks"

    id = Column(String(36), primary_key=True)  # UUID
    project_id = Column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    step = Column(
        Enum(
            "qc", "normalize", "reduce", "cluster",
            "markers", "enrich", "annotate", "convert",
            "markers_pairwise", "plot_markers",
            "subset_cluster", "marker_expr", "merge_celltypes",
            "monocle", "cellchat", "infercnv", "wgcna",
            name="task_step",
        ),
        nullable=False,
    )
    status = Column(
        Enum(
            "pending", "running", "completed", "failed", "cancelled",
            name="task_status",
        ),
        default="pending",
    )
    params = Column(JSON, nullable=True)  # 分析参数
    progress = Column(Integer, default=0)  # 0-100
    progress_message = Column(String(256), nullable=True)  # R 引擎实时报告的阶段描述
    result_path = Column(String(512), nullable=True)
    error_msg = Column(Text, nullable=True)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    pipeline_id = Column(String(36), ForeignKey("pipelines.id"), nullable=True)

    # 关系
    project = relationship("Project", back_populates="tasks")
    user = relationship("User", back_populates="tasks")
    pipeline = relationship("Pipeline", back_populates="tasks")


# ===== Pipeline 表 (全新) =====

class Pipeline(Base):
    """
    Pipeline 表 — 全流程分析编排。
    一条 pipeline 记录关联 8 个步骤的 task，记录整体执行状态和参数。
    """

    __tablename__ = "pipelines"

    id = Column(String(36), primary_key=True)  # UUID
    project_id = Column(
        Integer, ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    params = Column(JSON, nullable=False)  # 全 8 步的参数集合：{"qc": {...}, "normalize": {...}, ...}
    status = Column(
        Enum(
            "pending", "running", "completed", "failed", "cancelled", "paused",
            name="pipeline_status",
        ),
        default="pending",
    )
    current_step = Column(String(50), nullable=True)  # 当前正在执行的步骤 ID
    error_step = Column(String(50), nullable=True)  # 失败的步骤 ID
    error_msg = Column(Text, nullable=True)  # 错误信息
    created_at = Column(DateTime, default=datetime.utcnow)
    started_at = Column(DateTime, nullable=True)
    completed_at = Column(DateTime, nullable=True)

    # 关系
    project = relationship("Project")
    user = relationship("User")
    tasks = relationship("Task", back_populates="pipeline", cascade="all, delete-orphan")
