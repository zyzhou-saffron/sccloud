"""
scCloud v2 — 管理员 API 路由
用户管理: 列表 / 详情 / 编辑 / 删除
"""

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Optional
import logging
import os
import shutil

from app.auth.deps import get_admin_user
from app.db.models import User, Project, get_db

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ===== 请求/响应模型 =====

class UserUpdateRequest(BaseModel):
    role: Optional[str] = None
    max_projects: Optional[int] = None
    total_quota: Optional[int] = None
    used_quota: Optional[int] = None
    is_active: Optional[bool] = None


class UserItem(BaseModel):
    id: int
    username: str
    email: str | None = None
    role: str
    is_guest: bool
    max_projects: int
    total_quota: int
    used_quota: int
    is_active: bool
    created_at: str | None = None

    class Config:
        from_attributes = True


class UserListResponse(BaseModel):
    users: list[UserItem]
    total: int


# ===== 端点 =====

@router.get("/users", response_model=UserListResponse)
async def list_users(
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    search: str = Query("", max_length=100),
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
):
    """管理员: 获取用户列表（分页+搜索）。"""
    query = db.query(User)

    if search:
        query = query.filter(User.username.ilike(f"%{search}%"))

    total = query.count()
    users = (
        query.order_by(User.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )

    return UserListResponse(
        users=[
            UserItem(
                id=u.id,
                username=u.username,
                email=u.email,
                role=u.role,
                is_guest=u.is_guest,
                max_projects=u.max_projects,
                total_quota=u.total_quota,
                used_quota=u.used_quota,
                is_active=u.is_active,
                created_at=u.created_at.isoformat() if u.created_at else None,
            )
            for u in users
        ],
        total=total,
    )


@router.get("/users/{user_id}", response_model=UserItem)
async def get_user(
    user_id: int,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
):
    """管理员: 获取单个用户详情。"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    return UserItem(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role,
        is_guest=user.is_guest,
        max_projects=user.max_projects,
        total_quota=user.total_quota,
        used_quota=user.used_quota,
        is_active=user.is_active,
        created_at=user.created_at.isoformat() if user.created_at else None,
    )


@router.put("/users/{user_id}")
async def update_user(
    user_id: int,
    data: UserUpdateRequest,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
):
    """管理员: 更新用户信息。"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 不允许管理员修改自己
    if user.id == admin.id and data.role is not None and data.role != "admin":
        raise HTTPException(
            status_code=400,
            detail="不能取消自己的管理员权限",
        )

    # 角色校验
    VALID_ROLES = {"guest", "user", "super", "admin"}
    if data.role is not None and data.role not in VALID_ROLES:
        raise HTTPException(
            status_code=400,
            detail=f"无效角色: {data.role}，可选: {', '.join(sorted(VALID_ROLES))}",
        )

    # 改角色时自动设默认值（除非管理员显式指定）
    if data.role is not None and data.role != user.role:
        user.role = data.role
        from app.db.models import ROLE_DEFAULTS
        defaults = ROLE_DEFAULTS.get(data.role, {})
        if data.max_projects is None:
            user.max_projects = defaults.get("max_projects", user.max_projects)
        if data.total_quota is None:
            user.total_quota = defaults.get("total_quota", user.total_quota)
        user.is_guest = (data.role == "guest")
    else:
        if data.max_projects is not None:
            user.max_projects = data.max_projects
        if data.total_quota is not None:
            user.total_quota = data.total_quota

    if data.used_quota is not None:
        user.used_quota = data.used_quota
    if data.is_active is not None:
        user.is_active = data.is_active

    db.commit()

    return {"status": "ok"}


@router.delete("/users/{user_id}")
async def delete_user(
    user_id: int,
    admin: User = Depends(get_admin_user),
    db: Session = Depends(get_db),
):
    """管理员: 删除用户。"""
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")

    if user.id == admin.id:
        raise HTTPException(
            status_code=400,
            detail="不能删除自己的账户",
        )

    # 清理用户所有项目的磁盘文件
    projects = db.query(Project).filter(Project.user_id == user.id).all()
    for p in projects:
        if p.storage_path and os.path.isdir(p.storage_path):
            shutil.rmtree(p.storage_path, ignore_errors=True)

    db.delete(user)
    db.commit()

    return {"status": "deleted"}


# ===== 数据保留策略 =====

@router.get("/retention")
async def get_retention_info(admin: User = Depends(get_admin_user)):
    """查看当前数据保留策略和过期统计。"""
    from app.db.models import ROLE_DEFAULTS
    from app.main import data_cleanup

    policy = {role: defaults["retention_days"] for role, defaults in ROLE_DEFAULTS.items()}
    stats = data_cleanup.get_stats()
    return {"policy": policy, **stats}


@router.post("/cleanup")
async def manual_cleanup(admin: User = Depends(get_admin_user)):
    """手动触发一次过期项目清理。"""
    from app.main import data_cleanup

    result = data_cleanup.cleanup_now()
    return {
        "deleted_count": result["deleted"],
        "freed_mb": round(result["freed_mb"], 2),
    }
