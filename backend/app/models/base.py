from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from ..domain import ModelRequest, ModelResponse, ModelStreamEvent
from ..registry import NamedRegistry
from ..redaction import redact_secrets


class ModelProviderError(RuntimeError):
    """Model failure shown to users and stored in the monitor.

    Messages are always passed through credential-pattern redaction; use
    :meth:`redact` to also mask the exact key of the failing connection.
    """

    def __init__(self, code: str, message: str, retryable: bool = False, retry_safe: bool = False) -> None:
        super().__init__(redact_secrets(message))
        self.code = code
        self.retryable = retryable
        # True only when the provider answered with an error response (no model
        # compute happened). A bounded automatic retry is then safe and cannot
        # double-bill; uncertain outcomes (timeouts, mid-request disconnects)
        # must keep retry_safe=False so the unknown-outcome fence stays.
        self.retry_safe = retry_safe

    def redact(self, *secrets: str | None) -> "ModelProviderError":
        self.args = (redact_secrets(str(self), secrets),)
        return self


class ModelProvider(Protocol):
    name: str

    async def generate(self, request: ModelRequest) -> ModelResponse:
        ...

    def stream(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        ...


class ModelProviderRegistry(NamedRegistry[ModelProvider]):
    def __init__(self) -> None:
        super().__init__("模型提供商")
