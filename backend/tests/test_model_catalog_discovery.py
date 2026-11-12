"""Structured discovery preserves upstream identity, evidence and revision ownership."""
import asyncio
import json

import httpx
import pytest

from app.models.catalog_discovery import (
    all_model_kinds, normalize_catalog, store_discovery, discovered_entry,
    discovered_capabilities,
)
from app.db import DB_SCHEMA_VERSION, connect, init_db
from app.persistence.upgrades import migration_name
from test_openai_compatible import build_provider_with_upstream
from test_model_catalog_api import client  # noqa: F401


def test_input_vision_is_not_image_output_and_unknowns_remain_unknown():
    entries = normalize_catalog([
        {"id": "gateway/vision", "display_name": "Vision", "modalities": {"input": ["text", "image"], "output": ["text"]}, "api_key": "must-not-leak"},
        {"id": "gateway/paint", "kind": "image", "context_window": 32000},
        {"id": "gateway/film", "kind": "video"},
        {"id": "opaque-group", "display_name": "Private"},
    ])
    assert entries[0]["output_types"] == ["chat"]
    assert entries[0]["input_types"] == ["text", "image"]
    assert entries[1]["output_types"] == ["image"]
    assert entries[1]["output_types_source"] == "provider"
    assert entries[2]["output_types"] == ["video"]
    assert entries[3]["output_types"] == []
    assert entries[3]["output_types_source"] == "unknown"
    assert "api_key" not in json.dumps(entries)


def test_all_kinds_scoped_to_catalog_and_plain_get_fallback_only_for_rejected_parameter():
    requests = []

    def handler(request):
        requests.append(str(request.url))
        if request.url.params.get("kind"):
            return httpx.Response(400, json={"error": {"message": "Unsupported query parameter: kind", "type": "invalid_request_error"}})
        return httpx.Response(200, json={"data": [{"id": "raw/paint", "kind": "image", "display_name": "Paint"}]})

    provider = build_provider_with_upstream(handler)

    async def discover():
        with all_model_kinds():
            return await provider.list_models()

    result = asyncio.run(discover())
    assert requests == ["https://gateway.example.test/models?kind=all", "https://gateway.example.test/models"]
    assert result == ["raw/paint"]
    assert result.entries[0]["display_name"] == "Paint"


def test_auth_failure_does_not_retry_standard_catalog():
    requests = []

    def handler(request):
        requests.append(str(request.url))
        return httpx.Response(401, json={"error": {"message": "invalid api key"}})

    provider = build_provider_with_upstream(handler)

    async def discover():
        with all_model_kinds():
            return await provider.list_models()

    with pytest.raises(Exception):
        asyncio.run(discover())
    assert len(requests) == 1


def test_cached_evidence_bound_to_service_revision_and_never_from_name_guess(tmp_path):
    path = tmp_path / "catalog.db"
    init_db(path)
    with connect(path) as conn:
        # Cache writes reject outdated/deleted services rather than resurrecting them.
        assert not store_discovery(conn, "missing", 1, normalize_catalog([{"id": "gpt-image-2"}]))
        conn.execute("INSERT INTO model_connections (id, name, protocol, base_url, effective_base_url, data_boundary, revision) VALUES ('s1', 'One', 'auto', 'https://example.test', 'https://example.test', 'one', 1)")
        conn.execute("INSERT INTO model_connections (id, name, protocol, base_url, effective_base_url, data_boundary, revision) VALUES ('s2', 'Two', 'auto', 'https://other.test', 'https://other.test', 'two', 1)")
        entries = normalize_catalog([{"id": "raw/shared", "kind": "image"}, {"id": "gpt-image-2"}])
        assert store_discovery(conn, "s1", 1, entries)
        assert discovered_entry(conn, "s1", 1, "raw/shared")["output_types"] == ["image"]
        assert discovered_capabilities(conn, "s1", 1, "raw/shared") == {"chat": "unsupported", "image_generation": "supported", "video_generation": "unsupported"}
        assert discovered_capabilities(conn, "s1", 1, "gpt-image-2") == {}
        assert discovered_entry(conn, "s2", 1, "raw/shared") is None
        conn.execute("UPDATE model_connections SET revision=2 WHERE id='s1'")
        assert discovered_entry(conn, "s1", 2, "raw/shared") is None
        assert not store_discovery(conn, "s1", 1, entries)


def test_late_discovery_cannot_replace_a_newer_directory(tmp_path):
    from datetime import datetime, timezone
    from app.models.catalog_discovery import read_cached_catalog

    path = tmp_path / "race.db"
    init_db(path)
    old = datetime(2025, 1, 1, 12, 0, tzinfo=timezone.utc)
    new = datetime(2025, 1, 1, 12, 1, tzinfo=timezone.utc)
    with connect(path) as conn:
        conn.execute("INSERT INTO model_connections (id,name,effective_base_url,data_boundary) VALUES ('s1','One','https://example.test','one')")
    with connect(path) as conn:
        assert store_discovery(conn, "s1", 1, [{"id": "new-model"}], started_at=new)
    with connect(path) as conn:
        assert store_discovery(conn, "s1", 1, [{"id": "old-model"}], started_at=old)
        assert read_cached_catalog(conn, "s1")["models"] == ["new-model"]


def test_catalog_redacts_credentials_before_truncating_display_fields():
    secret = "key-" + "x" * 100
    entries = normalize_catalog([{"id": "safe-model", "display_name": "a" * 100 + secret, "owned_by": "b" * 100 + secret}], api_key=secret)
    assert entries[0]["id"] == "safe-model"
    assert "display_name" not in entries[0] and "owned_by" not in entries[0]


def test_cached_discovery_never_persists_known_credentials(tmp_path):
    from app.models.catalog_discovery import read_cached_catalog

    path = tmp_path / "secret.db"
    init_db(path)
    with connect(path) as conn:
        conn.execute("INSERT INTO model_connections (id,name,effective_base_url,data_boundary) VALUES ('s1','One','https://example.test','one')")
    with connect(path) as conn:
        assert store_discovery(conn, "s1", 1, [
            {"id": "secret-token", "output_types": ["chat"]},
            {"id": "safe-model", "display_name": "Bearer secret-token", "owned_by": "secret-token", "api_key": "secret-token"},
        ], api_key="secret-token")
        result = read_cached_catalog(conn, "s1")
        assert result["models"] == ["safe-model"]
        assert "secret-token" not in str(result)


def test_v35_upgrade_keeps_existing_connections_and_adds_cache(tmp_path):
    path = tmp_path / "upgrade.db"
    init_db(path)
    with connect(path) as conn:
        conn.execute("DROP TABLE model_catalog_entries")
        conn.execute("UPDATE schema_migrations SET version=35,name='presentation_model_budgets' WHERE version=?", (DB_SCHEMA_VERSION,))
        conn.execute("INSERT INTO model_connections (id,name,effective_base_url,data_boundary) VALUES ('old','Old','https://example.test','old')")
    init_db(path)
    with connect(path) as conn:
        assert conn.execute("SELECT name FROM model_connections WHERE id='old'").fetchone()[0] == "Old"
        assert conn.execute("SELECT COUNT(*) FROM model_catalog_entries").fetchone()[0] == 0
        assert conn.execute("SELECT name FROM schema_migrations WHERE version=?", (DB_SCHEMA_VERSION,)).fetchone()[0] == migration_name(DB_SCHEMA_VERSION)


def test_discovery_api_saves_trusted_alias_evidence_before_ensure(client, monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    from app.api import model
    from app.models.catalog_discovery import DiscoveredModels

    catalog = client.post("/agent/model-connections", json={"name": "Gateway", "model_base_url": "https://gateway.example.test/v1", "api_key": "synthetic-catalog-key"}).json()
    connection = next(item for item in catalog["connections"] if item["name"] == "Gateway")
    entries = normalize_catalog([{"id": "vendor/paint-group", "kind": "image", "display_name": "Image group"}])
    provider = SimpleNamespace(name="openai", models_url="https://gateway.example.test/v1/models", list_models=AsyncMock(return_value=DiscoveredModels(entries)))
    monkeypatch.setattr(model, "_provider_for", lambda *_args, **_kwargs: provider)
    response = client.post(f"/agent/model-connections/{connection['id']}/discover")
    assert response.status_code == 200, response.text
    assert response.json()["models"] == ["vendor/paint-group"]
    assert response.json()["entries"][0]["output_types_source"] == "provider"
    result = client.post(f"/agent/model-connections/{connection['id']}/profiles/ensure", json={"model_name": "vendor/paint-group", "expected_revision": connection["revision"]})
    assert result.status_code == 200, result.text
    profile = next(item for item in result.json()["profiles"] if item["connection_id"] == connection["id"])
    assert profile["supported_purposes"] == ["image"]
    assert profile["discovery"]["display_name"] == "Image group"
    assert "synthetic-catalog-key" not in result.text
    selected = client.post("/agent/model-defaults/image", json={"profile_id": profile["id"], "expected_version": result.json()["purpose_version"]})
    assert selected.status_code == 200, selected.text


def test_unsaved_draft_discovery_never_replaces_saved_service_evidence(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, Mock
    from app.api import model
    from app.models.catalog_discovery import DiscoveredModels

    entries = normalize_catalog([{"id": "draft/image", "kind": "image"}])
    provider = SimpleNamespace(name="openai", models_url="https://draft.example.test/models", list_models=AsyncMock(return_value=DiscoveredModels(entries)))
    cache = Mock(return_value=True)
    monkeypatch.setattr(model, "_provider_for", lambda *_args, **_kwargs: provider)
    monkeypatch.setattr(model, "store_discovery", cache)
    connection = {"api_key": "synthetic-draft", "model_base_url": "https://draft.example.test", "model_name": "gpt-4.1", "model_protocol": "openai", "resolved_model_protocol": "openai", "connection_id": "saved-service", "connection_revision": 1}
    result = asyncio.run(model._discover_connection(connection, remember=False))
    assert result["entries"][0]["id"] == "draft/image"
    cache.assert_not_called()
