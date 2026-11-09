from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

from app.attachments.service import AttachmentStore, create_attachment, get_attachment_file, get_attachment_metadata
from app.db import connect, init_db


def test_original_file_and_metadata_do_not_require_parsing(tmp_path):
    db = tmp_path / "preview.db"
    init_db(db)
    store = AttachmentStore(local_root=tmp_path / "files")
    original = b"%PDF-1.7\nsynthetic test document"
    attachment = create_attachment(1, "document", "资料.pdf", original, db_path=db, store=store)
    path, filename, content_type = get_attachment_file(attachment["id"], db_path=db, store=store)
    assert path.read_bytes() == original
    assert filename == "资料.pdf" and content_type == "application/pdf"
    metadata = get_attachment_metadata(attachment["id"], db_path=db)
    assert metadata["parse_status"] == "pending"
    assert "object_key" not in metadata
    path.unlink()
    with pytest.raises(ValueError, match="原文件不存在"):
        get_attachment_file(attachment["id"], db_path=db, store=store)


@pytest.mark.parametrize("use_symlink", [False, True])
def test_attachment_file_cannot_escape_storage_root(tmp_path, use_symlink):
    db = tmp_path / "preview.db"
    init_db(db)
    store = AttachmentStore(local_root=tmp_path / "files")
    attachment = create_attachment(1, "document", "notes.txt", b"safe", db_path=db, store=store)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside")
    object_key = "../outside.txt"
    if use_symlink:
        try:
            (store.local_root / "alias.txt").symlink_to(outside)
        except OSError as exc:
            if getattr(exc, "winerror", None) == 1314:
                pytest.skip("Windows account lacks symlink privilege; lexical escape and ACL checks still run")
            raise
        object_key = "alias.txt"
    with connect(db) as conn:
        conn.execute("UPDATE attachments SET object_key = ? WHERE id = ?", (object_key, attachment["id"]))
    with pytest.raises(ValueError, match="路径无效"):
        get_attachment_file(attachment["id"], db_path=db, store=store)


def test_attachment_preview_api_is_private_and_preserves_original(tmp_path, monkeypatch):
    from app import db
    from app.main import app
    from api_client import register_authenticated_client

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    init_db()
    with register_authenticated_client(app, email="preview-owner@example.test") as owner:
        conversation_id = owner.get("/conversations").json()[0]["id"]
        original = "原始文件内容".encode()
        upload = owner.post("/attachments", data={"conversation_id": conversation_id, "kind": "document"}, files={"file": ("中文资料.txt", original, "text/plain")})
        upload.raise_for_status()
        attachment_id = upload.json()["id"]
        endpoint = f"/attachments/{attachment_id}/file"
        response = owner.get(endpoint)
        assert response.status_code == 200 and response.content == original
        assert response.headers["content-type"].startswith("text/plain")
        assert quote("中文资料.txt") in response.headers["content-disposition"]
        assert response.headers["cache-control"] == "no-store"
        metadata = owner.get(f"/attachments/{attachment_id}").json()
        assert metadata["size_bytes"] == len(original) and "object_key" not in metadata
        # The literal config route must not be shadowed by the metadata route.
        assert "storage" in owner.get("/attachments/config").json()
        with TestClient(app) as anonymous:
            assert anonymous.get(endpoint).status_code == 401
            assert anonymous.get(f"/attachments/{attachment_id}").status_code == 401
        with register_authenticated_client(app, email="preview-other@example.test") as other:
            assert other.get(endpoint).status_code == 404
            assert other.get(f"/attachments/{attachment_id}").status_code == 404
        assert owner.get(endpoint).content == original
        owner.delete(f"/attachments/{attachment_id}").raise_for_status()
        assert owner.get(endpoint).status_code == 404
