"""用户记忆 REST 接口的确定性回归测试。

覆盖：概览、条目 CRUD 与校验、规则 CRUD/形状/上限、一键清除、
PUT /agent/settings 开关联动。embedding 绝不进入 API 响应。
"""
from __future__ import annotations

import pytest

from app import db
from app.agent.memory import service as memory_service
from app.jobs.worker import JobWorkerManager
from app.knowledge import reset_embedder
from api_client import create_authenticated_client


@pytest.fixture(autouse=True)
def pin_hash_embedder(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EMBEDDING_BACKEND", "hash")
    reset_embedder()
    yield
    reset_embedder()


@pytest.fixture
def api(tmp_path, monkeypatch):
    from app.main import app

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    db.init_db()
    monkeypatch.setattr(JobWorkerManager, "start", lambda self: None)
    with create_authenticated_client(app) as client:
        yield client, app


def test_memory_overview_endpoint(api) -> None:
    client, _ = api
    empty = client.get("/memory")
    assert empty.status_code == 200
    assert empty.json() == {"enabled": True, "items": [], "rules": []}

    item = client.post(
        "/memory/items", json={"kind": "fact", "summary": "用户住在杭州"}
    )
    assert item.status_code == 201
    created = item.json()
    assert created["kind"] == "fact"
    assert created["summary"] == "用户住在杭州"
    assert "embedding" not in created
    assert "embedding_json" not in created

    rule = client.post("/memory/rules", json={"rule": "回答用中文"})
    assert rule.status_code == 201

    overview = client.get("/memory")
    assert overview.status_code == 200
    body = overview.json()
    assert body["enabled"] is True
    assert [row["summary"] for row in body["items"]] == ["用户住在杭州"]
    assert [row["rule"] for row in body["rules"]] == ["回答用中文"]


def test_memory_items_post_validation_and_delete(api) -> None:
    client, _ = api
    assert client.post("/memory/items", json={"kind": "mood", "summary": "x"}).status_code == 422
    assert client.post("/memory/items", json={"summary": "缺少 kind"}).status_code == 422
    assert client.post("/memory/items", json={"kind": "fact", "summary": "   "}).status_code == 400

    created = client.post(
        "/memory/items", json={"kind": "preference", "summary": "用户偏好简洁回答"}
    )
    assert created.status_code == 201
    item_id = created.json()["id"]

    listed = client.get("/memory/items")
    assert listed.status_code == 200
    assert [row["id"] for row in listed.json()] == [item_id]

    deleted = client.delete(f"/memory/items/{item_id}")
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert client.delete(f"/memory/items/{item_id}").status_code == 404
    assert client.get("/memory/items").json() == []


def test_memory_rules_shape_update_and_delete(api) -> None:
    client, _ = api
    created = client.post("/memory/rules", json={"rule": "旧规则"})
    assert created.status_code == 201
    rule_id = created.json()["id"]

    # Bug1 回归：GET /memory/rules 必须是 {rules:[...]} 形状，裸数组会破坏前端。
    listed = client.get("/memory/rules")
    assert listed.status_code == 200
    body = listed.json()
    assert isinstance(body, dict)
    assert [row["rule"] for row in body["rules"]] == ["旧规则"]

    updated = client.put(
        f"/memory/rules/{rule_id}", json={"rule": "新规则", "enabled": False}
    )
    assert updated.status_code == 200
    assert updated.json()["rule"] == "新规则"
    assert not updated.json()["enabled"]

    reenabled = client.put(f"/memory/rules/{rule_id}", json={"enabled": True})
    assert reenabled.status_code == 200
    assert reenabled.json()["enabled"]
    assert reenabled.json()["rule"] == "新规则"

    assert client.put("/memory/rules/9999", json={"rule": "x"}).status_code == 404
    assert client.put(f"/memory/rules/{rule_id}", json={"rule": "   "}).status_code == 400
    assert client.post("/memory/rules", json={"rule": "   "}).status_code == 400

    deleted = client.delete(f"/memory/rules/{rule_id}")
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True}
    assert client.delete(f"/memory/rules/{rule_id}").status_code == 404


def test_memory_rules_limit_conflicts(api) -> None:
    client, _ = api
    for index in range(memory_service.MAX_MEMORY_RULES):
        memory_service.add_memory_rule(f"rule-{index}")
    overflow = client.post("/memory/rules", json={"rule": "overflow"})
    assert overflow.status_code == 409
    assert len(client.get("/memory/rules").json()["rules"]) == memory_service.MAX_MEMORY_RULES


def test_memory_clear_endpoint(api) -> None:
    client, _ = api
    client.post("/memory/items", json={"kind": "fact", "summary": "用户养猫"})
    client.post("/memory/items", json={"kind": "preference", "summary": "偏好深夜工作"})
    client.post("/memory/rules", json={"rule": "回答保持简洁"})

    cleared = client.delete("/memory")
    assert cleared.status_code == 200
    assert cleared.json() == {"cleared_items": 2, "cleared_rules": 1}

    overview = client.get("/memory").json()
    assert overview["items"] == []
    assert overview["rules"] == []
    assert overview["enabled"] is True


def test_agent_settings_toggle_controls_memory(api) -> None:
    client, _ = api
    saved = client.put(
        "/agent/settings",
        json={"persona_role": "测试助手", "user_memory_enabled": False},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["user_memory_enabled"] is False
    assert client.get("/memory").json()["enabled"] is False

    restored = client.put(
        "/agent/settings",
        json={"persona_role": "测试助手", "user_memory_enabled": True},
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["user_memory_enabled"] is True
    assert client.get("/memory").json()["enabled"] is True
