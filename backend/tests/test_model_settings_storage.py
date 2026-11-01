from __future__ import annotations

import sqlite3
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import secret_store
from app.agent import settings
from app.db import DB_SCHEMA_VERSION, connect, init_db


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    config = SimpleNamespace(model_name="audit-model", model_base_url=None, model_protocol="auto", openai_api_key=None)
    monkeypatch.setattr(settings, "get_settings", lambda: config)
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "memory")
    monkeypatch.setattr(secret_store, "_MEMORY_SECRETS", {})
    path = tmp_path / "settings.db"
    init_db(path)
    return path, config


def configured(workspace, **extra):
    path, _ = workspace
    return settings.save_agent_settings({"model_name": "audit-old-model", "model_base_url": "https://old.example.test/v1", "api_key": "audit-fake-old-credential", **extra}, path)


def raw_settings(path):
    with connect(path) as conn:
        return dict(conn.execute("SELECT * FROM agent_settings WHERE id = 1").fetchone())


def test_reference_hides_key_and_never_writes_plaintext_to_sqlite(workspace):
    path, _ = workspace
    saved = configured(workspace)
    raw = raw_settings(path)
    assert raw["model_api_key"] == ""
    assert raw["model_secret_ref"].startswith("memory:workspace:")
    assert saved["connection_id"] and saved["config_revision"] == 1
    assert saved["api_key_source"] == "memory" and saved["secret_storage_writable"]
    assert not {"model_api_key", "model_secret_ref", "api_key"} & saved.keys()
    assert settings.get_model_connection(path)["api_key"] == "audit-fake-old-credential"


def test_sql_failure_preserves_old_complete_connection_and_discards_candidate(workspace, monkeypatch):
    path, _ = workspace
    configured(workspace)
    before = raw_settings(path)
    credentials = dict(secret_store._MEMORY_SECRETS)
    real_connect = settings.connect
    @contextmanager
    def failing_connect(db_path):
        with real_connect(db_path) as conn:
            class FailingUpdate:
                def execute(self, query, *args):
                    if query.lstrip().startswith("UPDATE agent_settings SET") and "config_revision =" in query:
                        raise sqlite3.OperationalError("synthetic SQL failure")
                    return conn.execute(query, *args)
            yield FailingUpdate()
    monkeypatch.setattr(settings, "connect", failing_connect)
    with pytest.raises(sqlite3.OperationalError):
        settings.save_agent_settings({"model_base_url": "https://new.example.test/v1", "model_name": "audit-new-model", "api_key": "audit-fake-new-credential"}, path)
    assert raw_settings(path) == before
    assert secret_store._MEMORY_SECRETS == credentials


def test_secret_write_failure_preserves_original_configuration(workspace, monkeypatch):
    path, _ = workspace
    configured(workspace)
    before = raw_settings(path)
    monkeypatch.setattr(settings, "create_model_api_key", Mock(side_effect=secret_store.SecretStoreUnavailable("synthetic write failure")))
    with pytest.raises(secret_store.SecretStoreUnavailable):
        settings.save_agent_settings({"api_key": "audit-fake-new-credential"}, path)
    assert raw_settings(path) == before


def test_candidate_readback_mismatch_is_not_committed(workspace, monkeypatch):
    path, _ = workspace
    configured(workspace)
    before = raw_settings(path)
    count = len(secret_store._MEMORY_SECRETS)
    monkeypatch.setattr(settings, "get_secret", lambda *_args: "audit-wrong-value")
    with pytest.raises(secret_store.SecretStoreUnavailable, match="校验失败"):
        settings.save_agent_settings({"api_key": "audit-fake-new-credential"}, path)
    assert raw_settings(path) == before
    assert len(secret_store._MEMORY_SECRETS) == count


def test_missing_saved_secret_is_not_a_clear_operation(workspace):
    path, _ = workspace
    configured(workspace)
    before = raw_settings(path)
    secret_store._MEMORY_SECRETS.clear()
    with pytest.raises(secret_store.SecretStoreUnavailable, match="暂不可读取"):
        settings.save_agent_settings({"model_name": "another-model"}, path)
    assert raw_settings(path) == before


def test_late_replay_does_not_overwrite_a_newer_save(workspace):
    path, _ = workspace
    first = configured(workspace, request_id="request-one", expected_revision=0)
    settings.save_agent_settings({"model_name": "audit-newer-model", "request_id": "request-two", "expected_revision": 1}, path)
    count = len(secret_store._MEMORY_SECRETS)
    replayed = configured(workspace, request_id="request-one", expected_revision=0)
    assert replayed["config_revision"] == 2 and replayed["model_name"] == "audit-newer-model"
    assert replayed["last_save_request_id"] == "request-two" and replayed["connection_id"] == first["connection_id"]
    assert len(secret_store._MEMORY_SECRETS) == count


def test_request_id_reuse_with_different_payload_conflicts(workspace):
    path, _ = workspace
    configured(workspace, request_id="request-one")
    with pytest.raises(settings.AgentSettingsConflict, match="不同内容"):
        settings.save_agent_settings({"model_name": "different", "request_id": "request-one"}, path)
    assert raw_settings(path)["config_revision"] == 1


def test_parallel_saves_with_same_revision_allow_one_complete_pair(workspace):
    path, _ = workspace
    configured(workspace)
    def attempt(label):
        try:
            settings.save_agent_settings({"model_name": label, "model_base_url": f"https://{label}.example.test/v1", "api_key": f"audit-fake-{label}-credential", "expected_revision": 1, "request_id": label}, path)
            return label
        except settings.AgentSettingsConflict:
            return None
    with ThreadPoolExecutor(max_workers=2) as executor:
        winners = [label for label in executor.map(attempt, ["alpha", "beta"]) if label]
    assert len(winners) == 1
    actual = settings.get_model_connection(path)
    assert actual["model_name"] == winners[0] and actual["config_revision"] == 2
    assert actual["model_base_url"] == f"https://{winners[0]}.example.test/v1"
    assert actual["api_key"] == f"audit-fake-{winners[0]}-credential"


def test_omission_preserves_preferences_but_blank_address_is_persisted(workspace):
    path, config = workspace
    config.model_base_url = "https://environment.example.test/v1"
    assert settings.get_agent_settings(path)["model_base_url"] == config.model_base_url
    settings.save_agent_settings({"custom_instructions": "Keep this preference", "library_memory_enabled": False}, path)
    saved = settings.save_agent_settings({"model_base_url": "", "model_name": "another-model"}, path)
    assert saved["model_base_url"] == saved["configured_model_base_url"] == ""
    assert saved["custom_instructions"] == "Keep this preference" and not saved["library_memory_enabled"]
    assert settings.get_model_connection(path)["model_base_url"] == "https://api.openai.com/v1"
    assert settings.get_agent_settings(path)["model_base_url"] == ""


def test_blank_model_is_rejected(workspace):
    path, _ = workspace
    with pytest.raises(ValueError, match="模型名称不能为空"):
        settings.save_agent_settings({"model_name": "  "}, path)


def test_changed_api_root_without_new_key_cannot_save(workspace):
    path, _ = workspace
    configured(workspace)
    before = raw_settings(path)
    for root in ["https://another.example.test/v1", "https://old.example.test/different-tenant", ""]:
        with pytest.raises(ValueError, match="旧密钥不能"):
            settings.save_agent_settings({"model_base_url": root, "api_key": ""}, path)
        assert raw_settings(path) == before


def test_environment_key_cannot_follow_later_environment_address_changes(workspace):
    path, config = workspace
    config.model_base_url, config.openai_api_key = "https://environment-old.example.test/v1", "audit-fake-environment-credential"
    assert settings.get_agent_settings(path)["api_key_source"] == "environment"
    config.model_base_url = "https://environment-new.example.test/v1"
    actual = settings.get_model_connection(path)
    assert actual["model_base_url"] == "https://environment-old.example.test/v1" and actual["api_key"] == ""
    before = raw_settings(path)
    with pytest.raises(secret_store.SecretStoreUnavailable, match="环境服务地址已改变"):
        settings.save_agent_settings({"model_name": "another-model"}, path)
    assert raw_settings(path) == before


def test_readonly_environment_does_not_delete_distinct_legacy_key(workspace, monkeypatch):
    path, config = workspace
    config.openai_api_key = "audit-fake-environment-credential"
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "environment")
    with connect(path) as conn:
        conn.execute("UPDATE agent_settings SET model_api_key = 'audit-fake-legacy-credential'")
    actual = settings.get_model_connection(path)
    assert actual["api_key"] == "audit-fake-legacy-credential" and actual["api_key_source"] == "legacy"
    assert raw_settings(path)["model_api_key"] == "audit-fake-legacy-credential"
    assert settings.get_agent_settings(path)["secret_migration_warning"]


def test_legacy_key_clears_only_after_verified_safe_migration(workspace):
    path, _ = workspace
    with connect(path) as conn:
        conn.execute("UPDATE agent_settings SET model_api_key = 'audit-fake-legacy-credential'")
    assert settings.get_model_connection(path)["api_key"] == "audit-fake-legacy-credential"
    raw = raw_settings(path)
    assert raw["model_api_key"] == "" and raw["model_secret_ref"]
    assert settings.get_model_connection(path)["secret_ref"] == raw["model_secret_ref"]
    assert len(secret_store._MEMORY_SECRETS) == 1


def test_failed_legacy_migration_keeps_plaintext_and_discards_candidate(workspace, monkeypatch):
    path, _ = workspace
    with connect(path) as conn:
        conn.execute("UPDATE agent_settings SET model_api_key = 'audit-fake-legacy-credential'")
    monkeypatch.setattr(settings, "get_secret", lambda *_args: "different-fake-value")
    assert settings.get_model_connection(path)["api_key"] == "audit-fake-legacy-credential"
    assert raw_settings(path)["model_api_key"] == "audit-fake-legacy-credential"
    assert not raw_settings(path)["model_secret_ref"] and not secret_store._MEMORY_SECRETS


def test_old_secure_slot_is_migrated_before_a_different_environment_key(workspace):
    path, config = workspace
    config.openai_api_key = "audit-fake-different-environment-key"
    secret_store.set_model_api_key("audit-fake-original-slot-key", path)
    actual = settings.get_model_connection(path)
    assert actual["api_key"] == "audit-fake-original-slot-key"
    assert actual["api_key_source"] == "memory"
    assert raw_settings(path)["model_secret_ref"].startswith("memory:")


def test_custom_saved_root_never_imports_environment_key_for_another_root(workspace):
    path, config = workspace
    config.model_base_url = "https://environment.example.test/v1"
    config.openai_api_key = "audit-fake-environment-key"
    with connect(path) as conn:
        conn.execute("UPDATE agent_settings SET model_base_url = 'https://saved.example.test/v1'")
    actual = settings.get_model_connection(path)
    assert actual["model_base_url"] == "https://saved.example.test/v1"
    assert actual["api_key"] == "" and not raw_settings(path)["model_secret_ref"]


def test_ollama_never_resurrects_an_old_slot_when_switching_back(workspace):
    path, _ = workspace
    secret_store.set_model_api_key("audit-fake-old-slot-credential", path)
    settings.get_model_connection(path)
    settings.save_agent_settings({"model_protocol": "ollama", "model_base_url": "http://localhost:11434", "model_name": "qwen"}, path)
    assert settings.get_model_connection(path)["api_key"] == ""
    settings.save_agent_settings({"model_protocol": "openai", "model_base_url": "https://new.example.test/v1"}, path)
    assert settings.get_model_connection(path)["api_key"] == ""


def test_secret_references_are_isolated_across_workspaces_with_same_user_id(workspace, tmp_path):
    from app.workspace import use_workspace
    path, _ = workspace
    another = tmp_path / "other" / "settings.db"
    init_db(another)
    with use_workspace(1, path.parent):
        first = configured(workspace)
    with use_workspace(1, another.parent):
        settings.save_agent_settings({"api_key": "audit-fake-other-workspace-credential"}, another)
        assert settings.get_model_connection(another)["api_key"] == "audit-fake-other-workspace-credential"
    with use_workspace(1, path.parent):
        assert settings.get_model_connection(path)["api_key"] == "audit-fake-old-credential"
        assert settings.get_agent_settings(path)["connection_id"] == first["connection_id"]


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"])
def test_local_macos_web_uses_mock_keyring_for_save_and_reread(workspace, monkeypatch, host):
    path, _ = workspace
    credentials = {}
    keyring = SimpleNamespace(get_password=lambda service, account: credentials.get((service, account)), set_password=lambda service, account, value: credentials.__setitem__((service, account), value), delete_password=lambda service, account: credentials.pop((service, account), None))
    monkeypatch.setitem(sys.modules, "keyring", keyring)
    monkeypatch.setattr(secret_store.sys, "platform", "darwin")
    monkeypatch.delenv("TUANTUAN_SECRET_BACKEND")
    monkeypatch.setenv("BIND_HOST", host)
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "local")
    monkeypatch.setenv("TUANTUAN_DESKTOP", "false")
    assert secret_store._backend() == "keyring"
    saved = configured(workspace)
    assert saved["api_key_source"] == "keyring" and saved["secret_storage_writable"]
    assert settings.get_model_connection(path)["api_key"] == "audit-fake-old-credential" and len(credentials) == 1


@pytest.mark.parametrize("host,mode,platform", [("0.0.0.0", "hosted", "darwin"), ("127.0.0.1", "hosted", "darwin"), ("127.0.0.1", "local", "linux")])
def test_hosted_or_unsupported_platform_default_is_readonly(workspace, monkeypatch, host, mode, platform):
    path, _ = workspace
    monkeypatch.delenv("TUANTUAN_SECRET_BACKEND")
    monkeypatch.setattr(secret_store.sys, "platform", platform)
    monkeypatch.setenv("BIND_HOST", host)
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", mode)
    assert secret_store._backend() == "environment"
    assert not settings.get_agent_settings(path)["secret_storage_writable"]
    before = raw_settings(path)
    with pytest.raises(secret_store.SecretStoreUnavailable, match="只读环境密钥"):
        settings.save_agent_settings({"model_name": "test-model", "api_key": "audit-fake-new-credential"}, path)
    assert raw_settings(path) == before


def test_v25_additive_upgrade_preserves_configuration_and_is_idempotent(workspace):
    path, _ = workspace
    fields = ["connection_id", "config_revision", "last_save_request_id", "model_secret_ref", "model_config_initialized"]
    with connect(path) as conn:
        conn.execute("UPDATE agent_settings SET model_name = 'legacy-model', model_base_url = 'https://legacy.example.test/v1', custom_instructions = 'Keep this preference'")
        for field in fields:
            conn.execute(f"ALTER TABLE agent_settings DROP COLUMN {field}")
        conn.execute("DROP TABLE model_settings_requests")
        conn.execute("DELETE FROM schema_migrations WHERE version > 25")
        conn.execute("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (25, 'old_v25')")
    init_db(path)
    first = settings.get_agent_settings(path)
    init_db(path)
    second = settings.get_agent_settings(path)
    assert first["connection_id"] == second["connection_id"] and first["config_revision"] == second["config_revision"] == 0
    assert second["model_name"] == "legacy-model" and second["custom_instructions"] == "Keep this preference"
    assert second["model_base_url"] == "https://legacy.example.test/v1"
    with connect(path) as conn:
        assert conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == DB_SCHEMA_VERSION
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
