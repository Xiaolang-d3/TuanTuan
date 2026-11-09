import pytest

from app import db
from app.chat import execution
from app.domain import AgentRunResult, AgentStreamEvent
from app.main import app
from api_client import register_authenticated_client


def test_ag_ui_accepts_skill_selection_and_reconnect_keeps_original_binding(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    db.init_db()
    calls = []

    class Runtime:
        async def run_stream(self, *args, **kwargs):
            calls.append(kwargs)
            yield AgentStreamEvent(type="completed", result=AgentRunResult(content="完成", provider="test", platform="manual", rounds=1))

    monkeypatch.setattr(execution, "get_agent_runtime", lambda *args, **kwargs: Runtime())
    with register_authenticated_client(app, "skill-chat@example.com") as client:
        item = client.post("/extensions/skills", json={"content": "---\nname: chat-skill\ndescription: 用于聊天\n---\nSELECTED_BODY"}).json()
        client.patch(f"/extensions/{item['id']}/enabled", json={"enabled": True})
        conversation = client.post("/conversations", json={"title": "技能测试"}).json()["id"]
        request = {"threadId": str(conversation), "runId": "skill-api-run", "state": {}, "messages": [{"id": "input", "role": "user", "content": "你好"}], "tools": [], "context": [], "forwardedProps": {"skillId": item["id"]}}
        response = client.post("/ag-ui", json=request)
        assert response.status_code == 200, response.text
        assert calls[0]["skill_binding"]["id"] == item["id"]
        assert calls[0]["skill_binding"]["revision"] == item["revision"]
        messages = client.get(f"/chat/messages?conversation_id={conversation}").json()
        assert messages[0]["payload"]["skill_binding"]["id"] == item["id"]
        request["forwardedProps"]["skillId"] = "does-not-exist"
        assert client.post("/ag-ui", json=request).status_code == 200
        assert len(calls) == 1
        request["runId"] = "another-run"
        assert client.post("/ag-ui", json=request).status_code == 409

        from app.agent.snapshots import save_run_snapshot
        from app.domain import AgentClarification, AgentMessage, AgentRunSnapshot, ClarificationOption
        from app.workspace import ensure_workspace, use_workspace
        user_id = client.get("/auth/me").json()["user"]["id"]
        binding = calls[0]["skill_binding"]
        def waiting():
            with use_workspace(user_id, ensure_workspace(user_id)):
                save_run_snapshot(conversation, AgentRunSnapshot(route_kind="conversation", needs_plan=False, skill_binding=binding, messages=[AgentMessage(role="user", content="你好")], clarification=AgentClarification(question="继续？", options=[ClarificationOption(label="继续", send="继续")])) )
        waiting()
        client.patch(f"/extensions/{item['id']}/enabled", json={"enabled": False})
        request.update(runId="continue-original", messages=[{"id": "reply", "role": "user", "content": "继续"}], forwardedProps={"skillId": item["id"]})
        continued = client.post("/ag-ui", json=request)
        assert continued.status_code == 200, continued.text
        assert calls[-1]["skill_binding"] == binding and calls[-1]["resume"] is not None
        waiting()
        request.update(runId="clear-original", forwardedProps={"skillId": None})
        assert client.post("/ag-ui", json=request).status_code == 200
        assert calls[-1].get("skill_binding") is None and calls[-1]["resume"] is None
