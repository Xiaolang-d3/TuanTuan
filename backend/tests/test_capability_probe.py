import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.domain import ModelResponse, ModelStreamEvent, ToolCall
from app.models.base import ModelProviderError
from app.models.capability_probe import probe_capabilities, probe_streaming, probe_tools


def provider(events=()):
    async def stream(request):
        for event in events:
            yield event
    return SimpleNamespace(name="responses", stream=stream, probe_vision=AsyncMock(return_value={"status": "supported", "source": "probe", "detail": "image accepted"}))


@pytest.mark.parametrize("events,supported", [
    ([ModelStreamEvent(type="text_delta", delta="OK"), ModelStreamEvent(type="completed", response=ModelResponse(content="OK"))], True),
    ([ModelStreamEvent(type="completed", response=ModelResponse(content="OK"))], False),
    ([ModelStreamEvent(type="text_delta", delta="OK")], False),
    ([ModelStreamEvent(type="text_delta", delta="partial"), ModelStreamEvent(type="completed", response=ModelResponse(content="partial", provider_metadata={"finish_reason": "length"}))], False),
    ([], False),
])
def test_stream_requires_incremental_text_and_successful_completion(events, supported):
    result = asyncio.run(probe_streaming(provider(events)))
    assert result["status"] == ("supported" if supported else "unknown")


@pytest.mark.parametrize("mode", ["valid", "text", "wrong_name", "wrong_arguments"])
def test_tools_require_exact_structured_call_without_execution(mode):
    async def generate(request):
        assert request.tool_choice == "required"
        assert len(request.tools) == 1
        token = request.messages[0].content.split("token ")[1].split(".")[0]
        if mode == "text":
            return ModelResponse(content="I can call tools")
        return ModelResponse(tool_calls=[ToolCall(id="test", name="wrong" if mode == "wrong_name" else "tuantuan_capability_echo", arguments={"token": "wrong" if mode == "wrong_arguments" else token})])
    result = asyncio.run(probe_tools(SimpleNamespace(generate=generate)))
    assert result["status"] == ("supported" if mode == "valid" else "unknown")


def test_failed_image_does_not_skip_other_probes():
    item = provider([ModelStreamEvent(type="text_delta", delta="OK"), ModelStreamEvent(type="completed", response=ModelResponse(content="OK"))])
    item.probe_vision = AsyncMock(side_effect=ModelProviderError("provider_error", "bad image"))
    item.generate = AsyncMock(return_value=ModelResponse(content="not a tool call"))
    results, errors = asyncio.run(probe_capabilities(item, 1))
    assert results["vision"]["status"] == "unknown"
    assert results["streaming"]["status"] == "supported"
    assert results["tools"]["status"] == "unknown"
    assert len(errors) == 1
    item.generate.assert_awaited_once()


def test_timeout_closes_stream_and_preserves_other_results():
    closed = []
    async def stream(request):
        try:
            yield ModelStreamEvent(type="text_delta", delta="partial")
            await asyncio.sleep(10)
        finally:
            closed.append(True)
    item = provider()
    item.stream = stream
    item.generate = AsyncMock(return_value=ModelResponse(content="no call"))
    results, errors = asyncio.run(probe_capabilities(item, .03))
    assert results["vision"]["status"] == "supported"
    assert results["streaming"]["status"] == "unknown"
    assert "流式输出检测超时" in errors[0]
    assert closed == [True]
    item.generate.assert_awaited_once()
