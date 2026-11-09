from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from app import db
from app.attachments.service import AttachmentStore, attachment_thumbnail, create_attachment, delete_attachment
from app.chat.artifacts import ArtifactConflict, SaveArtifactIn, fenced_blocks, message_artifacts, save_artifact
from app.chat.conversations import create_conversation, delete_conversation
from app.chat.service import save_chat_message
from app.db import connect, init_db, json_dump
from app.library.organization import create_folder
from app.library.sources import get_source_file, list_sources, update_source
from app.main import app
from app.workspace import use_workspace
from api_client import create_authenticated_client, register_authenticated_client


@pytest.fixture
def archive(tmp_path, monkeypatch):
    path = tmp_path / "chat.db"
    init_db(path)
    monkeypatch.setattr("app.attachments.service.get_attachment_store", lambda: AttachmentStore(local_root=tmp_path / "attachments"))
    conversation = create_conversation("成果测试", path)
    def message(content="# 海王星资料\n\n```python\nprint('hello')\n```\n", status="done", payload=None, role="assistant"):
        with connect(path) as conn:
            cursor = conn.execute("INSERT INTO chat_messages (conversation_id,role,content,payload_json) VALUES (?,?,?,?)",
                                  (conversation["id"], role, content, json_dump(payload or {"agent": {"status": status, "events": []}})))
        return int(cursor.lastrowid)
    return path, conversation["id"], message


def save(path, message_id, *, selector="answer", filename="回答.md", **changes):
    manifest = message_artifacts(message_id, path)
    request = SaveArtifactIn(selector=selector, snapshot=manifest["snapshot"], filename=filename, **changes)
    return save_artifact(message_id, request, path)


def test_error_only_answer_is_not_an_artifact_but_partial_work_is(archive):
    path, _, message = archive
    payload = {"agent": {"status": "failed", "events": [], "error": {"code": "image_generation_not_executed", "message": "未返回图片"}}}
    error_id = message(content="未返回图片", payload=payload)
    assert message_artifacts(error_id, path)["artifacts"] == []
    partial_id = message(content="已整理的部分正文", payload=payload)
    manifest = message_artifacts(partial_id, path)
    assert manifest["incomplete"] and manifest["artifacts"][0]["kind"] == "answer"
    assert "已整理的部分正文" in manifest["artifacts"][0]["content"]


def test_markdown_sources_code_and_private_metadata(archive):
    path, _, message = archive
    mid = message(payload={"agent": {"status": "done", "model_selection": {"model_name": "test-model", "api_key": "do-not-export"}, "events": [
        {"tool_name": "search_public_web", "data": {"sources": [
            {"title": "官网", "url": "https://example.com/article?token=secret&lang=zh"},
            {"title": "私有路径", "url": "file:///private/person.txt"},
            {"title": "内嵌凭据", "url": "https://user:secret@example.com/private"}]}},
        {"tool_name": "search_library", "data": {"excerpts": [{"title": "本地笔记", "source_id": 12}]}}
    ]}})
    manifest = message_artifacts(mid, path)
    assert [a["kind"] for a in manifest["artifacts"]] == ["answer", "code"]
    answer = manifest["artifacts"][0]["content"]
    assert "https://example.com/article?lang=zh" in answer and "本地资料 ID：12" in answer
    assert "secret" not in answer and "file:///" not in answer and "do-not-export" not in answer
    source = save(path, mid)["source"]
    assert not source["enabled"] and source["file_status"] == "ready"
    assert source["metadata"]["chat_archive"]["model_name"] == "test-model"
    assert "api_key" not in str(source["metadata"])
    stored, filename, mime = get_source_file(source["id"], path)
    assert filename == "回答.md" and mime == "text/markdown" and stored.read_text(encoding="utf-8") == answer
    with connect(path) as conn:
        assert not conn.execute("SELECT 1 FROM knowledge_chunks WHERE source_type='library_source'").fetchone()


def test_save_code_preserves_newlines_and_chosen_folder(archive):
    path, _, message = archive
    mid = message("```python\r\na = 1\r\n\r\nprint(a)\r\n```\r\n")
    folder = create_folder("生成代码", path)
    code = message_artifacts(mid, path)["artifacts"][1]
    source = save(path, mid, selector=code["selector"], filename="示例.py", folder_id=folder["id"])["source"]
    assert source["folder_id"] == folder["id"]
    assert get_source_file(source["id"], path)[0].read_bytes() == b"a = 1\r\n\r\nprint(a)\r\n"


def test_same_snapshot_is_idempotent_under_concurrent_requests(archive):
    path, _, message = archive
    mid = message()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: save(path, mid), range(2)))
    assert results[0]["source"]["id"] == results[1]["source"]["id"]
    assert sorted(r["reused"] for r in results) == [False, True]
    assert len(list_sources(path)) == 1


def test_stale_snapshot_and_invalid_selector_folder_or_extension_do_not_write(archive):
    path, _, message = archive
    mid = message()
    old = message_artifacts(mid, path)
    with connect(path) as conn:
        conn.execute("UPDATE chat_messages SET content='更新后的回答' WHERE id=?", (mid,))
    with pytest.raises(ArtifactConflict, match="更新"):
        save_artifact(mid, SaveArtifactIn(selector="answer", snapshot=old["snapshot"], filename="回答.md"), path)
    for changes in ({"selector": "code:999"}, {"folder_id": 999}, {"filename": "回答.exe"}):
        with pytest.raises(ValueError):
            save(path, mid, **changes)
    assert list_sources(path) == []


def test_enabled_archive_indexes_redacted_text_only(archive):
    path, _, message = archive
    mid = message("海王星笔记 reader@example.com")
    source = save(path, mid, enabled=True)["source"]
    assert source["enabled"] and "reader@example.com" not in source["redacted_content"]
    with connect(path) as conn:
        chunks = conn.execute("SELECT content FROM knowledge_chunks WHERE source_type='library_source'").fetchall()
        assert chunks and all("reader@example.com" not in row["content"] for row in chunks)


def test_disk_failure_rolls_back_record_and_removes_partial_directory(archive, monkeypatch):
    path, _, message = archive
    mid = message()
    original = Path.write_bytes
    def fail(target, content):
        if target.name == "回答.md":
            original(target, content[:3])
            raise OSError("disk full")
        return original(target, content)
    monkeypatch.setattr(Path, "write_bytes", fail)
    with pytest.raises(OSError):
        save(path, mid)
    assert list_sources(path) == []
    assert not list((path.parent / "library").glob("*/回答.md"))


def test_archived_attachment_and_image_are_independent_of_chat(archive):
    path, cid, message = archive
    buffer = BytesIO()
    Image.new("RGB", (800, 400), "white").save(buffer, "PNG")
    original = buffer.getvalue()
    attachment = create_attachment(cid, "image", "示意图.png", original, db_path=path)
    mid = message("图片", role="user", payload={"attachments": [attachment]})
    selector = f"attachment:{attachment['id']}"
    manifest = message_artifacts(mid, path)
    assert not manifest["artifacts"][0]["can_index"]
    with pytest.raises(ValueError, match="可检索文字"):
        save(path, mid, selector=selector, filename="示意图.png", enabled=True)
    source = save(path, mid, selector=selector, filename="示意图.png")["source"]
    assert source["text_parse_status"] == "not_required" and source["file_status"] == "ready"
    assert not source["enabled"]
    with pytest.raises(ValueError, match="可检索文字"):
        update_source(source["id"], enabled=True, db_path=path)
    thumbnail = attachment_thumbnail(attachment["id"], db_path=path)
    with Image.open(BytesIO(thumbnail)) as image:
        assert image.format == "WEBP" and image.width <= 480 and image.height <= 320
    delete_attachment(attachment["id"], db_path=path)
    delete_conversation(cid, path)
    assert get_source_file(source["id"], path)[0].read_bytes() == original


@pytest.mark.parametrize("status", ["failed", "cancelled"])
def test_incomplete_result_has_explicit_archive_marker(archive, status):
    path, _, message = archive
    mid = message("保留的半段回答", status=status)
    source = save(path, mid)["source"]
    assert source["content"].startswith("> 未完成") and source["metadata"]["chat_archive"]["incomplete"]


def test_waiting_user_result_is_not_a_final_artifact(archive):
    path, _, message = archive
    mid = message("确认是否继续", status="waiting_user")
    with pytest.raises(ArtifactConflict):
        message_artifacts(mid, path)


def test_fences_preserve_inner_fences_and_ignore_unclosed_output():
    blocks = fenced_blocks("````text\n```python\nprint(1)\n```\n````\n~~~mermaid\nflowchart LR\nA-->B\n~~~\n```py\nhalf")
    assert len(blocks) == 2 and blocks[0]["content"] == "```python\nprint(1)\n```\n"
    assert blocks[1]["language"] == "mermaid"


def test_artifact_api_and_thumbnail_require_auth_and_isolate_accounts(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "api.db")
    init_db()
    owner = create_authenticated_client(app)
    other = register_authenticated_client(app, "another@example.com")
    try:
        with use_workspace(1):
            conversation = create_conversation("API 成果")
            message = save_chat_message("assistant", "# 原回答", {}, conversation_id=conversation["id"])
            buffer = BytesIO()
            Image.new("RGB", (64, 64), "white").save(buffer, "PNG")
            attachment = create_attachment(conversation["id"], "image", "private.png", buffer.getvalue())
        manifest = owner.get(f"/chat/messages/{message['id']}/artifacts")
        assert manifest.status_code == 200
        request = {"selector": "answer", "snapshot": manifest.json()["snapshot"], "filename": "回答.md"}
        assert other.get(f"/chat/messages/{message['id']}/artifacts").status_code == 404
        assert other.post(f"/chat/messages/{message['id']}/save-to-library", json=request).status_code == 404
        stored = owner.post(f"/chat/messages/{message['id']}/save-to-library", json=request)
        assert stored.status_code == 200
        source_id = stored.json()["source"]["id"]
        assert owner.get(f"/library/sources/{source_id}/file").content == b"# \xe5\x8e\x9f\xe5\x9b\x9e\xe7\xad\x94"
        assert other.get(f"/library/sources/{source_id}/file").status_code == 404
        thumbnail = owner.get(f"/attachments/{attachment['id']}/thumbnail")
        assert thumbnail.status_code == 200 and thumbnail.headers["content-type"] == "image/webp"
        assert thumbnail.headers["cache-control"] == "no-store"
        assert other.get(f"/attachments/{attachment['id']}/thumbnail").status_code == 404
        token = owner.headers.pop("Authorization")
        assert owner.get(f"/chat/messages/{message['id']}/artifacts").status_code == 401
        assert owner.get("/attachments/private/thumbnail").status_code == 401
        owner.headers["Authorization"] = token
    finally:
        owner.close(); other.close()
