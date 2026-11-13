from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from app.agent.kernels.base import (
    DEFAULT_KERNEL,
    KernelUnavailable,
    dsh_feature_enabled,
    has_deepseek_connection,
    is_deepseek_model_name,
    is_dsh_safe_endpoint,
    is_kernel_available,
    is_valid_kernel,
    normalize_kernel,
    validate_kernel_selection,
)
from app.agent.run_store import AgentRunStore
from app.agent.settings import get_agent_settings, save_agent_settings
from app.chat.conversations import create_conversation, fork_conversation, update_conversation
from app.db import connect, init_db


class KernelSelectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._temp_dir.name) / "test.db"
        init_db(self.db_path)
        self._previous_dsh = os.environ.get("TUANTUAN_DSH_ENABLED")
        os.environ["TUANTUAN_DSH_ENABLED"] = "1"

    def tearDown(self) -> None:
        if self._previous_dsh is None:
            os.environ.pop("TUANTUAN_DSH_ENABLED", None)
        else:
            os.environ["TUANTUAN_DSH_ENABLED"] = self._previous_dsh
        self._temp_dir.cleanup()

    def test_normalize_and_validate_kernel(self) -> None:
        self.assertEqual(normalize_kernel("DSH"), "dsh")
        self.assertEqual(normalize_kernel(""), DEFAULT_KERNEL)
        self.assertEqual(normalize_kernel("unknown"), DEFAULT_KERNEL)
        self.assertTrue(is_valid_kernel("tuantuan"))
        self.assertTrue(is_valid_kernel("dsh"))
        self.assertFalse(is_valid_kernel("other"))

    def test_conversation_defaults_to_tuantuan_and_accepts_dsh(self) -> None:
        default = create_conversation("默认内核", self.db_path)
        self.assertEqual(default["kernel"], "tuantuan")
        dsh = create_conversation("DSH 内核", self.db_path, kernel="dsh")
        self.assertEqual(dsh["kernel"], "dsh")
        with self.assertRaises(ValueError):
            create_conversation("非法内核", self.db_path, kernel="other")

    def test_kernel_locked_after_first_message(self) -> None:
        conversation = create_conversation("锁定测试", self.db_path, kernel="dsh")
        with connect(self.db_path) as conn:
            conn.execute(
                "INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', ?)",
                (conversation["id"], "第一条消息"),
            )
        with self.assertRaises(ValueError):
            update_conversation(conversation["id"], kernel="tuantuan", kernel_selected=True, db_path=self.db_path)
        empty = create_conversation("可切换", self.db_path, kernel="dsh")
        updated = update_conversation(empty["id"], kernel="tuantuan", kernel_selected=True, db_path=self.db_path)
        self.assertEqual(updated["kernel"], "tuantuan")

    def test_default_kernel_setting_roundtrip(self) -> None:
        self.assertEqual(get_agent_settings(self.db_path)["default_kernel"], "tuantuan")
        saved = save_agent_settings({"default_kernel": "dsh"}, self.db_path)
        self.assertEqual(saved["default_kernel"], "dsh")
        self.assertEqual(get_agent_settings(self.db_path)["default_kernel"], "dsh")
        with self.assertRaises(ValueError):
            save_agent_settings({"default_kernel": "other"}, self.db_path)

    def test_dsh_availability_needs_feature_and_deepseek_connection(self) -> None:
        self.assertTrue(is_kernel_available("tuantuan", self.db_path))
        self.assertFalse(is_kernel_available("dsh", self.db_path))
        with self.assertRaisesRegex(KernelUnavailable, "模型档案"):
            validate_kernel_selection("dsh", self.db_path)
        with connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO model_connections (id, name, base_url, effective_base_url, protocol, data_boundary)
                VALUES ('lookalike-1', 'Lookalike', 'https://api.deepseek.com.attacker.test', 'https://api.deepseek.com.attacker.test', 'auto', 'lookalike-1')
                """
            )
            conn.execute(
                """
                INSERT INTO model_profiles (id, connection_id, model_name, name)
                VALUES ('lookalike-profile', 'lookalike-1', 'deepseek-chat', 'Lookalike')
                """
            )
        self.assertFalse(has_deepseek_connection(self.db_path))
        with connect(self.db_path) as conn:
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
        self.assertTrue(has_deepseek_connection(self.db_path))
        self.assertTrue(is_kernel_available("dsh", self.db_path))
        os.environ["TUANTUAN_DSH_ENABLED"] = "0"
        self.assertFalse(dsh_feature_enabled())
        self.assertFalse(is_kernel_available("dsh", self.db_path))

    def test_dsh_endpoint_policy_accepts_configured_https_and_rejects_deception(self) -> None:
        self.assertTrue(is_dsh_safe_endpoint("https://api.deepseek.com"))
        self.assertTrue(is_dsh_safe_endpoint("https://api.deepseek.com/v1"))
        self.assertTrue(is_dsh_safe_endpoint("https://www.fastaitoken.com/v1"))
        self.assertFalse(is_dsh_safe_endpoint("http://api.deepseek.com"))
        self.assertFalse(is_dsh_safe_endpoint("http://www.fastaitoken.com/v1"))
        self.assertFalse(is_dsh_safe_endpoint("https://api.deepseek.com.attacker.test"))
        self.assertFalse(is_dsh_safe_endpoint("https://api.deepseek.com@attacker.test"))
        self.assertTrue(is_deepseek_model_name("deepseek-v4-flash"))
        self.assertTrue(is_deepseek_model_name("DeepSeek-Chat"))
        self.assertFalse(is_deepseek_model_name("gpt-6.1-sol"))

    def test_dsh_availability_needs_a_deepseek_model_profile(self) -> None:
        with connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO model_connections (id, name, base_url, effective_base_url, protocol, data_boundary)
                VALUES ('official-1', 'Official', 'https://api.deepseek.com', 'https://api.deepseek.com', 'auto', 'official-1')
                """
            )
            conn.execute(
                """
                INSERT INTO model_profiles (id, connection_id, model_name, name)
                VALUES ('gpt-profile', 'official-1', 'gpt-6.1-sol', 'GPT')
                """
            )
        self.assertFalse(has_deepseek_connection(self.db_path))
        self.assertFalse(is_kernel_available("dsh", self.db_path))

    def test_proxy_endpoint_with_deepseek_profile_enables_dsh(self) -> None:
        with connect(self.db_path) as conn:
            conn.execute(
                """
                INSERT INTO model_connections (id, name, base_url, effective_base_url, protocol, data_boundary)
                VALUES ('proxy-1', 'Proxy', 'https://www.fastaitoken.com/v1', 'https://www.fastaitoken.com/v1', 'auto', 'proxy-1')
                """
            )
            conn.execute(
                """
                INSERT INTO model_profiles (id, connection_id, model_name, name)
                VALUES ('proxy-profile', 'proxy-1', 'deepseek-v4-flash', 'DeepSeek Flash')
                """
            )
        self.assertTrue(has_deepseek_connection(self.db_path))
        self.assertTrue(is_kernel_available("dsh", self.db_path))

    def test_switching_or_forking_to_dsh_binds_a_deepseek_profile(self) -> None:
        with connect(self.db_path) as conn:
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

        created = create_conversation("直接创建 DSH", self.db_path, kernel="dsh")
        self.assertEqual(created["model_profile_id"], "deepseek-profile")

        empty = create_conversation("可切换", self.db_path)
        switched = update_conversation(empty["id"], kernel="dsh", kernel_selected=True, db_path=self.db_path)
        self.assertEqual(switched["model_profile_id"], "deepseek-profile")

        source = create_conversation("有历史的对话", self.db_path)
        forked = fork_conversation(source["id"], kernel="dsh", db_path=self.db_path)
        self.assertEqual(forked["model_profile_id"], "deepseek-profile")

        with self.assertRaisesRegex(ValueError, "DeepSeek"):
            update_conversation(
                switched["id"],
                model_profile_id=None,
                model_profile_selected=True,
                db_path=self.db_path,
            )

    def test_run_store_records_kernel(self) -> None:
        store = AgentRunStore(self.db_path)
        run = store.start_run(
            "run-kernel-1",
            conversation_id=1,
            task_id=None,
            user_content="测试内核记录",
            kernel="dsh",
        )
        self.assertEqual(run["kernel"], "dsh")
        self.assertEqual(store.get_run("run-kernel-1")["kernel"], "dsh")


if __name__ == "__main__":
    unittest.main()
