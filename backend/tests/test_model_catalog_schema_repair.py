"""A v36 workspace may predate the corrected catalog-cache schema placement."""
import sqlite3

import pytest

from app.db import DB_SCHEMA_VERSION, connect, init_db
from app.persistence.schema import AUTH_SCHEMA
from test_model_catalog_api import client  # noqa: F401


def test_current_version_missing_cache_is_backed_up_and_repaired_without_changing_models(tmp_path):
    path = tmp_path / "workspace.db"
    init_db(path)
    with connect(path) as conn:
        conn.execute("INSERT INTO model_connections(id,name,effective_base_url,data_boundary) VALUES('saved','Saved','https://example.test/v1','saved')")
        conn.execute("INSERT INTO model_profiles(id,connection_id,model_name,name,parameters_json) VALUES('profile','saved','gpt-4.1','Saved model','{\"temperature\":0.2}')")
        original = conn.execute("SELECT * FROM model_profiles").fetchall()
        conn.execute("DROP TABLE model_catalog_entries")
        versions = conn.execute("SELECT * FROM schema_migrations").fetchall()
    init_db(path)
    with connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM model_catalog_entries").fetchone()[0] == 0
        assert conn.execute("SELECT * FROM model_profiles").fetchall() == original
        assert conn.execute("SELECT * FROM schema_migrations").fetchall() == versions
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    backup = tmp_path / ".upgrade-backups" / f"before-schema-v{DB_SCHEMA_VERSION}-catalog-repair" / path.name
    assert backup.is_file()
    with sqlite3.connect(backup) as conn:
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='model_catalog_entries'").fetchone() is None
        assert conn.execute("SELECT model_name FROM model_profiles").fetchone()[0] == "gpt-4.1"
    saved_time = backup.stat().st_mtime_ns
    init_db(path)
    assert backup.stat().st_mtime_ns == saved_time


def test_newer_schema_missing_cache_is_rejected_without_repair(tmp_path):
    path = tmp_path / "future.db"
    init_db(path)
    with connect(path) as conn:
        conn.execute("DROP TABLE model_catalog_entries")
        conn.execute("UPDATE schema_migrations SET version=?", (DB_SCHEMA_VERSION + 1,))
    with pytest.raises(ValueError, match="更新版本"):
        init_db(path)
    with connect(path) as conn:
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='model_catalog_entries'").fetchone() is None


def test_auth_database_does_not_own_workspace_catalog_cache():
    with sqlite3.connect(":memory:") as conn:
        conn.executescript(AUTH_SCHEMA)
        assert conn.execute("SELECT name FROM sqlite_master WHERE name='model_catalog_entries'").fetchone() is None


def test_connection_api_recovers_missing_cache_and_still_saves_services(client):
    created = client.post("/agent/model-connections", json={"name": "Existing", "model_base_url": "https://existing.example.test/v1", "api_key": "synthetic-existing", "model_name": "gpt-4.1"})
    assert created.status_code == 200, created.text
    with connect() as conn:
        conn.execute("DROP TABLE model_catalog_entries")
    response = client.get("/agent/model-connections")
    assert response.status_code == 200, response.text
    assert any(item["name"] == "Existing" for item in response.json()["connections"])
    saved = client.post("/agent/model-connections", json={"name": "New", "model_base_url": "https://new.example.test/v1", "api_key": "synthetic-new"})
    assert saved.status_code == 200, saved.text
    assert {"Existing", "New"} <= {item["name"] for item in saved.json()["connections"]}
