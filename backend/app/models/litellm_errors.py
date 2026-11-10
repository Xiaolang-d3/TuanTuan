"""Translate LiteLLM exceptions into 团团's ModelProviderError codes."""
from __future__ import annotations

import ast
import json
import re
from typing import Any

from .base import ModelProviderError
from ..redaction import redact_secrets
from .litellm_core import get_litellm
from .openai_compatible import _ACCOUNT_POOL_MARKERS, _MODEL_UNAVAILABLE_MARKERS, _rejects_chat_completions


_ROUTE_LABELS = {
    "openai": "Chat Completions",
    "responses": "Responses API",
    "anthropic": "Anthropic Messages",
    "gemini": "Gemini generateContent",
    "ollama": "Ollama Chat",
}
_CONTEXT_MARKERS = (
    "context_length_exceeded", "maximum context length", "context window", "prompt is too long",
    "too many tokens", "input is too long",
)
_CONTENT_POLICY_MARKERS = ("content_policy", "content policy", "content management policy", "content_filter")
_PREFIX = re.compile(r"^(?:litellm\.)?[A-Za-z]+Error:\s*", re.IGNORECASE)
# "OpenAIException - ", "GeminiException BadRequestError - "
_PROVIDER_PREFIX = re.compile(r"^[A-Za-z_]+Exception(?:\s+[A-Za-z]+Error)?\s*-\s*", re.IGNORECASE)
# LiteLLM's own hints, never useful to a user.
_NOISE_SUFFIXES = (
    re.compile(r"\.?\s*Handle with `litellm\.[A-Za-z]+`\.?", re.IGNORECASE),
    re.compile(r"\.?\s*File an issue if.*$", re.IGNORECASE | re.DOTALL),
    re.compile(r",?\s*Original Response:.*$", re.IGNORECASE | re.DOTALL),
    re.compile(r"\s*Traceback \(most recent call last\):.*$", re.DOTALL),
)


def _strip_wrappers(text: str) -> str:
    text = text.strip()
    previous = None
    while previous != text:
        previous = text
        text = _PROVIDER_PREFIX.sub("", _PREFIX.sub("", text)).strip()
    for pattern in _NOISE_SUFFIXES:
        text = pattern.sub("", text).strip()
    return text


def _exception_chain(exc: BaseException) -> list[BaseException]:
    """exc, then its __cause__/__context__ ancestry (LiteLLM keeps the httpx error there)."""
    chain: list[BaseException] = []
    current: BaseException | None = exc
    while current is not None and len(chain) < 12 and all(current is not seen for seen in chain):
        chain.append(current)
        current = current.__cause__ or current.__context__
    return chain


def _has_http_status(chain: list[BaseException]) -> bool:
    """A real upstream HTTP response (not LiteLLM's synthetic 500) is in the chain."""
    import httpx
    import openai

    return any(isinstance(item, (openai.APIStatusError, httpx.HTTPStatusError)) for item in chain)


def failure_kind(exc: BaseException) -> str | None:
    """'timeout' / 'connection' / 'invalid_response' from the underlying error, else None.

    LiteLLM reports connection failures as InternalServerError/APIConnectionError
    with status_code=500, so the status code cannot tell them apart.
    """
    import httpx
    import openai

    # LiteLLM's own exception classes subclass openai's (APIStatusError,
    # APIConnectionError), so only the underlying client errors count.
    chain = [item for item in _exception_chain(exc) if not is_litellm_exception(item)]
    if _has_http_status(chain):
        return None
    for item in chain:
        if isinstance(item, (httpx.TimeoutException, openai.APITimeoutError, TimeoutError)):
            return "timeout"
    for item in chain:
        if isinstance(item, (httpx.ConnectError, openai.APIConnectionError, ConnectionError)) or (
            isinstance(item, OSError) and type(item).__name__ == "gaierror"
        ):
            return "connection"
    for item in chain:
        if isinstance(item, json.JSONDecodeError):
            return "invalid_response"
    return None


_BYTES_LITERAL = re.compile(r"""b(['"]).*\1""", re.DOTALL)


def _decode_bytes_literal(text: str) -> str:
    """Streaming Anthropic/Gemini errors carry ``str(bytes)``, e.g. ``b'{"error": ...}'``."""
    if not _BYTES_LITERAL.fullmatch(text):
        return text
    try:
        value = ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return text
    return value.decode("utf-8", "replace").strip() if isinstance(value, bytes) else text


def litellm_error_detail(exc: BaseException) -> str:
    """Upstream reason without LiteLLM's ``litellm.XError: ProviderException -`` wrapper."""
    response = getattr(exc, "response", None)
    payload: Any = None
    if response is not None:
        try:
            payload = response.json()
        except Exception:
            payload = None
    if payload is None:
        body = getattr(exc, "body", None)
        if isinstance(body, (bytes, bytearray)):
            body = bytes(body).decode("utf-8", "replace")
        payload = body if isinstance(body, (dict, str)) else None
    text = ""
    if isinstance(payload, dict):
        error = payload.get("error", payload)
        if isinstance(error, dict):
            text = str(error.get("message") or error.get("detail") or error.get("code") or "")
        elif isinstance(error, str):
            text = error
    elif isinstance(payload, str):
        text = payload
    if not text:
        text = str(getattr(exc, "message", "") or str(exc) or "")
    text = _decode_bytes_literal(_strip_wrappers(text))
    if text.startswith("{"):
        try:
            decoded = json.loads(text)
        except ValueError:
            decoded = None
        if isinstance(decoded, dict):
            error = decoded.get("error", decoded)
            text = str((error.get("message") or error.get("detail")) if isinstance(error, dict) else error or text)
            text = _strip_wrappers(text)
    if text.startswith("<") or "<html" in text[:80].lower():
        return ""
    # LiteLLM appends a retry hint and model-group metadata to router errors.
    text = text.split("Received Model Group=")[0].split(" LiteLLM Retried:")[0].strip()
    return text[:300]


def is_litellm_exception(exc: BaseException) -> bool:
    return type(exc).__module__.startswith("litellm")


def map_litellm_error(exc: BaseException, protocol: str = "openai", secrets: tuple[str | None, ...] = ()) -> ModelProviderError:
    """Map a LiteLLM exception; ``secrets`` (the connection's API keys) are masked in the message."""
    if isinstance(exc, ModelProviderError):
        return exc.redact(*secrets)
    from ..model_network import model_address_error

    return (model_address_error(exc) or _map_litellm_error(exc, protocol, secrets)).redact(*secrets)


def _map_litellm_error(exc: BaseException, protocol: str, secrets: tuple[str | None, ...]) -> ModelProviderError:
    litellm = get_litellm()
    detail = redact_secrets(litellm_error_detail(exc), secrets)
    lowered = detail.lower()
    status = getattr(exc, "status_code", None)
    route = _ROUTE_LABELS.get(protocol, "模型")
    kind = failure_kind(exc)

    if isinstance(exc, litellm.Timeout) or kind == "timeout":
        return ModelProviderError("request_timeout", "模型服务响应超时，请稍后重试", retryable=True)
    if kind == "connection":
        return ModelProviderError(
            "service_unavailable", "无法连接模型服务，请检查网关地址或网络状态", retryable=True,
        )
    if kind == "invalid_response":
        return ModelProviderError("invalid_provider_response", "模型服务返回了无法解析的响应")
    if any(marker in lowered for marker in _ACCOUNT_POOL_MARKERS):
        return ModelProviderError(
            "account_pool_exhausted",
            "模型网关没有可调度的上游账户，请联系服务商检查账户状态、额度或并发限制",
            retryable=True,
        )
    # LiteLLM classifies some upstream bodies by text (e.g. a 401 whose type is
    # "invalid_request_error" becomes BadRequestError), so the HTTP status wins.
    if isinstance(exc, (litellm.AuthenticationError, litellm.PermissionDeniedError)) or status in {401, 403}:
        return ModelProviderError("authentication_failed", "模型服务认证失败，请检查 API Key 是否有效")
    if isinstance(exc, litellm.RateLimitError) or status == 429:
        return ModelProviderError("rate_limited", "模型服务触发限流，请稍后重试", retryable=True)
    if isinstance(exc, litellm.ContextWindowExceededError) or (
        status in {400, 413, 422} and any(marker in lowered for marker in _CONTEXT_MARKERS)
    ):
        return ModelProviderError(
            "context_window_exceeded",
            "对话内容超出了当前模型的上下文长度，请精简资料或改用更长上下文的模型",
        )
    if isinstance(exc, litellm.ContentPolicyViolationError) or (
        status in {400, 403, 422} and any(marker in lowered for marker in _CONTENT_POLICY_MARKERS)
    ):
        return ModelProviderError(
            "content_policy",
            f"模型服务拒绝了本次内容（内容安全策略）{('：' + detail[:160]) if detail else ''}",
        )
    if protocol == "openai" and status in {400, 404, 422} and _rejects_chat_completions(lowered):
        return ModelProviderError(
            "protocol_unsupported",
            f"模型不支持 Chat Completions 协议，可在连接的接口协议中改用 OpenAI Responses API：{detail[:200]}",
        )
    if isinstance(exc, litellm.NotFoundError) or status in {404, 405}:
        if status != 405 and any(marker in lowered for marker in _MODEL_UNAVAILABLE_MARKERS):
            return ModelProviderError("model_unavailable", f"当前账户组不支持模型 {detail[:160] or '（未知模型）'}")
        return ModelProviderError(
            "route_not_found",
            f"当前地址没有提供 {route} 路由，可检查协议或 API 根路径",
        )
    if isinstance(exc, litellm.ServiceUnavailableError):
        return ModelProviderError(
            "service_unavailable",
            f"模型服务暂时不可用（{status or 503}）{('：' + detail[:160]) if detail else ''}，请稍后重试",
            retryable=True,
        )
    if isinstance(exc, (litellm.BadRequestError, litellm.UnprocessableEntityError)):
        message = f"模型服务返回异常状态（{status or 400}）"
        return ModelProviderError("provider_error", f"{message}：{detail}" if detail else message)
    if isinstance(status, int) and status >= 400:
        message = f"模型服务返回异常状态（{status}）"
        return ModelProviderError(
            "provider_error", f"{message}：{detail}" if detail else message, retryable=status >= 500,
        )
    if isinstance(exc, (litellm.APIConnectionError, litellm.APIError, litellm.InternalServerError, litellm.BadGatewayError)):
        return ModelProviderError(
            "provider_error",
            f"模型服务发生异常{('：' + detail[:200]) if detail else ''}",
            retryable=True,
        )
    return ModelProviderError("provider_error", "模型服务发生未知异常")
