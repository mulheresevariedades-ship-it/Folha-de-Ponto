"""Privacidade e segurança de dados pessoais (LGPD): máscara, validação e criptografia de CPF."""

from __future__ import annotations

import os
import re
from typing import Optional

try:
    from cryptography.fernet import Fernet, InvalidToken

    _HAS_FERNET = True
except ImportError:  # pragma: no cover
    Fernet = None  # type: ignore[assignment]
    InvalidToken = None  # type: ignore[assignment]
    _HAS_FERNET = False

_NON_DIGITS = re.compile(r"\D+")


def normalize_cpf(value: object) -> str:
    if value is None:
        return ""
    return _NON_DIGITS.sub("", str(value))


def validate_cpf(value: object) -> bool:
    digits = normalize_cpf(value)
    if len(digits) != 11 or digits == digits[0] * 11:
        return False
    for length in (9, 10):
        weight = list(range(length + 1, 1, -1))
        total = sum(int(digits[index]) * weight[index] for index in range(length))
        if int(digits[length]) != (11 - (total % 11)) % 11:
            return False
    return True


def mask_cpf(value: object, visible_last: int = 2) -> str:
    digits = normalize_cpf(value)
    if len(digits) < visible_last:
        return "***.***.***-**"
    return f"***.***.***-{digits[-visible_last:]}"


def _fernet() -> Optional[Fernet]:
    if not _HAS_FERNET:
        return None
    raw = os.getenv("CPF_ENCRYPTION_KEY", "").strip()
    if not raw:
        return None
    try:
        return Fernet(raw.encode("ascii"))
    except (ValueError, TypeError):
        return None


def encrypt_cpf(value: object) -> str:
    digits = normalize_cpf(value)
    if not digits or not _HAS_FERNET:
        return digits
    fernet = _fernet()
    if fernet is None:
        return digits
    return fernet.encrypt(digits.encode()).decode()


def decrypt_cpf(value: object) -> str:
    stored = str(value or "")
    if not stored:
        return ""
    if not _HAS_FERNET:
        return normalize_cpf(stored)
    fernet = _fernet()
    if fernet is None:
        return normalize_cpf(stored)
    try:
        return fernet.decrypt(stored.encode()).decode()
    except (InvalidToken, ValueError, TypeError):
        return normalize_cpf(stored)


def protect_cpf(value: object) -> str:
    return encrypt_cpf(value)


def display_cpf(value: object) -> str:
    return mask_cpf(decrypt_cpf(value))