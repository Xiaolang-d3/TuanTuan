from __future__ import annotations

import asyncio
from contextlib import aclosing
from typing import Any
from uuid import uuid4

from ..domain import AgentMessage, ModelRequest, ToolDefinition
from .base import ModelProviderError


def flag(status: str, detail: str) -> dict[str, str]:
    return {"status": status, "source": "probe", "detail": detail}


async def probe_streaming(provider: Any) -> dict[str, str]:
    request = ModelRequest(messages=[AgentMessage(role="user", content="Reply with OK only.")], parameters={"max_output_tokens": 128})
    saw_text = False
    completed = False
    async with aclosing(provider.stream(request)) as events:
        async for event in events:
            if event.type == "text_delta" and event.delta:
                saw_text = True
            if event.type == "completed" and event.response and event.response.content.strip():
                completed = event.response.provider_metadata.get("finish_reason") not in {"length", "max_tokens", "MAX_TOKENS"}
    if saw_text and completed:
        return flag("supported", "已收到文本增量和完整结束事件，流式输出检测通过")
    return flag("unknown", "未同时收到文本增量和完整结束事件，无法确认流式输出支持")


async def probe_tools(provider: Any) -> dict[str, str]:
    token = uuid4().hex
    request = ModelRequest(
        messages=[AgentMessage(role="user", content=f"Call tuantuan_capability_echo once with token {token}. Do not answer in text.")],
        tools=[ToolDefinition(name="tuantuan_capability_echo", description="Diagnostic echo; only return a tool call, no operation is executed.", input_schema={"type": "object", "properties": {"token": {"type": "string"}}, "required": ["token"], "additionalProperties": False})],
        tool_choice="required", parameters={"max_output_tokens": 256},
    )
    response = await provider.generate(request)
    if len(response.tool_calls) == 1:
        call = response.tool_calls[0]
        if call.name == "tuantuan_capability_echo" and call.arguments == {"token": token}:
            return flag("supported", "已返回正确的工具名称与结构化参数；检测未执行任何工具")
    return flag("unknown", "未返回符合要求的工具调用，无法确认工具调用支持")


async def probe_capabilities(provider: Any, timeout: float) -> tuple[dict[str, Any], list[str]]:
    results = {}
    errors = []
    for name, label, probe in (("vision", "图片输入", provider.probe_vision), ("streaming", "流式输出", lambda: probe_streaming(provider)), ("tools", "工具调用", lambda: probe_tools(provider))):
        try:
            async with asyncio.timeout(timeout / 3):
                results[name] = await probe()
            results[name]["protocol"] = provider.name
        except TimeoutError:
            message = f"{label}检测超时，请重试"
            results[name] = flag("unknown", message)
            errors.append(message)
        except ModelProviderError as exc:
            message = f"{label}检测失败：{exc}"
            results[name] = flag("unknown", message)
            errors.append(message)
        except Exception:
            message = f"{label}检测失败，请确认服务配置后重试"
            results[name] = flag("unknown", message)
            errors.append(message)
    return results, errors
