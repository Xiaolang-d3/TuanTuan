from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.agent.kernels.dsh import adapter as adapter_module
from app.agent.kernels.dsh.adapter import DshKernelRuntime
from app.agent.kernels.dsh.approvals import APPROVE_LABEL, approval_clarification, decision_from_reply
from app.agent.kernels.dsh.client import DshJsonRpcClient, DshLaunch, Notification


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
            self.assertIn(1, adapter_module._pending)
            second = await self.collect(
                self.runtime(session, tool_ready_grace=0),
                user_content=APPROVE_LABEL,
                resume=type("R", (), {"model_dump": lambda self, **k: snapshot})(),
            )
            completed = next(event for event in second if event["type"] == "completed")
            self.assertIn("中文回复", completed["result"]["content"])
            self.assertNotIn(1, adapter_module._pending)
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


if __name__ == "__main__":
    unittest.main()
