from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db
import app.chat.execution as execution
from app.chat.conversations import create_conversation


class KernelStateResetTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "kernel-state.db"
        db.init_db()

    async def asyncTearDown(self) -> None:
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    async def test_cancelling_a_dsh_conversation_resets_harness_state(self) -> None:
        conversation = create_conversation("DSH 取消测试", kernel="dsh")

        with patch.object(execution, "reset_conversation_kernel_state") as reset_state:
            result = await execution.cancel_current_agent_task(conversation["id"])

        self.assertFalse(result["cancelled"])
        reset_state.assert_called_once_with(conversation["id"])
