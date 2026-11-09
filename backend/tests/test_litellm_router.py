"""litellm.Router fallbacks, retries and cooldown against a loopback server."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import db
from app.agent.model_routing import DEFAULT_FALLBACK_POLICY
from app.domain import AgentMessage, ModelRequest
from app.models.base import ModelProviderError
from app.models.litellm_provider import LiteLLMProvider, clear_litellm_option_cache
from app.models.litellm_router import RouteTarget, RoutedModelProvider, build_routed_provider
from fake_llm_server import FakeLLMServer


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "litellm")
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "router.db")
    db.init_db()
    clear_litellm_option_cache()


@pytest.fixture
def server():
    with FakeLLMServer() as fake:
        yield fake


def target(server, name, protocol="openai", *, profile_id=None, effort=None, parameters=None):
    base = f"{server.url}/{name}/v1" if protocol in {"openai", "responses"} else f"{server.url}/{name}"
    provider = LiteLLMProvider(f"key-{name}", f"model-{name}", base, 10, protocol=protocol)
    identity = {"profile_id": profile_id or f"profile-{name}", "connection_id": f"conn-{name}",
                "profile_revision": 1, "connection_revision": 1, "model_name": f"model-{name}"}
    return RouteTarget(identity=identity, provider=provider, parameters=parameters or {}, reasoning_effort=effort)


def routed(primary, fallbacks, **policy):
    merged = json.loads(json.dumps(DEFAULT_FALLBACK_POLICY)) | {"enabled": True} | policy
    return RoutedModelProvider(
        primary=primary.provider, primary_identity=primary.identity,
        primary_parameters=primary.parameters, primary_reasoning_effort=primary.reasoning_effort,
        fallbacks=fallbacks, policy=merged,
    )


def request():
    return ModelRequest(messages=[AgentMessage(role="user", content="你好")])


def paths(server, prefix):
    return [entry for entry in server.requests if entry["path"].startswith(f"/{prefix}/")]


def events():
    with db.connect() as conn:
        return [dict(row) for row in conn.execute(
            "SELECT status, error_code, profile_id, fallback_from_profile_id, backend FROM model_service_events ORDER BY id"
        )]


def test_primary_answers_without_fallback(server):
    primary, backup = target(server, "primary"), target(server, "backup")
    response = run(routed(primary, {"general": [backup]}).generate(request()))
    assert response.provider_metadata["answered_profile_id"] == "profile-primary"
    assert "fallback_from_profile_id" not in response.provider_metadata
    assert not paths(server, "backup")
    assert events() == [{"status": "success", "error_code": "", "profile_id": "profile-primary", "fallback_from_profile_id": "", "backend": "litellm"}]


def test_general_fallback_answers_and_is_recorded(server):
    server.errors["/primary/"] = (503, {"error": {"message": "overloaded"}})
    primary = target(server, "primary", effort="high")
    backup = target(server, "backup", protocol="anthropic", effort="low", parameters={"max_output_tokens": 300})
    provider = routed(primary, {"general": [backup]})
    response = run(provider.generate(request()))
    assert response.content == "你好"
    assert response.provider_metadata["answered_profile_id"] == "profile-backup"
    assert response.provider_metadata["answered_model_name"] == "model-backup"
    assert response.provider_metadata["fallback_from_profile_id"] == "profile-primary"
    # Each deployment keeps its own options and credentials.
    assert paths(server, "primary")[0]["body"]["reasoning_effort"] == "high"
    backup_request = paths(server, "backup")[0]
    assert backup_request["path"] == "/backup/v1/messages"
    assert backup_request["headers"]["x-api-key"] == "key-backup"
    assert backup_request["body"]["max_tokens"] == 300
    recorded = events()
    assert recorded[0]["profile_id"] == "profile-primary" and recorded[0]["error_code"] == "fallback_used"
    assert recorded[1] == {"status": "success", "error_code": "", "profile_id": "profile-backup",
                           "fallback_from_profile_id": "profile-primary", "backend": "litellm"}


def test_context_window_error_uses_context_fallback_not_general(server):
    server.errors["/primary/"] = (400, {"error": {"message": "This model's maximum context length is 8192 tokens", "code": "context_length_exceeded"}})
    primary, general, long_context = target(server, "primary"), target(server, "general"), target(server, "long")
    provider = routed(primary, {"general": [general], "context_window": [long_context]})
    response = run(provider.generate(request()))
    assert response.provider_metadata["answered_profile_id"] == "profile-long"
    assert not paths(server, "general")


def test_content_policy_error_uses_content_fallback(server):
    server.errors["/primary/"] = (400, {"error": {
        "message": "Your request was rejected as a result of our safety system.",
        "type": "invalid_request_error", "code": "content_policy_violation",
    }})
    primary, safe = target(server, "primary"), target(server, "safe")
    response = run(routed(primary, {"content_policy": [safe]}).generate(request()))
    assert response.provider_metadata["answered_profile_id"] == "profile-safe"


def test_auth_error_without_matching_fallback_maps_code(server):
    server.errors["/primary/"] = (401, {"error": {"message": "bad key"}})
    server.errors["/backup/"] = (401, {"error": {"message": "bad key"}})
    primary, backup = target(server, "primary"), target(server, "backup")
    with pytest.raises(ModelProviderError) as caught:
        run(routed(primary, {"general": [backup]}).generate(request()))
    assert caught.value.code == "authentication_failed"


def test_retry_policy_retries_server_errors(server):
    server.errors["/primary/"] = (503, {"error": {"message": "overloaded"}})
    primary, backup = target(server, "primary"), target(server, "backup")
    provider = routed(primary, {"general": [backup]}, retry_policy={"timeout": 0, "rate_limit": 0, "server_error": 2})
    run(provider.generate(request()))
    assert len(paths(server, "primary")) >= 2


def test_cooldown_skips_failing_primary(server):
    server.errors["/primary/"] = (503, {"error": {"message": "overloaded"}})
    primary, backup = target(server, "primary"), target(server, "backup")
    provider = routed(primary, {"general": [backup]}, allowed_fails=1, cooldown_seconds=60)
    for _ in range(3):
        assert run_twice_safe(provider)["answered_profile_id"] == "profile-backup"
    # After the allowed failures the primary is cooled down and not called again.
    assert len(paths(server, "primary")) < 3


def run_twice_safe(provider):
    async def call():
        return (await provider.generate(request())).provider_metadata
    return asyncio.run(call())


def test_stream_with_fallback(server):
    server.errors["/primary/"] = (503, {"error": {"message": "overloaded"}})
    primary, backup = target(server, "primary"), target(server, "backup", protocol="anthropic")
    provider = routed(primary, {"general": [backup]})

    async def collect():
        return [event async for event in provider.stream(request())]

    collected = run(collect())
    assert "".join(e.delta for e in collected if e.type == "text_delta") == "好的"
    final = collected[-1].response
    assert final.provider_metadata["answered_profile_id"] == "profile-backup"
    assert final.provider_metadata["thinking_blocks"][0]["signature"] == "sig-xyz"


def test_responses_primary_uses_bridge_with_store_false(server):
    primary = target(server, "primary", protocol="responses", effort="high")
    backup = target(server, "backup")
    response = run(routed(primary, {"general": [backup]}).generate(request()))
    sent = paths(server, "primary")[0]
    assert sent["path"] == "/primary/v1/responses"
    assert sent["body"]["store"] is False
    assert "reasoning.encrypted_content" in sent["body"]["include"]
    assert response.provider_metadata["answered_profile_id"] == "profile-primary"


def test_unnegotiated_primary_bypasses_router(server):
    primary, backup = target(server, "primary"), target(server, "backup")

    class Unsettled:
        negotiated = False
        name = "openai"
        models_url = ""

        async def generate(self, model_request):
            return await primary.provider.generate(model_request)

    provider = RoutedModelProvider(
        primary=Unsettled(), primary_identity=primary.identity, primary_parameters={}, primary_reasoning_effort=None,
        fallbacks={"general": [backup]}, policy=DEFAULT_FALLBACK_POLICY | {"enabled": True},
    )
    response = run(provider.generate(request()))
    assert "routed" not in response.provider_metadata


def test_build_routed_provider_skips_invalid_profiles(server):
    primary = target(server, "primary")
    connections = {
        "good": {"profile_id": "good", "connection_id": "c", "profile_revision": 1, "connection_revision": 1,
                 "model_name": "m", "model_base_url": f"{server.url}/good/v1", "resolved_model_protocol": "openai",
                 "detected_protocol": None, "api_key": "k", "parameters": {}, "reasoning_effort": None},
        "keyless": {"profile_id": "keyless", "resolved_model_protocol": "openai", "detected_protocol": None,
                    "api_key": "", "model_name": "m", "model_base_url": ""},
    }

    def load(profile_id):
        if profile_id not in connections:
            raise ValueError("disabled")
        return connections[profile_id]

    policy = DEFAULT_FALLBACK_POLICY | {"enabled": True, "fallback_profile_ids": ["good", "keyless", "missing", "profile-primary"]}
    provider = build_routed_provider(primary.provider, primary.identity, policy, timeout_seconds=5, load_profile=load)
    assert isinstance(provider, RoutedModelProvider)
    assert [t.profile_id for t in provider._fallbacks["general"]] == ["good"]
    only_bad = DEFAULT_FALLBACK_POLICY | {"enabled": True, "fallback_profile_ids": ["keyless"]}
    assert build_routed_provider(primary.provider, primary.identity, only_bad, timeout_seconds=5, load_profile=load) is primary.provider


def test_runtime_marks_fallback_answer_on_model_selection():
    from app.agent.runtime import AgentRuntime
    from app.domain import ModelResponse
    from app.models import ModelProviderRegistry
    from app.observability.model_context import public_model_selection
    from app.tools import AskUserTool, ToolRegistry

    selection = {
        "profile_id": "profile-primary", "profile_revision": 1, "connection_id": "conn", "connection_revision": 1,
        "model_name": "model-primary", "model_base_url": "https://primary.example.test/v1",
        "model_protocol": "openai", "resolved_model_protocol": "openai",
    }

    class FallbackAnswered:
        name = "openai"

        async def generate(self, model_request):
            return ModelResponse(content="备用模型回答", provider_metadata={
                "routed": True, "answered_profile_id": "profile-backup", "answered_model_name": "model-backup",
                "fallback_from_profile_id": "profile-primary",
            })

    models = ModelProviderRegistry()
    models.register("profile-primary", FallbackAnswered())
    tools = ToolRegistry()
    tools.register_handler(AskUserTool())
    runtime = AgentRuntime(models=models, tools=tools, model_provider="profile-primary", platform_name="manual",
                           max_tool_rounds=2, max_model_retries=0, model_selection=selection)
    result = asyncio.run(runtime.run("你好"))
    public = public_model_selection(result.model_selection)
    assert public["fallback_used"] is True
    assert public["answered_model_name"] == "model-backup"
    assert "fallback_used" not in runtime.model_selection
