import json

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
    with (
        register_authenticated_client(app, "search-owner@example.test") as owner,
        register_authenticated_client(app, "search-other@example.test") as other,
    ):
        yield owner, other, app


def _user_id(client):
    return client.get("/auth/me").json()["user"]["id"]


def _search(client, q, **params):
    response = client.get("/search", params={"q": q, **params})
    assert response.status_code == 200, response.text
    assert response.headers["Cache-Control"] == "no-store"
    return response.json()


def _put_source(conn, source_id, title, *, original="", redacted="safe needle", mode="redacted", enabled=1,
                status="ready", metadata="{}", updated_at="2026-01-01 00:00:00"):
    conn.execute(
        "INSERT INTO library_sources (id, title, content_hash, content, redacted_content, privacy_mode, "
        "enabled, parse_status, metadata_json, updated_at) VALUES (?, ?, '', ?, ?, ?, ?, ?, ?, ?)",
        (source_id, title, original, redacted, mode, enabled, status, metadata, updated_at),
    )


def _seed_all(conn):
    conn.executemany(
        "INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, '2026-01-01 00:00:00')",
        [(101, "方案对话"), (102, "needle 图片专用会话"), (103, "needle 空草稿")],
    )
    conn.executemany(
        "INSERT INTO chat_messages (id, conversation_id, role, content, created_at) VALUES (?, ?, 'user', ?, '2026-01-02 00:00:00')",
        [(901, 101, "private-body NEEDLE"), (902, 102, "private-image-message needle")],
    )
    conn.executemany(
        "INSERT INTO image_studio_tasks (id, conversation_id, request_hash, prompt, status, created_at) "
        "VALUES (?, 102, '', ?, ?, '2026-01-03 00:00:00.125')",
        [("image", "private-image-prompt needle", "running"), ("removed", "private-removed needle", "done")],
    )
    conn.execute("INSERT INTO authored_documents (id, conversation_id, message_id, title) VALUES ('doc', 101, 901, 'needle 文档标题')")
    conn.execute(
        "INSERT INTO authored_document_versions (document_id, version, markdown, evidence_json, citations_json, created_at) "
        "VALUES ('doc', 1, '# needle 文档标题' || char(10) || 'private-markdown', '[]', '[]', '2026-01-04 00:00:00')"
    )
    conn.executemany(
        "INSERT INTO background_jobs (id, kind, idempotency_key, request_hash, request_json, snapshot_json, status, updated_at) "
        "VALUES (?, ?, ?, '', ?, '{}', 'succeeded', '2026-01-05 00:00:00')",
        [("deck", "ppt.generate", "ppt-key", json.dumps({"topic": "private-ppt-topic Needle", "conversation_id": 101, "api_key": "private-key"})),
         ("review", "document.review", "review-key", '{"topic":"needle"}'),
         ("invalid", "ppt.quick_generate", "invalid-key", "{malformed")],
    )
    conn.execute(
        "INSERT INTO projects (id, name, description, status, updated_at) "
        "VALUES ('project', '项目名称', 'private-project-description needle', 'archived', '2026-01-06 00:00:00')"
    )
    _put_source(conn, 201, "needle 归档图片", redacted="", enabled=0)
    conn.execute(
        "INSERT INTO image_studio_works (id, asset_id, source_id, asset_json, created_at) "
        "VALUES ('image-work', 'asset', 201, '{}', '2026-01-07 00:00:00')"
    )
    conn.execute(
        "INSERT INTO final_works (id, kind, source_id, source_version, filename, media_type, size, payload, created_at) "
        "VALUES ('final-work', 'document', 'doc', 1, 'needle 定稿.docx', 'text/plain', 1, x'41', '2026-01-08 00:00:00')"
    )
    _put_source(conn, 202, "项目资料", redacted="private-redacted-example needle", updated_at="2026-01-08 00:00:00")


def test_search_all_kinds_isolated_and_metadata_only(accounts):
    owner, other, app = accounts
    with use_workspace(_user_id(owner)), db.connect() as conn:
        _seed_all(conn)
    # Numeric IDs overlap across independent workspaces, without combining data.
    with use_workspace(_user_id(other)), db.connect() as conn:
        _put_source(conn, 202, "other-only", redacted="owner must not see this token")

    anonymous = TestClient(app).get("/search", params={"q": "needle"})
    assert anonymous.status_code == 401
    assert anonymous.headers["Cache-Control"] == "no-store"
    assert _search(other, "needle") == {"items": [], "has_more": False}
    assert _search(owner, "other-only") == {"items": [], "has_more": False}
    assert _search(other, "other-only")["items"][0]["id"] == "202"

    first = _search(owner, "  nEeDlE  ", limit=3)
    second = _search(owner, "needle", offset=3)
    assert first["has_more"] is True
    assert second["has_more"] is False
    items = first["items"] + second["items"]
    assert [(row["kind"], row["id"], row["title"], row["status"]) for row in items] == [
        ("final_work", "final-work", "needle 定稿.docx", None),
        ("knowledge", "202", "项目资料", None),
        ("image_work", "image-work", "needle 归档图片", None),
        ("project", "project", "项目名称", "archived"),
        ("presentation", "deck", "演示文稿", "succeeded"),
        ("document", "doc", "needle 文档标题", None),
        ("image", "image", "图片创作", "uncertain"),
        ("chat", "101", "方案对话", "active"),
    ]
    assert all(set(row) == {"kind", "id", "title", "updated_at", "conversation_id", "status"} for row in items)
    assert [row["conversation_id"] for row in items] == [None, None, None, None, 101, 101, 102, 101]
    assert items[-1]["updated_at"] == "2026-01-02T00:00:00.000Z"
    assert "private-" not in json.dumps(items)
    for row in items:
        assert _search(owner, "needle", kind=row["kind"]) == {"items": [row], "has_more": False}


def test_search_honors_library_visibility_and_does_not_mutate_state(accounts):
    owner, _, _ = accounts
    owner_id = _user_id(owner)
    with use_workspace(owner_id), db.connect() as conn:
        _put_source(conn, 1, "公开标题", original="original-only", redacted="redacted-visible needle")
        _put_source(conn, 2, "original 标题", original="opted-in-original needle", redacted="hidden-redacted-only", mode="original")
        _put_source(conn, 3, "needle 禁用", enabled=0)
        _put_source(conn, 4, "needle 待解析", status="pending")
        _put_source(conn, 5, "needle 已删除", metadata='{"organization":{"trashed_at":"2026-01-03"}}')
        _put_source(conn, 6, "needle 不完整元信息", metadata="invalid-json")
        _put_source(conn, 7, "needle 空白正文", redacted="\t \n")
        conn.execute("INSERT INTO image_studio_works(id, asset_id, source_id, asset_json) VALUES ('trashed-image','asset',5,'{}')")
        before = conn.execute("SELECT * FROM agent_settings").fetchone()

    assert [row["id"] for row in _search(owner, "needle")["items"]] == ["2", "1"]
    assert not _search(owner, "original-only")["items"]
    assert not _search(owner, "hidden-redacted-only")["items"]
    assert _search(owner, "opted-in-original")["items"][0]["title"] == "original 标题"
    with use_workspace(owner_id), db.connect() as conn:
        assert conn.execute("SELECT * FROM agent_settings").fetchone() == before
        assert conn.execute("SELECT count(*) FROM background_jobs").fetchone()[0] == 0
        conn.execute("UPDATE agent_settings SET knowledge_memory_enabled = 0")
    assert not _search(owner, "needle")["items"]
    with use_workspace(owner_id), db.connect() as conn:
        conn.execute("UPDATE agent_settings SET knowledge_memory_enabled = 1, library_memory_enabled = 0")
    assert not _search(owner, "needle")["items"]


def test_search_hides_private_derived_titles_and_matches_literals(accounts):
    owner, _, _ = accounts
    with use_workspace(_user_id(owner)), db.connect() as conn:
        conn.execute("INSERT INTO conversations(id, title, summary) VALUES (101, 'private first message', 'private-summary-only')")
        conn.execute("INSERT INTO chat_messages(id, conversation_id, role, content) VALUES (901, 101, 'user', '  private first\nmessage ')")
        conn.execute("INSERT INTO chat_messages(conversation_id, role, content) VALUES (101, 'system', 'private-system-only')")
        conn.execute("INSERT INTO authored_documents(id, conversation_id, message_id, title) VALUES ('doc', 101, 901, 'private paragraph')")
        conn.execute("INSERT INTO authored_document_versions(document_id, version, markdown, evidence_json, citations_json) VALUES ('doc', 1, 'private paragraph', '[]', '[]')")
        conn.execute("INSERT INTO projects(id, name) VALUES ('label', 'Straße 100%_[草案] api_key=private000')")

    assert _search(owner, "private first", kind="chat")["items"][0]["title"] == "对话"
    assert _search(owner, "private paragraph", kind="document")["items"][0]["title"] == "文档"
    assert not _search(owner, "private-system-only")["items"]
    assert not _search(owner, "private-summary-only")["items"]
    project = _search(owner, "STRASSE 100%_[草案]")["items"][0]
    assert project["title"] == "Straße 100%_[草案] api_key=***"
    assert not _search(owner, "%%")["items"]
    assert not _search(owner, "' OR 1=1 --")["items"]


def test_search_validates_bounds_without_echoing_queries(accounts):
    owner, _, _ = accounts
    assert _search(owner, " \t\u3000 ") == {"items": [], "has_more": False}
    for params in ({}, {"q": "secret" * 40}, {"q": "search", "kind": "private-invalid"},
                   {"q": "search", "limit": 0}, {"q": "search", "limit": 51},
                   {"q": "search", "offset": -1}, {"q": "search", "offset": 10_001}):
        response = owner.get("/search", params=params)
        assert response.status_code == 422
        assert response.headers["Cache-Control"] == "no-store"
        assert response.json() == {"detail": "无效的搜索参数"}
