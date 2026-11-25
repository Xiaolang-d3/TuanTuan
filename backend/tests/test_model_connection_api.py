"""Connection safety and diagnostic deadline tests; no model network traffic."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.api import model
from app.api.schemas import AgentSettingsIn, ModelCapabilitiesIn, ModelDiscoveryIn


@pytest.fixture
def connection(monkeypatch):
    saved = {
        "model_name": "custom-model", "model_base_url": "https://saved.example.test/v1",
        "configured_model_base_url": "https://saved.example.test/v1",
        "model_protocol": "openai", "resolved_model_protocol": "openai",
        "api_key": "synthetic-saved-key", "connection_id": "saved-connection", "config_revision": 3,
    }
    monkeypatch.setattr(model, "get_model_connection", lambda: saved)
    monkeypatch.setattr(model, "get_settings", lambda: SimpleNamespace(model_timeout_seconds=10))
    provider = SimpleNamespace(name="openai", models_url="https://target.example.test/models",
                               list_models=AsyncMock(return_value=["custom-model"]))
    factory = Mock(return_value=provider)
    monkeypatch.setattr(model, "build_model_provider", factory)
    return saved, provider, factory


@pytest.mark.parametrize("address", ["https://other.example.test/v1", "https://saved.example.test/tenant-b", ""])
def test_discovery_never_sends_saved_key_to_changed_api_root(connection, address):
    _saved, _provider, factory = connection
    with pytest.raises(HTTPException) as error:
        asyncio.run(model.discover_models(ModelDiscoveryIn(model_base_url=address, api_key="")))
    assert error.value.status_code == 400
    factory.assert_not_called()


def test_omitted_address_reuses_the_saved_connection(connection):
    saved, provider, factory = connection
    result = asyncio.run(model.discover_models(ModelDiscoveryIn()))
    assert factory.call_args.kwargs["base_url"] == saved["model_base_url"]
    assert factory.call_args.kwargs["api_key"] == saved["api_key"]
    assert result["models"] == ["custom-model"]
    provider.list_models.assert_awaited_once()


def test_explicit_new_key_is_only_forwarded_to_the_new_root(connection):
    _saved, _provider, factory = connection
    asyncio.run(model.discover_models(ModelDiscoveryIn(model_base_url="https://new.example.test/v1", api_key="synthetic-new-key")))
    assert factory.call_args.kwargs["api_key"] == "synthetic-new-key"
    assert factory.call_args.kwargs["base_url"] == "https://new.example.test/v1"


def test_catalog_draft_never_reuses_or_updates_saved_connection(connection, monkeypatch):
    saved, provider, factory = connection
    load_saved = Mock(side_effect=AssertionError("draft must not load saved credentials"))
    monkeypatch.setattr(model, "get_model_connection", load_saved)
    draft = ModelDiscoveryIn(model_base_url=saved["model_base_url"], model_protocol="openai")
    with pytest.raises(HTTPException) as error:
        asyncio.run(model.discover_models(draft, draft_only=True))
    assert error.value.status_code == 400
    factory.assert_not_called()
    draft.api_key = "synthetic-draft-key"
    result = asyncio.run(model.discover_models(draft, draft_only=True))
    load_saved.assert_not_called()
    provider.list_models.assert_awaited_once()
    assert factory.call_args.kwargs["api_key"] == draft.api_key
    assert draft.api_key not in str(result)


def test_capability_probe_also_blocks_cross_connection_reuse(connection):
    _saved, _provider, factory = connection
    with pytest.raises(HTTPException) as error:
        asyncio.run(model.model_capabilities_probe(ModelCapabilitiesIn(model_base_url="https://new.example.test/v1", probe=True)))
    assert error.value.status_code == 400
    factory.assert_not_called()


def test_discovery_has_a_total_deadline(connection, monkeypatch):
    _saved, provider, _factory = connection
    async def stalled():
        await asyncio.Event().wait()
    provider.list_models = stalled
    monkeypatch.setattr(model, "_diagnostic_timeout", lambda: 0.001)
    with pytest.raises(HTTPException) as error:
        asyncio.run(model.discover_models(ModelDiscoveryIn()))
    assert error.value.status_code == 504


def test_save_preserves_omitted_preferences(monkeypatch):
    save = Mock(return_value={"model_name": "new-model"})
    monkeypatch.setattr(model, "save_agent_settings", save)
    monkeypatch.setattr(model, "reload_agent_components", Mock())
    model.agent_settings_put(AgentSettingsIn(persona_role="test persona", model_name="new-model", expected_revision=3, request_id="synthetic-request"))
    values = save.call_args.args[0]
    assert "library_memory_enabled" not in values
    assert "display_name" not in values
    assert values["expected_revision"] == 3
    assert values["request_id"] == "synthetic-request"


def test_health_timeout_is_reported_as_timeout_not_unknown_failure(connection, monkeypatch):
    saved, provider, _factory = connection
    async def stalled():
        await asyncio.Event().wait()
    provider.check_connection = stalled
    monkeypatch.setattr(model, "_diagnostic_timeout", lambda: 0.001)
    events = Mock()
    monkeypatch.setattr(model, "record_model_service_event", events)
    monkeypatch.setattr(model, "get_model_monitor_snapshot", lambda: {})
    result = asyncio.run(model.model_monitor_check())
    assert result["available"] is False
    assert result["check_error_code"] == "request_timeout"
    assert result["config_revision"] == saved["config_revision"]
    assert events.call_args.kwargs["error_code"] == "request_timeout"


def test_save_receipt_survives_subsequent_saves(tmp_path, monkeypatch):
    from app.db import connect, init_db

    database = tmp_path / "receipts.db"
    init_db(database)
    with connect(database) as conn:
        conn.execute("INSERT INTO model_settings_requests(request_id,payload_fingerprint,saved_revision) VALUES ('earlier','fake-digest',3)")
    monkeypatch.setattr(model, "connect", lambda: connect(database))
    monkeypatch.setattr(model, "get_agent_settings", lambda: {"config_revision": 4, "last_save_request_id": "later"})
    result = model.agent_settings_request_get("earlier")
    assert result["committed"] is True
    assert result["saved_revision"] == 3
    assert result["settings"]["config_revision"] == 4
    assert model.agent_settings_request_get("absent")["committed"] is False
