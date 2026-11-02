from __future__ import annotations

import hashlib
import sqlite3
import sys
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import branding, db, secret_store, workspace


@pytest.mark.parametrize("suffix", ["DATA_DIR", "SECRET_BACKEND", "MODEL_BACKEND"])
def test_environment_prefers_current_and_falls_back(monkeypatch, suffix):
    current = f"TUANTUAN_{suffix}"
    monkeypatch.delenv(current, raising=False)
    monkeypatch.setenv(f"CAREERLOOP_{suffix}", "old")
    monkeypatch.setenv(f"DENGDENG_{suffix}", "older")
    assert branding.env(current) == "old"
    monkeypatch.setenv(current, "new")
    assert branding.env(current) == "new"
    monkeypatch.setenv(current, "")
    assert branding.env(current) == ""
    monkeypatch.delenv(current)
    monkeypatch.delenv(f"CAREERLOOP_{suffix}")
    assert branding.env(current) == "older"


@pytest.mark.parametrize("name", branding.LEGACY_DATABASE_NAMES)
def test_database_adoption_preserves_data_and_sidecars(tmp_path, name):
    old = tmp_path / name
    with closing(sqlite3.connect(old)) as conn:
        conn.execute("CREATE TABLE marker (value TEXT)")
        conn.execute("INSERT INTO marker VALUES ('retained')")
        conn.commit()
    for suffix in ("-wal", "-shm"):
        Path(f"{old}{suffix}").write_bytes(suffix.encode())
    target = branding.adopt_database(tmp_path)
    assert target.name == "tuantuan.db"
    for suffix in ("-wal", "-shm"):
        assert Path(f"{target}{suffix}").read_bytes() == suffix.encode()
        Path(f"{target}{suffix}").unlink()
    with closing(sqlite3.connect(target)) as conn:
        assert conn.execute("SELECT value FROM marker").fetchone()[0] == "retained"
    assert branding.adopt_database(tmp_path) == target
    assert not old.exists()


def test_database_adoption_keeps_existing_current_database(tmp_path):
    (tmp_path / "tuantuan.db").write_bytes(b"current")
    (tmp_path / "careerloop.db").write_bytes(b"legacy")
    assert branding.adopt_database(tmp_path).read_bytes() == b"current"
    assert (tmp_path / "careerloop.db").read_bytes() == b"legacy"


@pytest.mark.parametrize("name", branding.LEGACY_DATABASE_NAMES)
def test_workspace_discovery_and_routing_adopts_old_database(tmp_path, monkeypatch, name):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    root = tmp_path / "workspaces" / "42"
    root.mkdir(parents=True)
    (root / name).write_bytes(b"workspace")
    assert workspace.existing_workspace_roots() == [root]
    with workspace.use_workspace(42):
        assert workspace.resolve_db_path() == root / "tuantuan.db"
    assert (root / "tuantuan.db").read_bytes() == b"workspace"


@pytest.mark.parametrize("name", branding.LEGACY_DATABASE_NAMES)
def test_secret_references_survive_database_rename(tmp_path, monkeypatch, name):
    old_path = tmp_path / name
    old_namespace = "workspace:" + hashlib.sha256(str(old_path.resolve()).encode()).hexdigest()[:24]
    account = old_namespace + ":connection:sample:version:1"
    reference = "keyring:" + account
    secrets = {(branding.LEGACY_KEYRING_SERVICE, account): "retained-key"}
    keyring = SimpleNamespace(get_password=lambda service, key: secrets.get((service, key)), set_password=lambda service, key, value: secrets.__setitem__((service, key), value))
    monkeypatch.setitem(sys.modules, "keyring", keyring)
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "keyring")
    assert secret_store.get_secret(reference, tmp_path / "tuantuan.db") == "retained-key"
    assert secrets[(secret_store.SERVICE_NAME, account)] == "retained-key"
    with pytest.raises(secret_store.SecretStoreUnavailable):
        secret_store.get_secret(reference, tmp_path / "other" / "tuantuan.db")


def test_keyring_fallback_survives_failed_migration(tmp_path, monkeypatch):
    keyring = SimpleNamespace(get_password=lambda service, account: "old-key" if service == branding.LEGACY_KEYRING_SERVICE else None, set_password=Mock(side_effect=RuntimeError("locked")))
    monkeypatch.setitem(sys.modules, "keyring", keyring)
    assert secret_store._keyring_read("user:42:model-api-key", tmp_path / "tuantuan.db") == "old-key"


@pytest.mark.parametrize("legacy_exists", [False, True])
def test_minio_default_uses_legacy_bucket_for_every_operation(tmp_path, monkeypatch, legacy_exists):
    from app.attachments.service import AttachmentStore
    store = AttachmentStore(tmp_path, storage="minio")
    store.settings = store.settings.model_copy(update={"minio_bucket": "tuantuan-attachments", "minio_public_endpoint": "files.example.test"})
    response = Mock()
    response.read.return_value = b"image"
    client = Mock()
    client.bucket_exists.side_effect = lambda bucket: legacy_exists if bucket == branding.LEGACY_ATTACHMENT_BUCKET else False
    client.get_object.return_value = response
    monkeypatch.setattr(store, "_minio_client", lambda **kwargs: client)
    expected = branding.LEGACY_ATTACHMENT_BUCKET if legacy_exists else "tuantuan-attachments"
    stored = store.put("aabb", "image.png", b"image")
    assert client.put_object.call_args.args[0] == expected
    assert store.get(stored.object_key) == b"image"
    assert client.get_object.call_args.args[0] == expected
    store.presigned_get_url(stored.object_key)
    assert client.presigned_get_object.call_args.args[0] == expected
    store.delete(stored.object_key)
    assert client.remove_object.call_args.args[0] == expected


def test_explicit_minio_bucket_never_probes_legacy_default(tmp_path, monkeypatch):
    from app.attachments.service import AttachmentStore
    store = AttachmentStore(tmp_path, storage="minio")
    store.settings = store.settings.model_copy(update={"minio_bucket": "tuantuan-attachments", "minio_bucket_legacy_fallback": False})
    client = Mock()
    monkeypatch.setattr(store, "_minio_client", lambda **kwargs: client)
    assert store._bucket() == "tuantuan-attachments"
    client.bucket_exists.assert_not_called()


def test_encrypted_secret_survives_database_rename(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "encrypted")
    monkeypatch.setenv("TUANTUAN_SECRET_MASTER_KEY", Fernet.generate_key().decode())
    old = tmp_path / branding.LEGACY_DATABASE_NAMES[0]
    reference = secret_store.create_model_api_key("retained-encrypted-key", "connection", old)
    assert secret_store.get_secret(reference, tmp_path / "tuantuan.db") == "retained-encrypted-key"


def test_display_names_only_normalize_product_defaults():
    for old in ("CareerLoop", "BossCopilot", "Dengdeng", "灯灯"):
        assert branding.display_name(old) == "团团"
    assert branding.display_name("我的助手") == "我的助手"


@pytest.mark.parametrize("prefix", ["TUANTUAN_", "CAREERLOOP_", "DENGDENG_"])
def test_health_identity_uses_current_brand_and_compatible_instance_env(monkeypatch, prefix):
    from app.api.system import health
    for name in ("TUANTUAN_INSTANCE_ID", "CAREERLOOP_INSTANCE_ID", "DENGDENG_INSTANCE_ID"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv(prefix + "INSTANCE_ID", "branding-test-instance")
    assert health()["service"] == "tuantuan"
    assert health()["instance_id"] == "branding-test-instance"


def test_database_adoption_does_not_overwrite_orphaned_destination_sidecars(tmp_path):
    legacy = tmp_path / "careerloop.db"
    legacy.write_bytes(b"legacy")
    sidecar = tmp_path / "tuantuan.db-wal"
    sidecar.write_bytes(b"retained-wal")
    with pytest.raises(FileExistsError):
        branding.adopt_database(tmp_path)
    assert legacy.read_bytes() == b"legacy"
    assert sidecar.read_bytes() == b"retained-wal"


def test_database_adoption_rolls_back_if_a_sidecar_cannot_move(tmp_path, monkeypatch):
    legacy = tmp_path / "careerloop.db"
    legacy.write_bytes(b"legacy")
    sidecar = tmp_path / "careerloop.db-wal"
    sidecar.write_bytes(b"retained-wal")
    rename = Path.rename
    def fail_sidecar(path, target):
        if path == sidecar:
            raise OSError("synthetic sidecar move failure")
        return rename(path, target)
    monkeypatch.setattr(Path, "rename", fail_sidecar)
    with pytest.raises(OSError, match="synthetic sidecar"):
        branding.adopt_database(tmp_path)
    assert legacy.read_bytes() == b"legacy"
    assert sidecar.read_bytes() == b"retained-wal"
    assert not (tmp_path / "tuantuan.db").exists()
