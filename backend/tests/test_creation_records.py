from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from api_client import register_authenticated_client
from app import db
from app.jobs.worker import JobWorkerManager
from app.workspace import use_workspace


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    from app.main import app

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    monkeypatch.setattr(JobWorkerManager, "start", lambda self: None)
    with register_authenticated_client(app, "creation-owner@example.test") as owner, \
         register_authenticated_client(app, "creation-other@example.test") as other:
        yield owner, other, app


def test_records_join_sources_with_stable_pages_and_safe_fields(accounts):
    owner, other, app = accounts
    user_id = owner.get("/auth/me").json()["user"]["id"]
    with use_workspace(user_id), db.connect() as conn:
        conn.executemany(
            "INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, '2026-01-01 00:00:00')",
            [(101, "有内容的对话"), (102, "图片来源会话"), (103, "空草稿")],
        )
        conn.executemany(
            "INSERT INTO chat_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', 'private-body', '2026-01-02 00:00:00')",
            [(901, 101), (902, 102)],
        )
        conn.executemany(
            "INSERT INTO image_studio_tasks (id, conversation_id, request_hash, prompt, status, error, created_at) "
            "VALUES (?, 102, '', '图片提示词', ?, 'private-upstream-error', '2026-01-03 00:00:00.125')",
            [("orphan", "running"), ("removed-image", "done")],
        )
        conn.execute("INSERT INTO authored_documents (id, conversation_id, message_id, title) VALUES ('doc', 101, 901, '文档标题')")
        conn.execute(
            "INSERT INTO authored_document_versions (document_id, version, markdown, evidence_json, citations_json, created_at) "
            "VALUES ('doc', 1, 'private-markdown', '[]', '[]', '2026-01-04 00:00:00')"
        )
        conn.executemany(
            "INSERT INTO background_jobs (id, kind, idempotency_key, request_hash, request_json, snapshot_json, status, updated_at) "
            "VALUES (?, ?, ?, '', ?, '{}', 'succeeded', '2026-01-05 00:00:00')",
            [("deck", "ppt.generate", "ppt-key", '{"topic":"PPT 主题","conversation_id":101,"api_key":"private-key"}'),
             ("other", "document.review", "review-key", "{}")],
        )
    assert TestClient(app).get("/creation-records").status_code == 401
    assert other.get("/creation-records").json() == {"items": [], "has_more": False}
    first = owner.get("/creation-records", params={"limit": 2})
    assert first.status_code == 200, first.text
    assert first.headers["Cache-Control"] == "no-store"
    assert "private-" not in first.text
    assert first.json()["has_more"] is True
    assert [(row["kind"], row["id"], row["title"]) for row in first.json()["items"]] == [
        ("presentation", "deck", "PPT 主题"), ("document", "doc", "文档标题"),
    ]
    second = owner.get("/creation-records", params={"limit": 2, "offset": 2}).json()
    assert second == {"items": [
        {"kind": "image", "id": "orphan", "title": "图片提示词", "updated_at": "2026-01-03T00:00:00.125Z", "conversation_id": 102, "status": "uncertain"},
        {"kind": "chat", "id": "101", "title": "有内容的对话", "updated_at": "2026-01-02T00:00:00.000Z", "conversation_id": 101, "status": "active"},
    ], "has_more": False}
    assert owner.get("/creation-records", params={"kind": "image"}).json()["items"] == second["items"][:1]
    for params in ({"kind": "video"}, {"limit": 51}, {"offset": -1}):
        assert owner.get("/creation-records", params=params).status_code == 422
