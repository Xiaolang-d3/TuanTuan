"""Public contracts across independent model services; all credentials are fake."""
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app import db, secret_store
from app.agent import settings
from app.api import model
from app.db import init_db
from app.main import app
from api_client import create_authenticated_client


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


def create(client, name, key):
    response = client.post("/agent/model-connections", json={
        "name": name, "model_base_url": f"https://{name}.example.test/v1",
        "model_protocol": "openai", "api_key": key, "model_name": "shared-model-name",
    })
    assert response.status_code == 200, response.text
    catalog = response.json()
    connection = next(item for item in catalog["connections"] if item["name"] == name)
    profile = next(item for item in catalog["profiles"] if item["connection_id"] == connection["id"])
    assert "api_key" not in connection and "secret_ref" not in connection
    assert key not in response.text
    return catalog, connection, profile


def test_reveal_connection_key_is_explicit_and_not_cached(client):
    from fastapi.testclient import TestClient

    _, connection, _ = create(client, "reveal", "synthetic-reveal-key")
    path = f"/agent/model-connections/{connection['id']}/reveal-key"
    assert "synthetic-reveal-key" not in client.get("/agent/model-connections").text
    result = client.post(path)
    assert result.status_code == 200
    assert result.json() == {"api_key": "synthetic-reveal-key"}
    assert result.headers["cache-control"] == "no-store"
    missing = client.post("/agent/model-connections/missing/reveal-key")
    assert missing.status_code == 400
    assert missing.headers["cache-control"] == "no-store"
    with TestClient(app) as anonymous:
        assert anonymous.post(path).status_code == 401


def test_remove_service_hides_models_and_preserves_history(client):
    _, connection, profile = create(client, "removable", "synthetic-remove-key")
    path = f"/agent/model-connections/{connection['id']}"
    removed = client.delete(path + "?remove=true&expected_revision=1")
    assert removed.status_code == 200, removed.text
    for catalog in (removed.json(), client.get("/agent/model-connections").json()):
        assert connection["id"] not in {item["id"] for item in catalog["connections"]}
        assert profile["id"] not in {item["id"] for item in catalog["profiles"]}
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM model_profile_versions WHERE profile_id=?", (profile["id"],)).fetchone()[0] == 1
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert client.patch(path, json={"enabled": True, "expected_revision": 2}).status_code == 400
    assert client.post(path + "/profiles/ensure", json={"model_name": "new", "expected_revision": 2}).status_code == 400
    from app.agent.model_purposes import selection_catalog
    choices = selection_catalog()
    assert connection["id"] not in {item["id"] for item in choices["connections"]}
    assert profile["id"] not in {item["id"] for item in choices["profiles"]}


def test_remove_service_checks_revision_and_default_before_hiding(client):
    _, connection, profile = create(client, "protected", "synthetic-protected-key")
    path = f"/agent/model-connections/{connection['id']}"
    assert client.delete(path + "?remove=true&expected_revision=0").status_code == 409
    client.post("/agent/model-default", json={"profile_id": profile["id"]})
    assert client.delete(path + "?remove=true&expected_revision=1").status_code == 400
    assert connection["id"] in {item["id"] for item in client.get("/agent/model-connections").json()["connections"]}


def test_connections_and_profiles_do_not_silently_change_default(client):
    original = client.get("/agent/model-connections").json()["default_profile_id"]
    catalog, first, profile = create(client, "first", "synthetic-first-key")
    assert catalog["default_profile_id"] == original
    response = client.post("/agent/model-profiles", json={"connection_id": first["id"], "model_name": "second-model"})
    assert response.status_code == 200
    assert len([item for item in response.json()["profiles"] if item["connection_id"] == first["id"]]) == 2
    changed = client.post("/agent/model-default", json={"profile_id": profile["id"]})
    assert changed.status_code == 200
    saved = client.get("/agent/settings").json()
    assert saved["model_name"] == "shared-model-name" and saved["model_base_url"] == first["model_base_url"]
    assert saved["api_key_configured"] is True


def test_saved_connection_discovery_uses_its_own_key(client, monkeypatch):
    _catalog, first, _profile = create(client, "first", "synthetic-first-key")
    create(client, "second", "synthetic-second-key")
    provider = SimpleNamespace(name="openai", models_url="https://first.example.test/v1/models", list_models=AsyncMock(return_value=["another-model"]))
    factory = Mock(return_value=provider)
    monkeypatch.setattr(model, "build_model_provider", factory)
    response = client.post(f"/agent/model-connections/{first['id']}/discover")
    assert response.status_code == 200
    assert factory.call_args.kwargs["api_key"] == "synthetic-first-key"
    assert factory.call_args.kwargs["base_url"] == first["model_base_url"]


def test_service_model_selection_reuses_profile_and_preserves_default(client):
    from app.agent.model_catalog import get_profile_connection

    catalog, connection, _profile = create(client, "first", "synthetic-first-key")
    original_default = catalog["default_profile_id"]
    path = f"/agent/model-connections/{connection['id']}/profiles/ensure"
    body = {"model_name": "discovered-model", "expected_revision": connection["revision"]}
    first = client.post(path, json=body)
    repeated = client.post(path, json=body)
    assert first.status_code == repeated.status_code == 200
    models = [item for item in repeated.json()["profiles"] if item["connection_id"] == connection["id"] and item["model_name"] == "discovered-model"]
    assert len(models) == 1
    assert repeated.json()["default_profile_id"] == original_default
    assert "synthetic-first-key" not in repeated.text and "secret_ref" not in repeated.text
    conversation = client.post("/conversations", json={"title": "service catalog selection"}).json()
    selected = client.patch(f"/conversations/{conversation['id']}", json={"model_profile_id": models[0]["id"]})
    assert selected.status_code == 200
    resolved = get_profile_connection(selected.json()["model_profile_id"])
    assert resolved["model_name"] == "discovered-model"
    assert resolved["api_key"] == "synthetic-first-key"
    assert resolved["model_base_url"] == connection["model_base_url"]


def test_service_model_rejects_stale_connection_and_disabled_model(client):
    _catalog, connection, profile = create(client, "first", "synthetic-first-key")
    path = f"/agent/model-connections/{connection['id']}/profiles/ensure"
    body = {"model_name": "discovered-model", "expected_revision": connection["revision"]}
    client.patch(f"/agent/model-connections/{connection['id']}", json={"name": "renamed", "expected_revision": connection["revision"]})
    assert client.post(path, json=body).status_code == 409
    client.patch(f"/agent/model-profiles/{profile['id']}", json={"enabled": False, "expected_revision": profile["revision"]})
    disabled = client.post(path, json={"model_name": profile["model_name"], "expected_revision": connection["revision"] + 1})
    assert disabled.status_code == 400 and "停用" in disabled.json()["detail"]
    client.delete(f"/agent/model-connections/{connection['id']}")
    archived = client.post(path, json={**body, "expected_revision": connection["revision"] + 2})
    assert archived.status_code == 400


def test_connection_edit_preserves_credentials_and_rejects_stale_revision(client):
    _catalog, connection, _profile = create(client, "first", "synthetic-first-key")
    address = {"model_base_url": "https://changed.example.test/v1", "expected_revision": connection["revision"], "api_key": ""}
    assert client.patch(f"/agent/model-connections/{connection['id']}", json=address).status_code == 400
    renamed = client.patch(f"/agent/model-connections/{connection['id']}", json={"name": "renamed", "expected_revision": connection["revision"]})
    assert renamed.status_code == 200
    assert client.patch(f"/agent/model-connections/{connection['id']}", json={"name": "stale", "expected_revision": connection["revision"]}).status_code == 409


def test_default_archive_is_rejected_and_conversation_selection_can_reset(client):
    _catalog, first, profile = create(client, "first", "synthetic-first-key")
    client.post("/agent/model-default", json={"profile_id": profile["id"]})
    assert client.delete(f"/agent/model-connections/{first['id']}").status_code == 400
    conversation = client.post("/conversations", json={"title": "model selection"}).json()
    selected = client.patch(f"/conversations/{conversation['id']}", json={"model_profile_id": profile["id"]})
    assert selected.status_code == 200 and selected.json()["model_profile_id"] == profile["id"]
    renamed = client.patch(f"/conversations/{conversation['id']}", json={"title": "same selection"})
    assert renamed.json()["model_profile_id"] == profile["id"]
    reset = client.patch(f"/conversations/{conversation['id']}", json={"model_profile_id": None})
    assert reset.json()["model_profile_id"] is None
    assert client.patch(f"/conversations/{conversation['id']}", json={"model_profile_id": "foreign-profile"}).status_code == 400


def test_ag_ui_model_profile_type_is_validated_before_run(client):
    conversation = client.post("/conversations", json={"title": "validation"}).json()
    response = client.post("/ag-ui", json={
        "threadId": str(conversation["id"]), "runId": "invalid-profile", "messages": [{"id": "message", "role": "user", "content": "hello"}],
        "tools": [], "context": [], "state": {}, "forwardedProps": {"modelProfileId": 42},
    })
    assert response.status_code == 422


def test_routing_policy_api_checks_versions_and_effective_execution_model(client):
    _catalog, connection, profile = create(client, "routed", "synthetic-route-key")
    initial = client.get("/agent/model-routing").json()
    payload = {"roles": {"execute": profile["id"]}, "strict_capabilities": False, "expected_version": initial["version"]}
    response = client.put("/agent/model-routing", json=payload)
    assert response.status_code == 200 and response.json()["version"] == initial["version"] + 1
    assert "synthetic-route-key" not in response.text and "secret_ref" not in response.text
    catalog = client.get("/agent/model-connections").json()
    assert catalog["effective_execution_profile_id"] == profile["id"]
    assert catalog["default_profile_id"] != profile["id"]
    assert client.put("/agent/model-routing", json=payload).status_code == 409
    payload["expected_version"] = response.json()["version"]
    assert client.put("/agent/model-routing", json={**payload, "roles": {"unknown": profile["id"]}}).status_code == 422
    assert client.put("/agent/model-routing", json={**payload, "roles": {"plan": "foreign-profile"}}).status_code == 400
    assert client.delete(f"/agent/model-connections/{connection['id']}").status_code == 200
    unavailable = client.get("/agent/capabilities")
    assert unavailable.status_code == 400 and "停用" in unavailable.json()["detail"]


def test_connection_directory_without_placeholder_profile(client, monkeypatch):
    response = client.post('/agent/model-connections', json={
        'name': 'shared-service', 'model_base_url': 'https://shared.example.test/v1',
        'model_protocol': 'openai', 'api_key': 'synthetic-service-key',
    })
    assert response.status_code == 200, response.text
    catalog = response.json()
    connection = next(item for item in catalog['connections'] if item['name'] == 'shared-service')
    assert not any(profile['connection_id'] == connection['id'] for profile in catalog['profiles'])
    provider = SimpleNamespace(name='openai', models_url='https://shared.example.test/v1/models', list_models=AsyncMock(return_value=['chat-model', 'gpt-image-2']))
    factory = Mock(return_value=provider)
    monkeypatch.setattr(model, 'build_model_provider', factory)
    for action in ('discover', 'check'):
        result = client.post(f"/agent/model-connections/{connection['id']}/{action}")
        assert result.status_code == 200, result.text
        assert result.json()['models'] == ['chat-model', 'gpt-image-2']
    assert factory.call_args.kwargs['api_key'] == 'synthetic-service-key'
    refreshed = client.get('/agent/model-connections').json()
    assert refreshed['profiles'] == catalog['profiles']
    assert 'synthetic-service-key' not in str(refreshed)
    selected = client.post(f"/agent/model-connections/{connection['id']}/profiles/ensure", json={'model_name': 'gpt-image-2', 'expected_revision': connection['revision']})
    assert selected.status_code == 200, selected.text
    from app.agent.model_catalog import get_profile_connection
    image = next(profile for profile in selected.json()['profiles'] if profile['connection_id'] == connection['id'])
    resolved = get_profile_connection(image['id'])
    assert resolved['api_key'] == 'synthetic-service-key'
    assert resolved['resolved_model_protocol'] == 'images'
    assert resolved['model_base_url'] == connection['model_base_url']
    assert len(selected.json()['connections']) == len(catalog['connections'])


def test_fresh_workspace_has_no_seeded_connections_or_models(client, monkeypatch):
    monkeypatch.setattr(settings, 'get_settings', lambda: SimpleNamespace(model_name='', model_base_url=None, model_protocol='auto', openai_api_key=None))
    catalog = client.get('/agent/model-connections').json()
    assert catalog['connections'] == []
    assert catalog['profiles'] == []
    assert not catalog['default_profile_id']
    empty = client.get('/agent/settings')
    assert empty.status_code == 200
    assert empty.json()['model_name'] == ''
    assert client.get('/agent/capabilities').json()['configured'] is False
    from app.agent.model_router import get_routing_policy, save_routing_policy
    assert get_routing_policy() == {'version': 1, 'roles': {}, 'strict_capabilities': False}
    assert save_routing_policy({'expected_version': 1, 'roles': {}})['version'] == 2
    saved = client.post('/agent/model-connections', json={'name': 'service', 'model_base_url': 'https://service.example.test/v1', 'api_key': 'synthetic-only-key'})
    assert saved.status_code == 200, saved.text
    assert len(saved.json()['connections']) == 1
    assert saved.json()['profiles'] == []
    assert not saved.json()['default_profile_id']
