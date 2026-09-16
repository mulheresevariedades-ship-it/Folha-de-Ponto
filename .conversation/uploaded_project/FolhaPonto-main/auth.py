"""Autenticação JWT, senhas com bcrypt e controle de acesso por papel."""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:  # pragma: no cover
    pass

import bcrypt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

ROLES: tuple[str, ...] = ("admin", "operador", "consulta")

SECRET_KEY = os.getenv(
    "SECRET_KEY", "troque-esta-chave-por-uma-string-aleatoria-de-64-caracteres"
)
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
JWT_EXPIRATION_MINUTES = int(os.getenv("JWT_EXPIRATION_MINUTES", "480"))

_fetch_user: Optional[Callable[[int], Optional[dict[str, Any]]]] = None
_is_revoked: Optional[Callable[[str], bool]] = None
_revoke_token: Optional[Callable[[str, Optional[int], Any], None]] = None

_bearer = HTTPBearer(auto_error=False)


def configure(
    fetch_user: Optional[Callable[[int], Optional[dict[str, Any]]]] = None,
    is_revoked: Optional[Callable[[str], bool]] = None,
    revoke_token: Optional[Callable[[str, Optional[int], Any], None]] = None,
) -> None:
    global _fetch_user, _is_revoked, _revoke_token
    _fetch_user = fetch_user
    _is_revoked = is_revoked
    _revoke_token = revoke_token


def hash_password(password: str) -> str:
    return bcrypt.hashpw(
        password.encode("utf-8")[:72], bcrypt.gensalt()
    ).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(
            password.encode("utf-8")[:72], password_hash.encode("utf-8")
        )
    except (ValueError, TypeError):
        return False


def create_access_token(
    user_id: int, username: str, role: str, full_name: str = ""
) -> str:
    issued_at = datetime.now(timezone.utc)
    expires_at = issued_at + timedelta(minutes=JWT_EXPIRATION_MINUTES)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "full_name": full_name,
        "iat": issued_at,
        "exp": expires_at,
        "jti": uuid.uuid4().hex,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])


def revoke_token(
    token: str, user_id: Optional[int], expires_at: Any = None
) -> None:
    if _revoke_token is not None:
        _revoke_token(token, user_id, expires_at)


def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> dict[str, Any]:
    if credentials is None:
        raise HTTPException(status_code=401, detail="Autenticação necessária.")
    token = credentials.credentials
    if _is_revoked is not None and _is_revoked(token):
        raise HTTPException(status_code=401, detail="Sessão encerrada.")
    try:
        payload = decode_access_token(token)
        user_id = int(payload.get("sub", ""))
    except (JWTError, TypeError, ValueError):
        raise HTTPException(status_code=401, detail="Token inválido ou expirado.")
    if _fetch_user is None:
        raise HTTPException(
            status_code=503, detail="Serviço de autenticação indisponível."
        )
    user = _fetch_user(user_id)
    if user is None or not user.get("active", True):
        raise HTTPException(status_code=401, detail="Usuário não encontrado ou inativo.")
    session = dict(user)
    session["token"] = token
    session["token_id"] = payload.get("jti")
    return session


def require_roles(*roles: str):
    def dependency(
        current: dict[str, Any] = Depends(get_current_user),
    ) -> dict[str, Any]:
        if roles and current.get("role") not in roles:
            raise HTTPException(
                status_code=403, detail="Permissão insuficiente."
            )
        return current

    return dependency