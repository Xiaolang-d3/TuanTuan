"""Opening configuration must not authenticate against the user's keychain."""
from types import SimpleNamespace
from unittest.mock import Mock
import sys

import pytest

from app import db, secret_store
from app.agent import settings, bootstrap
from app.agent.model_catalog import get_model_catalog, get_profile_connection
from app.agent.model_routing import profile_capability_report
from app.api.model import model_capabilities_get
from app.config import Settings
from app.observability.model_monitor import get_model_monitor_snapshot


@pytest.fixture
def saved_keychain(tmp_path, monkeypatch):
    path = tmp_path / "keychain.db"
    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db(path)
    config = Settings(model_name="test-model", model_base_url="https://model.example.test/v1")
    monkeypatch.setattr(settings, "get_settings", lambda: config)
    monkeypatch.setattr(bootstrap, "get_settings", lambda: config)
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "keyring")
    credentials = {}
    reader = Mock(side_effect=lambda service, account: credentials.get((service, account)))
    monkeypatch.setitem(sys.modules, "keyring", SimpleNamespace(
        get_password=reader,
        set_password=lambda service, account, value: credentials.__setitem__((service, account), value),
        delete_password=lambda service, account: credentials.pop((service, account), None),
    ))
    saved = settings.save_agent_settings({"api_key": "synthetic-keychain-test-key"}, path)
    reader.reset_mock()
    return path, saved, reader, credentials


def test_display_endpoints_do_not_read_keychain_or_build_providers(saved_keychain, monkeypatch):
    path, saved, reader, _ = saved_keychain
    reader.side_effect = AssertionError("display tried to read a real secret")
    monkeypatch.setattr(bootstrap, "_cached_components", Mock(side_effect=AssertionError("display built provider")))
    for _ in range(3):
        public = settings.get_agent_settings(path)
        assert public["api_key_configured"] and public["credential_status"] == "saved_unverified"
        catalog = get_model_catalog(path)
        assert catalog["connections"][0]["api_key_configured"]
        assert catalog["connections"][0]["credential_status"] == "saved_unverified"
        assert get_model_monitor_snapshot(db_path=path)["api_key_configured"]
        assert model_capabilities_get()["model_name"] == saved["model_name"]
        assert profile_capability_report(saved["profile_id"], path)["model_name"] == saved["model_name"]
        capabilities = bootstrap.get_agent_capabilities()
        assert capabilities["configured"] and capabilities["credential_status"] == "saved_unverified"
        assert "synthetic-keychain-test-key" not in str([public, catalog, capabilities])
    reader.assert_not_called()


def test_execution_still_reads_key_and_detects_revocation(saved_keychain):
    path, saved, reader, credentials = saved_keychain
    actual = get_profile_connection(saved["profile_id"], path)
    assert actual["api_key"] == "synthetic-keychain-test-key"
    assert actual["credential_status"] == "available" and reader.call_count == 1
    credentials.clear()
    with pytest.raises(secret_store.SecretStoreUnavailable, match="暂不可读取"):
        get_profile_connection(saved["profile_id"], path)
    assert reader.call_count == 3  # Current slot, then legacy service fallback.


def test_preview_cannot_restore_run_or_bypass_workspace_boundary(saved_keychain, tmp_path):
    path, saved, reader, _ = saved_keychain
    actual = get_profile_connection(saved["profile_id"], path)
    reader.reset_mock()
    with pytest.raises(ValueError, match="恢复运行必须校验"):
        get_profile_connection(selection={"profile_id": saved["profile_id"]}, db_path=path, resolve_credentials=False)
    with pytest.raises(secret_store.SecretStoreUnavailable, match="当前工作区"):
        secret_store.secret_reference_backend(actual["secret_ref"], tmp_path / "other.db")
    reader.assert_not_called()
