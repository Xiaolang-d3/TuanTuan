"""AG-UI only schedules user memory after a normal durable completion."""
from __future__ import annotations

import json

from app import db
from app.agent.memory import service as memory
from app.agent.run_store import AgentRunStore
from app.chat import execution
from app.domain import AgentRunResult, AgentStreamEvent
from app.jobs.worker import JobWorkerManager
from app.main import app
from api_client import create_authenticated_client


def test_ag_ui_schedules_only_completed_turn_and_does_not_reschedule_replay(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    db.init_db()
    monkeypatch.setattr(JobWorkerManager, "start", lambda self: None)
    monkeypatch.setattr(memory, "get_model_connection", lambda *args, **kwargs: {"model_name": "test"})

    completed = AgentRunResult(content="正常完成", provider="test", platform="manual", rounds=1)
    results = iter([
        completed,
        AgentRunResult(content="失败", provider="test", platform="manual", rounds=1, status="failed"),
        AgentRunResult(content="暂停", provider="test", platform="manual", rounds=1, status="waiting_user"),
        AgentRunResult(content="取消", provider="test", platform="manual", rounds=1, status="cancelled"),
        AgentRunResult(content="部分返回", provider="test", platform="manual", rounds=1, stop_reason="partial_result"),
        completed.model_copy(),
        completed.model_copy(),
        completed.model_copy(),
        completed.model_copy(),
    ])
    executed = []

    class Runtime:
        async def run_stream(self, *args, **kwargs):
            executed.append(kwargs["run_id"])
            yield AgentStreamEvent(type="completed", result=next(results))

    monkeypatch.setattr(execution, "get_agent_runtime", lambda *args, **kwargs: Runtime())
    prompts = []
    scheduled = []

    def generate(request):
        prompts.append(request.messages[0].content)
        return {"content": "[]"}

    def spawn(target, *, name, args, kwargs):
        assert target is memory.extract_from_conversation
        assert name == f"memory-extract-{args[0]}"
        run = AgentRunStore().get_run(executed[-1])
        assert run["status"] == "completed"
        assert run["assistant_message_id"] == kwargs["through_message_id"]
        scheduled.append(executed[-1])
        target(*args, **kwargs, generate=generate)

    monkeypatch.setattr("app.workspace.spawn_thread", spawn)

    with create_authenticated_client(app) as client:
        cid = client.post("/conversations", json={"title": "记忆"}).json()["id"]

        def turn(run_id):
            with client.stream("POST", "/ag-ui", json={
                "threadId": str(cid), "runId": run_id, "state": {},
                "messages": [{"id": f"user-{run_id}", "role": "user", "content": f"turn {run_id}"}],
                "tools": [], "context": [], "forwardedProps": {},
            }) as response:
                assert response.status_code == 200, response.text
                return [json.loads(line.removeprefix("data: ")) for line in response.iter_lines()
                        if line.startswith("data: ")]

        for index in range(5):
            turn(f"run-{index}")
        assert scheduled == []

        finished = turn("run-5")
        assert finished[-1]["type"] == "RUN_FINISHED"
        assert scheduled == ["run-5"]
        assert len(prompts) == 1 and "turn run-5" in prompts[0]
        assert turn("run-5")[-1]["type"] == "RUN_FINISHED"
        assert executed.count("run-5") == 1
        assert scheduled == ["run-5"]
        rows = client.get("/chat/messages", params={"conversation_id": cid}).json()
        assert len(rows) == 12

        # Once disabled, reaching another full window does not start a worker.
        assert client.put("/agent/settings", json={"persona_role": "测试助手", "user_memory_enabled": False}).status_code == 200
        for index in range(6, 9):
            turn(f"run-{index}")
        assert scheduled == ["run-5"]
