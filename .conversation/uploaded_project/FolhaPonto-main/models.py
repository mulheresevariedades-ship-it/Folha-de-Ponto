"""Modelos Pydantic usados pela API."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=120)
    password: str = Field(min_length=1, max_length=200)


class UserOut(BaseModel):
    id: int
    username: str
    role: str
    full_name: str = ""
    active: bool = True


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class ReviewPayload(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    matricula: Optional[str] = Field(default=None, max_length=30)
    competencia: str = Field(min_length=3, max_length=30)
    employee_id: Optional[int] = None
    note: str = Field(default="", max_length=500)


class ImportConfirmPayload(BaseModel):
    preview_id: str = Field(min_length=8, max_length=80)


class SimulateSendPayload(BaseModel):
    result: Optional[Literal["success", "error"]] = None