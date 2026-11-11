"""Read cached model directories without credentials, network or cross-account leaks."""
import json
import sqlite3
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpcore
import pytest
from fastapi.testclient import TestClient

from api_client import create_authenticated_client, register_authenticated_client
from app import db, secret_store
from app.agent import model_catalog, settings
from app.api import model
from app.main import app
from app.models.catalog_discovery import DiscoveredModels, normalize_catalog
from app.workspace import use_workspace


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "isolated.db")
    monkeypatch.setattr(secret_store, "_MEMORY_SECRETS", {})
    monkeypatch.setattr(settings, "get_settings", lambda: SimpleNamespace(
        model_name="", model_base_url=None, model_protocol="auto", openai_api_key=None,
    ))
    db.init_db()
    with create_authenticated_client(app) as owner, register_authenticated_client(app, "other-cache@example.test") as other:
        yield owner, other


def create_connection(client, name):
    response = client.post("/agent/model-connections", json={
        "name": name, "model_base_url": f"https://{name}.example.test/v1",
        "model_protocol": "openai", "api_key": f"synthetic-{name}-key",
    })
    assert response.status_code == 200, response.text
    return next(item for item in response.json()["connections"] if item["name"] == name)


def insert_cache(user_id, connection_id, revision, model_id, metadata, discovered_at="2025-01-01 12:00:00"):
    with use_workspace(user_id), db.connect() as conn:
        conn.execute(
            "INSERT INTO model_catalog_entries "
            "(connection_id, connection_revision, model_id, metadata_json, discovered_at) VALUES (?, ?, ?, ?, ?)",
            (connection_id, revision, model_id, metadata, discovered_at),
        )


def catalog_url(connection_id):
    return f"/agent/model-connections/{connection_id}/catalog"


def test_empty_cache_and_discovery_round_trip_without_secrets_or_network_on_get(clients, monkeypatch):
    owner, _ = clients
    connection = create_connection(owner, "roundtrip")
    empty_connection = create_connection(owner, "empty-cache")
    disabled_connection = create_connection(owner, "guarded-disabled")
    disabled = owner.patch(f"/agent/model-connections/{disabled_connection['id']}", json={
        "enabled": False, "expected_revision": disabled_connection["revision"],
    })
    assert disabled.status_code == 200, disabled.text
    connection_id = connection["id"]
    path = catalog_url(connection_id)
    empty = owner.get(path)
    assert empty.status_code == 200
    assert empty.headers["cache-control"] == "no-store"
    assert empty.json() == {
        "connection_id": connection_id, "connection_revision": connection["revision"],
        "models": [], "entries": [], "discovered_at": None, "cache_age_seconds": None,
    }

    entries = normalize_catalog([
        {"id": "vendor/z", "kind": "image", "display_name": "Paint", "api_key": "must-not-leak"},
        {"id": "vendor/a", "modalities": {"input": ["text", "image"], "output": ["text"]}},
    ])
    provider = SimpleNamespace(name="openai", models_url="https://roundtrip.example.test/v1/models",
                               list_models=AsyncMock(return_value=DiscoveredModels(entries)))
    factory = Mock(return_value=provider)
    monkeypatch.setattr(model, "_provider_for", factory)
    live = owner.post(f"/agent/model-connections/{connection_id}/discover")
    assert live.status_code == 200, live.text
    assert live.json()["models"] == ["vendor/a", "vendor/z"]
    provider.list_models.assert_awaited_once()

    # Fix the cache timestamp, rather than depending on the machine clock.
    owner_id = owner.get("/auth/me").json()["user"]["id"]
    with use_workspace(owner_id), db.connect() as conn:
        conn.execute("UPDATE model_catalog_entries SET discovered_at=? WHERE connection_id=?",
                     ("2025-01-02 03:04:05", connection_id))
        before = [tuple(row) for row in conn.execute(
            "SELECT * FROM model_catalog_entries WHERE connection_id=? ORDER BY model_id", (connection_id,),
        )]
    no_secret = Mock(side_effect=AssertionError("GET must not resolve credentials"))
    no_network = Mock(side_effect=AssertionError("GET must not call upstream"))
    no_async_network = AsyncMock(side_effect=AssertionError("GET must not call upstream"))
    monkeypatch.setattr(model_catalog, "_secret", no_secret)
    monkeypatch.setattr(settings, "get_secret", no_secret)
    monkeypatch.setattr(secret_store, "get_secret", no_secret)
    monkeypatch.setattr(secret_store, "get_model_api_key", no_secret)
    monkeypatch.setattr(model, "_provider_for", no_network)
    monkeypatch.setattr(httpcore.ConnectionPool, "handle_request", no_network)
    monkeypatch.setattr(httpcore.AsyncConnectionPool, "handle_async_request", no_async_network)
    cached = owner.get(path)
    assert cached.status_code == 200, cached.text
    assert cached.headers["cache-control"] == "no-store"
    cached_body = cached.json()
    assert isinstance(cached_body.pop("cache_age_seconds"), (int, float))
    assert cached_body == {
        "connection_id": connection_id, "connection_revision": connection["revision"],
        "models": live.json()["models"], "entries": live.json()["entries"],
        "discovered_at": "2025-01-02T03:04:05Z",
    }
    assert "synthetic-roundtrip-key" not in cached.text and "must-not-leak" not in cached.text
    assert owner.get(catalog_url(empty_connection["id"])).json()["models"] == []
    for denied_path in (catalog_url("missing"), catalog_url(disabled_connection["id"])):
        denied = owner.get(denied_path)
        assert denied.status_code == 400 and denied.headers["cache-control"] == "no-store"
    no_secret.assert_not_called()
    no_network.assert_not_called()
    no_async_network.assert_not_awaited()
    with use_workspace(owner_id), db.connect() as conn:
        after = [tuple(row) for row in conn.execute(
            "SELECT * FROM model_catalog_entries WHERE connection_id=? ORDER BY model_id", (connection_id,),
        )]
    assert after == before


def test_discovery_does_not_return_or_cache_echoed_key(clients, monkeypatch):
    owner, _ = clients
    connection = create_connection(owner, "echo-cache")
    secret = "synthetic-echo-cache-key"
    entries = normalize_catalog([
        {"id": "safe-model", "display_name": "label " + secret, "owned_by": secret},
        {"id": secret, "kind": "text"},
    ])
    provider = SimpleNamespace(name="openai", models_url="https://echo.example.test/v1/models", list_models=AsyncMock(return_value=DiscoveredModels(entries)))
    monkeypatch.setattr(model, "_provider_for", Mock(return_value=provider))
    live = owner.post(f"/agent/model-connections/{connection['id']}/discover")
    assert live.status_code == 200 and secret not in live.text
    cached = owner.get(catalog_url(connection["id"]))
    assert cached.status_code == 200 and secret not in cached.text
    assert cached.json()["models"] == ["safe-model"]


def test_cache_is_scoped_to_account_connection_and_revision(clients):
    owner, other = clients
    first = create_connection(owner, "first-cache")
    second = create_connection(owner, "second-cache")
    owner_id = owner.get("/auth/me").json()["user"]["id"]
    first_path = catalog_url(first["id"])
    second_path = catalog_url(second["id"])
    insert_cache(owner_id, first["id"], first["revision"], "a/current", '{"id":"a/current"}')
    insert_cache(owner_id, second["id"], second["revision"], "b/other", '{"id":"b/other"}')
    # Even a future revision with a newer timestamp must not appear.
    insert_cache(owner_id, first["id"], first["revision"] + 1, "z/future", '{"id":"z/future"}', "2099-01-01 00:00:00")
    assert owner.get(first_path).json()["models"] == ["a/current"]
    assert owner.get(second_path).json()["models"] == ["b/other"]
    foreign = other.get(first_path)
    assert foreign.status_code == 400 and foreign.headers["cache-control"] == "no-store"
    assert "a/current" not in foreign.text
    with TestClient(app) as anonymous:
        result = anonymous.get(first_path)
        assert result.status_code == 401 and result.headers["cache-control"] == "no-store"

    # Deliberately collide the same connection ID and revision across accounts.
    # The response must follow the authenticated workspace, not just the ID.
    other_id = other.get("/auth/me").json()["user"]["id"]
    with use_workspace(other_id), db.connect() as conn:
        conn.execute(
            "INSERT INTO model_connections (id,name,effective_base_url,data_boundary,revision) VALUES (?,?,?,?,?)",
            (first["id"], "other owner", "https://other.example.test", "other", first["revision"]),
        )
    insert_cache(other_id, first["id"], first["revision"], "other/private", '{"id":"other/private"}')
    other_cache = other.get(first_path)
    assert other_cache.status_code == 200 and other_cache.json()["models"] == ["other/private"]
    assert owner.get(first_path).json()["models"] == ["a/current"]

    # Rename is a real connection edit: the still-present revision 1 cache is stale.
    # Remove the synthetic future record so the new revision starts empty.
    with use_workspace(owner_id), db.connect() as conn:
        conn.execute("DELETE FROM model_catalog_entries WHERE connection_id=? AND connection_revision=?",
                     (first["id"], first["revision"] + 1))
    updated = owner.patch(f"/agent/model-connections/{first['id']}", json={
        "name": "renamed-cache", "expected_revision": first["revision"],
    })
    assert updated.status_code == 200, updated.text
    stale = owner.get(first_path)
    assert stale.status_code == 200
    assert stale.json() == {
        "connection_id": first["id"], "connection_revision": first["revision"] + 1,
        "models": [], "entries": [], "discovered_at": None, "cache_age_seconds": None,
    }
    with use_workspace(owner_id), db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM model_catalog_entries WHERE connection_id=? AND connection_revision=?",
                            (first["id"], first["revision"])).fetchone()[0] == 1
    insert_cache(owner_id, first["id"], first["revision"] + 1, "c/new", '{"id":"c/new"}')
    assert owner.get(first_path).json()["models"] == ["c/new"]
    assert owner.get(second_path).json()["models"] == ["b/other"]


def test_disabled_deleted_and_missing_connections_are_rejected(clients):
    owner, _ = clients
    connection = create_connection(owner, "disabled-cache")
    owner_id = owner.get("/auth/me").json()["user"]["id"]
    path = catalog_url(connection["id"])
    insert_cache(owner_id, connection["id"], connection["revision"], "private/model", '{"id":"private/model"}')
    disabled = owner.patch(f"/agent/model-connections/{connection['id']}", json={
        "enabled": False, "expected_revision": connection["revision"],
    })
    assert disabled.status_code == 200, disabled.text
    # Insert matching current-revision evidence: rejection is not just a cache miss.
    insert_cache(owner_id, connection["id"], connection["revision"] + 1, "private/disabled", '{"id":"private/disabled"}')
    for result in (owner.get(path), owner.get(catalog_url("missing"))):
        assert result.status_code == 400 and result.headers["cache-control"] == "no-store"
        assert "private/" not in result.text
    removed = owner.delete(f"/agent/model-connections/{connection['id']}?remove=true&expected_revision={connection['revision'] + 1}")
    assert removed.status_code == 200, removed.text
    deleted = owner.get(path)
    assert deleted.status_code == 400 and deleted.headers["cache-control"] == "no-store"
    assert "private/" not in deleted.text


def test_sqlite_failure_is_sanitized_and_not_cached(clients, monkeypatch):
    owner, _ = clients
    connection = create_connection(owner, "failed-cache")

    @contextmanager
    def unavailable():
        raise sqlite3.OperationalError("private sqlite details")
        yield

    monkeypatch.setattr(model, "connect", unavailable)
    response = owner.get(catalog_url(connection["id"]))
    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store"
    assert "private sqlite details" not in response.text


def test_legacy_json_and_untrusted_metadata_are_safely_projected(clients):
    owner, _ = clients
    connection = create_connection(owner, "legacy-cache")
    owner_id = owner.get("/auth/me").json()["user"]["id"]
    rows = [
        ("a/good", json.dumps({
            "id": "a/good", "api_key": "leak-legacy-key", "secret_ref": "leak-reference",
            "nested": {"secret": "leak-nested"}, "output_types": ["image", "bad", "image", 9],
            "input_types": ["image", "text", "bad", "image"], "output_types_source": "provider",
            "display_name": "  Paint  ", "owned_by": "  Vendor  ",
            "context_window": 4096, "max_output_tokens": True,
        }), "2025-01-01 00:00:00"),
        ("b/no-id", '{"output_types":["chat"],"secret":"leak-no-id"}', "2025-01-01T04:00:00+02:00"),
        ("c/broken", '{"api_key":"leak-broken",', "2025-01-01 01:00:00"),
        ("d/list", '["leak-list"]', "malformed-leak-time"),
        ("e/mismatch", '{"id":"other","display_name":"leak-mismatch","output_types":["video"]}', "2025-01-01 00:00:00"),
        ("f/wrong-types", '{"id":"f/wrong-types","output_types":[{},null],"input_types":"text","output_types_source":{},"display_name":["leak-display"],"owned_by":{},"context_window":-1,"max_output_tokens":0}', "2025-01-01 00:00:00"),
        ("g/surrogate", json.dumps({"id": "g/surrogate", "display_name": "\ud800"}), "2025-01-01 00:00:00"),
        ("h/bad-utf8", b'\xff', "2025-01-01 00:00:00"),
        (" invalid ", '{"id":" invalid ","api_key":"leak-invalid-id"}', "2099-01-01 00:00:00"),
    ]
    for model_id, metadata, timestamp in rows:
        insert_cache(owner_id, connection["id"], connection["revision"], model_id, metadata, timestamp)
    response = owner.get(catalog_url(connection["id"]))
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {
        "connection_id": connection["id"], "connection_revision": connection["revision"],
        "models": ["a/good", "b/no-id", "c/broken", "d/list", "e/mismatch", "f/wrong-types", "g/surrogate", "h/bad-utf8"],
        "entries": [
            {"id": "a/good", "output_types": ["image"], "input_types": ["image", "text"],
             "output_types_source": "provider", "display_name": "Paint", "owned_by": "Vendor", "context_window": 4096},
            {"id": "b/no-id", "output_types": ["chat"]},
            {"id": "c/broken"}, {"id": "d/list"}, {"id": "e/mismatch"},
            {"id": "f/wrong-types", "output_types": []}, {"id": "g/surrogate"}, {"id": "h/bad-utf8"},
        ],
        "discovered_at": None, "cache_age_seconds": None,
    }
    assert "leak-" not in response.text and "synthetic-legacy-cache-key" not in response.text
