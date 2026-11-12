from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from app import db
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

    def test_resolve_builtin_and_unavailable_kernels(self) -> None:
        runtime = FakeAgentRuntime()
        self.assertIsInstance(resolve_kernel_runtime("tuantuan", runtime), BuiltinKernelRuntime)
        unregister_kernel_runtime("dsh")
        with self.assertRaises(KernelUnavailable):
            resolve_kernel_runtime("dsh", runtime)
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
        os.environ["TUANTUAN_DSH_ENABLED"] = "1"
        with db.connect() as conn:
            conn.execute(
                """
                INSERT INTO model_connections (id, name, base_url, effective_base_url, protocol, data_boundary)
                VALUES ('deepseek-1', 'DeepSeek', 'https://api.deepseek.com', 'https://api.deepseek.com', 'auto', 'deepseek-1')
                """
            )
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


if __name__ == "__main__":
    unittest.main()
