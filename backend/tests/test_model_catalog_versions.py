"""Restoring a run never substitutes today's secret or profile parameters."""
from types import SimpleNamespace

import pytest

from app import secret_store
from app.agent import settings, bootstrap
from app.agent.model_binding import internal_model_selection
from app.agent.model_catalog import get_profile_connection, update_model_profile
from app.db import connect, init_db
from app.observability.model_context import public_model_selection


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    config = SimpleNamespace(model_name="test-model", model_base_url="https://test.example.test/v1", model_protocol="openai", openai_api_key=None)
    monkeypatch.setattr(settings, "get_settings", lambda: config)
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "memory")
    monkeypatch.setattr(secret_store, "_MEMORY_SECRETS", {})
    path = tmp_path / "versions.db"
    init_db(path)
    return path, config


def test_environment_rotation_changes_cache_and_blocks_old_restore(workspace):
    path, config = workspace
    config.openai_api_key = "synthetic-first-key"
    first = get_profile_connection(db_path=path)
    selection = internal_model_selection(first)
    config.openai_api_key = "synthetic-rotated-key"
    second = get_profile_connection(db_path=path)
    assert bootstrap._runtime_cache_key(first) != bootstrap._runtime_cache_key(second)
    with pytest.raises(secret_store.SecretStoreUnavailable, match="凭证已改变"):
        get_profile_connection(db_path=path, selection=selection)
    assert "credential_fingerprint" not in public_model_selection(selection)
    assert "synthetic-first-key" not in str(selection)


def test_image_capability_is_independent_and_reset_when_connection_changes(workspace):
    from app.agent.model_catalog import update_model_connection
    path, config = workspace
    config.openai_api_key = 'synthetic-image-test-key'
    first = get_profile_connection(db_path=path)
    profile = update_model_profile(first['profile_id'], {'capabilities': {'vision': 'supported', 'image_generation': 'unsupported'}}, path)
    profile = update_model_profile(profile['id'], {'capabilities': {'image_generation': 'unsupported'}}, path)
    assert profile['capabilities']['vision'] == 'supported'
    blocked = get_profile_connection(db_path=path)
    frozen = internal_model_selection(blocked)
    update_model_connection(blocked['connection_id'], {'base_url': 'https://replacement.invalid/v1', 'api_key': 'synthetic-replacement-test-key', 'expected_revision': blocked['connection_revision']}, path)
    refreshed = get_profile_connection(db_path=path)
    assert refreshed['capabilities']['image_generation'] == 'unknown'
    assert refreshed['profile_revision'] > blocked['profile_revision']
    assert get_profile_connection(db_path=path, selection=frozen)['capabilities']['image_generation'] == 'unsupported'


def test_profile_contract_accepts_image_capability_and_rejects_invalid_values():
    from app.api.model_contracts import ProfileUpdateIn
    from pydantic import ValidationError
    assert ProfileUpdateIn(expected_revision=1, capabilities={'image_generation': 'unsupported'}).capabilities == {'image_generation': 'unsupported'}
    with pytest.raises(ValidationError):
        ProfileUpdateIn(expected_revision=1, capabilities={'image_generation': 'yes'})


def test_legacy_binding_survives_migration_and_key_replacement(workspace, monkeypatch):
    path, _ = workspace
    with connect(path) as conn:
        conn.execute("UPDATE agent_settings SET model_api_key = 'synthetic-legacy-key'")
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "environment")
    first = get_profile_connection(db_path=path)
    assert first["secret_ref"].startswith("legacy:")
    selection = internal_model_selection(first)
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "memory")
    settings.save_agent_settings({"api_key": "synthetic-replacement-key"}, path)
    restored = get_profile_connection(db_path=path, selection=selection)
    assert restored["api_key"] == "synthetic-legacy-key"
    assert get_profile_connection(db_path=path)["api_key"] == "synthetic-replacement-key"
    with connect(path) as conn:
        assert conn.execute("SELECT model_api_key FROM agent_settings").fetchone()[0] == ""
        stored = [row[0] for row in conn.execute("SELECT payload_json FROM model_connection_versions")]
    assert "synthetic-legacy-key" not in str(stored)
    assert "synthetic-replacement-key" not in str(stored)


def test_version_restores_parameters_after_profile_edit(workspace):
    path, _ = workspace
    first = get_profile_connection(db_path=path)
    update_model_profile(first["profile_id"], {"parameters": {"temperature": 0.2, "max_output_tokens": 100}}, path)
    second = get_profile_connection(db_path=path)
    update_model_profile(first["profile_id"], {"parameters": {"temperature": 0.8, "max_output_tokens": 500}}, path)
    restored = get_profile_connection(db_path=path, selection=internal_model_selection(second))
    assert restored["parameters"] == {"temperature": 0.2, "max_output_tokens": 100}


def test_shared_image_adapter_keeps_the_protocol_bound_to_a_restored_run(workspace):
    from app.agent.model_catalog import ensure_service_model_profile
    path, config = workspace
    config.openai_api_key = "synthetic-shared-images-key"
    connection = get_profile_connection(db_path=path)
    image = ensure_service_model_profile(connection["connection_id"], {"model_name": "gpt-image-2", "expected_revision": connection["connection_revision"]}, path)
    current = get_profile_connection(image["id"], path)
    assert current["model_protocol"] == "images"
    bound = internal_model_selection(current)
    assert get_profile_connection(db_path=path, selection=bound)["model_protocol"] == "images"
    legacy = {**bound, "model_protocol": "responses", "resolved_model_protocol": "responses"}
    assert get_profile_connection(db_path=path, selection=legacy)["model_protocol"] == "responses"
