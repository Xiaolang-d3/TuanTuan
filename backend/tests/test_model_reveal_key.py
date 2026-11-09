from cryptography.fernet import Fernet

from api_client import register_authenticated_client
from app import db
from app.main import app


def test_reveal_key_is_scoped_to_the_authenticated_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    monkeypatch.delenv("TUANTUAN_SECRET_BACKEND", raising=False)
    monkeypatch.setenv("TUANTUAN_SECRET_MASTER_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("TUANTUAN_MODEL_ALLOWED_HOSTS", "models.example.test")
    with register_authenticated_client(app, "owner@example.test") as owner, register_authenticated_client(app, "other@example.test") as other:
        created = owner.post("/agent/model-connections", json={
            "name": "owner", "model_base_url": "https://models.example.test/v1", "api_key": "private-test-key",
        })
        assert created.status_code == 200
        connection_id = created.json()["connections"][0]["id"]
        path = f"/agent/model-connections/{connection_id}/reveal-key"
        assert owner.post(path).json() == {"api_key": "private-test-key"}
        denied = other.post(path)
        assert denied.status_code == 400
        assert "private-test-key" not in denied.text
