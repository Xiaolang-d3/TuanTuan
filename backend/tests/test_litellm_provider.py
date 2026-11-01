"""LiteLLM model layer against a loopback fake server (no real network)."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import db
from app.domain import AgentMessage, ModelRequest, ToolCall, ToolDefinition
from app.models.base import ModelProviderError
from app.models.litellm_core import api_base_for, model_string
from app.models.litellm_provider import LiteLLMProvider, _original_response_id, clear_litellm_option_cache
from app.observability.model_monitor import get_model_monitor_snapshot
from fake_llm_server import FakeLLMServer


TOOL = ToolDefinition(
    name="search_library", description="搜索资料库",
    input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
)


def request(**overrides) -> ModelRequest:
    values = {"messages": [AgentMessage(role="user", content="你好")], "tools": [TOOL]}
    values.update(overrides)
    return ModelRequest(**values)


def run(coro):
    return asyncio.run(coro)


async def collect(provider, model_request):
    return [event async for event in provider.stream(model_request)]


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "litellm")
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "litellm.db")
    db.init_db()
    clear_litellm_option_cache()
    yield


@pytest.fixture
def server():
    with FakeLLMServer() as fake:
        yield fake


def body_options(entry):
    return {key: value for key, value in entry["body"].items() if key not in {"messages", "tools", "contents", "input", "system"}}


# --------------------------------------------------------------------- mapping
@pytest.mark.parametrize(("protocol", "expected"), [
    ("openai", "openai/m"), ("anthropic", "anthropic/m"), ("gemini", "gemini/m"),
    ("ollama", "ollama_chat/m"), ("responses", "openai/m"),
])
def test_model_string_per_protocol(protocol, expected):
    assert model_string(protocol, "m") == expected


def test_responses_bridge_and_base_urls():
    assert model_string("responses", "gpt-5", responses_bridge=True) == "openai/responses/gpt-5"
    assert api_base_for("anthropic", "https://gw.example.test/v1/") == "https://gw.example.test"
    assert api_base_for("ollama", "http://localhost:11434/api") == "http://localhost:11434"
    assert api_base_for("openai", "https://gw.example.test/v1") == "https://gw.example.test/v1"
    assert api_base_for("gemini", None) is None


def test_constructor_keeps_native_validation():
    with pytest.raises(ValueError):
        LiteLLMProvider(api_key="", model="m", base_url=None, protocol="openai")
    with pytest.raises(ValueError):
        LiteLLMProvider(api_key="k", model="m", protocol="made-up")
    provider = LiteLLMProvider(api_key="", model="qwen3", base_url="http://127.0.0.1:1", protocol="ollama")
    assert provider.name == "ollama"


# ------------------------------------------------------------- per protocol I/O
def test_openai_chat_generate_sends_effort_key_and_custom_base(server):
    provider = LiteLLMProvider("sk-openai", "deepseek-v3", f"{server.url}/v1", 10, protocol="openai")
    response = run(provider.generate(request(reasoning_effort="high", parameters={"temperature": 0.3, "max_output_tokens": 256})))
    sent = server.last()
    assert sent["path"] == "/v1/chat/completions"
    assert sent["headers"]["authorization"] == "Bearer sk-openai"
    assert sent["body"]["reasoning_effort"] == "high"
    assert sent["body"]["temperature"] == 0.3 and sent["body"]["max_tokens"] == 256
    assert sent["body"]["tools"][0]["function"]["name"] == "search_library"
    assert response.content == "你好"
    assert response.provider_metadata["reasoning_summary"] == "先想一想"
    assert response.provider_metadata["backend"] == "litellm"
    assert response.usage.total_tokens == 18


def test_openai_tool_calls_are_parsed(server):
    server.tool = True
    provider = LiteLLMProvider("sk", "deepseek-v3", f"{server.url}/v1", 10, protocol="openai")
    response = run(provider.generate(request()))
    assert response.tool_calls == [ToolCall(id="call_1", name="search_library", arguments={"query": "团团"})]


def test_openai_stream_text_reasoning_tools_and_usage(server):
    provider = LiteLLMProvider("sk", "deepseek-v3", f"{server.url}/v1", 10, protocol="openai")
    events = run(collect(provider, request()))
    assert [(e.type, e.delta) for e in events[:-1]] == [
        ("reasoning_delta", "先想"), ("reasoning_delta", "一想"), ("text_delta", "你"), ("text_delta", "好"),
    ]
    final = events[-1]
    assert final.type == "completed"
    assert final.response.content == "你好"
    assert final.response.tool_calls == [ToolCall(id="call_9", name="search_library", arguments={"query": "团团"})]
    assert final.response.usage.total_tokens == 29
    assert server.last()["body"]["stream"] is True


def test_anthropic_thinking_blocks_round_trip_across_tool_turn(server):
    server.tool = True
    provider = LiteLLMProvider("sk-ant", "claude-sonnet-4-5", server.url + "/v1", 10, protocol="anthropic")
    first = run(provider.generate(request(reasoning_effort="medium")))
    sent = server.last()
    assert sent["path"] == "/v1/messages"
    assert sent["headers"]["x-api-key"] == "sk-ant"
    assert sent["body"]["thinking"]["type"] in {"enabled", "adaptive"}
    # Prompt caching: the static system prompt is marked cacheable.
    assert sent["body"]["system"][0]["cache_control"] == {"type": "ephemeral"}
    blocks = first.provider_metadata["thinking_blocks"]
    assert blocks == [{"type": "thinking", "thinking": "需要查资料", "signature": "sig-abc"}]
    assert first.tool_calls[0].name == "search_library"
    assert first.provider_metadata["cost_usd"] > 0

    follow_up = request(messages=[
        AgentMessage(role="user", content="你好"),
        AgentMessage(role="assistant", content="", payload={
            "tool_calls": [{"id": "toolu_1", "name": "search_library", "arguments": {"query": "团团"}}],
            "thinking_blocks": blocks,
        }),
        AgentMessage(role="tool", content="{}", tool_call_id="toolu_1"),
    ], reasoning_effort="medium")
    server.tool = False
    run(provider.generate(follow_up))
    assistant = [m for m in server.last()["body"]["messages"] if m["role"] == "assistant"][0]
    assert assistant["content"][0] == {"type": "thinking", "thinking": "需要查资料", "signature": "sig-abc"}


def test_anthropic_stream_keeps_signed_thinking(server):
    provider = LiteLLMProvider("sk-ant", "claude-sonnet-4-5", server.url, 10, protocol="anthropic")
    events = run(collect(provider, request()))
    deltas = "".join(e.delta for e in events if e.type == "reasoning_delta")
    final = events[-1].response
    assert deltas == "需要查资料"
    assert final.provider_metadata["thinking_blocks"] == [{"type": "thinking", "thinking": "需要查资料", "signature": "sig-xyz"}]
    assert final.tool_calls and final.tool_calls[0].name == "search_library"


def test_gemini_generate_and_stream(server):
    provider = LiteLLMProvider("g-key", "gemini-2.5-flash", server.url, 10, protocol="gemini")
    response = run(provider.generate(request(reasoning_effort="low")))
    sent = server.last()
    assert sent["path"].startswith("/models/gemini-2.5-flash:generateContent")
    assert sent["headers"]["x-goog-api-key"] == "g-key"
    assert "thinkingConfig" in sent["body"]["generationConfig"]
    assert response.content == "你好" and response.provider_metadata["reasoning_summary"] == "思考中"
    events = run(collect(provider, request()))
    assert events[-1].response.tool_calls[0].arguments == {"query": "团团"}


def test_ollama_generate_and_stream_cost_zero(server):
    provider = LiteLLMProvider("", "qwen3", server.url, 10, protocol="ollama")
    response = run(provider.generate(request(tool_choice="required")))
    chat = [entry for entry in server.requests if entry["path"] == "/api/chat"][-1]
    assert "tool_choice" not in chat["body"]
    assert any("工具" in (m.get("content") or "") for m in chat["body"]["messages"] if m["role"] == "system")
    assert response.content == "你好" and response.provider_metadata["cost_usd"] == 0.0
    events = run(collect(provider, request()))
    assert events[-1].response.content == "你好"


def test_responses_encrypted_reasoning_round_trip(server):
    server.tool = True
    provider = LiteLLMProvider("sk-r", "gpt-5", f"{server.url}/v1", 10, protocol="responses")
    first = run(provider.generate(request(reasoning_effort="high")))
    sent = server.last()
    assert sent["path"] == "/v1/responses"
    assert sent["body"]["store"] is False
    assert sent["body"]["include"] == ["reasoning.encrypted_content"]
    assert sent["body"]["reasoning"] == {"effort": "high", "summary": "auto"}
    items = first.provider_metadata["responses_reasoning_items"]
    assert items[0]["encrypted_content"] == "enc-123"
    assert first.provider_metadata["response_id"] == "resp_1"
    assert first.tool_calls[0].id == "call_r1"

    server.tool = False
    run(provider.generate(request(messages=[
        AgentMessage(role="user", content="你好"),
        AgentMessage(role="assistant", content="", payload={
            "tool_calls": [{"id": "call_r1", "name": "search_library", "arguments": {"query": "团团"}}],
            "responses_reasoning_items": items,
        }),
        AgentMessage(role="tool", content="{}", tool_call_id="call_r1"),
    ])))
    replayed = [item for item in server.last()["body"]["input"] if item.get("type") == "reasoning"]
    assert replayed and replayed[0]["encrypted_content"] == "enc-123"


def test_responses_stream(server):
    provider = LiteLLMProvider("sk-r", "gpt-5", f"{server.url}/v1", 10, protocol="responses")
    events = run(collect(provider, request()))
    assert [(e.type, e.delta) for e in events[:-1]] == [("reasoning_delta", "先检索"), ("text_delta", "你"), ("text_delta", "好")]
    assert events[-1].response.content == "你好"
    assert events[-1].response.provider_metadata["responses_reasoning_items"][0]["encrypted_content"] == "enc-123"


def test_response_format_is_passed_through(server):
    schema = {"type": "json_schema", "json_schema": {"name": "r", "schema": {"type": "object", "properties": {"a": {"type": "string"}}}}}
    provider = LiteLLMProvider("sk", "gpt-4o", f"{server.url}/v1", 10, protocol="openai")
    run(provider.generate(request(response_format=schema, tools=[])))
    assert server.last()["body"]["response_format"]["type"] == "json_schema"


def test_original_response_id_decoding():
    import base64

    wrapped = "resp_" + base64.b64encode(b"litellm:custom_llm_provider:openai;model_id:None;response_id:resp_abc").decode()
    assert _original_response_id(wrapped) == "resp_abc"
    assert _original_response_id("resp_plain") == "resp_plain"
    assert _original_response_id("chatcmpl-1") == "chatcmpl-1"


# ---------------------------------------------------------------------- errors
@pytest.mark.parametrize(("status", "body", "code"), [
    (401, {"error": {"message": "invalid api key", "type": "invalid_request_error"}}, "authentication_failed"),
    (429, {"error": {"message": "slow down", "type": "rate_limit_error"}}, "rate_limited"),
    (400, {"error": {"message": "This model's maximum context length is 8192 tokens", "code": "context_length_exceeded"}}, "context_window_exceeded"),
    (400, {"error": {"message": "Your request was rejected by the content_policy", "code": "content_policy_violation"}}, "content_policy"),
    (503, {"error": {"message": "overloaded"}}, "service_unavailable"),
    (404, {"error": {"message": "The model `x` does not exist"}}, "model_unavailable"),
])
def test_errors_map_to_existing_codes(server, status, body, code):
    server.errors["/chat/completions"] = (status, body)
    provider = LiteLLMProvider("sk", "gpt-4o", f"{server.url}/v1", 10, protocol="openai")
    with pytest.raises(ModelProviderError) as caught:
        run(provider.generate(request()))
    assert caught.value.code == code
    assert any("\u4e00" <= ch <= "\u9fff" for ch in str(caught.value))  # Chinese message


def test_chat_completions_unsupported_maps_to_protocol_unsupported(server):
    server.errors["/chat/completions"] = (400, {"error": {"message": "This model only supports the Responses API; chat completions not supported"}})
    # (A model LiteLLM already knows as Responses-only, e.g. gpt-5-pro, would be
    # bridged automatically; use an unknown gateway model to see the raw rejection.)
    provider = LiteLLMProvider("sk", "gateway-pro-model", f"{server.url}/v1", 10, protocol="openai")
    with pytest.raises(ModelProviderError) as caught:
        run(provider.generate(request()))
    assert caught.value.code == "protocol_unsupported"


def test_unsupported_reasoning_effort_is_retried_without_it(server):
    calls = {"n": 0}
    original = server.errors

    class OnceErrors(dict):
        def items(self):
            calls["n"] += 1
            if calls["n"] == 1:
                return [("/chat/completions", (400, {"error": {"message": "Unrecognized request argument supplied: reasoning_effort"}}))]
            return []

    server.errors = OnceErrors()
    provider = LiteLLMProvider("sk", "gpt-4o", f"{server.url}/v1", 10, protocol="openai")
    response = run(provider.generate(request(reasoning_effort="high")))
    assert response.content == "你好"
    assert "reasoning_effort" not in server.last()["body"]
    server.errors = original


# ---------------------------------------------- connection and parse failures
PROTOCOL_BASES = {"openai": "/v1", "responses": "/v1", "anthropic": "", "gemini": "", "ollama": ""}
PROTOCOL_PATHS = {"openai": "/chat/completions", "responses": "/responses", "anthropic": "/messages",
                  "gemini": "generateContent", "ollama": "/api/chat"}


def _unused_port() -> int:
    import socket

    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@pytest.mark.parametrize("protocol", list(PROTOCOL_BASES))
@pytest.mark.parametrize("streaming", [False, True])
def test_connection_refused_maps_to_service_unavailable(protocol, streaming):
    # LiteLLM reports refused connections as a status-500 InternalServerError /
    # APIConnectionError; the httpx.ConnectError underneath decides.
    base = f"http://127.0.0.1:{_unused_port()}{PROTOCOL_BASES[protocol]}"
    provider = LiteLLMProvider("sk-test", "gpt-4o", base, 5, protocol=protocol)
    with pytest.raises(ModelProviderError) as caught:
        run(collect(provider, request()) if streaming else provider.generate(request()))
    assert caught.value.code == "service_unavailable"
    assert caught.value.retryable is True
    assert str(caught.value) == "无法连接模型服务，请检查网关地址或网络状态"


@pytest.mark.parametrize("protocol", list(PROTOCOL_BASES))
def test_malformed_json_maps_to_invalid_response_without_traceback(server, protocol):
    server.raw[PROTOCOL_PATHS[protocol]] = (200, b"{not json")
    provider = LiteLLMProvider("sk-test", "gpt-4o", f"{server.url}{PROTOCOL_BASES[protocol]}", 5, protocol=protocol)
    with pytest.raises(ModelProviderError) as caught:
        run(provider.generate(request()))
    assert caught.value.code == "invalid_provider_response"
    with db.connect() as conn:
        stored = [row[0] for row in conn.execute("SELECT error_message FROM model_service_events")]
    assert stored == ["模型服务返回了无法解析的响应"]


STREAM_PATHS = {**PROTOCOL_PATHS, "gemini": "streamGenerateContent"}


@pytest.mark.parametrize("protocol", list(PROTOCOL_BASES))
@pytest.mark.parametrize("streaming", [False, True])
def test_error_status_body_is_decoded_not_bytes_repr(server, protocol, streaming):
    # Anthropic/Gemini streaming errors used to show b'{"error": ...}'.
    path = STREAM_PATHS[protocol] if streaming else PROTOCOL_PATHS[protocol]
    server.raw[path] = (400, b'{"error": {"message": "field tools[0] is invalid"}}')
    provider = LiteLLMProvider("sk-test", "gpt-4o", f"{server.url}{PROTOCOL_BASES[protocol]}", 5, protocol=protocol)
    with pytest.raises(ModelProviderError) as caught:
        run(collect(provider, request()) if streaming else provider.generate(request()))
    assert str(caught.value) == "模型服务返回异常状态（400）：field tools[0] is invalid"


def test_error_detail_strips_litellm_wrappers():
    from app.models.litellm_core import get_litellm
    from app.models.litellm_errors import litellm_error_detail

    litellm = get_litellm()
    cases = {
        "InternalServerError: OpenAIException - upstream exploded": "upstream exploded",
        "upstream exploded. Handle with `litellm.InternalServerError`.": "upstream exploded",
        'GeminiException BadRequestError - {"error": {"message": "bad input"}}': "bad input",
        "Expecting value\nTraceback (most recent call last):\n  File \"x.py\", line 1": "Expecting value",
        "Unable to get json response - boom, Original Response: {not json": "Unable to get json response - boom",
        "AnthropicException - b'{\"error\": {\"message\": \"bad input\"}}'": "bad input",
        "b'plain \\xe4\\xbd\\xa0\\xe5\\xa5\\xbd'": "plain 你好",
    }
    for raw, expected in cases.items():
        exc = litellm.APIError(status_code=500, message=raw, llm_provider="openai", model="m")
        assert litellm_error_detail(exc) == expected, raw


# --------------------------------------------------------- monitor and cost
def test_monitor_records_backend_and_cost(server):
    provider = LiteLLMProvider("sk-ant", "claude-sonnet-4-5", server.url, 10, protocol="anthropic")
    run(provider.generate(request()))
    with db.connect() as conn:
        row = conn.execute("SELECT backend, cost_usd, status, protocol FROM model_service_events").fetchone()
    assert row["backend"] == "litellm" and row["status"] == "success" and row["protocol"] == "anthropic"
    assert row["cost_usd"] > 0
    snapshot = get_model_monitor_snapshot(connection={
        "model_name": "claude-sonnet-4-5", "model_base_url": server.url,
        "model_protocol": "anthropic", "resolved_model_protocol": "anthropic", "api_key": "sk-ant",
    })
    assert snapshot["summary"]["estimated_cost_usd"] == pytest.approx(row["cost_usd"])
    assert snapshot["summary"]["priced_requests"] == 1
    assert snapshot["recent_events"][0]["cost_usd"] == pytest.approx(row["cost_usd"])


def test_profile_prices_override_litellm_prices(server):
    provider = LiteLLMProvider(
        "sk-ant", "claude-sonnet-4-5", server.url, 10, protocol="anthropic",
        price_per_million_input=1.0, price_per_million_output=2.0,
    )
    response = run(provider.generate(request()))
    usage = response.usage
    assert response.provider_metadata["cost_usd"] == pytest.approx((usage.input_tokens * 1.0 + usage.output_tokens * 2.0) / 1_000_000)


def test_unknown_model_has_no_cost(server):
    provider = LiteLLMProvider("sk", "totally-unknown-model-x", f"{server.url}/v1", 10, protocol="openai")
    response = run(provider.generate(request()))
    assert "cost_usd" not in response.provider_metadata


def test_check_connection_and_probe_vision(server):
    provider = LiteLLMProvider("sk", "gpt-4o", f"{server.url}/v1", 10, protocol="openai")
    run(provider.check_connection())
    result = run(provider.probe_vision())
    assert result["status"] == "supported" and result["source"] == "probe"
    image_parts = [part for message in server.last()["body"]["messages"] if isinstance(message.get("content"), list) for part in message["content"] if part.get("type") == "image_url"]
    assert image_parts


def test_probe_vision_rejection_is_unsupported(server):
    server.errors["/chat/completions"] = (400, {"error": {"message": "This model does not support image input"}})
    provider = LiteLLMProvider("sk", "deepseek-chat", f"{server.url}/v1", 10, protocol="openai")
    result = run(provider.probe_vision())
    assert result["status"] == "unsupported"
