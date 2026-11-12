from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from app import db
from app.agent.run_store import AgentRunStore
from app.agent.settings import save_agent_settings
import app.chat.execution as main_module
from app.agent.kernels.base import (
    KernelUnavailable,
    register_kernel_runtime,
    resolve_kernel_runtime,
    unregister_kernel_runtime,
    validate_kernel_selection,
)
from app.agent.kernels.builtin import BuiltinKernelRuntime
from app.chat.conversations import create_conversation
from app.chat.conversations import ensure_active_task
from app.db import connect
from app.domain import AgentRunResult, AgentStreamEvent
from app.main import app
from api_client import create_authenticated_client


class FakeAgentRuntime:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def run_stream(self, user_content, **kwargs):
        self.calls.append({"user_content": user_content, "kwargs": kwargs})
        yield AgentStreamEvent(type="text_delta", delta="测试回复")
        yield AgentStreamEvent(
            type="completed",
            result=AgentRunResult(content="测试回复", provider="test", platform="manual", rounds=1),
        )


class KernelRoutingTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self._original_db_path = db.DB_PATH
        db.DB_PATH = Path(self._temp_dir.name) / "routing.db"
        db.init_db(db.DB_PATH)
        self._previous_dsh = os.environ.pop("TUANTUAN_DSH_ENABLED", None)
        self.client = create_authenticated_client(app)
        self._original_get_runtime = main_module.get_agent_runtime

    def tearDown(self) -> None:
        main_module.get_agent_runtime = self._original_get_runtime
        if self._previous_dsh is not None:
            os.environ["TUANTUAN_DSH_ENABLED"] = self._previous_dsh
        self.client.close()
        db.DB_PATH = self._original_db_path
        self._temp_dir.cleanup()

    def with_runtime(self, runtime, action):
        main_module.get_agent_runtime = lambda *args, **kwargs: runtime
        try:
            return action()
        finally:
            main_module.get_agent_runtime = self._original_get_runtime

    def run_ag_ui(self, conversation_id: int, content: str, run_id: str) -> list[dict]:
        with self.client.stream("POST", "/ag-ui", json={
            "threadId": str(conversation_id), "runId": run_id, "state": {},
            "messages": [{"id": f"user-{run_id}", "role": "user", "content": content}],
            "tools": [], "context": [], "forwardedProps": {},
        }) as response:
            return response.status_code, [
                json.loads(line.removeprefix("data: ")) for line in response.iter_lines() if line.startswith("data: ")
            ]

    def enable_dsh(self) -> None:
        os.environ["TUANTUAN_DSH_ENABLED"] = "1"
        with db.connect() as conn:
            conn.execute(
                """
                INSERT INTO model_connections (id, name, base_url, effective_base_url, protocol, data_boundary)
                VALUES ('deepseek-1', 'DeepSeek', 'https://api.deepseek.com', 'https://api.deepseek.com', 'auto', 'deepseek-1')
                """
            )
            conn.execute(
                """
                INSERT INTO model_profiles (id, connection_id, model_name, name)
                VALUES ('deepseek-profile', 'deepseek-1', 'deepseek-chat', 'DeepSeek Chat')
                """
            )

    def test_resolve_builtin_and_unavailable_kernels(self) -> None:
        runtime = FakeAgentRuntime()
        self.assertIsInstance(resolve_kernel_runtime("tuantuan", runtime), BuiltinKernelRuntime)
        with self.assertRaises(KernelUnavailable):
            validate_kernel_selection("other")

    def test_tuantuan_conversation_streams_through_builtin_kernel(self) -> None:
        conversation = create_conversation("自研内核对话")
        runtime = FakeAgentRuntime()
        status, events = self.with_runtime(runtime, lambda: self.run_ag_ui(conversation["id"], "你好", "run-builtin"))
        self.assertEqual(status, 200)
        self.assertEqual(runtime.calls[0]["kwargs"]["conversation_id"], conversation["id"])
        self.assertIn("测试回复", "".join(
            event.get("delta", "") for event in events if event.get("type") == "TEXT_MESSAGE_CONTENT"
        ))

    def test_dsh_conversation_rejected_when_feature_disabled(self) -> None:
        conversation = create_conversation("DSH 对话", kernel="dsh")
        status = self.with_runtime(FakeAgentRuntime(), lambda: self.client.post("/ag-ui", json={
            "threadId": str(conversation["id"]), "runId": "run-dsh-off", "state": {},
            "messages": [{"id": "user-1", "role": "user", "content": "你好"}],
            "tools": [], "context": [], "forwardedProps": {},
        }).status_code)
        self.assertEqual(status, 409)

    def test_dsh_conversation_streams_through_registered_kernel(self) -> None:
        self.enable_dsh()
        conversation = create_conversation("DSH 对话", kernel="dsh")
        fake_dsh_calls: list[dict] = []

        class FakeDshKernel:
            def __init__(self, agent_runtime) -> None:
                self.agent_runtime = agent_runtime

            async def run_stream(self, user_content, **kwargs):
                fake_dsh_calls.append({"user_content": user_content, "kwargs": kwargs})
                yield AgentStreamEvent(type="text_delta", delta="DSH 回复")
                yield AgentStreamEvent(
                    type="completed",
                    result=AgentRunResult(content="DSH 回复", provider="test", platform="manual", rounds=1),
                )

        register_kernel_runtime("dsh", lambda agent_runtime: FakeDshKernel(agent_runtime))
        try:
            runtime = FakeAgentRuntime()
            status, events = self.with_runtime(runtime, lambda: self.run_ag_ui(conversation["id"], "你好", "run-dsh"))
            self.assertEqual(status, 200)
            self.assertEqual(fake_dsh_calls[0]["kwargs"]["conversation_id"], conversation["id"])
        finally:
            unregister_kernel_runtime("dsh")

    def test_fork_endpoint_leaves_running_source_task_in_place(self) -> None:
        self.enable_dsh()
        source = create_conversation("运行中的方案")
        task_id = ensure_active_task(source["id"])
        with connect() as conn:
            conn.execute(
                "INSERT INTO chat_messages (conversation_id, task_id, role, content) VALUES (?, ?, 'user', ?)",
                (source["id"], task_id, "已完成的问题"),
            )
            conn.execute(
                "INSERT INTO chat_messages (conversation_id, task_id, role, content) VALUES (?, ?, 'assistant', ?)",
                (source["id"], task_id, "已完成的回答"),
            )
            pending_id = conn.execute(
                "INSERT INTO chat_messages (conversation_id, task_id, role, content) VALUES (?, ?, 'user', ?)",
                (source["id"], task_id, "正在执行的问题"),
            ).lastrowid
        run_store = AgentRunStore()
        run_store.start_run(
            "fork-active-run",
            conversation_id=source["id"],
            task_id=task_id,
            user_content="正在执行的问题",
        )
        run_store.bind_messages("fork-active-run", user_message_id=pending_id)

        response = self.client.post(
            f"/conversations/{source['id']}/fork",
            json={"kernel": "dsh"},
        )

        self.assertEqual(response.status_code, 200)
        forked = response.json()
        self.assertEqual(forked["kernel"], "dsh")
        self.assertNotEqual(forked["id"], source["id"])
        self.assertEqual(run_store.get_run("fork-active-run")["status"], "running")
        with connect() as conn:
            seed = conn.execute(
                "SELECT content FROM conversation_context_seeds WHERE conversation_id = ?",
                (forked["id"],),
            ).fetchone()["content"]
            target_message_count = conn.execute(
                "SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?",
                (forked["id"],),
            ).fetchone()["count"]
        self.assertIn("已完成的问题", seed)
        self.assertNotIn("正在执行的问题", seed)
        self.assertEqual(target_message_count, 0)

    def test_api_create_uses_available_default_kernel(self) -> None:
        self.enable_dsh()
        save_agent_settings({"default_kernel": "dsh"})

        response = self.client.post("/conversations", json={"title": "默认 DSH"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["kernel"], "dsh")
        self.assertEqual(response.json()["model_profile_id"], "deepseek-profile")

    def test_api_rejects_unavailable_explicit_dsh_kernel(self) -> None:
        response = self.client.post("/conversations", json={"title": "不可用 DSH", "kernel": "dsh"})
        self.assertEqual(response.status_code, 400)

    def test_api_rejects_switching_to_dsh_when_it_becomes_unavailable(self) -> None:
        self.enable_dsh()
        conversation = create_conversation("待切换内核")
        os.environ["TUANTUAN_DSH_ENABLED"] = "0"

        response = self.client.patch(f"/conversations/{conversation['id']}", json={"kernel": "dsh"})

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            self.client.get("/conversations").json()[0]["kernel"],
            "tuantuan",
        )

    def test_api_falls_back_when_saved_default_dsh_is_unavailable(self) -> None:
        save_agent_settings({"default_kernel": "dsh"})

        response = self.client.post("/conversations", json={"title": "默认回退"})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["kernel"], "tuantuan")


if __name__ == "__main__":
    unittest.main()
