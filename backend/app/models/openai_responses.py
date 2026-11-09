from __future__ import annotations

import json

from collections.abc import AsyncIterator
from time import perf_counter
from typing import Any

from openai import APIConnectionError, APIStatusError, APITimeoutError, AuthenticationError, RateLimitError

from .parameters import request_parameters
from ..agent.settings import get_agent_settings, persona_prompt
from ..domain import ModelRequest, ModelResponse, ModelStreamEvent, ModelUsage, ToolCall
from .base import ModelProviderError
from .validation import upstream_error_detail, validate_diagnostic_response
from .openai_compatible import OpenAICompatibleProvider, SYSTEM_PROMPT, _TINY_PNG_DATA_URL, _looks_like_vision_rejection
from ..domain.agent import ModelImageOutput


_OPENAI_ERRORS = (
    AuthenticationError,
    RateLimitError,
    APITimeoutError,
    APIConnectionError,
    APIStatusError,
)

IMAGE_NOT_EXECUTED_MESSAGE = (
    "服务已返回响应，但没有返回生成的图片。请确认当前连接开放 Grok 生图工具；"
    "可用的聊天模型不代表支持生图。"
)

IMAGE_GENERATION_INSTRUCTIONS = (
    "你是团团的图片生成助手。用户已明确要求文字生图，请使用本轮提供的 image_generation 工具生成图片，"
    "遵循用户指定的主题、风格和比例。不要以提示词、图片链接或文字描述替代真实工具输出，"
    "不要编造图片或声称未执行的工具已经成功。若服务拒绝生成，请简短说明。"
)


_REASONING_EFFORTS = frozenset({"low", "medium", "high"})
_ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content"
_REASONING_DELTA_EVENTS = frozenset({"response.reasoning_summary_text.delta", "response.reasoning_text.delta"})
# Optional request features an upstream rejected, remembered per API root and
# model so later providers for the same connection skip the failing request.
_UNSUPPORTED_OPTIONS: dict[tuple[str, str], set[str]] = {}


def clear_unsupported_option_cache() -> None:
    _UNSUPPORTED_OPTIONS.clear()


def _field(value: Any, name: str, default: Any = None) -> Any:
    return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)


def _rejected_option(arguments: dict[str, Any], exc: Exception) -> str | None:
    """Name the optional argument an upstream 400 explicitly complains about."""
    if not isinstance(exc, APIStatusError) or getattr(exc, "status_code", None) not in {400, 422}:
        return None
    text = f"{upstream_error_detail(exc)} {getattr(exc, 'message', '')}".lower()
    if "include" in arguments and any(word in text for word in ("include", "encrypted")):
        return "include"
    if "reasoning" in arguments and any(word in text for word in ("reasoning", "effort", "summary")):
        return "reasoning"
    if "include" in arguments and "reasoning" in text:
        return "include"
    return None


def _reasoning_items(output: list[Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """Collect replayable reasoning items and their human-readable summaries."""
    items: list[dict[str, Any]] = []
    summaries: list[str] = []
    for item in output:
        if _field(item, "type", "") != "reasoning":
            continue
        summary: list[dict[str, str]] = []
        for part in _field(item, "summary", None) or []:
            text = str(_field(part, "text", "") or "")
            if text:
                summary.append({"type": "summary_text", "text": text})
                summaries.append(text)
        encrypted = _field(item, "encrypted_content", None)
        # With store=False only encrypted reasoning can be replayed; an id
        # alone refers to an item the server never persisted.
        if encrypted:
            items.append({
                "type": "reasoning",
                "id": str(_field(item, "id", "") or ""),
                "encrypted_content": str(encrypted),
                "summary": summary,
            })
    return items, summaries


class OpenAIResponsesProvider(OpenAICompatibleProvider):
    """OpenAI Responses API provider sharing the configured API root and key."""

    name = "responses"

    @property
    def _unsupported_options(self) -> set[str]:
        return _UNSUPPORTED_OPTIONS.setdefault((self._base_url or "", self._model), set())

    async def _create(self, arguments: dict[str, Any], *, image_generation: bool = False, allow_option_fallback: bool = True) -> Any:
        """Create a response, retrying once per optional feature the upstream rejects."""
        if image_generation:
            # A failed transport may already have generated a paid image.
            # Preserve the image path's no-retry contract while text calls can
            # still negotiate optional reasoning parameters.
            client = self._client.with_options(timeout=180, max_retries=0)
            return await client.responses.create(**arguments)
        while True:
            try:
                return await self._client.responses.create(**arguments)
            except APIStatusError as exc:
                option = _rejected_option(arguments, exc)
                if option is None or not allow_option_fallback:
                    raise
                arguments.pop(option, None)
                self._unsupported_options.add(option)

    async def generate(self, request: ModelRequest) -> ModelResponse:
        started_at = perf_counter()
        result = None
        try:
            response = await self._create(self._request_arguments(request), image_generation=request.image_generation, allow_option_fallback=request.allow_option_fallback)
            result = self._response_from_response(response)
            self._validate_image_response(request, result)
        except _OPENAI_ERRORS as exc:
            error = self._provider_error(exc)
            self._record_event("generate", started_at, error=error)
            raise error from exc
        except ModelProviderError as error:
            self._record_event("generate", started_at, error=error,
                               usage=result.usage if result else None,
                               total_tokens=result.usage.total_tokens if result and result.usage else 0,
                               response_id=result.provider_metadata.get("response_id", "") if result else "")
            raise
        except (ValueError, TypeError, AttributeError, json.JSONDecodeError) as exc:
            error = ModelProviderError("provider_error", "模型服务返回了无法解析的 Responses API 响应")
            self._record_event("generate", started_at, error=error)
            raise error from exc
        self._record_event(
            "generate",
            started_at,
            total_tokens=result.usage.total_tokens if result.usage else 0,
            usage=result.usage,
            response_id=result.provider_metadata.get("response_id", ""),
        )
        return result

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        started_at = perf_counter()
        arguments = self._request_arguments(request)
        arguments["stream"] = True
        stream = None
        completed_response = None
        finished_images: dict[str, Any] = {}
        try:
            stream = await self._create(arguments, image_generation=request.image_generation, allow_option_fallback=request.allow_option_fallback)
            async for event in stream:
                event_type = getattr(event, "type", "")
                if event_type == "response.output_text.delta":
                    delta = str(getattr(event, "delta", "") or "")
                    if delta:
                        yield ModelStreamEvent(type="text_delta", delta=delta)
                elif event_type in _REASONING_DELTA_EVENTS:
                    delta = str(getattr(event, "delta", "") or "")
                    if delta:
                        yield ModelStreamEvent(type="reasoning_delta", delta=delta)
                elif event_type == "response.reasoning_summary_part.added" and int(getattr(event, "summary_index", 0) or 0) > 0:
                    yield ModelStreamEvent(type="reasoning_delta", delta="\n\n")
                elif event_type == "response.completed":
                    completed_response = getattr(event, "response", None)
                elif request.image_generation and event_type.startswith("response.image_generation_call."):
                    yield ModelStreamEvent(type="image_progress", delta=event_type.rsplit(".", 1)[-1])
                elif request.image_generation and event_type == "response.output_item.done":
                    item = getattr(event, "item", None)
                    if getattr(item, "type", "") == "image_generation_call":
                        finished_images[str(getattr(item, "id", ""))] = item
        except _OPENAI_ERRORS as exc:
            error = self._provider_error(exc)
            self._record_event("stream", started_at, error=error)
            raise error from exc
        finally:
            if stream is not None:
                close = getattr(stream, "close", None)
                if callable(close):
                    await close()
        if completed_response is None:
            error = ModelProviderError("provider_error", "Responses API 流式调用未返回完成事件")
            self._record_event("stream", started_at, error=error)
            raise error
        if finished_images:
            existing = {str(getattr(item, "id", "")) for item in completed_response.output}
            completed_response.output.extend(item for key, item in finished_images.items() if key not in existing)
        result = None
        try:
            result = self._response_from_response(completed_response)
            self._validate_image_response(request, result)
        except ModelProviderError as error:
            self._record_event("stream", started_at, error=error,
                               usage=result.usage if result else None,
                               total_tokens=result.usage.total_tokens if result and result.usage else 0,
                               response_id=str(getattr(completed_response, "id", "") or ""))
            raise
        self._record_event(
            "stream",
            started_at,
            total_tokens=result.usage.total_tokens if result.usage else 0,
            usage=result.usage,
            response_id=result.provider_metadata.get("response_id", ""),
        )
        yield ModelStreamEvent(type="completed", response=result)

    @staticmethod
    def _validate_image_response(request: ModelRequest, result: ModelResponse) -> None:
        if request.image_generation and not result.images:
            raise ModelProviderError("image_generation_not_executed", IMAGE_NOT_EXECUTED_MESSAGE)

    async def check_connection(self) -> None:
        started_at = perf_counter()
        try:
            response = await self._client.responses.create(
                model=self._model,
                input="仅回复 OK",
                max_output_tokens=16,
                store=False,
            )
            result = self._response_from_response(response)
            validate_diagnostic_response(result, response, self.name)
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        except _OPENAI_ERRORS as exc:
            error = self._provider_error(exc)
            self._record_event("health_check", started_at, error=error)
            raise error from exc
        usage = getattr(response, "usage", None)
        self._record_event(
            "health_check",
            started_at,
            total_tokens=int(getattr(usage, "total_tokens", 0) or 0),
            usage=result.usage,
            response_id=str(getattr(response, "id", "") or ""),
        )

    async def probe_vision(self) -> dict[str, str]:
        started_at = perf_counter()
        try:
            response = await self._client.responses.create(
                model=self._model,
                input=[
                    {
                        "role": "user",
                        "content": [
                            {"type": "input_text", "text": "只回复 OK"},
                            {"type": "input_image", "image_url": _TINY_PNG_DATA_URL},
                        ],
                    }
                ],
                max_output_tokens=16,
                store=False,
            )
            result = self._response_from_response(response)
            validate_diagnostic_response(result, response, self.name)
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        except _OPENAI_ERRORS as exc:
            error = self._provider_error(exc)
            self._record_event("health_check", started_at, error=error)
            if _looks_like_vision_rejection(upstream_error_detail(exc), getattr(exc, "status_code", None)):
                return {"status": "unsupported", "source": "probe", "detail": "服务拒绝了图片输入，当前模型不支持多模态"}
            raise error from exc
        self._record_event("health_check", started_at, total_tokens=result.usage.total_tokens if result.usage else 0, usage=result.usage)
        return {"status": "supported", "source": "probe", "detail": "服务接受了图片输入，当前模型支持多模态"}

    def _request_arguments(self, request: ModelRequest) -> dict[str, Any]:
        settings = get_agent_settings()
        extra_instructions = "\n".join(
            message.content for message in request.messages if message.role == "system" and message.content
        )
        instructions = SYSTEM_PROMPT + persona_prompt(settings)
        if extra_instructions:
            instructions = f"{instructions}\n{extra_instructions}"
        input_items: list[dict[str, Any]] = []
        for message in request.messages:
            if message.role == "system":
                continue
            input_items.extend(self._convert_input_message(message))
        arguments: dict[str, Any] = {
            "model": self._model,
            "instructions": instructions,
            "input": input_items,
            "store": False,
        }
        arguments.update(request_parameters(request.parameters, "max_output_tokens"))
        if request.response_format:
            schema = request.response_format.get("json_schema")
            if schema:
                arguments["text"] = {"format": {"type": "json_schema", **schema}}
            elif request.response_format.get("type") == "json_object":
                arguments["text"] = {"format": {"type": "json_object"}}
        if request.tools:
            arguments["tools"] = [
                {
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                    "strict": False,
                }
                for tool in request.tools
            ]
            arguments["tool_choice"] = request.tool_choice
        if request.image_generation:
            # The ordinary workspace prompt is written for text/file tools.
            # This explicit image request uses a dedicated prompt and one
            # required native tool, rather than letting the model skip it.
            arguments["instructions"] = IMAGE_GENERATION_INSTRUCTIONS
            arguments["tools"] = [{"type": "image_generation", "action": "generate"}]
            arguments["tool_choice"] = "required"
        unsupported = self._unsupported_options
        if "include" not in unsupported:
            # store=False keeps nothing server-side; encrypted reasoning lets the
            # model keep its chain of thought across tool turns.
            arguments["include"] = [_ENCRYPTED_REASONING_INCLUDE]
        if request.reasoning_effort in _REASONING_EFFORTS and "reasoning" not in unsupported:
            arguments["reasoning"] = {"effort": request.reasoning_effort, "summary": "auto"}
        return arguments

    @staticmethod
    def _convert_input_message(message: Any) -> list[dict[str, Any]]:
        if message.role == "assistant" and message.payload.get("tool_calls"):
            items: list[dict[str, Any]] = []
            # Reasoning must precede the function calls it produced.
            for reasoning in message.payload.get("responses_reasoning_items") or []:
                if isinstance(reasoning, dict) and reasoning.get("encrypted_content"):
                    items.append({
                        "type": "reasoning",
                        "id": str(reasoning.get("id") or ""),
                        "encrypted_content": str(reasoning["encrypted_content"]),
                        "summary": list(reasoning.get("summary") or []),
                    })
            if message.content:
                items.append({"role": "assistant", "content": message.content})
            items.extend(
                {
                    "type": "function_call",
                    "call_id": call["id"],
                    "name": call["name"],
                    "arguments": json.dumps(call.get("arguments", {}), ensure_ascii=False),
                }
                for call in message.payload["tool_calls"]
            )
            return items
        if message.role == "tool":
            return [
                {
                    "type": "function_call_output",
                    "call_id": message.tool_call_id,
                    "output": json.dumps(message.payload, ensure_ascii=False),
                }
            ]
        image_urls = message.payload.get("image_urls") if isinstance(message.payload, dict) else None
        if message.role == "user" and image_urls:
            content: list[dict[str, Any]] = []
            if message.content:
                content.append({"type": "input_text", "text": message.content})
            content.extend(
                {"type": "input_image", "image_url": url}
                for url in image_urls
                if isinstance(url, str) and url
            )
            return [{"role": "user", "content": content}]
        return [{"role": "assistant" if message.role == "assistant" else "user", "content": message.content}]

    def _response_from_response(self, response: Any) -> ModelResponse:
        output = getattr(response, "output", None)
        status = getattr(response, "status", None)
        if not isinstance(output, list) or status not in {"completed", "incomplete"}:
            raise ModelProviderError("invalid_provider_response", "模型服务返回了无法解析的 Responses API 响应")
        tool_calls: list[ToolCall] = []
        images: list[ModelImageOutput] = []
        blocks: list[dict[str, Any]] = []
        seen_images: set[str] = set()
        for item in output:
            if getattr(item, "type", "") == "message":
                for part in getattr(item, "content", []) or []:
                    if getattr(part, "type", "") == "output_text" and getattr(part, "text", ""):
                        blocks.append({"type": "text", "text": str(part.text)})
            if getattr(item, "type", "") == "image_generation_call":
                item_id = str(getattr(item, "id", "") or "")
                if getattr(item, "status", "") != "completed" or not item_id or not getattr(item, "result", None):
                    raise ModelProviderError("incomplete_image_output", "生图服务没有返回完整图片；不会自动重新生成，请确认服务执行结果")
                if item_id not in seen_images:
                    seen_images.add(item_id)
                    images.append(ModelImageOutput(item_id=item_id, base64_data=str(item.result)))
                    blocks.append({"type": "image", "index": len(images) - 1})
            if getattr(item, "type", "") != "function_call":
                continue
            try:
                arguments = json.loads(getattr(item, "arguments", "") or "{}")
            except json.JSONDecodeError as exc:
                raise ModelProviderError(
                    "invalid_tool_arguments",
                    f"模型返回的工具参数无法解析：{getattr(item, 'name', '')}",
                ) from exc
            tool_calls.append(
                ToolCall(
                    id=str(getattr(item, "call_id", "") or getattr(item, "id", "") or f"call-{len(tool_calls)}"),
                    name=str(getattr(item, "name", "") or ""),
                    arguments=arguments,
                )
            )
        raw_usage = getattr(response, "usage", None)
        usage = None
        if raw_usage is not None:
            usage = ModelUsage(
                input_tokens=int(getattr(raw_usage, "input_tokens", 0) or 0),
                output_tokens=int(getattr(raw_usage, "output_tokens", 0) or 0),
                total_tokens=int(getattr(raw_usage, "total_tokens", 0) or 0),
            )
        metadata: dict[str, Any] = {
            "model": getattr(response, "model", self._model),
            "finish_reason": getattr(response, "status", None),
            "response_id": getattr(response, "id", "") or "",
            "base_url": self._base_url,
            "protocol": self.name,
        }
        reasoning_items, summaries = _reasoning_items(output)
        if reasoning_items:
            metadata["responses_reasoning_items"] = reasoning_items
        if summaries:
            metadata["reasoning_summary"] = "\n\n".join(summaries)
        return ModelResponse(
            content=str(getattr(response, "output_text", "") or "\n\n".join(b["text"] for b in blocks if b["type"] == "text")),
            tool_calls=tool_calls,
            images=images,
            output_blocks=blocks,
            usage=usage,
            provider_metadata=metadata,
        )
