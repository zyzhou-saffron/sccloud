"""
scCloud v2 — 认证依赖注入
FastAPI 路由通过 Depends(get_current_user) 保护。
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.auth.service import decode_token
from app.db.models import User, get_db

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    """
    从 JWT token 中提取当前用户。
    替代旧系统的 user_data$current_user 内存变量。
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无法验证凭据",
        headers={"WWW-Authenticate": "Bearer"},
    )

    payload = decode_token(token)
    if payload is None:
        raise credentials_exception

    username: str = payload.get("sub")
    token_type: str = payload.get("type")

    if username is None or token_type != "access":
        raise credentials_exception

    # 参数化查询 — 不再用 sprintf 拼接
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise credentials_exception

    return user

async def get_admin_user(
    current_user: User = Depends(get_current_user),
) -> User:
    if current_user.role != 'admin':
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail='需要管理员权限',
        )
    return current_user


async def get_super_or_admin_user(
    current_user: User = Depends(get_current_user),
) -> User:
    if current_user.role not in ("super", "admin"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="需要高级账户权限",
        )
    return current_user
