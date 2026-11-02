from __future__ import annotations

import tempfile
import unittest
import os
from pathlib import Path

from app.agent.settings import get_agent_settings, get_model_connection, persona_prompt, save_agent_settings
from app.chat.conversations import create_conversation, ensure_active_task, reset_conversation_context
from app.db import connect, init_db
from app.secret_store import _MEMORY_SECRETS


class AgentSettingsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._temp_dir.name) / "test.db"
        os.environ["TUANTUAN_SECRET_BACKEND"] = "memory"
        _MEMORY_SECRETS.clear()
        init_db(self.db_path)

    def tearDown(self) -> None:
        os.environ.pop("TUANTUAN_SECRET_BACKEND", None)
        _MEMORY_SECRETS.clear()
        self._temp_dir.cleanup()

    def test_model_api_key_uses_secret_store_instead_of_sqlite(self) -> None:
        settings = get_agent_settings(self.db_path)
        settings["model_name"] = "secret-storage-test-model"
        settings["api_key"] = "test-secret-not-for-network"

        saved = save_agent_settings(settings, self.db_path)

        with connect(self.db_path) as conn:
            stored = conn.execute(
                "SELECT model_api_key FROM agent_settings WHERE id = 1"
            ).fetchone()["model_api_key"]
        self.assertEqual(stored, "")
        self.assertTrue(saved["api_key_configured"])
        self.assertEqual(
            get_model_connection(self.db_path)["api_key"],
            "test-secret-not-for-network",
        )

    def test_rebrand_preserves_custom_names_and_normalizes_legacy_defaults(self) -> None:
        self.assertEqual(get_agent_settings(self.db_path)["display_name"], "团团")
        for stored_name, expected in [
            ("CareerLoop", "团团"),
            ("BossCopilot", "团团"),
            ("灯灯", "团团"),
            ("我的研究搭档", "我的研究搭档"),
        ]:
            with self.subTest(stored_name=stored_name):
                with connect(self.db_path) as conn:
                    conn.execute(
                        "UPDATE agent_settings SET display_name = ? WHERE id = 1",
                        (stored_name,),
                    )
                settings = get_agent_settings(self.db_path)
                self.assertEqual(settings["display_name"], expected)
                self.assertIn(f"你的显示名称是 {expected}", persona_prompt(settings))
                with connect(self.db_path) as conn:
                    self.assertEqual(
                        conn.execute("SELECT display_name FROM agent_settings WHERE id = 1").fetchone()["display_name"],
                        expected,
                    )

    def test_persona_and_memory_settings_are_persisted(self) -> None:
        settings = get_agent_settings(self.db_path)
        settings.update({
            "display_name": "机会顾问",
            "persona_role": "坦诚、重视证据的求职顾问",
            "response_style": "detailed",
            "custom_instructions": "优先指出风险",
            "library_memory_enabled": False,
            "context_message_limit": 20,
        })
        saved = save_agent_settings(settings, self.db_path)

        self.assertEqual(saved["display_name"], "机会顾问")
        self.assertFalse(saved["library_memory_enabled"])
        self.assertEqual(saved["context_message_limit"], 20)
        prompt = persona_prompt(saved)
        self.assertIn("不得覆盖", prompt)
        self.assertIn("实际工具权限", prompt)
        self.assertIn("优先指出风险", prompt)

    def test_model_protocol_is_persisted_and_custom_gateway_uses_model_family(self) -> None:
        settings = get_agent_settings(self.db_path)
        settings.update({
            "model_name": "claude-sonnet-5-thinking",
            "model_base_url": "https://gateway.example.test",
            "model_protocol": "auto",
        })

        saved = save_agent_settings(settings, self.db_path)

        self.assertEqual(saved["model_protocol"], "auto")
        self.assertEqual(saved["resolved_model_protocol"], "anthropic")

        settings["model_protocol"] = "openai"
        overridden = save_agent_settings(settings, self.db_path)
        self.assertEqual(overridden["resolved_model_protocol"], "openai")

    def test_context_reset_preserves_messages_and_moves_cutoff(self) -> None:
        conversation = create_conversation("上下文测试", self.db_path)
        task_id = ensure_active_task(conversation["id"], self.db_path)
        with connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO chat_messages (conversation_id, task_id, role, content) VALUES (?, ?, 'user', '旧任务')",
                (conversation["id"], task_id),
            )
            message_id = conn.execute("SELECT MAX(id) AS id FROM chat_messages").fetchone()["id"]

        reset = reset_conversation_context(conversation["id"], self.db_path)
        with connect(self.db_path) as conn:
            count = conn.execute(
                "SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ?",
                (conversation["id"],),
            ).fetchone()["count"]

        self.assertEqual(reset["context_cutoff_message_id"], message_id)
        self.assertEqual(count, 1)
