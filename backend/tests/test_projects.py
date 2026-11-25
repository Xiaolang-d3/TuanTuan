from contextlib import contextmanager
from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from api_client import register_authenticated_client
from app import db
from app.jobs.worker import JobWorkerManager
from app.workspace import auth_db_path, use_workspace


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    from app.main import app

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    monkeypatch.setattr(JobWorkerManager, "start", lambda self: None)
    with register_authenticated_client(app, "project-owner@example.test") as owner, \
         register_authenticated_client(app, "project-other@example.test") as other:
        yield owner, other, TestClient(app)


@contextmanager
def workspace_db(client):
    user_id = client.get("/auth/me").json()["user"]["id"]
    with use_workspace(user_id), db.connect() as conn:
        yield conn


def expect(response, status):
    assert response.status_code == status, response.text
    assert response.headers["Cache-Control"] == "no-store"
    if status == 204:
        assert response.content == b""
        return None
    return response.json()


def create_project(client, name="项目", **fields):
    return expect(client.post("/projects", json={"name": name, **fields}), 201)


def link(client, project_id, kind, source_id, status=201):
    return expect(client.post(f"/projects/{project_id}/items", json={"kind": kind, "source_id": source_id}), status)


def seed_sources(conn):
    conn.execute("INSERT INTO conversations (id, title) VALUES (101, '活对话')")
    conn.execute("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES (902, 101, 'user', 'private-chat')")
    conn.executemany(
        "INSERT INTO image_studio_tasks (id, conversation_id, request_hash, prompt, status, error) "
        "VALUES (?, 101, '', '图片提示词', ?, 'private-image-error')",
        [("image-1", "running"), ("gone-image", "done")],
    )
    conn.execute("INSERT INTO authored_documents (id, conversation_id, message_id, title) VALUES ('doc-1', 101, 902, '文档')")
    conn.execute("INSERT INTO authored_document_versions (document_id, version, markdown, evidence_json, citations_json) "
                 "VALUES ('doc-1', 1, 'private-document', '[]', '[]')")
    conn.executemany(
        "INSERT INTO background_jobs (id, kind, idempotency_key, request_hash, request_json, snapshot_json, status) "
        "VALUES (?, ?, ?, '', ?, '{}', 'succeeded')",
        [("deck-1", "ppt.generate", "ppt-key", '{"topic":"演示主题","conversation_id":101,"api_key":"private-key"}'),
         ("deck-2", "ppt.quick_generate", "quick-key", '{"topic":"独立演示"}'),
         ("review-1", "document.review", "review-key", "{}")],
    )
    conn.execute("INSERT INTO library_sources (id, title, content_hash, content, enabled) "
                 "VALUES (321, '资料', 'hash', 'private-library', 0)")


def test_projects_crud_and_authentication(accounts):
    owner, other, anonymous = accounts
    expect(anonymous.get("/projects"), 401)
    expect(anonymous.post("/projects", json={"name": "匿名项目"}), 401)
    assert expect(owner.get("/projects"), 200) == {"items": []}
    assert expect(other.get("/projects"), 200) == {"items": []}

    project = create_project(owner, "  我的项目  ")
    project_id = project["id"]
    path = f"/projects/{project_id}"
    assert project == {"id": project_id, "name": "我的项目", "description": "",
                       "updated_at": project["created_at"], "created_at": project["created_at"]}
    assert datetime.fromisoformat(project["created_at"]).utcoffset().total_seconds() == 0
    assert expect(owner.get(path), 200) == {**project, "items": []}

    other_project = create_project(other, "另一个项目")
    assert expect(other.get("/projects"), 200) == {"items": [other_project]}
    expect(other.get(path), 404)
    expect(other.patch(path, json={"name": "无权修改"}), 404)
    link(other, project_id, "chat", "1", 404)
    expect(other.delete(f"{path}/items/chat/1"), 404)
    expect(other.delete(path), 404)

    patched = expect(owner.patch(path, json={"description": "项目描述"}), 200)
    assert patched["name"] == project["name"]
    assert patched["created_at"] == project["created_at"]
    assert patched["updated_at"] > project["updated_at"]
    patched = expect(owner.patch(path, json={"name": "改名", "description": ""}), 200)
    assert patched["name"] == "改名"
    assert patched["description"] == ""
    assert expect(owner.patch(path, json={}), 200) == patched
    assert expect(owner.get("/projects"), 200) == {"items": [patched]}
    expect(owner.delete(path), 204)
    expect(owner.get(path), 404)
    assert expect(owner.get("/projects"), 200) == {"items": []}
    with db.connect(auth_db_path()) as conn:
        assert conn.execute("SELECT name FROM sqlite_master WHERE name IN ('projects', 'project_items')").fetchall() == []


def test_link_projects_by_live_source_without_copying_or_owning_it(accounts):
    owner, other, _ = accounts
    with workspace_db(owner) as conn:
        seed_sources(conn)
    with workspace_db(other) as conn:
        conn.execute("INSERT INTO library_sources(id, title, content_hash) VALUES (444, 'other-only', 'other')")
        conn.execute("INSERT INTO library_sources(id, title, content_hash) VALUES (321, 'other-collision', 'collision')")
        conn.execute("INSERT INTO conversations(id, title) VALUES (101, 'other-chat')")

    project = create_project(owner)
    project_id = project["id"]
    path = f"/projects/{project_id}"
    assert expect(owner.get(path), 200)["items"] == []
    other_id = create_project(other)["id"]
    link(owner, project_id, "library", "444", 404)
    link(other, other_id, "document", "doc-1", 404)
    assert link(other, other_id, "library", "321")["title"] == "other-collision"
    assert link(other, other_id, "chat", "101")["title"] == "other-chat"

    for kind, source_id in [("image", "gone-image"), ("presentation", "review-1"), ("chat", "101.0"),
                            ("library", "0321"), ("library", "9223372036854775808")]:
        link(owner, project_id, kind, source_id, 404)

    expected = {
        ("chat", "101"): ("活对话", 101),
        ("image", "image-1"): ("图片提示词", 101),
        ("document", "doc-1"): ("文档", 101),
        ("presentation", "deck-1"): ("演示主题", 101),
        ("presentation", "deck-2"): ("独立演示", None),
        ("library", "321"): ("资料", None),
    }

    def assert_items(items, expected_items):
        assert len(items) == len(expected_items)
        for item in items:
            assert set(item) == {"kind", "source_id", "title", "conversation_id"}
        assert {(item["kind"], item["source_id"]): (item["title"], item["conversation_id"])
                for item in items} == expected_items

    for key, details in expected.items():
        assert_items([link(owner, project_id, *key)], {key: details})
    assert link(owner, project_id, "chat", "101")["title"] == "活对话"
    detail = owner.get(path)
    assert "private-" not in detail.text
    assert_items(expect(detail, 200)["items"], expected)

    another_id = create_project(owner, "同一来源的另一项目")["id"]
    link(owner, another_id, "library", "321")
    with workspace_db(owner) as conn:
        conn.execute("UPDATE conversations SET title='改名后的对话' WHERE id=101")
        conn.execute("UPDATE library_sources SET title='改名后的资料' WHERE id=321")
    expected[("chat", "101")] = ("改名后的对话", 101)
    expected[("library", "321")] = ("改名后的资料", None)
    assert_items(expect(owner.get(path), 200)["items"], expected)
    assert link(owner, project_id, "library", "321")["title"] == "改名后的资料"

    source_tables = ("conversations", "chat_messages", "image_studio_tasks", "authored_documents",
                     "authored_document_versions", "background_jobs", "library_sources")
    with workspace_db(owner) as conn:
        before = {table: conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall() for table in source_tables}
    expect(owner.delete(f"{path}/items/library/321"), 204)
    expect(owner.delete(f"{path}/items/library/321"), 204)
    del expected[("library", "321")]
    assert_items(expect(owner.get(path), 200)["items"], expected)
    expect(owner.delete(path), 204)
    assert_items(expect(owner.get(f"/projects/{another_id}"), 200)["items"],
                 {("library", "321"): ("改名后的资料", None)})
    with workspace_db(owner) as conn:
        assert conn.execute("SELECT COUNT(*) FROM project_items WHERE project_id = ?", (project_id,)).fetchone()[0] == 0
        assert {table: conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall() for table in source_tables} == before
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_missing_and_trashed_sources_are_skipped_and_can_be_unlinked(accounts):
    owner, _, _ = accounts
    with workspace_db(owner) as conn:
        seed_sources(conn)
    project_id = create_project(owner)["id"]
    path = f"/projects/{project_id}"
    for key in [("chat", "101"), ("image", "image-1"), ("library", "321")]:
        link(owner, project_id, *key)
    with workspace_db(owner) as conn:
        conn.execute("DELETE FROM conversations WHERE id=101")
        conn.execute("UPDATE library_sources SET metadata_json=? WHERE id=321",
                     ('{"organization":{"trashed_at":"2026-01-01"}}',))
    assert expect(owner.get(path), 200)["items"] == []
    link(owner, project_id, "library", "321", 404)
    expect(owner.delete(f"{path}/items/chat/101"), 204)
    with workspace_db(owner) as conn:
        conn.execute("UPDATE library_sources SET metadata_json='{}' WHERE id=321")
    assert [item["kind"] for item in expect(owner.get(path), 200)["items"]] == ["library"]
    with workspace_db(owner) as conn:
        assert [row[0] for row in conn.execute("SELECT kind FROM project_items ORDER BY kind")] == ["image", "library"]


def test_project_fields_and_lists_are_bounded(accounts):
    owner, _, _ = accounts
    for payload in ({"name": "　 "}, {"name": "x" * 121}, {"name": "x", "description": "x" * 2001},
                    {"name": "x", "workspace_id": 42}):
        expect(owner.post("/projects", json=payload), 422)
    project_id = create_project(owner)["id"]
    path = f"/projects/{project_id}"
    for payload in ({"name": None}, {"description": None}):
        expect(owner.patch(path, json=payload), 422)
    for kind, source_id in [("video", "1"), ("library", 321), ("library", ""),
                            ("chat", "x" * 129), ("document", "a/b")]:
        link(owner, project_id, kind, source_id, 422)
    expect(owner.get(f"/projects/{'x' * 129}"), 422)
    expect(owner.delete(f"{path}/items/image/{'x' * 129}"), 422)

    with workspace_db(owner) as conn:
        conn.executemany("INSERT INTO projects(id, name) VALUES (?, 'project')", [(f"extra{i}",) for i in range(199)])
        conn.executemany("INSERT INTO library_sources(id, title, content_hash) VALUES (?, 'source', 'hash')",
                         [(i,) for i in range(1, 202)])
        conn.executemany("INSERT INTO project_items (project_id, kind, source_id) VALUES (?, 'library', ?)",
                         [(project_id, str(i)) for i in range(1, 201)])
    assert len(expect(owner.get("/projects"), 200)["items"]) == 200
    expect(owner.post("/projects", json={"name": "超出上限"}), 409)
    assert len(expect(owner.get(path), 200)["items"]) == 200
    link(owner, project_id, "library", "1")  # retry is safe even at capacity
    link(owner, project_id, "library", "201", 409)
    expect(owner.delete(f"{path}/items/library/1"), 204)
    link(owner, project_id, "library", "201")
