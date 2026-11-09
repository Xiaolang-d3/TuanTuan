"""Detected protocol persistence, Responses reasoning replay/stream/effort and check hints."""
from __future__ import annotations

import asyncio
import json
import sqlite3
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from openai import APIStatusError

from app import db, secret_store
from app.agent import settings
from app.agent.model_catalog import get_profile_connection, record_detected_protocol
from app.api import model
from app.chat.ag_ui import event_stream
from app.db import DB_SCHEMA_VERSION, init_db
from app.domain import AgentMessage, ModelRequest, ModelResponse, ModelStreamEvent, ToolCall
from app.main import app
from app.model_protocol import connection_protocol_label
from app.models.auto_negotiating import AutoNegotiatingModelProvider, clear_protocol_cache, get_negotiated_model_protocol
from app.models.base import ModelProviderError
from app.models.configured import configure_model_provider
from app.models.factory import build_model_provider
from app.models.openai_responses import OpenAIResponsesProvider, clear_unsupported_option_cache
from api_client import create_authenticated_client


@pytest.fixture(autouse=True)
def _clean_caches():
    clear_protocol_cache()
    clear_unsupported_option_cache()
    yield
    clear_protocol_cache()
    clear_unsupported_option_cache()


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "catalog.db")
    monkeypatch.setattr(settings, "get_settings", lambda: SimpleNamespace(
        model_name="initial-model", model_base_url=None, model_protocol="auto", openai_api_key=None,
    ))
    monkeypatch.setattr(secret_store, "_MEMORY_SECRETS", {})
    init_db()
    authenticated = create_authenticated_client(app)
    yield authenticated
    authenticated.close()


def _create(client, name: str, protocol: str = "auto"):
    response = client.post("/agent/model-connections", json={
        "name": name, "model_base_url": f"https://{name}.example.test/v1",
        "model_protocol": protocol, "api_key": f"synthetic-{name}-key", "model_name": "grok-4.7",
    })
    assert response.status_code == 200, response.text
    catalog = response.json()
    connection = next(item for item in catalog["connections"] if item["name"] == name)
    profile = next(item for item in catalog["profiles"] if item["connection_id"] == connection["id"])
    return connection, profile


def _connection(client, connection_id: str) -> dict:
    return next(item for item in client.get("/agent/model-connections").json()["connections"] if item["id"] == connection_id)


class _Fake:
    def __init__(self, name: str, error: str | None = None) -> None:
        self.name, self.error = name, error
        self.models_url = f"https://{name}.example.test/models"

    async def check_connection(self) -> None:
        if self.error:
            raise ModelProviderError(self.error, "模型不支持 Chat Completions 协议")

    async def list_models(self) -> list[str]:
        if self.error:
            raise ModelProviderError(self.error, "模型不支持 Chat Completions 协议")
        return ["grok-4.7"]


# --- 1. migration -----------------------------------------------------------

def test_v27_database_upgrades_to_current_schema_with_backup(tmp_path):
    path = tmp_path / "tuantuan.db"
    init_db(path)
    with sqlite3.connect(path) as conn:
        conn.execute("ALTER TABLE model_connections DROP COLUMN detected_protocol")
        conn.execute("ALTER TABLE model_profiles DROP COLUMN reasoning_effort")
        conn.execute("DELETE FROM schema_migrations")
        conn.execute("INSERT INTO schema_migrations (version, name) VALUES (27, 'independent_library')")
    init_db(path)
    with sqlite3.connect(path) as conn:
        assert "detected_protocol" in {row[1] for row in conn.execute("PRAGMA table_info(model_connections)")}
        assert "reasoning_effort" in {row[1] for row in conn.execute("PRAGMA table_info(model_profiles)")}
        assert conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == DB_SCHEMA_VERSION
    assert (tmp_path / ".upgrade-backups" / f"before-schema-v{DB_SCHEMA_VERSION}" / "tuantuan.db").exists()


# --- 1. detected protocol ---------------------------------------------------

def test_detected_protocol_is_persisted_exposed_and_cleared_on_wire_changes(client):
    connection, profile = _create(client, "gateway")
    assert connection["detected_protocol"] is None
    bound = get_profile_connection(profile["id"])
    assert record_detected_protocol(bound, "responses") is True
    exposed = _connection(client, connection["id"])
    assert exposed["detected_protocol"] == "responses"
    assert exposed["protocol_label"] == "自动 · 实际使用 OpenAI Responses API"
    assert get_profile_connection(profile["id"])["detected_protocol"] == "responses"

    renamed = client.patch(f"/agent/model-connections/{connection['id']}", json={"name": "renamed", "expected_revision": exposed["revision"]})
    assert renamed.status_code == 200
    exposed = _connection(client, connection["id"])
    assert exposed["detected_protocol"] == "responses", "a rename keeps the detection"

    rekeyed = client.patch(f"/agent/model-connections/{connection['id']}", json={"api_key": "synthetic-new-key", "expected_revision": exposed["revision"]})
    assert rekeyed.status_code == 200
    exposed = _connection(client, connection["id"])
    assert exposed["detected_protocol"] is None, "a new key clears the detection"

    assert record_detected_protocol(get_profile_connection(profile["id"]), "responses")
    exposed = _connection(client, connection["id"])
    explicit = client.patch(f"/agent/model-connections/{connection['id']}", json={"model_protocol": "openai", "expected_revision": exposed["revision"]})
    assert explicit.status_code == 200
    assert _connection(client, connection["id"])["detected_protocol"] is None


def test_stale_detection_from_an_old_address_is_ignored(client):
    connection, profile = _create(client, "stale")
    bound = get_profile_connection(profile["id"])
    exposed = _connection(client, connection["id"])
    moved = client.patch(f"/agent/model-connections/{connection['id']}", json={
        "model_base_url": "https://moved.example.test/v1", "api_key": "synthetic-moved", "expected_revision": exposed["revision"],
    })
    assert moved.status_code == 200
    assert record_detected_protocol(bound, "responses") is False
    assert _connection(client, connection["id"])["detected_protocol"] is None


def test_connection_check_records_negotiated_protocol(client, monkeypatch):
    connection, profile = _create(client, "negotiate")

    def factory(**kwargs):
        return AutoNegotiatingModelProvider(
            [("openai", _Fake("openai", "protocol_unsupported")), ("responses", _Fake("responses"))],
            "negotiate-key", preferred=kwargs.get("detected_protocol"), on_protocol_detected=kwargs.get("on_protocol_detected"),
        )

    monkeypatch.setattr(model, "build_model_provider", factory)
    result = client.post(f"/agent/model-connections/{connection['id']}/check").json()
    assert result["available"] is True
    assert _connection(client, connection["id"])["detected_protocol"] == "responses"
    assert get_profile_connection(profile["id"])["detected_protocol"] == "responses"


def test_detected_protocol_is_first_candidate_after_restart():
    provider = build_model_provider(
        api_key="key", model="grok-4.7", base_url="https://gateway.example.test/v1", protocol="auto", detected_protocol="responses",
    )
    assert provider.name == "responses"
    assert get_negotiated_model_protocol("grok-4.7", "auto", "https://gateway.example.test/v1", "key") == "responses"
    explicit = build_model_provider(api_key="key", model="grok-4.7", base_url="https://gateway.example.test/v1", protocol="openai", detected_protocol="responses")
    assert explicit.name == "openai"


def test_protocol_labels():
    assert connection_protocol_label("auto", "responses") == "自动 · 实际使用 OpenAI Responses API"
    assert connection_protocol_label("openai", "responses") == "OpenAI 兼容 Chat Completions"
    assert connection_protocol_label("auto", None, "gpt-5").startswith("自动 · 优先 ")


def test_monitor_and_capabilities_show_detected_label(client):
    connection, profile = _create(client, "monitor")
    client.post("/agent/model-default", json={"profile_id": profile["id"]})
    record_detected_protocol(get_profile_connection(profile["id"]), "responses")
    monitor = client.get("/agent/model-monitor").json()
    assert monitor["protocol_label"] == "自动 · 实际使用 OpenAI Responses API"
    assert monitor["detected_protocol"] == "responses"
    capabilities = client.get("/agent/models/capabilities").json()
    assert capabilities["protocol"] == "responses"
    assert capabilities["protocol_label"] == "自动 · 实际使用 OpenAI Responses API"
    assert client.get("/agent/settings").json()["detected_model_protocol"] == "responses"


# --- 4. check-failure hint --------------------------------------------------

def test_explicit_openai_check_failure_suggests_responses(client, monkeypatch):
    connection, _profile = _create(client, "explicit", protocol="openai")
    monkeypatch.setattr(model, "build_model_provider", lambda **_: _Fake("openai", "protocol_unsupported"))
    result = client.post(f"/agent/model-connections/{connection['id']}/check").json()
    assert result["available"] is False
    assert result["check_error_code"] == "protocol_unsupported"
    assert result["suggested_protocol"] == "responses"
    discovered = client.post(f"/agent/model-connections/{connection['id']}/discover")
    assert discovered.status_code == 400
    assert discovered.json()["detail"]["suggested_protocol"] == "responses"
    assert discovered.json()["detail"]["message"]


def test_auto_or_other_errors_do_not_suggest_a_switch(client, monkeypatch):
    connection, _profile = _create(client, "noswitch", protocol="openai")
    monkeypatch.setattr(model, "build_model_provider", lambda **_: _Fake("openai", "authentication_failed"))
    assert client.post(f"/agent/model-connections/{connection['id']}/check").json()["suggested_protocol"] is None
    auto, _ = _create(client, "autoswitch")
    monkeypatch.setattr(model, "build_model_provider", lambda **_: _Fake("openai", "protocol_unsupported"))
    assert client.post(f"/agent/model-connections/{auto['id']}/check").json()["suggested_protocol"] is None


# --- 3. per-profile reasoning effort ---------------------------------------

def test_profile_reasoning_effort_round_trips_and_validates(client):
    _connection_record, profile = _create(client, "effort")
    assert profile["reasoning_effort"] is None
    updated = client.patch(f"/agent/model-profiles/{profile['id']}", json={"reasoning_effort": "high", "expected_revision": profile["revision"]})
    assert updated.status_code == 200
    saved = next(item for item in updated.json()["profiles"] if item["id"] == profile["id"])
    assert saved["reasoning_effort"] == "high"
    assert get_profile_connection(profile["id"])["reasoning_effort"] == "high"
    assert client.patch(f"/agent/model-profiles/{profile['id']}", json={"reasoning_effort": "max", "expected_revision": saved["revision"]}).status_code == 422
    cleared = client.patch(f"/agent/model-profiles/{profile['id']}", json={"reasoning_effort": None, "expected_revision": saved["revision"]})
    assert next(item for item in cleared.json()["profiles"] if item["id"] == profile["id"])["reasoning_effort"] is None


def test_configured_provider_applies_profile_effort():
    seen = []

    class Recorder:
        name = "responses"

        async def generate(self, request):
            seen.append(request.reasoning_effort)
            return ModelResponse()

    provider = configure_model_provider(Recorder(), {}, "medium")
    asyncio.run(provider.generate(ModelRequest(messages=[AgentMessage(role="user", content="hi")])))
    assert seen == ["medium"]


# --- 2/3. Responses provider -------------------------------------------------

def _bad_request(message: str) -> APIStatusError:
    error = APIStatusError(message, response=SimpleNamespace(status_code=400, headers={}, request=None), body={"error": {"message": message}})
    error.status_code = 400
    return error


def _completed(output, text="好"):
    return SimpleNamespace(id="resp", model="grok-4.7", status="completed", output_text=text, output=output,
                           usage=SimpleNamespace(input_tokens=1, output_tokens=1, total_tokens=2))


def _provider(model_name="grok-4.7"):
    return OpenAIResponsesProvider(api_key="test-key", model=model_name, base_url="https://gateway.example.test/v1")


def test_responses_requests_encrypted_reasoning_and_effort(monkeypatch):
    provider = _provider()
    create = AsyncMock(return_value=_completed([]))
    monkeypatch.setattr(provider._client.responses, "create", create)
    asyncio.run(provider.generate(ModelRequest(messages=[AgentMessage(role="user", content="hi")], reasoning_effort="high")))
    arguments = create.await_args.kwargs
    assert arguments["store"] is False
    assert arguments["include"] == ["reasoning.encrypted_content"]
    assert arguments["reasoning"] == {"effort": "high", "summary": "auto"}
    asyncio.run(provider.generate(ModelRequest(messages=[AgentMessage(role="user", content="hi")])))
    assert "reasoning" not in create.await_args.kwargs


def test_rejected_include_and_reasoning_are_retried_without_and_remembered(monkeypatch):
    provider = _provider("plain-model")
    create = AsyncMock(side_effect=[
        _bad_request("Unknown parameter: include"),
        _bad_request("Unsupported parameter: 'reasoning.effort' is not supported with this model."),
        _completed([]),
        _completed([]),
    ])
    monkeypatch.setattr(provider._client.responses, "create", create)
    request = ModelRequest(messages=[AgentMessage(role="user", content="hi")], reasoning_effort="low")
    assert asyncio.run(provider.generate(request)).content == "好"
    final = create.await_args_list[2].kwargs
    assert "include" not in final and "reasoning" not in final
    again = _provider("plain-model")
    monkeypatch.setattr(again._client.responses, "create", create)
    asyncio.run(again.generate(request))
    assert create.await_count == 4, "a remembered rejection is not retried"
    remembered = create.await_args_list[3].kwargs
    assert "include" not in remembered and "reasoning" not in remembered


def test_unrelated_bad_request_is_not_retried(monkeypatch):
    provider = _provider()
    create = AsyncMock(side_effect=_bad_request("invalid api key"))
    monkeypatch.setattr(provider._client.responses, "create", create)
    with pytest.raises(ModelProviderError):
        asyncio.run(provider.generate(ModelRequest(messages=[AgentMessage(role="user", content="hi")])))
    assert create.await_count == 1


def test_reasoning_items_are_captured_and_replayed_before_function_calls(monkeypatch):
    provider = _provider()
    output = [
        {"type": "reasoning", "id": "rs_1", "encrypted_content": "enc-1", "summary": [{"type": "summary_text", "text": "先查资料"}]},
        {"type": "reasoning", "id": "rs_unencrypted", "summary": []},
        SimpleNamespace(type="function_call", id="fc_1", call_id="call_1", name="lookup", arguments="{}"),
    ]
    monkeypatch.setattr(provider._client.responses, "create", AsyncMock(return_value=_completed(output, "")))
    response = asyncio.run(provider.generate(ModelRequest(messages=[AgentMessage(role="user", content="hi")])))
    items = response.provider_metadata["responses_reasoning_items"]
    assert items == [{"type": "reasoning", "id": "rs_1", "encrypted_content": "enc-1", "summary": [{"type": "summary_text", "text": "先查资料"}]}]
    assert response.provider_metadata["reasoning_summary"] == "先查资料"

    assistant = AgentMessage(role="assistant", content="我来查", payload={
        "tool_calls": [{"id": "call_1", "name": "lookup", "arguments": {}}], "responses_reasoning_items": items,
    })
    converted = OpenAIResponsesProvider._convert_input_message(assistant)
    assert [item.get("type", item.get("role")) for item in converted] == ["reasoning", "assistant", "function_call"]
    assert converted[0]["encrypted_content"] == "enc-1"


def test_stream_emits_reasoning_deltas(monkeypatch):
    provider = _provider()
    completed = _completed([], "答")

    class Stream:
        def __aiter__(self):
            async def events():
                yield SimpleNamespace(type="response.reasoning_summary_text.delta", delta="想")
                yield SimpleNamespace(type="response.reasoning_summary_part.added", summary_index=1)
                yield SimpleNamespace(type="response.reasoning_text.delta", delta="再想")
                yield SimpleNamespace(type="response.output_text.delta", delta="答")
                yield SimpleNamespace(type="response.completed", response=completed)
            return events()

        async def close(self):
            return None

    monkeypatch.setattr(provider._client.responses, "create", AsyncMock(return_value=Stream()))

    async def collect():
        return [event async for event in provider.stream(ModelRequest(messages=[AgentMessage(role="user", content="hi")]))]

    events = asyncio.run(collect())
    assert [(event.type, event.delta) for event in events[:-1]] == [
        ("reasoning_delta", "想"), ("reasoning_delta", "\n\n"), ("reasoning_delta", "再想"), ("text_delta", "答"),
    ]


# --- 2/3. runtime and AG-UI -------------------------------------------------

def test_runtime_persists_reasoning_items_and_streams_reasoning():
    from app.agent.runtime import AgentRuntime
    from app.domain import ToolDefinition, ToolResult
    from app.models import ModelProviderRegistry
    from app.tools import ToolRegistry

    items = [{"type": "reasoning", "id": "rs_1", "encrypted_content": "enc", "summary": []}]

    class Model:
        name = "reasoning-model"

        def __init__(self) -> None:
            self.requests = []
            self.responses = [
                ModelResponse(tool_calls=[ToolCall(id="call-1", name="get_library_context", arguments={})],
                              provider_metadata={"responses_reasoning_items": items}),
                ModelResponse(content="完成"),
            ]

        async def generate(self, request):
            self.requests.append(request)
            return self.responses.pop(0)

        async def stream(self, request):
            self.requests.append(request)
            response = self.responses.pop(0)
            yield ModelStreamEvent(type="reasoning_delta", delta="思考中")
            yield ModelStreamEvent(type="completed", response=response)

    class Tool:
        definition = ToolDefinition(name="get_library_context", description="读取", input_schema={"type": "object"})

        async def execute(self, arguments, context):
            return ToolResult(ok=True, status="done", message="完成")

    model_instance = Model()
    models = ModelProviderRegistry()
    models.register(model_instance.name, model_instance)
    tools = ToolRegistry()
    tools.register_handler(Tool())
    runtime = AgentRuntime(models=models, tools=tools, model_provider=model_instance.name, platform_name="test", max_tool_rounds=4)

    async def collect():
        return [event async for event in runtime.run_stream("根据我的知识库回答")]

    events = asyncio.run(collect())
    assert [event.delta for event in events if event.type == "reasoning_delta"] == ["思考中", "思考中"]
    final_request = model_instance.requests[-1]
    assistant = next(message for message in final_request.messages if message.role == "assistant" and message.payload.get("tool_calls"))
    assert assistant.payload["responses_reasoning_items"] == items
    result = events[-1].result
    assert any(event.tool_name == "agent_thinking" and event.message == "思考中" for event in result.events)


def test_ag_ui_wraps_reasoning_deltas_in_reasoning_messages():
    from ag_ui.core import RunAgentInput

    async def collect():
        queue: asyncio.Queue = asyncio.Queue()
        for item in [("reasoning_delta", {"delta": "想"}), ("reasoning_delta", {"delta": "法"}), ("text_delta", {"delta": "答"}), None]:
            await queue.put(item)
        worker = asyncio.get_running_loop().create_future()
        worker.set_result(None)
        run_input = RunAgentInput(thread_id="t", run_id="r", state={}, messages=[], tools=[], context=[], forwarded_props={})
        return [chunk async for chunk in event_stream(queue, worker, run_input, None)]

    chunks = asyncio.run(collect())
    types = [json.loads(chunk.split("data: ", 1)[1])["type"] for chunk in chunks]
    assert types == [
        "REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_CONTENT",
        "REASONING_MESSAGE_END", "REASONING_END", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT",
    ]
