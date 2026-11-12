"""内核标识、校验与可用性判定。"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Protocol, TYPE_CHECKING

from ...branding import env
from ...db import connect
from ...search_options import WebSearchOptions

if TYPE_CHECKING:
    from ...domain import AgentMessage, AgentRunSnapshot, AgentStreamEvent

KERNEL_TUANTUAN = "tuantuan"
KERNEL_DSH = "dsh"
KERNEL_CHOICES = (KERNEL_TUANTUAN, KERNEL_DSH)
DEFAULT_KERNEL = KERNEL_TUANTUAN


class KernelUnavailable(Exception):
    """当前对话的内核不可用或未注册。"""


class KernelRuntime(Protocol):
    async def run_stream(
        self,
        user_content: str,
        *,
        history: list["AgentMessage"] | None = None,
        conversation_id: int | None = None,
        task_id: int | None = None,
        image_urls: list[str] | None = None,
        routing_content: str | None = None,
        web_search_mode: str = "auto",
        web_search_options: WebSearchOptions | None = None,
        resume: "AgentRunSnapshot | None" = None,
        run_id: str | None = None,
        model_selection: dict[str, Any] | None = None,
        skill_binding: dict[str, Any] | None = None,
        local_evidence: list[dict[str, Any]] | None = None,
        document_targets: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator["AgentStreamEvent"]: ...


_kernel_factories: dict[str, Callable[[Any], KernelRuntime]] = {}


def register_kernel_runtime(kernel: str, factory: Callable[[Any], KernelRuntime]) -> None:
    normalized = normalize_kernel(kernel)
    if normalized == KERNEL_TUANTUAN:
        raise ValueError("内置内核运行时不可覆盖")
    _kernel_factories[normalized] = factory


def unregister_kernel_runtime(kernel: str) -> None:
    _kernel_factories.pop(normalize_kernel(kernel), None)


def resolve_kernel_runtime(kernel: str, agent_runtime: Any) -> KernelRuntime:
    normalized = normalize_kernel(kernel)
    if normalized == KERNEL_TUANTUAN:
        from .builtin import BuiltinKernelRuntime

        return BuiltinKernelRuntime(agent_runtime)
    factory = _kernel_factories.get(normalized)
    if factory is None:
        raise KernelUnavailable(f"内核 {normalized} 运行时不可用")
    return factory(agent_runtime)


def validate_kernel_selection(kernel: str, db_path: str | Path | None = None) -> str:
    if not is_valid_kernel(kernel):
        raise KernelUnavailable("内核类型无效")
    normalized = normalize_kernel(kernel)
    if normalized == KERNEL_DSH and not is_kernel_available(normalized, db_path):
        if not dsh_feature_enabled():
            raise KernelUnavailable("DSH 内核未启用")
        raise KernelUnavailable("DSH 内核需要先添加 DeepSeek 模型连接")
    return normalized


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
