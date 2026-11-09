from io import BytesIO

import pytest
from PIL import Image

from app import db
from app.attachments import service as attachments
from app.extensions.contracts import ExtensionContext
from app.presentations.sources import stage_sources
from app.workspace import use_workspace


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    with use_workspace(1):
        db.init_db()
        context = ExtensionContext.current()
        store = attachments.AttachmentStore(local_root=tmp_path / "attachments")
        monkeypatch.setattr(attachments, "get_attachment_store", lambda: store)
        yield context, store, tmp_path / "project"


def upload(scope, kind="document", name="资料.md", content="中文资料".encode()):
    return attachments.create_attachment(1, kind, name, content, store=scope[1])["id"]


def test_document_staged_as_markdown_without_host_paths(scope):
    context, _, root = scope
    attachment_id = upload(scope)
    sources = stage_sources([attachment_id], root, context)
    assert sources[0]["attachment_id"] == attachment_id
    assert sources[0]["path"] == f"sources/{attachment_id}.md"
    assert (root / sources[0]["path"]).read_text(encoding="utf-8") == "中文资料"
    assert sources[0]["sha256"]
    assert "object_key" not in sources[0]
    assert sources == stage_sources([attachment_id], root, context)


def test_images_are_staged_with_content_validation(scope):
    context, _, root = scope
    buffer = BytesIO()
    Image.new("RGB", (16, 9), "white").save(buffer, "PNG")
    attachment_id = upload(scope, "image", "../../图片.png", buffer.getvalue())
    sources = stage_sources([attachment_id], root, context)
    assert sources[0]["path"] == f"images/{attachment_id}.png"
    assert (root / sources[0]["path"]).read_bytes() == buffer.getvalue()


def test_cross_account_attachment_and_wrong_workspace_are_rejected(scope):
    context, _, root = scope
    attachment_id = upload(scope)
    with use_workspace(2):
        db.init_db()
        with pytest.raises(FileNotFoundError):
            stage_sources([attachment_id], root, ExtensionContext.current())
        with pytest.raises(PermissionError):
            stage_sources([attachment_id], root, context)
    assert not root.exists()


def test_metadata_hash_cannot_hide_replaced_image(scope):
    context, store, root = scope
    buffer = BytesIO()
    Image.new("RGB", (4, 4)).save(buffer, "PNG")
    attachment_id = upload(scope, "image", "x.png", buffer.getvalue())
    row = attachments.get_attachment(attachment_id)
    store._local_path(row["object_key"]).write_bytes(b"replacement")
    with pytest.raises(ValueError, match="校验"):
        stage_sources([attachment_id], root, context)


def test_document_uses_existing_redacted_parse_result(scope):
    context, _, root = scope
    attachment_id = upload(scope)
    with db.connect() as conn:
        conn.execute("UPDATE attachments SET parse_status='parsed',parsed_text='private',redacted_text='[已脱敏]' WHERE id=?", (attachment_id,))
    sources = stage_sources([attachment_id], root, context)
    assert (root / sources[0]["path"]).read_text(encoding="utf-8") == "[已脱敏]"


def test_source_limits_and_duplicate_ids_rejected(scope):
    context, _, root = scope
    attachment_id = upload(scope)
    for ids in [[attachment_id] * 2, ["../outside"], ["a" * 32] * 21]:
        with pytest.raises(ValueError):
            stage_sources(ids, root, context)
    assert not root.exists()


def test_failed_source_preflight_does_not_stage_partial_project(scope):
    context, _, root = scope
    attachment_id = upload(scope)
    with pytest.raises(FileNotFoundError):
        stage_sources([attachment_id, "a" * 32], root, context)
    assert not root.exists()
