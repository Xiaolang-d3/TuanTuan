import pytest

from app import db
from app.chat.artifacts import message_artifacts
from app.chat.service import save_chat_message
from app.jobs.worker import JobWorkerManager
from app.workspace import use_workspace
from api_client import create_authenticated_client, register_authenticated_client


@pytest.fixture
def api(tmp_path, monkeypatch):
    from app.main import app
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    db.init_db()
    monkeypatch.setattr(JobWorkerManager, "start", lambda self: None)
    with create_authenticated_client(app) as client:
        with use_workspace(1):
            message = save_chat_message("assistant", "# 文档\n\n原始回答。", payload={"agent": {"status": "done"}}, conversation_id=1)
            payload = {"message_id": message["id"], "snapshot": message_artifacts(message["id"])["snapshot"], "idempotency_key": "api-create"}
        yield client, app, payload


def test_documents_api_saves_exact_versions_and_conflicts_without_background_jobs(api):
    client, _, payload = api
    created = client.post("/conversations/1/documents", json=payload)
    assert created.status_code == 201, created.text
    assert created.headers["cache-control"] == "no-store"
    doc = created.json()
    assert client.post("/conversations/1/documents", json=payload).json()["document_id"] == doc["document_id"]
    path = f"/documents/{doc['document_id']}"
    save = {"base_version": 1, "markdown": "# 修改后的精确版本", "idempotency_key": "api-save"}
    result = client.post(path + "/versions", json=save)
    assert result.status_code == 201 and result.json()["version"] == 2
    assert client.post(path + "/versions", json=save).json()["version"] == 2
    conflict = client.post(path + "/versions", json={**save, "idempotency_key": "other"})
    assert conflict.status_code == 409 and conflict.headers["cache-control"] == "no-store"
    assert client.get(path + "/versions/1").json()["markdown"] == "# 文档\n\n原始回答。"
    assert [item["version"] for item in client.get(path + "/versions").json()["versions"]] == [2, 1]
    assert client.get(path).json()["version"] == 2
    assert any(item["document_id"] == doc["document_id"] for item in client.get("/documents").json()["documents"])
    with use_workspace(1):
        with db.connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM background_jobs").fetchone()[0] == 0


def test_document_ids_cannot_read_or_edit_another_account(api):
    client, app, payload = api
    doc = client.post("/conversations/1/documents", json=payload)
    assert doc.status_code == 201, doc.text
    path = f"/documents/{doc.json()['document_id']}"
    other = register_authenticated_client(app, email="other-document-owner@example.test")
    assert other.get(path).status_code == 404
    assert other.post(path + "/versions", json={"base_version": 1, "markdown": "越权", "idempotency_key": "foreign"}).status_code == 404
    assert other.get("/documents").json() == {"documents": []}
