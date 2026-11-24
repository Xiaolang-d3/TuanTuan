from __future__ import annotations

import asyncio
import json
from collections import deque
from contextlib import aclosing

import httpx
import pytest

from app.domain.agent import AgentMessage, ModelRequest, ToolDefinition
from app.models import chatgpt_subscription
from app.models.base import ModelProviderError
from app.models.catalog_discovery import DiscoveredModels

_TOKEN = "fake-subscription-token.first"
_NEW_TOKEN = "fake-subscription-token.second"
_MODEL = "gpt-test-model"
_STREAM_HEADERS = {"Content-Type": "text/event-stream; charset=utf-8"}
_REQUEST = ModelRequest(messages=[AgentMessage(role="user", content="你好")])


@pytest.fixture
def mocked_connection(monkeypatch):
    calls = []
    options = []
    tokens = deque([_TOKEN])
    responses = deque()
    real_client = httpx.AsyncClient

    def handler(request):
        calls.append(request)
        next_response = responses.popleft()
        if isinstance(next_response, Exception):
            raise next_response
        return next_response

    def make_client(**kwargs):
        options.append(kwargs)
        return real_client(**kwargs, transport=httpx.MockTransport(handler))

    async def token():
        return tokens.popleft()

    monkeypatch.setattr(chatgpt_subscription.httpx, "AsyncClient", make_client)
    provider = chatgpt_subscription.ChatGPTSubscriptionProvider(model=_MODEL, access_token=token, timeout_seconds=15)
    return provider, calls, options, tokens, responses


def _event(kind, **payload):
    return f"event: {kind}\r\ndata: {json.dumps({'type': kind, **payload}, ensure_ascii=False)}\r\n\r\n"


def _completed(output=None, **kwargs):
    return _event("response.completed", response={"status": "completed", "output": output or [], **kwargs})


def _text(text):
    return {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": text}]}


def _stream(wire):
    return httpx.Response(200, headers=_STREAM_HEADERS, content=wire.encode())


async def _events(provider, request=_REQUEST):
    return [event async for event in provider.stream(request)]


def test_direct_stream_pins_endpoint_and_emits_terminal_metadata(mocked_connection):
    provider, calls, options, tokens, responses = mocked_connection
    responses.append(_stream(
        ": keepalive\r\n\r\n"
        "event: response.output_text.delta\r\ndata: {\r\ndata: \"delta\": \"你\"}\r\n\r\n"
        + _event("response.output_text.delta", delta="好！")
        + _completed([_text("你好！")], usage={"input_tokens": 8, "output_tokens": 3, "total_tokens": 11})
    ))
    request = ModelRequest(
        messages=[AgentMessage(role="system", content="Say hello."), *_REQUEST.messages],
        parameters={"temperature": 0.5, "max_output_tokens": 64, "top_p": 0.7, "metadata": 1},
        reasoning_effort="low",
    )
    events = asyncio.run(_events(provider, request))
    assert [(event.type, event.delta) for event in events] == [("text_delta", "你"), ("text_delta", "好！"), ("completed", "")]
    assert events[-1].response.content == "你好！"
    assert events[-1].response.usage.total_tokens == 11
    assert events[-1].response.output_blocks == [{"type": "text", "text": "你好！"}]
    assert events[-1].response.provider_metadata["protocol"] == provider.name
    assert options == [{"follow_redirects": False, "timeout": 15, "trust_env": False}]
    assert len(calls) == 1 and not tokens
    call = calls[0]
    assert str(call.url) == "https://api.openai.com/v1/responses" and call.method == "POST"
    assert call.headers["authorization"] == f"Bearer {_TOKEN}"
    assert call.headers["content-type"] == "application/json"
    assert call.headers["accept"] == "text/event-stream"
    assert json.loads(call.content) == {
        "model": _MODEL, "store": False, "stream": True,
        "input": [{"role": "developer", "content": "Say hello."}, {"role": "user", "content": "你好"}],
    }


def test_account_catalog_filters_preserves_order_and_reloads_token(mocked_connection):
    provider, calls, _, tokens, responses = mocked_connection
    tokens.append(_NEW_TOKEN)
    responses.extend([
        httpx.Response(200, json={"models": [
            {"visibility": "list", "slug": "z-model", "display_name": "First shown"},
            {"visibility": "hidden", "slug": "hidden-model", "display_name": "Hidden"},
            {"slug": "no-visibility"},
            {"visibility": "list", "slug": "a-model", "display_name": _TOKEN},
            {"visibility": "list", "slug": _TOKEN, "display_name": "Do not publish"},
            {"visibility": "list", "slug": "z-model"},
            {"visibility": "list", "id": "wrong-key"},
        ]}),
        httpx.Response(200, json={"models": []}),
    ])

    async def check():
        catalog = await provider.list_models()
        await provider.check_connection()
        return catalog

    catalog = asyncio.run(check())
    assert isinstance(catalog, DiscoveredModels)
    assert catalog == ["z-model", "a-model"]
    assert [entry["id"] for entry in catalog.entries] == list(catalog)
    assert catalog.entries[0]["display_name"] == "First shown"
    assert catalog.entries[0]["input_types"] == ["text"]
    assert _TOKEN not in repr(catalog.entries)
    assert [(call.method, str(call.url), call.headers["authorization"]) for call in calls] == [
        ("GET", "https://api.openai.com/v1/models", f"Bearer {token}") for token in [_TOKEN, _NEW_TOKEN]
    ]


def test_generate_uses_completed_stream_without_second_request(mocked_connection):
    provider, calls, _, _, responses = mocked_connection
    responses.append(_stream(_event("response.output_text.delta", delta="Hel") + _completed([_text("Hello")])))
    result = asyncio.run(provider.generate(_REQUEST))
    assert result.content == "Hello"
    assert len(calls) == 1


def test_namespaced_local_function_round_trip_without_remote_state(mocked_connection):
    provider, calls, _, tokens, responses = mocked_connection
    tokens.append(_NEW_TOKEN)
    responses.extend([
        _stream(_completed([
            {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque", "summary": [{"text": "do not copy"}]},
            {"type": "function_call", "namespace": "workspace", "call_id": "call_1", "name": "lookup", "arguments": '{"key":"北京"}'},
        ])),
        _stream(_completed([_text("Result found.")])),
    ])
    tool = ToolDefinition(name="lookup", description="Look up a document", input_schema={"type": "object"})

    async def round_trip():
        first = await provider.generate(ModelRequest(messages=_REQUEST.messages, tools=[tool], tool_choice="required"))
        assistant = AgentMessage(role="assistant", payload={
            "tool_calls": [call.model_dump() for call in first.tool_calls],
            "responses_reasoning_items": first.provider_metadata["responses_reasoning_items"],
        })
        tool_result = AgentMessage(role="tool", tool_call_id="call_1", payload={"found": True})
        second = await provider.generate(ModelRequest(messages=[*_REQUEST.messages, assistant, tool_result], tools=[tool], tool_choice="none"))
        return first, second

    first, second = asyncio.run(round_trip())
    assert first.tool_calls[0].model_dump() == {"id": "call_1", "name": "lookup", "arguments": {"key": "北京"}}
    assert second.content == "Result found."
    first_body, second_body = [json.loads(call.content) for call in calls]
    assert first_body["tool_choice"] == "required"
    assert first_body["tools"][0]["type"] == "namespace"
    assert first_body["tools"][0]["name"] == "workspace"
    assert first_body["tools"][0]["tools"] == [{
        "type": "function", "name": "lookup", "description": "Look up a document",
        "parameters": {"type": "object"}, "strict": False,
    }]
    assert first_body["include"] == ["reasoning.encrypted_content"]
    assert "tools" not in second_body and "previous_response_id" not in second_body
    assert second_body["input"][1:] == [
        {"type": "reasoning", "id": "rs_1", "encrypted_content": "opaque", "summary": []},
        {"type": "function_call", "namespace": "workspace", "name": "lookup", "call_id": "call_1", "arguments": '{"key": "北京"}'},
        {"type": "function_call_output", "call_id": "call_1", "output": '{"found": true}'},
    ]


@pytest.mark.parametrize(("tail", "code"), [
    ("", "incomplete_provider_response"),
    ("data: [DONE]\n\n", "incomplete_provider_response"),
    (_event("response.incomplete", response={"status": "incomplete"}), "incomplete_provider_response"),
    (_event("response.failed", response={"error": {"code": "subscription_sharing_usage_limit_exceeded", "message": _TOKEN}}), "subscription_sharing_usage_limit_exceeded"),
    (_event("error", code="unrecognized", message=_TOKEN), "provider_error"),
    (f"data: {{unparseable {_TOKEN}}}\n\n", "invalid_provider_response"),
    (_event("response.completed", response={"status": "failed", "output": []}), "invalid_provider_response"),
])
def test_failed_or_interrupted_stream_never_reports_completion(mocked_connection, tail, code):
    provider, calls, _, _, responses = mocked_connection
    responses.append(_stream(_event("response.output_text.delta", delta="partial") + tail))
    observed = []

    async def collect():
        async for event in provider.stream(_REQUEST):
            observed.append(event.type)

    with pytest.raises(ModelProviderError) as raised:
        asyncio.run(collect())
    assert raised.value.code == code
    assert not raised.value.retryable and not raised.value.retry_safe
    assert _TOKEN not in str(raised.value)
    assert observed == ["text_delta"]
    assert len(calls) == 1


@pytest.mark.parametrize(("status", "body", "code"), [
    (401, {"detail": f"invalid credential {_TOKEN}"}, "authentication_failed"),
    (403, {"error": {"code": "subscription_sharing_user_not_eligible", "message": _TOKEN}}, "subscription_sharing_user_not_eligible"),
    (503, {"detail": "subscription_sharing_usage_unavailable"}, "subscription_sharing_usage_unavailable"),
    (429, {"error": {"code": _TOKEN}}, "rate_limited"),
    (307, {"detail": _TOKEN}, "route_not_found"),
])
def test_http_failures_are_sanitized_and_never_redirect_or_retry(mocked_connection, status, body, code):
    provider, calls, _, _, responses = mocked_connection
    responses.append(httpx.Response(status, json=body, headers={"location": f"https://example.invalid/{_TOKEN}"}))
    with pytest.raises(ModelProviderError) as raised:
        asyncio.run(provider.generate(_REQUEST))
    assert raised.value.code == code
    assert _TOKEN not in str(raised.value) and _TOKEN not in raised.value.code
    assert not raised.value.retryable and not raised.value.retry_safe
    assert len(calls) == 1


def test_token_callback_error_never_opens_network(monkeypatch):
    async def token():
        raise ModelProviderError("chatgpt_reauthorization_required", "请重新授权。")

    def unexpected_client(**_kwargs):
        pytest.fail("OAuth error must not open an HTTP client")

    monkeypatch.setattr(chatgpt_subscription.httpx, "AsyncClient", unexpected_client)
    provider = chatgpt_subscription.ChatGPTSubscriptionProvider(model=_MODEL, access_token=token)
    with pytest.raises(ModelProviderError) as raised:
        asyncio.run(provider.generate(_REQUEST))
    assert raised.value.code == "chatgpt_reauthorization_required"


@pytest.mark.parametrize("overrides", [
    {"image_generation": True},
    {"messages": [AgentMessage(role="user", payload={"image_urls": ["data:image/png;base64,test"]})]},
    {"response_format": {"type": "json_object"}},
    {"parameters": {"background": 1}},
])
def test_unsupported_features_reject_before_fetching_token(mocked_connection, overrides):
    provider, calls, _, tokens, _ = mocked_connection
    request = _REQUEST.model_copy(update=overrides)
    with pytest.raises(ModelProviderError, match="ChatGPT") as raised:
        asyncio.run(provider.generate(request))
    assert raised.value.code == "subscription_sharing_unsupported_capability"
    assert not calls and list(tokens) == [_TOKEN]


def test_transport_failure_redacts_detail_and_prevents_automatic_retry(mocked_connection):
    provider, calls, _, _, responses = mocked_connection
    responses.append(httpx.ReadTimeout(f"Timeout with {_TOKEN}"))
    with pytest.raises(ModelProviderError) as raised:
        asyncio.run(provider.generate(_REQUEST))
    assert raised.value.code == "request_timeout"
    assert _TOKEN not in str(raised.value) and raised.value.__suppress_context__
    assert not raised.value.retryable and not raised.value.retry_safe
    assert len(calls) == 1


@pytest.mark.parametrize("namespace", [None, "another_namespace"])
def test_only_approved_namespaced_function_calls_can_be_forwarded(mocked_connection, namespace):
    provider, _, _, _, responses = mocked_connection
    responses.append(_stream(_completed([
        {"type": "function_call", "namespace": namespace, "name": "lookup", "call_id": "call_1", "arguments": "{}"},
    ])))
    tool = ToolDefinition(name="lookup", description="Look up a document", input_schema={"type": "object"})
    with pytest.raises(ModelProviderError) as raised:
        asyncio.run(provider.generate(ModelRequest(messages=_REQUEST.messages, tools=[tool])))
    assert raised.value.code == "invalid_provider_response"


def test_missing_account_catalog_shape_is_not_a_successful_health_check(mocked_connection):
    provider, _, _, _, responses = mocked_connection
    responses.append(httpx.Response(200, json={"data": [{"id": "an-api-key-catalog"}]}))
    with pytest.raises(ModelProviderError) as raised:
        asyncio.run(provider.check_connection())
    assert raised.value.code == "invalid_provider_response"


def test_success_status_with_non_stream_response_is_rejected(mocked_connection):
    provider, _, _, _, responses = mocked_connection
    responses.append(httpx.Response(200, json={"status": "completed", "output": [_text("non-streaming")]}))
    with pytest.raises(ModelProviderError) as raised:
        asyncio.run(provider.generate(_REQUEST))
    assert raised.value.code == "invalid_provider_response"


def test_disconnect_closes_upstream_response(mocked_connection):
    provider, _, _, _, responses = mocked_connection

    class Stream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self):
            yield _event("response.output_text.delta", delta="partial").encode()
            pytest.fail("Cancelled reader must not advance the stream")

        async def aclose(self):
            self.closed = True

    upstream = Stream()
    responses.append(httpx.Response(200, headers=_STREAM_HEADERS, stream=upstream))

    async def collect_one():
        async with aclosing(provider.stream(_REQUEST)) as events:
            assert (await anext(events)).type == "text_delta"

    asyncio.run(collect_one())
    assert upstream.closed
