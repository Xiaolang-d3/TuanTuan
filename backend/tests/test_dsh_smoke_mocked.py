from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db
from app.agent.kernels.dsh import manager as dsh_manager
from app.agent.kernels.dsh.adapter import DshKernelRuntime
from app.agent.kernels.dsh.client import DshJsonRpcClient


PYTHON = sys.executable
FIXTURE = str(Path(__file__).resolve().parent / "fixtures" / "fake_dsh_runtime.py")


class DshSmokeMockedTest(unittest.IsolatedAsyncioTestCase):
    async def test_manager_and_adapter_run_one_turn_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            previous_data_dir = db.DATA_DIR
            db.DATA_DIR = root / "data"
            db.DATA_DIR.mkdir(parents=True, exist_ok=True)
            bin_js = db.DATA_DIR / "dsh-runtime" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
            bin_js.parent.mkdir(parents=True, exist_ok=True)
            bin_js.write_text("// fake", encoding="utf-8")
            try:
                with patch.object(dsh_manager, "current_user_id", return_value=0), patch.object(
                    dsh_manager.shutil, "which", return_value="node"
                ):
                    runtime = DshRuntimeManagerStub()
                    connection = {
                        "model_name": "deepseek-v4-flash",
                        "model_base_url": "https://api.deepseek.com",
                        "api_key": "fake-key",
                    }
                    adapter = DshKernelRuntime(runtime, connection, tool_ready_grace=0)
                    events = []
                    async for event in adapter.run_stream("你好", conversation_id=1):
                        events.append(event.model_dump(mode="json"))
                    completed = next(event for event in events if event["type"] == "completed")
                    self.assertIn("中文回复", completed["result"]["content"])
                    if runtime.last_session is not None:
                        await runtime.last_session.client.close()
            finally:
                db.DATA_DIR = previous_data_dir


class DshRuntimeManagerStub:
    last_session: dsh_manager.DshSession | None = None

    def acquire(self, conversation_id: int, connection: dict) -> dsh_manager.DshSession:
        root = Path(db.DATA_DIR) / "dsh" / "0" / str(conversation_id)
        root.mkdir(parents=True, exist_ok=True)
        client = DshJsonRpcClient(
            DshLaunchFake(), tmp_dir=root / "tmp", request_timeout=10.0, shutdown_timeout=2.0
        )
        self.last_session = dsh_manager.DshSession(conversation_id, client, root)
        return self.last_session


class DshLaunchFake:
    bin = PYTHON
    args = (FIXTURE,)
    env: dict[str, str] = {}


if __name__ == "__main__":
    unittest.main()
