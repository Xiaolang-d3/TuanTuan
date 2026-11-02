"""API keys echoed back by gateways never reach messages or the monitor DB."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import db
from app.agent.model_routing import DEFAULT_FALLBACK_POLICY
from app.domain import AgentMessage, ModelRequest
from app.models.base import ModelProviderError
from app.models.litellm_provider import _NATIVE_CLASSES, LiteLLMProvider, clear_litellm_option_cache
from app.models.litellm_router import RouteTarget, RoutedModelProvider
from app.redaction import redact_secrets
from fake_llm_server import FakeLLMServer

# A gateway key with no recognisable shape: only key-aware redaction catches it.
PLAIN_KEY = "gw9Zq4TOPSECRETv7Lm2"
SK_KEY = "sk-SECRETLEAKCHECK0123456789"
BASES = {"openai": "/v1", "responses": "/v1", "anthropic": "", "gemini": "", "ollama": ""}
PATHS = {"openai": "/chat/completions", "responses": "/responses", "anthropic": "/messages",
         "gemini": "generateContent", "ollama": "/api/chat"}


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "litellm")
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "redaction.db")
    db.init_db()
    clear_litellm_option_cache()


@pytest.fixture
def server():
    with FakeLLMServer() as fake:
        yield fake


def request() -> ModelRequest:
    return ModelRequest(messages=[AgentMessage(role="user", content="你好")])


def stored_messages() -> list[str]:
    with db.connect() as conn:
        return [row[0] for row in conn.execute("SELECT error_message FROM model_service_events")]


def echo(server, path, key):
    server.errors[path] = (400, {"error": {"message": f"credential Bearer {key} rejected (api_key={key})"}})


def test_redact_secrets_patterns_and_exact_values():
    text = (f"Authorization: Bearer {SK_KEY}; x-api-key: {PLAIN_KEY}; "
            "url https://g.example/v1beta/models/m:generateContent?key=AIzaSyA1234567890abcdefghijk&alt=sse")
    redacted = redact_secrets(text)
    assert SK_KEY not in redacted and PLAIN_KEY not in redacted and "AIzaSy" not in redacted
    assert redact_secrets(f"echo {PLAIN_KEY} back", [PLAIN_KEY]) == "echo *** back"
    assert redact_secrets("model gpt-4o-mini is unavailable") == "model gpt-4o-mini is unavailable"
    assert str(ModelProviderError("provider_error", f"bad Bearer {SK_KEY}")) == "bad Bearer ***"


@pytest.mark.parametrize("protocol", list(BASES))
@pytest.mark.parametrize("key", [PLAIN_KEY, SK_KEY])
def test_litellm_errors_mask_the_connection_key(server, protocol, key):
    echo(server, PATHS[protocol], key)
    provider = LiteLLMProvider(key, "gpt-4o", f"{server.url}{BASES[protocol]}", 5, protocol=protocol)
    with pytest.raises(ModelProviderError) as caught:
        asyncio.run(provider.generate(request()))
    assert key not in str(caught.value)
    assert stored_messages() and all(key not in message for message in stored_messages())


@pytest.mark.parametrize("protocol", list(BASES))
def test_native_errors_mask_the_connection_key(server, protocol, monkeypatch):
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "native")
    echo(server, PATHS[protocol], PLAIN_KEY)
    provider = _NATIVE_CLASSES[protocol](
        api_key=PLAIN_KEY, model="gpt-4o", base_url=f"{server.url}{BASES[protocol]}", timeout_seconds=5,
    )
    with pytest.raises(ModelProviderError) as caught:
        asyncio.run(provider.generate(request()))
    assert PLAIN_KEY not in str(caught.value)
    assert stored_messages() and all(PLAIN_KEY not in message for message in stored_messages())


def test_router_masks_keys_of_primary_and_fallbacks(server):
    def target(name):
        provider = LiteLLMProvider(f"{PLAIN_KEY}-{name}", f"model-{name}", f"{server.url}/{name}/v1", 5, protocol="openai")
        return RouteTarget(identity={"profile_id": f"profile-{name}", "connection_id": f"conn-{name}",
                                     "model_name": f"model-{name}"}, provider=provider)

    echo(server, "/primary/", f"{PLAIN_KEY}-primary")
    echo(server, "/backup/", f"{PLAIN_KEY}-backup")
    primary, backup = target("primary"), target("backup")
    policy = json.loads(json.dumps(DEFAULT_FALLBACK_POLICY)) | {"enabled": True}
    routed = RoutedModelProvider(
        primary=primary.provider, primary_identity=primary.identity, primary_parameters={},
        primary_reasoning_effort=None, fallbacks={"general": [backup]}, policy=policy,
    )
    with pytest.raises(ModelProviderError) as caught:
        asyncio.run(routed.generate(request()))
    assert PLAIN_KEY not in str(caught.value)
    assert stored_messages() and all(PLAIN_KEY not in message for message in stored_messages())
