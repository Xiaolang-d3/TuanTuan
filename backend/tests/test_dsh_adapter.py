from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from app.agent.kernels.dsh import adapter as adapter_module
from app.agent.kernels.dsh.adapter import DshKernelRuntime, close_dsh_runtime
from app.agent.kernels.dsh.approvals import APPROVE_LABEL, approval_clarification, decision_from_reply
from app.agent.kernels.dsh.client import DshClientError, DshJsonRpcClient, DshLaunch, DshTimeoutError, Notification
from app.agent.kernels.base import KernelUnavailable
from app.domain import AgentMessage


PYTHON = sys.executable
FIXTURE = str(Path(__file__).resolve().parent / "fixtures" / "fake_dsh_runtime.py")


class DshAdapterTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self._temp_dir.name)

    def tearDown(self) -> None:
        adapter_module._pending.clear()
        self._temp_dir.cleanup()

    def make_session(self, env: dict[str, str] | None = None) -> SimpleNamespace:
        client = DshJsonRpcClient(
            DshLaunch(bin=PYTHON, args=(FIXTURE,), env=dict(env or {})),
            tmp_dir=self.root / "tmp",
            request_timeout=10.0,
            shutdown_timeout=2.0,
        )
        return SimpleNamespace(conversation_id=1, client=client, home=self.root, last_active=0.0, initialized=False)

    def runtime(self, session: SimpleNamespace, **kwargs) -> DshKernelRuntime:
        manager = SimpleNamespace(acquire=lambda *a, **k: session)
        connection = {
            "model_name": "deepseek-v4-flash",
            "model_base_url": "https://api.deepseek.com",
            "api_key": "fake-key",
        }
        return DshKernelRuntime(manager, connection, **kwargs)

    async def collect(self, runtime, *, user_content: str = "你好", **run_kwargs) -> list[dict]:
        events = []
        async for event in runtime.run_stream(user_content, conversation_id=1, **run_kwargs):
            events.append(event.model_dump(mode="json"))
        return events

    async def test_text_turn_translates_to_stream_events(self) -> None:
        session = self.make_session()
        try:
            events = await self.collect(self.runtime(session, tool_ready_grace=0))
            deltas = "".join(event["delta"] for event in events if event["type"] == "text_delta")
            self.assertIn("中文回复", deltas)
            completed = next(event for event in events if event["type"] == "completed")
            self.assertEqual(completed["result"]["status"], "done")
            self.assertIn("中文回复", completed["result"]["content"])
        finally:
            await session.client.close()

    async def test_approval_pauses_with_waiting_user_and_resumes(self) -> None:
        record = self.root / "record.jsonl"
        session = self.make_session(env={"FAKE_DSH_APPROVE_DURING_TURN": "1", "FAKE_DSH_RECORD": str(record)})
        try:
            runtime = self.runtime(session, tool_ready_grace=0)
            first = await self.collect(runtime)
            waiting = next(event for event in first if event["type"] == "waiting_user")
            snapshot = waiting["result"]["snapshot"]
            self.assertIn("ping", snapshot["clarification"]["question"])
            self.assertIn((0, 1), adapter_module._pending)
            second = await self.collect(
                self.runtime(session, tool_ready_grace=0),
                user_content=APPROVE_LABEL,
                resume=type("R", (), {"model_dump": lambda self, **k: snapshot})(),
            )
            completed = next(event for event in second if event["type"] == "completed")
            self.assertIn("中文回复", completed["result"]["content"])
            self.assertNotIn((0, 1), adapter_module._pending)
            recorded = json.loads(record.read_text(encoding="utf-8").strip().splitlines()[-1])
            self.assertEqual(recorded["result"], {"outcome": "allowed-once"})
        finally:
            await session.client.close()

    async def test_approval_decision_mapping(self) -> None:
        request = Notification("approval/request", {"requestId": "r1", "toolName": "ping", "reason": "原因"})
        clarification = approval_clarification(request)
        self.assertIn("ping", clarification.question)
        self.assertEqual(decision_from_reply(APPROVE_LABEL), {"outcome": "allowed-once"})
        self.assertEqual(decision_from_reply("拒绝本次操作"), {"outcome": "rejected"})
        self.assertEqual(decision_from_reply("随便说点"), {"outcome": "rejected"})

    async def test_fresh_session_injects_saved_history_before_the_current_request(self) -> None:
        record = self.root / "record.jsonl"
        session = self.make_session(env={"FAKE_DSH_RECORD": str(record)})
        try:
            await self.collect(
                self.runtime(session, tool_ready_grace=0),
                user_content="请继续这个方案",
                history=[
                    AgentMessage(role="user", content="先比较两个内核"),
                    AgentMessage(role="assistant", content="已经整理了兼容性差异"),
                ],
            )
            query = next(
                json.loads(line)
                for line in record.read_text(encoding="utf-8").splitlines()
                if json.loads(line).get("method") == "session/query"
            )
            text = query["params"]["contentBlocks"][0]["text"]
            self.assertIn("先比较两个内核", text)
            self.assertIn("已经整理了兼容性差异", text)
            self.assertIn("请继续这个方案", text)
        finally:
            await session.client.close()

    async def test_empty_idle_turn_completes_without_waiting_for_text(self) -> None:
        class EmptyTurnClient:
            def __init__(self) -> None:
                self._idle_sent = False

            async def start(self) -> None:
                return None

            async def initialize(self, params) -> dict:
                return {}

            async def session_query(self, session_id, blocks) -> dict:
                return {}

            async def next_request(self, *, timeout=None):
                raise DshTimeoutError("没有请求")

            async def next_notification(self, *, timeout=None):
                if not self._idle_sent:
                    self._idle_sent = True
                    return Notification("session.status", {"status": "idle"})
                raise DshClientError("运行时已关闭")

        session = SimpleNamespace(
            conversation_id=1, client=EmptyTurnClient(), home=self.root,
            last_active=0.0, initialized=False,
        )
        events = await self.collect(self.runtime(session, tool_ready_grace=0))
        completed = next(event for event in events if event["type"] == "completed")
        self.assertEqual(completed["result"]["status"], "done")
        self.assertEqual(completed["result"]["content"], "")

    async def test_kernel_launch_unavailability_is_returned_as_a_failed_event(self) -> None:
        class UnavailableManager:
            def acquire(self, *args, **kwargs):
                raise KernelUnavailable("DSH 运行时未安装")

        connection = {
            "model_name": "deepseek-v4-flash",
            "model_base_url": "https://api.deepseek.com",
            "api_key": "fake-key",
        }
        events = await self.collect(DshKernelRuntime(UnavailableManager(), connection, tool_ready_grace=0))
        failed = next(event for event in events if event["type"] == "error")
        self.assertEqual(failed["result"]["error"]["code"], "dsh_unavailable")
        self.assertIn("DSH 运行时未安装", failed["result"]["error"]["message"])

    async def test_close_runtime_clears_pending_approvals_and_sessions(self) -> None:
        fake_manager = SimpleNamespace(close_all=AsyncMock())
        adapter_module._pending[(0, 1)] = {"request_id": "stale"}

        with patch.object(adapter_module, "_manager", fake_manager):
            await close_dsh_runtime()

        fake_manager.close_all.assert_awaited_once()
        self.assertEqual(adapter_module._pending, {})


if __name__ == "__main__":
    unittest.main()
