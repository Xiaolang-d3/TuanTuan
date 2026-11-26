from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import db
from app.chat import studio_generate
from app.main import app
from app.workspace import ensure_workspace, use_workspace
from api_client import register_authenticated_client


PRIVATE = "private-provider-payload"
STAMP = "2025-08-01 10:00:00"


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    db.init_db()
    owner = register_authenticated_client(app, "task-owner@example.com")
    other = register_authenticated_client(app, "task-other@example.com")
    try:
        yield owner, other, owner.get("/auth/me").json()["user"]["id"]
    finally:
        owner.close()
        other.close()


def _job(conn, task_id, kind, status, request=None, *, updated_at=STAMP):
    conn.execute(
        """INSERT INTO background_jobs
           (id,kind,idempotency_key,request_hash,request_json,snapshot_json,status,error,created_at,updated_at)
           VALUES (?,?,?,'unused',?,?,?,?,?,?)""",
        (task_id, kind, task_id, db.json_dump({"private": PRIVATE, **(request or {})}),
         db.json_dump({"private": PRIVATE}), status, PRIVATE, updated_at, updated_at),
    )


def _conversation(conn):
    return conn.execute("INSERT INTO conversations(title) VALUES (?)", (PRIVATE,)).lastrowid


def test_task_center_jobs_are_private_prioritized_and_pageable(clients):
    owner, other, owner_id = clients
    anonymous = TestClient(app).get("/task-center")
    assert anonymous.status_code == 401
    assert anonymous.headers["cache-control"] == "no-store"
    with use_workspace(owner_id, ensure_workspace(owner_id)), db.connect() as conn:
        cid = _conversation(conn)
        mid = conn.execute("INSERT INTO chat_messages(conversation_id,role,content) VALUES (?,'assistant',?)", (cid, PRIVATE)).lastrowid
        conn.execute("INSERT INTO authored_documents(id,conversation_id,message_id,title) VALUES ('doc',?,?,?)", (cid, mid, PRIVATE))
        conn.execute(
            """INSERT INTO attachments (id,conversation_id,kind,object_key,original_filename,content_type,size_bytes,sha256)
               VALUES ('attachment',?,'file','test/file','private.txt','text/plain',1,'hash')""", (cid,),
        )
        _job(conn, "waiting", "ppt.generate", "waiting_user", {"conversation_id": cid}, updated_at="2024-01-01 00:00:00")
        _job(conn, "queued", "document.review", "queued", {"conversation_id": 9999})
        _job(conn, "running", "document.export", "running", {"document_id": "doc"})
        _job(conn, "cancelled", "ppt.quick_generate", "cancelled", {"conversation_id": cid})
        _job(conn, "failed", "document.review", "failed")
        _job(conn, "interrupted", "library.source_backfill", "interrupted", {"source_kind": "attachment", "source_key": "attachment"})
        for index in range(102):
            _job(conn, f"done-{index:03}", "test", "succeeded", updated_at="2025-08-02 10:00:00")

    assert other.get("/task-center").json() == {"items": [], "has_more": False}
    response = owner.get("/task-center?limit=3")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    assert PRIVATE not in response.text
    page = response.json()
    assert page["has_more"]
    assert [(item["id"], item["status"]) for item in page["items"]] == [
        ("running", "running"), ("queued", "queued"), ("waiting", "awaiting_confirmation"),
    ]
    assert all(set(item) == {"id", "kind", "status", "title", "updated_at", "source", "notification_key"} for item in page["items"])
    assert [item["source"] for item in page["items"]] == [
        {"kind": "chat", "id": str(cid)}, None, {"kind": "chat", "id": str(cid)},
    ]
    assert datetime.fromisoformat(page["items"][0]["updated_at"]).isoformat() == "2025-08-01T10:00:00+00:00"
    assert owner.get("/task-center?limit=3").json() == page
    assert owner.get("/task-center?limit=1&offset=3").json()["items"][0]["status"] == "completed"
    end = owner.get("/task-center?limit=4&offset=105").json()
    assert not end["has_more"]
    assert [item["status"] for item in end["items"]] == ["interrupted", "failed", "cancelled"]
    assert end["items"][0]["source"] == {"kind": "chat", "id": str(cid)}
    assert owner.get("/task-center?limit=101").status_code == 422
    assert owner.get("/task-center?offset=-1").status_code == 422

    with use_workspace(owner_id, ensure_workspace(owner_id)), db.connect() as conn:
        conn.execute("UPDATE background_jobs SET status='running', revision=revision+1 WHERE id='waiting'")
    changed = next(item for item in owner.get("/task-center").json()["items"] if item["id"] == "waiting")
    assert changed["status"] == "running"
    assert changed["notification_key"] != page["items"][2]["notification_key"]


def test_task_center_images_use_existing_receipts_never_submit_or_write(clients, monkeypatch):
    owner, other, owner_id = clients

    def forbidden(*args, **kwargs):
        pytest.fail("reading task center must not send an image request")

    monkeypatch.setattr(studio_generate, "submit", forbidden)
    monkeypatch.setattr(studio_generate, "_execute", forbidden)
    with use_workspace(owner_id, ensure_workspace(owner_id)):
        with db.connect() as conn:
            studio_cid = _conversation(conn)
            chat_cid = _conversation(conn)
            msg = conn.execute(
                "INSERT INTO chat_messages(conversation_id,role,content,created_at) VALUES (?,'assistant',?,?)",
                (studio_cid, PRIVATE, "2025-08-01 10:05:00"),
            ).lastrowid
            conn.executemany(
                """INSERT INTO image_studio_tasks (id,conversation_id,request_hash,prompt,model_name,status,error,created_at,source_asset_id)
                   VALUES (?,?,'unused',?,?,?,?,?,?)""",
                [(task_id, studio_cid, PRIVATE, PRIVATE, status, PRIVATE, STAMP, original) for task_id, status, original in [
                    ("studio-live", "running", None), ("studio-old", "running", None),
                    ("studio-explicit-unknown", "uncertain", None), ("studio-failed-edit", "failed", "asset-old"),
                    ("studio-saved", "running", None), ("studio-rewound", "done", None),
                ]],
            )
            conn.executemany(
                """INSERT INTO chat_image_operations (id,conversation_id,status,selection_json,result_json,created_at)
                   VALUES (?,?,?,?,?,?)""",
                [(task_id, cid, status, db.json_dump(selection), db.json_dump({"private": PRIVATE}), STAMP)
                 for task_id, cid, status, selection in [
                     ("studio-saved", studio_cid, "done", {}), ("studio-rewound", studio_cid, "done", {}),
                     ("chat-live", chat_cid, "started", {}), ("chat-stopped", chat_cid, "started", {}),
                     ("chat-edit", chat_cid, "started", {"edit_digest": PRIVATE}), ("chat-saved", chat_cid, "done", {}),
                     ("chat-rewound", chat_cid, "done", {}),
                 ]],
            )
            conn.executemany(
                """INSERT INTO agent_execution_runs (run_id,conversation_id,status,updated_at) VALUES (?,?,?,?)""",
                [("chat-live", chat_cid, "running", STAMP), ("chat-stopped", chat_cid, "failed", STAMP)],
            )
            conn.executemany(
                """INSERT INTO chat_image_assets (id,operation_id,conversation_id,message_id,provider_item_id,stored_path,metadata_json)
                   VALUES (?,?,?,?,'provider-item',?,?)""",
                [("studio-asset", "studio-saved", studio_cid, msg, PRIVATE, "{}"),
                 ("chat-asset", "chat-saved", chat_cid, None, PRIVATE, "{}")],
            )
        assert studio_generate.try_reserve_edit("studio-live", studio_cid)

    try:
        response = owner.get("/task-center")
        assert response.status_code == 200, response.text
        assert PRIVATE not in response.text
        items = response.json()["items"]
        assert response.json() == owner.get("/task-center").json()
        assert other.get("/task-center").json() == {"items": [], "has_more": False}
        assert {item["id"]: item["status"] for item in items} == {
            "studio-live": "running", "studio-old": "outcome_unknown", "studio-explicit-unknown": "outcome_unknown",
            "studio-failed-edit": "failed", "studio-saved": "completed",
            "chat-live": "running", "chat-stopped": "outcome_unknown", "chat-edit": "outcome_unknown", "chat-saved": "completed",
        }
        assert len(items) == 9  # Studio + chat receipt for the same image count once.
        assert len({item["notification_key"] for item in items}) == len(items)
        by_id = {item["id"]: item for item in items}
        assert by_id["studio-saved"]["updated_at"] == "2025-08-01T10:05:00.000Z"
        assert by_id["studio-failed-edit"]["kind"] == by_id["chat-edit"]["kind"] == "image.edit"
        assert by_id["studio-saved"]["source"] == {"kind": "image", "id": "studio-saved"}
        assert owner.get("/image-studio/tasks/studio-saved").json()["status"] == "done"
        assert by_id["chat-saved"]["source"] == {"kind": "chat", "id": str(chat_cid)}
    finally:
        with use_workspace(owner_id, ensure_workspace(owner_id)):
            studio_generate.release_edit("studio-live")

    after = next(item for item in owner.get("/task-center").json()["items"] if item["id"] == "studio-live")
    assert after["status"] == "outcome_unknown"
    assert after["notification_key"] != by_id["studio-live"]["notification_key"]
    with use_workspace(owner_id, ensure_workspace(owner_id)), db.connect() as conn:
        assert conn.execute("SELECT status FROM image_studio_tasks WHERE id='studio-live'").fetchone()[0] == "running"
        assert conn.execute("SELECT status FROM image_studio_tasks WHERE id='studio-saved'").fetchone()[0] == "running"
        assert conn.execute("SELECT status FROM chat_image_operations WHERE id='chat-stopped'").fetchone()[0] == "started"
        assert conn.execute("SELECT count(*) FROM chat_image_operations").fetchone()[0] == 7
