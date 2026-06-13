"""
scCloud v2 — 认证路由
登录/注册/刷新 token。
"""

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.auth.deps import get_current_user
from app.auth.service import (
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)
from app.db.models import User, get_db

router = APIRouter(prefix="/api/auth", tags=["认证"])


# ===== Schemas =====

class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=2, max_length=100, pattern=r"^[a-zA-Z0-9_]+$")
    password: str = Field(..., min_length=6, max_length=128)
    email: str | None = None


class TokenResponse(BaseModel):
    role: str = "user"
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    username: str
    is_guest: bool = False


class RefreshRequest(BaseModel):
    refresh_token: str


class UserInfo(BaseModel):
    id: int
    username: str
    email: str | None
    role: str
    max_projects: int
    total_quota: int = 0
    used_quota: int = 0
    is_active: bool = True
    is_guest: bool = False


# ===== 路由 =====

@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(req: RegisterRequest, db: Session = Depends(get_db)):
    """
    用户注册。
    Pydantic 校验 username 格式 → 防止 SQL 注入和路径穿越。
    """
    # 检查用户名是否已存在 (参数化查询)
    existing = db.query(User).filter(User.username == req.username).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="用户名已存在",
        )

    # 创建用户 — bcrypt 哈希
    user = User(
        username=req.username,
        email=req.email,
        password_hash=hash_password(req.password),
        role="user",
        max_projects=1,
        total_quota=10,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    # 生成 token
    token_data = {"sub": user.username, "role": user.role}
    return TokenResponse(
        access_token=create_access_token(token_data),
        role=user.role,
        refresh_token=create_refresh_token(token_data),
        username=user.username,
        is_guest=user.is_guest,
    )


@router.post("/login", response_model=TokenResponse)
async def login(
    form_data: OAuth2PasswordRequestForm = Depends(),
    db: Session = Depends(get_db),
):
    """用户登录 — 验证密码并返回 JWT token。"""
    user = db.query(User).filter(User.username == form_data.username).first()
    if not user or not verify_password(form_data.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户名或密码错误",
        )

    token_data = {"sub": user.username, "role": user.role}
    return TokenResponse(
        access_token=create_access_token(token_data),
        role=user.role,
        refresh_token=create_refresh_token(token_data),
        username=user.username,
        is_guest=user.is_guest,
    )


@router.post("/refresh", response_model=TokenResponse)
async def refresh_token(req: RefreshRequest, db: Session = Depends(get_db)):
    """刷新 access token — 解决旧系统刷新页面丢失登录状态问题。"""
    payload = decode_token(req.refresh_token)
    if payload is None or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token 无效或已过期",
        )

    username = payload.get("sub")
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="用户不存在",
        )

    token_data = {"sub": user.username, "role": user.role}
    return TokenResponse(
        access_token=create_access_token(token_data),
        role=user.role,
        refresh_token=create_refresh_token(token_data),
        username=user.username,
        is_guest=user.is_guest,
    )


@router.get("/me", response_model=UserInfo)
async def get_me(current_user: User = Depends(get_current_user)):
    """获取当前用户信息。"""
    return UserInfo(
        id=current_user.id,
        username=current_user.username,
        email=current_user.email,
        role=current_user.role,
        max_projects=current_user.max_projects,
        total_quota=current_user.total_quota,
        used_quota=current_user.used_quota,
        is_active=current_user.is_active,
        is_guest=current_user.is_guest,
    )


class ChangePasswordRequest(BaseModel):
    old_password: str = Field(..., min_length=1)
    new_password: str = Field(..., min_length=6, max_length=128)


@router.post("/change-password")
async def change_password(
    req: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修改密码 — 对应旧系统设置面板中的密码修改功能。"""
    # 校验旧密码
    if not verify_password(req.old_password, current_user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="当前密码错误",
        )

    # 更新密码
    current_user.password_hash = hash_password(req.new_password)
    db.commit()

    return {"detail": "密码修改成功"}


# ===== 游客模式 =====


@router.post("/guest", response_model=TokenResponse)
async def guest_login(db: Session = Depends(get_db)):
    """
    游客登录 — 自动创建临时用户，无需用户名密码。
    游客用户名格式: guest_<uuid8>，限制最多 1 个项目。
    """
    import uuid

    guest_username = f"guest_{uuid.uuid4().hex[:8]}"
    # 游客也需要密码哈希（随机），防止被暴力登录
    random_password = uuid.uuid4().hex
    user = User(
        username=guest_username,
        password_hash=hash_password(random_password),
        is_guest=True,
        role="guest",
        max_projects=1,
        total_quota=10,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token_data = {"sub": user.username, "role": user.role}
    return TokenResponse(
        access_token=create_access_token(token_data),
        role=user.role,
        refresh_token=create_refresh_token(token_data),
        username=user.username,
        is_guest=user.is_guest,
    )


class UpgradeGuestRequest(BaseModel):
    username: str = Field(
        ..., min_length=2, max_length=100, pattern=r"^[a-zA-Z0-9_]+$"
    )
    password: str = Field(..., min_length=6, max_length=128)


@router.post("/upgrade", response_model=TokenResponse)
async def upgrade_guest(
    req: UpgradeGuestRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    游客升级 — 将临时 guest 账号转为正式注册用户。
    保留所有已有项目和分析数据，仅更新用户名、密码和配额。
    """
    if not current_user.is_guest:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="当前账号已是正式用户",
        )

    # 检查新用户名是否已占用
    existing = db.query(User).filter(User.username == req.username).first()
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="用户名已存在",
        )

    # 升级: 更新用户名、密码、取消游客标记、提升配额
    current_user.username = req.username
    current_user.password_hash = hash_password(req.password)
    current_user.is_guest = False
    current_user.role = "user"
    current_user.max_projects = 1
    current_user.total_quota = 10
    db.commit()
    db.refresh(current_user)

    # 重新签发 token（用户名已变）
    token_data = {"sub": current_user.username, "role": current_user.role}
    return TokenResponse(
        access_token=create_access_token(token_data),
        role=current_user.role,
        refresh_token=create_refresh_token(token_data),
        username=current_user.username,
        is_guest=current_user.is_guest,
    )
