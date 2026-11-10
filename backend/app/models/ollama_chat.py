from __future__ import annotations

import json

from collections.abc import AsyncIterator
from time import perf_counter
from typing import Any

import httpx

from .parameters import request_parameters
from ..redaction import remember_secret
from ..model_network import model_http_client, model_address_error
from ..agent.settings import get_agent_settings, persona_prompt
from ..domain import ModelRequest, ModelResponse, ModelStreamEvent, ModelUsage, ToolCall
from ..observability.model_monitor import record_model_service_event
from .base import ModelProviderError
from .validation import upstream_error_detail, validate_diagnostic_response
from .openai_compatible import SYSTEM_PROMPT, _TINY_PNG_DATA_URL, _looks_like_vision_rejection


class OllamaChatProvider:
    name = "ollama"

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str | None = None,
        timeout_seconds: float = 60,
    ) -> None:
        self._model = model
        self._secret = api_key  # masked in error messages
        remember_secret(api_key)  # masked verbatim in logs
        self._base_url = (base_url or "http://127.0.0.1:11434").rstrip("/")
        headers = {"content-type": "application/json"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        self._client = model_http_client(headers=headers, timeout=timeout_seconds)

    @property
    def chat_url(self) -> str:
        suffix = "/chat" if self._base_url.endswith("/api") else "/api/chat"
        return f"{self._base_url}{suffix}"

    @property
    def models_url(self) -> str:
        suffix = "/tags" if self._base_url.endswith("/api") else "/api/tags"
        return f"{self._base_url}{suffix}"

    async def generate(self, request: ModelRequest) -> ModelResponse:
        started_at = perf_counter()
        body = self._request_body(request)
        body["stream"] = False
        try:
            response = await self._client.post(self.chat_url, json=body)
            response.raise_for_status()
            result = self._response_from_payload(response.json())
        except ModelProviderError as error:
            self._record_event("generate", started_at, error=error)
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError, TypeError) as exc:
            error = self._provider_error(exc)
            self._record_event("generate", started_at, error=error)
            raise error from exc
        self._record_event("generate", started_at, total_tokens=result.usage.total_tokens if result.usage else 0, usage=result.usage)
        return result

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        started_at = perf_counter()
        body = self._request_body(request)
        body["stream"] = True
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        usage = ModelUsage()
        finish_reason = ""
        try:
            async with self._client.stream("POST", self.chat_url, json=body) as response:
                if response.is_error:
                    await response.aread()
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.strip():
                        continue
                    payload = json.loads(line)
                    message = payload.get("message") or {}
                    text = str(message.get("content") or "")
                    if text:
                        text_parts.append(text)
                        yield ModelStreamEvent(type="text_delta", delta=text)
                    tool_calls.extend(self._tool_calls(message.get("tool_calls") or []))
                    if payload.get("done"):
                        finish_reason = str(payload.get("done_reason") or "stop")
                        usage = self._usage_from_payload(payload)
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError, TypeError, json.JSONDecodeError) as exc:
            error = self._provider_error(exc)
            self._record_event("stream", started_at, error=error)
            raise error from exc
        self._record_event("stream", started_at, total_tokens=usage.total_tokens, usage=usage)
        yield ModelStreamEvent(
            type="completed",
            response=ModelResponse(
                content="".join(text_parts),
                tool_calls=tool_calls,
                usage=usage,
                provider_metadata={
                    "model": self._model,
                    "finish_reason": finish_reason,
                    "response_id": "",
                    "base_url": self._base_url,
                    "protocol": self.name,
                },
            ),
        )

    async def check_connection(self) -> None:
        started_at = perf_counter()
        try:
            response = await self._client.post(
                self.chat_url,
                json={
                    "model": self._model,
                    "messages": [{"role": "user", "content": "仅回复 OK"}],
                    "stream": False,
                    "options": {"num_predict": 8},
                },
            )
            response.raise_for_status()
            payload = response.json()
            result = self._response_from_payload(payload)
            validate_diagnostic_response(result, payload, self.name)
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            error = self._provider_error(exc)
            self._record_event("health_check", started_at, error=error)
            raise error from exc
        self._record_event("health_check", started_at, total_tokens=self._usage_from_payload(payload).total_tokens, usage=self._usage_from_payload(payload))

    async def probe_vision(self) -> dict[str, str]:
        started_at = perf_counter()
        try:
            response = await self._client.post(
                self.chat_url,
                json={
                    "model": self._model,
                    "messages": [
                        {
                            "role": "user",
                            "content": "只回复 OK",
                            "images": [_TINY_PNG_DATA_URL.split(",", 1)[1]],
                        }
                    ],
                    "stream": False,
                    "options": {"num_predict": 8},
                },
            )
            response.raise_for_status()
            payload = response.json()
            result = self._response_from_payload(payload)
            validate_diagnostic_response(result, payload, self.name)
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            error = self._provider_error(exc)
            self._record_event("health_check", started_at, error=error)
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            if _looks_like_vision_rejection(upstream_error_detail(exc), status):
                return {"status": "unsupported", "source": "probe", "detail": "服务拒绝了图片输入，当前模型不支持多模态"}
            raise error from exc
        self._record_event("health_check", started_at, total_tokens=result.usage.total_tokens if result.usage else 0, usage=result.usage)
        return {"status": "supported", "source": "probe", "detail": "服务接受了图片输入，当前模型支持多模态"}

    async def list_models(self) -> list[str]:
        try:
            response = await self._client.get(self.models_url)
            response.raise_for_status()
            payload = response.json()
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            raise self._provider_error(exc) from exc
        return sorted(
            {
                str(item.get("name") or item.get("model") or "").strip()
                for item in payload.get("models") or []
                if isinstance(item, dict) and str(item.get("name") or item.get("model") or "").strip()
            }
        )

    def _request_body(self, request: ModelRequest) -> dict[str, Any]:
        settings = get_agent_settings()
        messages = [{"role": "system", "content": SYSTEM_PROMPT + persona_prompt(settings)}]
        messages.extend(self._convert_message(message) for message in request.messages)
        body: dict[str, Any] = {"model": self._model, "messages": messages}
        parameters = request_parameters(request.parameters, "num_predict")
        if parameters:
            body["options"] = parameters
        if request.tools and request.tool_choice != "none":
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.input_schema,
                    },
                }
                for tool in request.tools
            ]
            if request.tool_choice == "required":
                body["messages"].append(
                    {
                        "role": "system",
                        "content": "本轮必须调用一个已提供的工具，不要直接返回最终回答。",
                    }
                )
        return body

    @staticmethod
    def _convert_message(message: Any) -> dict[str, Any]:
        if message.role == "assistant" and message.payload.get("tool_calls"):
            return {
                "role": "assistant",
                "content": message.content,
                "tool_calls": [
                    {
                        "function": {
                            "name": call["name"],
                            "arguments": call.get("arguments", {}),
                        }
                    }
                    for call in message.payload["tool_calls"]
                ],
            }
        if message.role == "tool":
            return {
                "role": "tool",
                "content": json.dumps(message.payload, ensure_ascii=False),
                "tool_name": str(message.payload.get("tool_name") or ""),
            }
        result: dict[str, Any] = {"role": message.role, "content": message.content}
        image_urls = message.payload.get("image_urls") if isinstance(message.payload, dict) else None
        if message.role == "user" and image_urls:
            result["images"] = [
                url.split(",", 1)[1] if url.startswith("data:") and "," in url else url
                for url in image_urls
                if isinstance(url, str) and url
            ]
        return result

    def _response_from_payload(self, payload: dict[str, Any]) -> ModelResponse:
        if not isinstance(payload, dict) or not isinstance(payload.get("message"), dict):
            raise ModelProviderError("invalid_provider_response", "Ollama 返回了无法解析的响应")
        message = payload.get("message") or {}
        return ModelResponse(
            content=str(message.get("content") or ""),
            tool_calls=self._tool_calls(message.get("tool_calls") or []),
            usage=self._usage_from_payload(payload),
            provider_metadata={
                "model": payload.get("model") or self._model,
                "finish_reason": payload.get("done_reason"),
                "response_id": "",
                "base_url": self._base_url,
                "protocol": self.name,
            },
        )

    @staticmethod
    def _tool_calls(items: list[Any]) -> list[ToolCall]:
        calls: list[ToolCall] = []
        for item in items:
            function = item.get("function") if isinstance(item, dict) else None
            if not isinstance(function, dict):
                continue
            arguments = function.get("arguments")
            if isinstance(arguments, str):
                try:
                    arguments = json.loads(arguments or "{}")
                except json.JSONDecodeError as exc:
                    raise ModelProviderError(
                        "invalid_tool_arguments",
                        f"模型返回的工具参数无法解析：{function.get('name', '')}",
                    ) from exc
            calls.append(
                ToolCall(
                    id=str(item.get("id") or f"ollama-call-{len(calls)}"),
                    name=str(function.get("name") or ""),
                    arguments=arguments if isinstance(arguments, dict) else {},
                )
            )
        return calls

    @staticmethod
    def _usage_from_payload(payload: dict[str, Any]) -> ModelUsage:
        input_tokens = int(payload.get("prompt_eval_count") or 0)
        output_tokens = int(payload.get("eval_count") or 0)
        return ModelUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
        )

    def _provider_error(self, exc: Exception) -> ModelProviderError:
        # Gateways may echo the key back in error bodies; never surface or store it.
        return self._map_provider_error(exc).redact(self._secret)

    @staticmethod
    def _map_provider_error(exc: Exception) -> ModelProviderError:
        policy_error = model_address_error(exc)
        if policy_error:
            return policy_error
        if isinstance(exc, httpx.TimeoutException):
            return ModelProviderError("request_timeout", "模型服务响应超时，请稍后重试", retryable=True)
        if isinstance(exc, httpx.RequestError):
            return ModelProviderError("service_unavailable", "无法连接 Ollama，请检查服务地址与运行状态", retryable=True)
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            if status in {401, 403}:
                return ModelProviderError("authentication_failed", "Ollama 服务认证失败，请检查 API Key")
            if status == 429:
                return ModelProviderError("rate_limited", "Ollama 服务触发限流，请稍后重试", retryable=True)
            detail = ""
            try:
                payload = exc.response.json()
                detail = str(payload.get("error") or "") if isinstance(payload, dict) else ""
            except Exception:
                pass
            message = f"Ollama 返回异常状态（{status}）"
            if detail:
                message = f"{message}：{detail[:200]}"
            return ModelProviderError("provider_error", message, retryable=status >= 500)
        return ModelProviderError("invalid_provider_response", "Ollama 返回了无法解析的响应")

    def _record_event(
        self,
        request_kind: str,
        started_at: float,
        *,
        error: ModelProviderError | None = None,
        total_tokens: int = 0,
        usage: ModelUsage | None = None,
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
                protocol=self.name,
            )
        except Exception:
            pass
