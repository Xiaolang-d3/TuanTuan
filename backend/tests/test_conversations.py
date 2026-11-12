from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from app.chat.conversations import (
    create_conversation,
    end_active_task,
    ensure_active_task,
    fork_conversation,
    list_conversations,
)
from app.chat.service import agent_history
from app.db import connect, init_db


class ConversationTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._temp_dir.name) / "test.db"
        init_db(self.db_path)

    def tearDown(self) -> None:
        self._temp_dir.cleanup()

    def test_messages_and_tasks_are_isolated(self) -> None:
        first = create_conversation("AI Agent 岗位", self.db_path)
        second = create_conversation("Python 后端", self.db_path)
        first_task = ensure_active_task(first["id"], self.db_path)
        second_task = ensure_active_task(second["id"], self.db_path)

        with connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO chat_messages (conversation_id, task_id, role, content) VALUES (?, ?, 'user', ?)",
                (first["id"], first_task, "分析当前岗位"),
            )
            first_count = conn.execute(
                "SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?",
                (first["id"],),
            ).fetchone()["count"]
            second_count = conn.execute(
                "SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?",
                (second["id"],),
            ).fetchone()["count"]

        self.assertEqual(first_count, 1)
        self.assertEqual(second_count, 0)
        self.assertNotEqual(first_task, second_task)

    def test_new_task_is_created_after_current_task_ends(self) -> None:
        conversation = create_conversation("面试准备", self.db_path)
        first_task = ensure_active_task(conversation["id"], self.db_path)
        self.assertTrue(end_active_task(conversation["id"], self.db_path))
        next_task = ensure_active_task(conversation["id"], self.db_path)

        self.assertNotEqual(first_task, next_task)
        self.assertGreaterEqual(len(list_conversations(self.db_path)), 2)

    def test_fork_creates_an_empty_target_with_read_only_context_snapshot(self) -> None:
        source = create_conversation("产品方案", self.db_path, kernel="tuantuan")
        task_id = ensure_active_task(source["id"], self.db_path)
        with connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO chat_messages (conversation_id, task_id, role, content) VALUES (?, ?, 'user', ?)",
                (source["id"], task_id, "先比较两个内核"),
            )
            conn.execute(
                "INSERT INTO chat_messages (conversation_id, task_id, role, content) VALUES (?, ?, 'assistant', ?)",
                (source["id"], task_id, "已经整理了兼容性差异"),
            )

        forked = fork_conversation(source["id"], kernel="dsh", db_path=self.db_path)

        self.assertEqual(forked["kernel"], "dsh")
        self.assertNotEqual(forked["id"], source["id"])
        with connect(self.db_path) as conn:
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?",
                    (source["id"],),
                ).fetchone()["count"],
                2,
            )
            self.assertEqual(
                conn.execute(
                    "SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?",
                    (forked["id"],),
                ).fetchone()["count"],
                0,
            )
        history = agent_history(forked["id"], 10**9, self.db_path)
        self.assertEqual(history[0].role, "system")
        self.assertIn("先比较两个内核", history[0].content)
        self.assertIn("已经整理了兼容性差异", history[0].content)


if __name__ == "__main__":
    unittest.main()
