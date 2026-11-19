from __future__ import annotations

import base64
from io import BytesIO

import pytest
from PIL import Image

from api_client import create_authenticated_client, register_authenticated_client
from app import db
from app.agent.snapshots import load_run_snapshot, save_run_snapshot
from app.chat.execution import _active_chat_runs
from app.chat.image_assets import asset_file, begin_generation, persist_images
from app.chat.service import save_chat_message
from app.domain import AgentRunSnapshot, ModelResponse
from app.domain.agent import ModelImageOutput
from app.main import app
from app.workspace import ensure_workspace, use_workspace


@pytest.fixture
def isolated_data(tmp_path, monkeypatch):
    # conftest clears TUANTUAN_DATA_DIR after setting it. Patch the paths used by
    # workspace routing directly so neither auth nor business data uses a real DB.
    data_dir = tmp_path.resolve()
    monkeypatch.setattr(db, "DATA_DIR", data_dir)
    monkeypatch.setattr(db, "DB_PATH", data_dir / "tuantuan.db")
    monkeypatch.setattr(db, "LEGACY_DB_PATH", data_dir / "bosscopilot.db")
    db.init_db()


class RunState:
    finished = False

    def done(self):
        return self.finished


def image_response():
    output = BytesIO()
    Image.new("RGB", (2, 2), "blue").save(output, "PNG")
    return output.getvalue(), ModelResponse(images=[ModelImageOutput(
        item_id="test-image", base64_data=base64.b64encode(output.getvalue()).decode("ascii")
    )])


def test_active_run_blocks_conversation_deletion_before_any_cleanup(isolated_data, monkeypatch):
    client = create_authenticated_client(app)
    try:
        user_id = client.get("/auth/me").json()["user"]["id"]
        conversation_id = client.post("/conversations", json={"title": "生图"}).json()["id"]
        upload = client.post(
            "/attachments",
            data={"conversation_id": str(conversation_id), "kind": "document"},
            files={"file": ("参考.txt", b"reference", "text/plain")},
        )
        assert upload.status_code == 200
        attachment_id = upload.json()["id"]
        with use_workspace(user_id, ensure_workspace(user_id)):
            save_chat_message("user", "图片描述", {}, conversation_id)
            begin_generation("completed-image", conversation_id, {})
            original, response = image_response()
            asset = persist_images("completed-image", response, "test-model")["assets"][0]
            image_path = asset_file(asset["id"])[0]
            begin_generation("running-image", conversation_id, {})
            save_run_snapshot(conversation_id, AgentRunSnapshot(
                route_kind="conversation", needs_plan=False, messages=[]
            ))

        running = RunState()
        monkeypatch.setitem(_active_chat_runs, (user_id, conversation_id), running)
        blocked = client.delete(f"/conversations/{conversation_id}")
        assert blocked.status_code == 409
        assert blocked.json()["detail"] == "请先停止当前生成任务"
        assert client.get(f"/chat/messages?conversation_id={conversation_id}").json()[0]["content"] == "图片描述"
        assert client.get(f"/attachments/{attachment_id}/file").content == b"reference"
        assert client.get(f"/chat-assets/{asset['id']}/file").content == original
        with use_workspace(user_id, ensure_workspace(user_id)):
            assert image_path.read_bytes() == original
            assert load_run_snapshot(conversation_id) is not None
            with db.connect() as conn:
                operation = conn.execute(
                    "SELECT status FROM chat_image_operations WHERE id=?", ("running-image",)
                ).fetchone()
            assert operation["status"] == "started"

        running.finished = True
        deleted = client.delete(f"/conversations/{conversation_id}")
        assert deleted.status_code == 200
        assert deleted.json()["deleted"] is True
        assert not image_path.exists()
        assert client.get(f"/attachments/{attachment_id}/file").status_code == 404
    finally:
        client.close()


def test_active_run_is_scoped_to_its_account(isolated_data, monkeypatch):
    owner = create_authenticated_client(app)
    other = register_authenticated_client(app, "other@example.com")
    try:
        owner_id = owner.get("/auth/me").json()["user"]["id"]
        owner_conversation = owner.post("/conversations", json={"title": "用户一"}).json()["id"]
        other_conversation = other.post("/conversations", json={"title": "用户二"}).json()["id"]
        assert owner_conversation == other_conversation
        monkeypatch.setitem(_active_chat_runs, (owner_id, owner_conversation), RunState())

        assert owner.delete(f"/conversations/{owner_conversation}").status_code == 409
        assert other.delete(f"/conversations/{other_conversation}").status_code == 200
        assert owner.delete("/conversations/999999").status_code == 404
        assert any(item["id"] == owner_conversation for item in owner.get("/conversations").json())
    finally:
        owner.close()
        other.close()
