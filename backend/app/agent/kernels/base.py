"""内核标识、校验与可用性判定。"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

from ...branding import env
from ...db import connect

KERNEL_TUANTUAN = "tuantuan"
KERNEL_DSH = "dsh"
KERNEL_CHOICES = (KERNEL_TUANTUAN, KERNEL_DSH)
DEFAULT_KERNEL = KERNEL_TUANTUAN


def normalize_kernel(value: Any) -> str:
    kernel = str(value or DEFAULT_KERNEL).strip().lower()
    return kernel if kernel in KERNEL_CHOICES else DEFAULT_KERNEL


def is_valid_kernel(value: Any) -> bool:
    return str(value or "").strip().lower() in KERNEL_CHOICES


def dsh_feature_enabled() -> bool:
    return env("TUANTUAN_DSH_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}


def has_deepseek_connection(db_path: str | Path | None = None) -> bool:
    """Whether an enabled model connection points at a DeepSeek endpoint."""
    try:
        with connect(db_path) as conn:
            row = conn.execute(
                """
                SELECT 1 FROM model_connections
                WHERE enabled = 1 AND (deleted_at IS NULL OR deleted_at = '')
                  AND base_url LIKE '%deepseek.com%'
                LIMIT 1
                """
            ).fetchone()
    except sqlite3.OperationalError:
        return False
    return row is not None


def is_kernel_available(kernel: str, db_path: str | Path | None = None) -> bool:
    normalized = normalize_kernel(kernel)
    if normalized == KERNEL_TUANTUAN:
        return True
    if normalized == KERNEL_DSH:
        return dsh_feature_enabled() and has_deepseek_connection(db_path)
    return False
