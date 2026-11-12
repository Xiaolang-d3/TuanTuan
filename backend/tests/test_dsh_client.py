from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

from app.agent.kernels.dsh.client import (
    DshJsonRpcClient,
    DshLaunch,
    DshProtocolError,
)


PYTHON = sys.executable
FIXTURE = str(Path(__file__).resolve().parent / "fixtures" / "fake_dsh_runtime.py")


class DshClientTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self._temp_dir.name)

    def tearDown(self) -> None:
        self._temp_dir.cleanup()

    def launch(self, *, env: dict[str, str] | None = None) -> DshJsonRpcClient:
        client_env = dict(env or {})
        return DshJsonRpcClient(
            DshLaunch(bin=PYTHON, args=(FIXTURE,), env=client_env),
            tmp_dir=self.root / "dsh-tmp",
            request_timeout=10.0,
            shutdown_timeout=2.0,
        )

    async def test_initialize_and_query_roundtrip(self) -> None:
        client = self.launch()
        try:
            await client.start()
            result = await client.initialize({"cwd": str(self.root), "provider": "deepseek-official", "model": "deepseek-v4-flash"})
            self.assertEqual(result["serverInfo"]["name"], "fake-dsh")
            query = await client.session_query("s-1", [{"type": "text", "text": "你好"}])
            self.assertEqual(query["messageId"], "msg-1")
            notifications = [await client.next_notification(), await client.next_notification()]
            self.assertEqual(notifications[0].method, "session.event")
            self.assertIn("中文回复", json.dumps(notifications[0].params, ensure_ascii=False))
            self.assertEqual(notifications[1].method, "session.status")
            self.assertEqual(notifications[1].params["status"], "idle")
        finally:
            await client.close()

    async def test_approval_request_roundtrip(self) -> None:
        record = self.root / "record.jsonl"
        client = self.launch(env={"FAKE_DSH_RECORD": str(record)})
        try:
            await client.start()
            await client.initialize({
                "cwd": str(self.root), "provider": "deepseek-official", "model": "deepseek-v4-flash",
                "approvalRequests": True,
            })
            request = await client.next_request(timeout=5.0)
            self.assertEqual(request.method, "approval/request")
            self.assertEqual(request.params["toolName"], "ping")
            await client.respond(request.params["requestId"], {"outcome": "allowed-once"})
            await client.session_wait("s-1")
            await client.close()
        finally:
            await client.close()
        recorded = json.loads(record.read_text(encoding="utf-8").strip().splitlines()[-1])
        self.assertEqual(recorded["id"], "req-1")
        self.assertEqual(recorded["result"], {"outcome": "allowed-once"})

    async def test_protocol_error_mapped(self) -> None:
        client = self.launch()
        try:
            await client.start()
            with self.assertRaises(DshProtocolError) as raised:
                await client.request("unknown-method", {})
            self.assertEqual(raised.exception.code, -32601)
        finally:
            await client.close()

    async def test_close_kills_process_ignoring_shutdown(self) -> None:
        client = self.launch(env={"FAKE_DSH_IGNORE_SHUTDOWN": "1"})
        await client.start()
        await client.initialize({"cwd": str(self.root)})
        await client.close()
        self.assertIsNotNone(client._process)
        self.assertIsNotNone(client._process.returncode)


if __name__ == "__main__":
    unittest.main()
