"""LiteLLM-backed model provider behind 团团's provider interface.

One instance serves one (protocol, model, API root, key).  The protocol is the
one 团团 resolved or negotiated; it decides the LiteLLM route:

* ``openai``    → ``litellm.acompletion("openai/<model>")``
* ``responses`` → ``litellm.aresponses("openai/<model>")``
* ``anthropic`` → ``litellm.acompletion("anthropic/<model>")``
* ``gemini``    → ``litellm.acompletion("gemini/<model>")``
* ``ollama``    → ``litellm.acompletion("ollama_chat/<model>")``

Model discovery (``list_models``) stays on the native adapter: it is a plain
catalog GET with 团团-specific error messages and LiteLLM has no generic
equivalent for arbitrary gateways.
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from time import perf_counter
from typing import Any

from ..redaction import remember_secret
from ..model_network import hosted_models, PublicModelTransport
from ..agent.settings import get_agent_settings, persona_prompt
from ..domain import ModelRequest, ModelResponse, ModelStreamEvent, ModelUsage, ToolCall
from ..observability.model_monitor import record_model_service_event
from .anthropic_messages import AnthropicMessagesProvider
from .base import ModelProviderError
from .gemini_generate_content import GeminiGenerateContentProvider
from .litellm_core import api_base_for, estimate_cost_usd, get_litellm, model_string
from .litellm_errors import is_litellm_exception, litellm_error_detail, map_litellm_error
from .ollama_chat import OllamaChatProvider
from .openai_compatible import SYSTEM_PROMPT, _TINY_PNG_DATA_URL, OpenAICompatibleProvider, _looks_like_vision_rejection
from .openai_responses import (
    _ENCRYPTED_REASONING_INCLUDE,
    _REASONING_DELTA_EVENTS,
    OpenAIResponsesProvider,
    _rejected_option,
)
from .validation import validate_diagnostic_response

logger = logging.getLogger(__name__)


_NATIVE_CLASSES = {
    "openai": OpenAICompatibleProvider,
    "responses": OpenAIResponsesProvider,
    "anthropic": AnthropicMessagesProvider,
    "gemini": GeminiGenerateContentProvider,
    "ollama": OllamaChatProvider,
}
_REASONING_EFFORTS = frozenset({"low", "medium", "high"})
# Optional chat parameters an upstream rejected, remembered per route.
_UNSUPPORTED_CHAT_OPTIONS: dict[tuple[str, str, str], set[str]] = {}


def clear_litellm_option_cache() -> None:
    _UNSUPPORTED_CHAT_OPTIONS.clear()


def _field(value: Any, name: str, default: Any = None) -> Any:
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def _event_type(event: Any) -> str:
    raw = _field(event, "type", "")
    return str(getattr(raw, "value", raw) or "")


def _usage_from(raw: Any) -> ModelUsage | None:
    if raw is None:
        return None
    input_tokens = int(_field(raw, "prompt_tokens", None) or _field(raw, "input_tokens", 0) or 0)
    output_tokens = int(_field(raw, "completion_tokens", None) or _field(raw, "output_tokens", 0) or 0)
    total = int(_field(raw, "total_tokens", 0) or 0) or input_tokens + output_tokens
    return ModelUsage(input_tokens=input_tokens, output_tokens=output_tokens, total_tokens=total)


def _original_response_id(value: Any) -> str:
    """Undo LiteLLM's ``resp_<base64("litellm:...;response_id:<id>")>`` wrapping."""
    text = str(value or "")
    if not text.startswith("resp_"):
        return text
    import base64
    import binascii

    encoded = text[len("resp_"):]
    try:
        decoded = base64.b64decode(encoded + "=" * (-len(encoded) % 4), validate=False).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return text
    if not decoded.startswith("litellm:") or "response_id:" not in decoded:
        return text
    return decoded.split("response_id:", 1)[1] or text


def _parse_arguments(name: str, raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError) as exc:
        raise ModelProviderError("invalid_tool_arguments", f"模型返回的工具参数无法解析：{name}") from exc
    return value if isinstance(value, dict) else {}


def _replayable_thinking_blocks(blocks: Any) -> list[dict[str, Any]]:
    """Anthropic only accepts signed (or redacted) thinking blocks back."""
    result: list[dict[str, Any]] = []
    for block in blocks or []:
        if not isinstance(block, dict):
            block = dict(block) if hasattr(block, "keys") else {}
        kind = block.get("type")
        if kind == "thinking" and block.get("signature"):
            result.append({"type": "thinking", "thinking": str(block.get("thinking") or ""), "signature": str(block["signature"])})
        elif kind == "redacted_thinking" and block.get("data"):
            result.append({"type": "redacted_thinking", "data": str(block["data"])})
    return result


class _ThinkingAccumulator:
    """Rebuild signed thinking blocks from streamed deltas.

    LiteLLM streams Anthropic thinking as text fragments followed by a chunk
    that repeats the full text with the signature; ``stream_chunk_builder``
    concatenates both, so blocks are assembled here instead.
    """

    def __init__(self) -> None:
        self.blocks: list[dict[str, Any]] = []
        self._text: list[str] = []

    def add(self, blocks: Any) -> None:
        for block in blocks or []:
            block = block if isinstance(block, dict) else dict(block)
            if block.get("type") == "redacted_thinking":
                self.blocks.append({"type": "redacted_thinking", "data": block.get("data", "")})
                continue
            if block.get("signature"):
                text = "".join(self._text) or str(block.get("thinking") or "")
                self.blocks.append({"type": "thinking", "thinking": text, "signature": block["signature"]})
                self._text = []
            elif block.get("thinking"):
                self._text.append(str(block["thinking"]))


class LiteLLMProvider:
    backend = "litellm"

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str | None = None,
        timeout_seconds: float = 60,
        *,
        protocol: str = "openai",
        price_per_million_input: float | None = None,
        price_per_million_output: float | None = None,
    ) -> None:
        if protocol not in _NATIVE_CLASSES:
            raise ValueError(f"未知模型协议：{protocol}")
        # The native adapter keeps model discovery and enforces the same
        # constructor validation (e.g. a required API key) as before.
        self._native = _NATIVE_CLASSES[protocol](api_key=api_key, model=model, base_url=base_url, timeout_seconds=timeout_seconds)
        self.name = protocol
        self._protocol = protocol
        self._model = model
        self._api_key = api_key
        remember_secret(api_key)  # masked verbatim in logs
        self._configured_base_url = (base_url or "").rstrip("/") or None
        self._timeout = timeout_seconds
        self._prices = (price_per_million_input, price_per_million_output)
        self._hosted_client = None

    def hosted_client(self):
        """The exact client type LiteLLM expects for this route's dialect."""
        if not hosted_models():
            return None
        if self._protocol == "openai":
            return self._native._client
        if self._hosted_client is None:
            get_litellm()
            from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler

            self._hosted_client = AsyncHTTPHandler(
                timeout=self._timeout, transport=PublicModelTransport(), follow_redirects=False,
            )
        return self._hosted_client

    # ------------------------------------------------------------------
    # Identity
    # ------------------------------------------------------------------
    @property
    def models_url(self) -> str:
        return self._native.models_url

    @property
    def _base_url(self) -> str:
        """Address recorded by the monitor; identical to the native adapter's."""
        return str(getattr(self._native, "_base_url", None) or self._configured_base_url or "")

    @property
    def litellm_model(self) -> str:
        return model_string(self._protocol, self._model)

    def litellm_params(self, *, responses_bridge: bool = False) -> dict[str, Any]:
        """Deployment parameters for ``litellm.Router`` (credential included)."""
        params: dict[str, Any] = {
            "model": model_string(self._protocol, self._model, responses_bridge=responses_bridge),
            "timeout": self._timeout,
            "max_retries": 0,
        }
        base = api_base_for(self._protocol, self._configured_base_url)
        if base:
            params["api_base"] = base
        if self._api_key:
            params["api_key"] = self._api_key
        return params

    def _call_options(self) -> dict[str, Any]:
        options = self.litellm_params()
        options.pop("model")
        options["num_retries"] = 0
        if hosted_models():
            options["client"] = self.hosted_client()
        return options

    # ------------------------------------------------------------------
    # Request building
    # ------------------------------------------------------------------
    def _system_prompt(self) -> str:
        return SYSTEM_PROMPT + persona_prompt(get_agent_settings())

    def chat_messages(self, request: ModelRequest, *, protocol: str | None = None) -> list[dict[str, Any]]:
        protocol = protocol or self._protocol
        system: Any = self._system_prompt()
        if protocol == "anthropic" and request.prompt_cache:
            # Static instructions are the cacheable prefix of every tool round.
            system = [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
        messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
        for message in request.messages:
            converted = OpenAICompatibleProvider._convert_message(message)
            if message.role == "assistant" and isinstance(message.payload, dict):
                if protocol == "anthropic" and message.payload.get("thinking_blocks"):
                    converted["thinking_blocks"] = _replayable_thinking_blocks(message.payload["thinking_blocks"])
                if protocol == "responses" and message.payload.get("responses_reasoning_items"):
                    converted["reasoning_items"] = list(message.payload["responses_reasoning_items"])
            messages.append(converted)
        if protocol == "ollama" and request.tools and request.tool_choice == "required":
            messages.append({"role": "system", "content": "本轮必须调用一个已提供的工具，不要直接返回最终回答。"})
        return messages

    def chat_arguments(self, request: ModelRequest, *, protocol: str | None = None) -> dict[str, Any]:
        protocol = protocol or self._protocol
        arguments: dict[str, Any] = {"messages": self.chat_messages(request, protocol=protocol)}
        if request.tools and not (protocol == "anthropic" and request.tool_choice == "none"):
            arguments["tools"] = [
                {"type": "function", "function": {"name": tool.name, "description": tool.description, "parameters": tool.input_schema}}
                for tool in request.tools
            ]
            if protocol != "ollama":
                arguments["tool_choice"] = request.tool_choice
        parameters = dict(request.parameters or {})
        effort = request.reasoning_effort if request.reasoning_effort in _REASONING_EFFORTS else None
        unsupported = _UNSUPPORTED_CHAT_OPTIONS.get((protocol, self._base_url, self._model), set())
        if effort and "reasoning_effort" not in unsupported:
            arguments["reasoning_effort"] = {"effort": effort, "summary": "auto"} if protocol == "responses" else effort
        if "temperature" in parameters and not (effort and protocol == "anthropic"):
            # Anthropic rejects a custom temperature while extended thinking is on.
            arguments["temperature"] = parameters["temperature"]
        if "max_output_tokens" in parameters:
            arguments["max_tokens"] = int(parameters["max_output_tokens"])
        if request.response_format and (not request.allow_option_fallback or "response_format" not in unsupported):
            arguments["response_format"] = request.response_format
        if protocol == "responses":
            # Stateless Responses calls must ask for encrypted reasoning to replay it.
            arguments["extra_body"] = {"store": False, "include": [_ENCRYPTED_REASONING_INCLUDE]}
        return arguments

    def _responses_arguments(self, request: ModelRequest) -> dict[str, Any]:
        # Reuse the native Responses request builder: instructions, encrypted
        # reasoning replay, function tools and the unsupported-option memory.
        arguments = self._native._request_arguments(request)
        arguments.pop("model", None)
        parameters = dict(request.parameters or {})
        if "temperature" in parameters:
            arguments["temperature"] = parameters["temperature"]
        if "max_output_tokens" in parameters:
            arguments["max_output_tokens"] = int(parameters["max_output_tokens"])
        if request.response_format:
            schema = request.response_format.get("json_schema") if isinstance(request.response_format, dict) else None
            if isinstance(schema, dict):
                arguments["text"] = {"format": {"type": "json_schema", **schema}}
            elif isinstance(request.response_format, dict) and request.response_format.get("type") == "json_object":
                arguments["text"] = {"format": {"type": "json_object"}}
        return arguments

    # ------------------------------------------------------------------
    # LiteLLM calls
    # ------------------------------------------------------------------
    async def _acompletion(self, arguments: dict[str, Any], *, allow_option_fallback: bool = True) -> Any:
        litellm = get_litellm()
        options = {**self._call_options(), **arguments}
        while True:
            try:
                return await litellm.acompletion(model=self.litellm_model, **options)
            except Exception as exc:
                option = self._rejected_chat_option(options, exc)
                if option is None or not allow_option_fallback:
                    raise
                options.pop(option, None)
                _UNSUPPORTED_CHAT_OPTIONS.setdefault((self._protocol, self._base_url, self._model), set()).add(option)

    @staticmethod
    def _rejected_chat_option(options: dict[str, Any], exc: Exception) -> str | None:
        if not is_litellm_exception(exc) or getattr(exc, "status_code", None) not in {400, 422}:
            return None
        text = litellm_error_detail(exc).lower()
        if "reasoning_effort" in options and any(word in text for word in ("reasoning", "effort", "thinking")):
            return "reasoning_effort"
        if "response_format" in options and any(word in text for word in ("response_format", "json_schema", "response format")):
            return "response_format"
        return None

    async def _aresponses(self, arguments: dict[str, Any], *, allow_option_fallback: bool = True) -> Any:
        litellm = get_litellm()
        options = {**self._call_options(), **arguments}
        while True:
            try:
                return await litellm.aresponses(model=self.litellm_model, **options)
            except Exception as exc:
                option = _rejected_option(options, exc) if is_litellm_exception(exc) else None
                if option is None or not allow_option_fallback:
                    raise
                options.pop(option, None)
                self._native._unsupported_options.add(option)

    def _cost(self, response: Any, usage: ModelUsage | None) -> float | None:
        try:
            return estimate_cost_usd(
                response, protocol=self._protocol, model=self._model,
                input_tokens=usage.input_tokens if usage else 0,
                output_tokens=usage.output_tokens if usage else 0,
                price_per_million_input=self._prices[0], price_per_million_output=self._prices[1],
            )
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Response conversion
    # ------------------------------------------------------------------
    def response_from_completion(self, response: Any, *, protocol: str | None = None) -> ModelResponse:
        protocol = protocol or self._protocol
        choices = _field(response, "choices", None) or []
        if not choices:
            raise self._invalid_response_error()
        choice = choices[0]
        message = _field(choice, "message")
        if message is None:
            raise self._invalid_response_error()
        tool_calls = []
        for index, call in enumerate(_field(message, "tool_calls", None) or []):
            function = _field(call, "function")
            name = str(_field(function, "name", "") or "")
            tool_calls.append(ToolCall(id=str(_field(call, "id", "") or f"call-{index}"), name=name, arguments=_parse_arguments(name, _field(function, "arguments", "{}"))))
        usage = _usage_from(_field(response, "usage"))
        metadata: dict[str, Any] = {
            "model": _field(response, "model", self._model) or self._model,
            "finish_reason": _field(choice, "finish_reason"),
            "response_id": _field(response, "id", "") or "",
            "base_url": self._base_url,
            "protocol": protocol,
            "backend": "litellm",
        }
        reasoning = str(_field(message, "reasoning_content", "") or "")
        if reasoning:
            metadata["reasoning_summary"] = reasoning
        thinking = _replayable_thinking_blocks(_field(message, "thinking_blocks", None))
        if thinking:
            metadata["thinking_blocks"] = thinking
        reasoning_items = _field(message, "reasoning_items", None)
        if reasoning_items:
            metadata["responses_reasoning_items"] = [
                {"type": "reasoning", "id": str(_field(item, "id", "") or ""), "encrypted_content": str(_field(item, "encrypted_content", "")),
                 "summary": list(_field(item, "summary", None) or [])}
                for item in reasoning_items if _field(item, "encrypted_content", None)
            ]
            if not metadata["responses_reasoning_items"]:
                metadata.pop("responses_reasoning_items")
        cost = self._cost(response, usage)
        if cost is not None:
            metadata["cost_usd"] = cost
        return ModelResponse(content=str(_field(message, "content", "") or ""), tool_calls=tool_calls, usage=usage, provider_metadata=metadata)

    def _response_from_responses(self, response: Any) -> ModelResponse:
        result = self._native._response_from_response(response)
        metadata = dict(result.provider_metadata)
        if not result.content:
            # LiteLLM's ResponsesAPIResponse may not expose ``output_text``.
            texts = [
                str(_field(part, "text", "") or "")
                for item in (_field(response, "output", None) or [])
                if _field(item, "type", "") == "message"
                for part in (_field(item, "content", None) or [])
                if _field(part, "type", "") == "output_text"
            ]
            result = result.model_copy(update={"content": "".join(texts)})
        metadata.update(base_url=self._base_url, backend="litellm")
        if metadata.get("response_id"):
            metadata["response_id"] = _original_response_id(metadata["response_id"])
        cost = self._cost(response, result.usage)
        if cost is not None:
            metadata["cost_usd"] = cost
        return result.model_copy(update={"provider_metadata": metadata})

    def _invalid_response_error(self) -> ModelProviderError:
        label = {"openai": "Chat Completions", "anthropic": "Anthropic Messages", "gemini": "Gemini generateContent", "ollama": "Ollama Chat"}.get(self._protocol, self._protocol)
        return ModelProviderError(
            "invalid_provider_response",
            f"模型服务没有返回符合 {label} 协议的响应内容。请确认 Base URL（{self._base_url or '官方默认地址'}）指向真实 API 根地址，且当前账户支持模型 {self._model}",
        )

    def _error(self, exc: BaseException) -> ModelProviderError:
        secrets = (self._api_key,)
        if isinstance(exc, ModelProviderError):
            return exc.redact(*secrets)
        if is_litellm_exception(exc) or hasattr(exc, "status_code"):
            return map_litellm_error(exc, self._protocol, secrets)
        if isinstance(exc, (ValueError, TypeError, AttributeError, KeyError, json.JSONDecodeError)):
            logger.warning("LiteLLM response could not be parsed (%s)", type(exc).__name__, exc_info=exc)
            return ModelProviderError("invalid_provider_response", "模型服务返回了无法解析的响应")
        # Unclassified failures (e.g. a module missing from a packaged build) must stay diagnosable.
        logger.warning("Unexpected LiteLLM failure (%s)", type(exc).__name__, exc_info=exc)
        return ModelProviderError("provider_error", "模型服务发生未知异常")

    # ------------------------------------------------------------------
    # Provider interface
    # ------------------------------------------------------------------
    async def generate(self, request: ModelRequest) -> ModelResponse:
        if request.image_generation:
            # Image progress, binary output and no-retry handling are owned by
            # the native Responses adapter; the completion router cannot carry
            # these outputs safely.
            return await self._native.generate(request)
        started_at = perf_counter()
        try:
            if self._protocol == "responses":
                result = self._response_from_responses(await self._aresponses(self._responses_arguments(request), allow_option_fallback=request.allow_option_fallback))
            else:
                result = self.response_from_completion(await self._acompletion(self.chat_arguments(request), allow_option_fallback=request.allow_option_fallback))
        except Exception as exc:
            error = self._error(exc)
            self._record_event("generate", started_at, error=error)
            raise error from exc
        self._record_success("generate", started_at, result)
        return result

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        if request.image_generation:
            async for event in self._native.stream(request):
                yield event
            return
        started_at = perf_counter()
        events = self._stream_responses(request) if self._protocol == "responses" else self._stream_chat(request)
        result: ModelResponse | None = None
        try:
            async for event in events:
                if event.type == "completed":
                    result = event.response
                    continue
                yield event
        except Exception as exc:
            error = self._error(exc)
            self._record_event("stream", started_at, error=error)
            raise error from exc
        if result is None:
            error = ModelProviderError("invalid_provider_response", "模型流已结束，但没有返回完整响应")
            self._record_event("stream", started_at, error=error)
            raise error
        self._record_success("stream", started_at, result)
        yield ModelStreamEvent(type="completed", response=result)

    async def _stream_chat(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        arguments = self.chat_arguments(request)
        arguments.update(stream=True, stream_options={"include_usage": True})
        stream = await self._acompletion(arguments, allow_option_fallback=request.allow_option_fallback)
        async for event in self.consume_chat_stream(stream):
            yield event

    async def consume_chat_stream(self, stream: Any, *, protocol: str | None = None) -> AsyncIterator[ModelStreamEvent]:
        """Turn a LiteLLM chat stream into 团团 stream events plus one completed event."""
        protocol = protocol or self._protocol
        content: list[str] = []
        reasoning: list[str] = []
        thinking = _ThinkingAccumulator()
        tool_parts: dict[int, dict[str, Any]] = {}
        reasoning_items: list[Any] = []
        usage = None
        response_id = ""
        response_model = self._model
        finish_reason = None
        last_chunk = None
        try:
            async for chunk in stream:
                last_chunk = chunk
                response_id = _field(chunk, "id", "") or response_id
                response_model = _field(chunk, "model", "") or response_model
                if _field(chunk, "usage", None) is not None:
                    usage = _usage_from(chunk.usage) or usage
                choices = _field(chunk, "choices", None) or []
                if not choices:
                    continue
                choice = choices[0]
                finish_reason = _field(choice, "finish_reason", None) or finish_reason
                delta = _field(choice, "delta")
                if delta is None:
                    continue
                reasoning_delta = _field(delta, "reasoning_content", None)
                if reasoning_delta:
                    reasoning.append(str(reasoning_delta))
                    yield ModelStreamEvent(type="reasoning_delta", delta=str(reasoning_delta))
                thinking.add(_field(delta, "thinking_blocks", None))
                for item in _field(delta, "reasoning_items", None) or []:
                    reasoning_items.append(item)
                text = _field(delta, "content", None)
                if text:
                    content.append(str(text))
                    yield ModelStreamEvent(type="text_delta", delta=str(text))
                for position, call in enumerate(_field(delta, "tool_calls", None) or []):
                    index = _field(call, "index", None)
                    index = position if index is None else int(index)
                    part = tool_parts.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    if _field(call, "id", None):
                        part["id"] = str(call.id if not isinstance(call, dict) else call["id"])
                    function = _field(call, "function")
                    if function is not None:
                        if _field(function, "name", None):
                            part["name"] += str(_field(function, "name"))
                        arguments = _field(function, "arguments", None)
                        if isinstance(arguments, dict):
                            part["arguments"] += json.dumps(arguments, ensure_ascii=False)
                        elif arguments:
                            part["arguments"] += str(arguments)
        finally:
            close = getattr(stream, "aclose", None) or getattr(stream, "close", None)
            if callable(close):
                try:
                    outcome = close()
                    if hasattr(outcome, "__await__"):
                        await outcome
                except Exception:
                    pass
        tool_calls = [
            ToolCall(id=part["id"] or f"stream-call-{index}", name=part["name"], arguments=_parse_arguments(part["name"], part["arguments"]))
            for index, part in sorted(tool_parts.items())
        ]
        if not content and not tool_calls and not reasoning and usage is None and finish_reason is None:
            raise self._invalid_response_error()
        metadata: dict[str, Any] = {
            "model": response_model, "finish_reason": finish_reason, "response_id": response_id,
            "base_url": self._base_url, "protocol": protocol, "backend": "litellm",
        }
        if reasoning:
            metadata["reasoning_summary"] = "".join(reasoning)
        if thinking.blocks:
            metadata["thinking_blocks"] = thinking.blocks
        replay = [
            {"type": "reasoning", "id": str(_field(item, "id", "") or ""), "encrypted_content": str(_field(item, "encrypted_content", "")), "summary": list(_field(item, "summary", None) or [])}
            for item in reasoning_items if _field(item, "encrypted_content", None)
        ]
        if replay:
            metadata["responses_reasoning_items"] = replay
        cost = self._cost(last_chunk, usage)
        if cost is not None:
            metadata["cost_usd"] = cost
        yield ModelStreamEvent(type="completed", response=ModelResponse(content="".join(content), tool_calls=tool_calls, usage=usage, provider_metadata=metadata))

    async def _stream_responses(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        arguments = self._responses_arguments(request)
        arguments["stream"] = True
        stream = await self._aresponses(arguments, allow_option_fallback=request.allow_option_fallback)
        completed = None
        try:
            async for event in stream:
                kind = _event_type(event)
                if kind == "response.output_text.delta":
                    delta = str(_field(event, "delta", "") or "")
                    if delta:
                        yield ModelStreamEvent(type="text_delta", delta=delta)
                elif kind in _REASONING_DELTA_EVENTS:
                    delta = str(_field(event, "delta", "") or "")
                    if delta:
                        yield ModelStreamEvent(type="reasoning_delta", delta=delta)
                elif kind == "response.reasoning_summary_part.added" and int(_field(event, "summary_index", 0) or 0) > 0:
                    yield ModelStreamEvent(type="reasoning_delta", delta="\n\n")
                elif kind == "response.completed":
                    completed = _field(event, "response")
                elif kind in {"response.failed", "error"}:
                    detail = str(_field(_field(_field(event, "response"), "error"), "message", "") or _field(event, "message", "") or "")
                    raise ModelProviderError(
                        "provider_error", f"Responses API 流式调用失败{('：' + detail[:200]) if detail else ''}",
                    ).redact(self._api_key)
        finally:
            close = getattr(stream, "aclose", None)
            if callable(close):
                try:
                    await close()
                except Exception:
                    pass
        if completed is None:
            raise ModelProviderError("provider_error", "Responses API 流式调用未返回完成事件")
        yield ModelStreamEvent(type="completed", response=self._response_from_responses(completed))

    async def check_connection(self) -> None:
        """A small real inference, validated like the native adapters."""
        started_at = perf_counter()
        try:
            if self._protocol == "responses":
                raw = await self._aresponses({"input": "仅回复 OK", "max_output_tokens": 16, "store": False})
                result = self._response_from_responses(raw)
                validate_diagnostic_response(result, raw, "responses")
            else:
                raw = await self._acompletion({"messages": [{"role": "user", "content": "仅回复 OK"}]})
                result = self.response_from_completion(raw)
                # LiteLLM normalizes every chat route to the OpenAI shape.
                validate_diagnostic_response(result, raw, "openai")
        except Exception as exc:
            error = self._error(exc)
            self._record_event("health_check", started_at, error=error)
            raise error from exc
        self._record_success("health_check", started_at, result)

    async def probe_vision(self) -> dict[str, str]:
        started_at = perf_counter()
        try:
            if self._protocol == "responses":
                raw = await self._aresponses({
                    "input": [{"role": "user", "content": [{"type": "input_text", "text": "只回复 OK"}, {"type": "input_image", "image_url": _TINY_PNG_DATA_URL}]}],
                    "max_output_tokens": 16, "store": False,
                })
                result = self._response_from_responses(raw)
                validate_diagnostic_response(result, raw, "responses")
            else:
                raw = await self._acompletion({
                    "messages": [{"role": "user", "content": [{"type": "text", "text": "只回复 OK"}, {"type": "image_url", "image_url": {"url": _TINY_PNG_DATA_URL}}]}],
                    "max_tokens": 16,
                })
                result = self.response_from_completion(raw)
                validate_diagnostic_response(result, raw, "openai")
        except Exception as exc:
            error = self._error(exc)
            self._record_event("health_check", started_at, error=error)
            if not isinstance(exc, ModelProviderError) and _looks_like_vision_rejection(litellm_error_detail(exc), getattr(exc, "status_code", None)):
                return {"status": "unsupported", "source": "probe", "detail": "服务拒绝了图片输入，当前模型不支持多模态"}
            raise error from exc
        self._record_success("health_check", started_at, result)
        return {"status": "supported", "source": "probe", "detail": "服务接受了图片输入，当前模型支持多模态"}

    async def list_models(self) -> list[str]:
        return await self._native.list_models()

    # ------------------------------------------------------------------
    # Monitoring
    # ------------------------------------------------------------------
    def _record_success(self, request_kind: str, started_at: float, result: ModelResponse) -> None:
        self._record_event(
            request_kind, started_at, usage=result.usage,
            total_tokens=result.usage.total_tokens if result.usage else 0,
            response_id=str(result.provider_metadata.get("response_id", "") or ""),
            cost_usd=result.provider_metadata.get("cost_usd"),
        )

    def _record_event(
        self,
        request_kind: str,
        started_at: float,
        *,
        error: ModelProviderError | None = None,
        total_tokens: int = 0,
        usage: ModelUsage | None = None,
        response_id: str = "",
        cost_usd: float | None = None,
    ) -> None:
        try:
            record_model_service_event(
                request_kind=request_kind,
                status="error" if error else "success",
                error_code=error.code if error else "",
                error_message=str(error) if error else "",
                latency_ms=round((perf_counter() - started_at) * 1000),
                total_tokens=total_tokens,
                input_tokens=usage.input_tokens if usage else 0,
                output_tokens=usage.output_tokens if usage else 0,
                model_name=self._model,
                base_url=self._base_url,
                response_id=response_id,
                protocol=self.name,
                cost_usd=cost_usd,
                backend="litellm",
            )
        except Exception:
            # Monitoring is best-effort and must never break a model call.
            pass
