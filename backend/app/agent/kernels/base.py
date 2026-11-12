"""内核标识、校验与可用性判定。"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable, Protocol, TYPE_CHECKING
from urllib.parse import urlparse

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
    if factory is None and normalized == KERNEL_DSH:
        from .dsh import adapter  # noqa: F401  导入即注册 dsh 内核工厂

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
        raise KernelUnavailable("DSH 内核需要先添加 DeepSeek 模型档案")
    return normalized


def normalize_kernel(value: Any) -> str:
    kernel = str(value or DEFAULT_KERNEL).strip().lower()
    return kernel if kernel in KERNEL_CHOICES else DEFAULT_KERNEL


def is_valid_kernel(value: Any) -> bool:
    return str(value or "").strip().lower() in KERNEL_CHOICES


def dsh_feature_enabled() -> bool:
    return env("TUANTUAN_DSH_ENABLED", "").strip().lower() in {"1", "true", "yes", "on"}


def is_deepseek_official_endpoint(value: Any) -> bool:
    """Accept the official HTTPS API host only, before giving DSH an API key."""
    try:
        parsed = urlparse(str(value or "").strip())
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme.lower() == "https"
        and parsed.hostname == "api.deepseek.com"
        and parsed.username is None
        and parsed.password is None
        and port in {None, 443}
    )


def has_deepseek_connection(db_path: str | Path | None = None) -> bool:
    """Whether a selectable DeepSeek model is available for the DSH kernel."""
    try:
        with connect(db_path) as conn:
            rows = conn.execute(
                """
                SELECT connection.base_url, connection.effective_base_url
                FROM model_connections AS connection
                JOIN model_profiles AS profile ON profile.connection_id = connection.id
                WHERE connection.enabled = 1
                  AND profile.enabled = 1
                  AND (connection.deleted_at IS NULL OR connection.deleted_at = '')
                """
            ).fetchall()
    except sqlite3.OperationalError:
        return False
    return any(
        is_deepseek_official_endpoint(row["base_url"])
        or is_deepseek_official_endpoint(row["effective_base_url"])
        for row in rows
    )


def is_kernel_available(kernel: str, db_path: str | Path | None = None) -> bool:
    normalized = normalize_kernel(kernel)
    if normalized == KERNEL_TUANTUAN:
        return True
    if normalized == KERNEL_DSH:
        return dsh_feature_enabled() and has_deepseek_connection(db_path)
    return False
