import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app
from api_client import register_authenticated_client


SKILL = "---\nname: 周报助手\ndescription: >\n  归纳每周的工作与下一步行动\npermissions: [shell]\n---\n只总结用户提供的事实，输出结论与行动清单。"


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    db.init_db()
    with register_authenticated_client(app, "extension-owner@example.com") as owner, register_authenticated_client(app, "extension-other@example.com") as other:
        yield owner, other


def test_catalog_requires_login_and_skill_persists_without_granting_tools(clients):
    owner, other = clients
    assert TestClient(app).get("/extensions").status_code == 401
    response = owner.post("/extensions/skills", json={"content": SKILL})
    assert response.status_code == 201, response.text
    skill = response.json()
    assert skill["enabled"] is False and skill["permissions"] == []
    assert skill["revision"] and "content" not in owner.get("/extensions").json()["extensions"][0]
    assert all(item["id"] != skill["id"] for item in other.get("/extensions").json()["extensions"])
    assert other.get(f"/extensions/{skill['id']}").status_code == 404
    assert other.patch(f"/extensions/{skill['id']}/enabled", json={"enabled": True}).status_code == 404
    assert owner.patch(f"/extensions/{skill['id']}/enabled", json={"enabled": True}).status_code == 200
    assert skill["id"] in [item["id"] for item in owner.get("/skills").json()["skills"]]
    assert owner.get(f"/extensions/{skill['id']}").json()["content"].endswith("行动清单。")
    assert owner.patch(f"/extensions/{skill['id']}/enabled", json={"enabled": False}).status_code == 200
    assert skill["id"] not in [item["id"] for item in owner.get("/skills").json()["skills"]]
    assert owner.delete(f"/extensions/{skill['id']}").status_code == 204
    assert owner.get(f"/extensions/{skill['id']}").status_code == 404


def make_zip(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in entries:
            archive.writestr(name, content)
    return buffer.getvalue()


@pytest.mark.parametrize("entries", [
    [("../SKILL.md", SKILL)], [("SKILL.md", SKILL), ("skill.MD", SKILL)],
    [("SKILL.md", SKILL), ("C:/secret", "secret")],
    [("SKILL.md", SKILL), ("assets/../secret", "secret")],
])
def test_zip_import_rejects_traversal_and_case_collisions(clients, entries):
    owner, _ = clients
    response = owner.post("/extensions/import", files={"file": ("skill.zip", make_zip(entries), "application/zip")})
    assert response.status_code == 422, response.text


def test_zip_resources_are_authorized_and_removed_with_catalog_entry(clients):
    owner, other = clients
    package = make_zip([("report/SKILL.md", SKILL), ("report/references/format.txt", "格式要求")])
    response = owner.post("/extensions/import", files={"file": ("report.zip", package, "application/zip")})
    assert response.status_code == 201, response.text
    item = response.json()
    path = f"/extensions/{item['id']}/resources?path=references/format.txt"
    assert owner.get(path).content.decode() == "格式要求"
    assert other.get(path).status_code == 404
    assert owner.get(f"/extensions/{item['id']}/resources?path=../SKILL.md").status_code == 422


def test_plugin_manifest_and_mcp_drafts_never_claim_execution(clients):
    owner, other = clients
    plugin = {"id": "report-kit", "name": "报告工具包", "version": "1.0", "api_version": 1, "tools": [{"adapter": "ppt-master"}]}
    response = owner.post("/extensions/plugins", json={"content": __import__("json").dumps(plugin)})
    assert response.status_code == 201, response.text
    item = response.json()
    assert item["status"] == "dependency_missing"
    assert owner.patch(f"/extensions/{item['id']}/enabled", json={"enabled": True}).status_code == 409
    assert owner.post("/extensions/mcp", json={"name": "bad", "transport": "http", "endpoint": "file:///secret"}).status_code == 422
    draft = owner.post("/extensions/mcp", json={"name": "知识库", "transport": "http", "endpoint": "https://example.com/mcp"})
    assert draft.status_code == 201
    assert draft.json()["status"] == "draft"
    assert owner.get("/extensions").json()["connections"][0]["id"] == draft.json()["id"]
    assert not other.get("/extensions").json()["connections"]
    assert owner.get("/extensions").json()["execution"]["available"] is False


def test_online_skill_flow_is_authenticated_scoped_and_usable_in_chat(clients, monkeypatch):
    from app.extensions import discovery
    from test_skill_discovery import mock_network
    owner, other = clients
    calls = mock_network(monkeypatch)
    anonymous = TestClient(app)
    assert anonymous.get("/extensions/skills/search?q=report").status_code == 401
    assert anonymous.post("/extensions/skills/preview", json={"source": "acme/reports"}).status_code == 401
    assert anonymous.post("/extensions/skills/install", json={"preview_id": "a" * 32, "path": "skills/report"}).status_code == 401
    search = owner.get("/extensions/skills/search?q=report")
    assert search.status_code == 200 and search.headers["cache-control"] == "no-store"
    preview = owner.post("/extensions/skills/preview", json={"source": "acme/reports"})
    assert preview.status_code == 200, preview.text
    payload = {"preview_id": preview.json()["preview_id"], "path": "skills/report"}
    assert other.post("/extensions/skills/install", json=payload).status_code == 422
    before = len(calls)
    response = owner.post("/extensions/skills/install", json=payload)
    assert response.status_code == 201, response.text
    item = response.json()
    assert item["source"] == "github" and item["enabled"] is False and len(calls) == before
    assert not any(entry["id"] == item["id"] for entry in other.get("/extensions").json()["extensions"])
    owner.patch(f"/extensions/{item['id']}/enabled", json={"enabled": True})
    assert item["id"] in [entry["id"] for entry in owner.get("/skills").json()["skills"]]
    monkeypatch.setattr(discovery, "_json", lambda _: {"broken": []})
    assert owner.get("/extensions/skills/search?q=report").status_code == 502
    assert owner.get("/extensions/skills/search?q=x").status_code == 422
