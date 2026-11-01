from __future__ import annotations

import pytest
import subprocess
import sys
from cryptography.fernet import Fernet

from app import db, secret_store
from app.agent import settings
from app.model_connection import normalize_api_root
from app.workspace import ensure_workspace, use_workspace


@pytest.fixture
def hosted(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    monkeypatch.delenv("TUANTUAN_SECRET_BACKEND", raising=False)
    monkeypatch.setenv("TUANTUAN_SECRET_MASTER_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("TUANTUAN_MODEL_ALLOWED_HOSTS", "models.example.test")
    return tmp_path


def test_users_have_persistent_isolated_encrypted_model_keys(hosted):
    roots = [ensure_workspace(user_id) for user_id in (101, 102)]
    references = []
    for user_id, root in zip((101, 102), roots):
        with use_workspace(user_id, root):
            settings.save_agent_settings({"model_name": f"model-{user_id}", "model_base_url": "https://models.example.test/v1", "api_key": f"secret-{user_id}"})
            assert settings.get_model_connection()["api_key"] == f"secret-{user_id}"
            with db.connect(root / "tuantuan.db") as conn:
                references.append(conn.execute("SELECT model_secret_ref FROM agent_settings").fetchone()[0])
            assert f"secret-{user_id}" not in str(settings.get_agent_settings())
            assert all(f"secret-{user_id}".encode() not in path.read_bytes() for path in (root / ".model-secrets").iterdir())
    with use_workspace(102, roots[1]):
        with pytest.raises(secret_store.SecretStoreUnavailable):
            secret_store.get_secret(references[0])
    # Reads come from encrypted files, not the process-local memory backend.
    secret_store._MEMORY_SECRETS.clear()
    with use_workspace(101, roots[0]):
        assert settings.get_model_connection()["api_key"] == "secret-101"
    result = subprocess.run(
        [sys.executable, "-c", "import sys; from app.secret_store import get_secret; assert get_secret(sys.argv[1], sys.argv[2]) == 'secret-101'", references[0], str(roots[0] / "tuantuan.db")],
        capture_output=True, text=True, check=False,
    )
    assert result.returncode == 0, result.stderr


def test_new_hosted_workspace_does_not_import_environment_model(hosted, monkeypatch):
    from app.config import get_settings
    monkeypatch.setenv("OPENAI_API_KEY", "server-key")
    monkeypatch.setenv("MODEL_NAME", "server-model")
    get_settings.cache_clear()
    try:
        root = ensure_workspace(103)
        with use_workspace(103, root):
            result = settings.get_agent_settings()
            assert result["model_name"] == ""
            assert not result["api_key_configured"]
    finally:
        get_settings.cache_clear()


def test_wrong_master_key_fails_closed(hosted, monkeypatch):
    root = ensure_workspace(104)
    with use_workspace(104, root):
        reference = secret_store.create_model_api_key("secret", "connection")
        monkeypatch.setenv("TUANTUAN_SECRET_MASTER_KEY", Fernet.generate_key().decode())
        with pytest.raises(secret_store.SecretStoreUnavailable):
            secret_store.get_secret(reference)


@pytest.mark.parametrize("url", ["http://models.example.test/v1", "https://127.0.0.1/v1", "https://unapproved.example.test/v1"])
def test_hosted_model_urls_require_authorized_https_hosts(hosted, url):
    with pytest.raises(ValueError, match="托管模式"):
        normalize_api_root(url)


def test_authorized_host_is_accepted(hosted):
    assert normalize_api_root("https://models.example.test/v1") == "https://models.example.test/v1"


def test_authenticated_users_manage_only_their_own_connections(hosted):
    from api_client import register_authenticated_client
    from app.main import app

    first = register_authenticated_client(app, "first@example.test")
    second = register_authenticated_client(app, "second@example.test")
    response = first.post("/agent/model-connections", json={
        "name": "first", "model_base_url": "https://models.example.test/v1",
        "model_name": "model-first", "api_key": "first-private-key",
    })
    assert response.status_code == 200, response.text
    connection_id = response.json()["connections"][0]["id"]
    assert "first-private-key" not in response.text
    assert second.get("/agent/model-connections").json()["connections"] == []
    denied = second.patch(f"/agent/model-connections/{connection_id}", json={"expected_revision": 1, "name": "stolen"})
    assert denied.status_code == 400
    assert first.get("/agent/model-connections").json()["connections"][0]["name"] == "first"
