from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from app import db
from app.main import app
from app.chat.execution import _active_chat_runs, cancel_current_agent_task
from app.workspace import ensure_workspace, use_workspace
from app.library.sources import create_text_source
from api_client import register_authenticated_client


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    db.init_db()
    yield


def test_second_user_cannot_see_first_user_library_sources() -> None:
    owner = register_authenticated_client(app, "owner@example.com")
    created = owner.post(
        "/library/sources",
        json={
            "title": "私有笔记",
            "content": "这是一段只属于第一个本地账户的资料内容。",
        },
    )
    assert created.status_code == 200
    source_id = created.json()["source"]["id"]
    assert any(item["id"] == source_id for item in owner.get("/library/sources").json())

    other = register_authenticated_client(app, "other@example.com")
    assert other.get("/library/sources").json() == []
    assert other.get(f"/library/sources/{source_id}").status_code == 404


def test_second_user_cannot_read_first_user_conversation() -> None:
    owner = register_authenticated_client(app, "owner@example.com")
    conversation = owner.post("/conversations", json={"title": "只给自己看的对话"}).json()
    other = register_authenticated_client(app, "other@example.com")
    assert other.patch(f"/conversations/{conversation['id']}", json={"title": "不应改到"}).status_code == 404
    assert all(item["title"] != "只给自己看的对话" for item in other.get("/conversations").json())


class ChatIsolationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "tuantuan.db"
        db.init_db()

    async def asyncTearDown(self) -> None:
        for task in list(_active_chat_runs.values()):
            task.cancel()
        await asyncio.gather(*_active_chat_runs.values(), return_exceptions=True)
        _active_chat_runs.clear()
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    async def test_cancelling_one_user_chat_does_not_stop_another(self) -> None:
        owner = register_authenticated_client(app, "owner@example.com")
        other = register_authenticated_client(app, "other@example.com")
        owner_conversation = owner.post("/conversations", json={"title": "A"}).json()
        other_conversation = other.post("/conversations", json={"title": "B"}).json()
        owner_user = owner.get("/auth/me").json()["user"]["id"]
        other_user = other.get("/auth/me").json()["user"]["id"]

        async def wait_forever() -> None:
            await asyncio.Event().wait()

        owner_task = asyncio.create_task(wait_forever())
        other_task = asyncio.create_task(wait_forever())
        _active_chat_runs[(owner_user, owner_conversation["id"])] = owner_task
        _active_chat_runs[(other_user, other_conversation["id"])] = other_task

        with use_workspace(owner_user, ensure_workspace(owner_user)):
            result = await cancel_current_agent_task(owner_conversation["id"])
        await asyncio.gather(owner_task, return_exceptions=True)

        self.assertTrue(result["cancelled"])
        self.assertTrue(owner_task.cancelled())
        self.assertFalse(other_task.done())


def test_legacy_instance_data_is_adopted_by_the_first_user(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    db.init_db()
    create_text_source(
        title="旧资料",
        content="这是一份升级前已经存在的本地资料。",
        db_path=tmp_path / "tuantuan.db",
    )
    owner = register_authenticated_client(app, "legacy-owner@example.com")
    titles = [item["title"] for item in owner.get("/library/sources").json()]
    assert "旧资料" in titles
    other = register_authenticated_client(app, "newcomer@example.com")
    assert "旧资料" not in [item["title"] for item in other.get("/library/sources").json()]


def test_first_account_keeps_legacy_data_when_second_workspace_initializes_first(tmp_path, monkeypatch) -> None:
    from app import auth

    create_text_source(
        title="旧账户私有资料", content="历史资料只能交给第一个账户。",
        db_path=tmp_path / "tuantuan.db",
    )
    # Delay workspace creation to deterministically model interleaved registrations.
    with monkeypatch.context() as delayed:
        delayed.setattr(auth, "ensure_workspace", lambda user_id: tmp_path / "unused")
        auth.register_user("first@example.com", "synthetic-test-password")
        auth.register_user("second@example.com", "synthetic-test-password")
    second = ensure_workspace(2)
    first = ensure_workspace(1)
    with db.connect(second / "tuantuan.db") as conn:
        assert conn.execute("SELECT COUNT(*) FROM library_sources").fetchone()[0] == 0
    with db.connect(first / "tuantuan.db") as conn:
        assert conn.execute("SELECT title FROM library_sources").fetchone()[0] == "旧账户私有资料"
