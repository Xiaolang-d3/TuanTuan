from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db
from app.agent.kernels.base import KernelUnavailable
from app.agent.kernels.dsh import manager
from app.agent.kernels.dsh.composition import write_patch
from app.agent.kernels.dsh.manager import DshRuntimeManager, build_dsh_launch, dsh_home


class FakeClient:
    def __init__(self, launch, tmp_dir=None) -> None:
        self.launch = launch
        self.tmp_dir = tmp_dir
        self.running = True
        self.closed = False

    async def start(self) -> None:
        self.running = True

    async def close(self) -> None:
        self.closed = True
        self.running = False


class DormantClient(FakeClient):
    def __init__(self, launch, tmp_dir=None) -> None:
        super().__init__(launch, tmp_dir)
        self.running = False


class DshManagerTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self._temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self._temp_dir.name)
        self._original_data_dir = db.DATA_DIR
        db.DATA_DIR = self.root / "data"
        db.DATA_DIR.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        db.DATA_DIR = self._original_data_dir
        self._temp_dir.cleanup()

    def deepseek_connection(self, base_url: str = "https://api.deepseek.com") -> dict:
        return {"model_base_url": base_url, "api_key": "test-key"}

    def vendored_bin(self) -> Path:
        path = db.DATA_DIR / "dsh-runtime" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("// fake", encoding="utf-8")
        return path

    def test_dsh_home_is_scoped_by_user_and_conversation(self) -> None:
        with patch.object(manager, "current_user_id", return_value=7):
            self.assertEqual(dsh_home(3), db.DATA_DIR / "dsh" / "7" / "3")

    def test_build_launch_maps_deepseek_connection(self) -> None:
        self.vendored_bin()
        home = db.DATA_DIR / "dsh" / "0" / "1"
        patch_path = home / "tuantuan.patch.yml"
        write_patch(patch_path, "https://api.deepseek.com", "C:/python.exe", ["-m", "mcp"])
        with patch.object(manager.shutil, "which", return_value="C:/node/node.exe"):
            launch = build_dsh_launch(self.deepseek_connection(), patch_path=patch_path)
        self.assertEqual(launch.bin, "C:/node/node.exe")
        self.assertIn("--profile", launch.args)
        self.assertIn("sdk", launch.args)
        self.assertIn(str(patch_path), launch.args)
        self.assertEqual(launch.env["DSH_HOME"], str(home))
        self.assertEqual(launch.env["DEEPSEEK_BASE_URL"], "https://api.deepseek.com")
        self.assertEqual(launch.env["DEEPSEEK_API_KEY"], "test-key")
        patch_text = patch_path.read_text(encoding="utf-8")
        self.assertIn("baseURL: 'https://api.deepseek.com'", patch_text)
        self.assertIn("- id: tool-bash", patch_text)
        self.assertIn("disabled: true", patch_text)
        self.assertIn("name: '@deepseek-ai/dsh-mcp-client'", patch_text)
        self.assertIn("command: 'C:/python.exe'", patch_text)

    def test_build_launch_accepts_any_safe_https_endpoint(self) -> None:
        self.vendored_bin()
        with patch.object(manager.shutil, "which", return_value="node"):
            launch = build_dsh_launch(
                self.deepseek_connection("https://www.fastaitoken.com/v1"),
                patch_path=db.DATA_DIR / "p.yml",
            )
            self.assertEqual(launch.env["DEEPSEEK_BASE_URL"], "https://www.fastaitoken.com/v1")

    def test_build_launch_rejects_lookalike_and_insecure_endpoints(self) -> None:
        self.vendored_bin()
        with patch.object(manager.shutil, "which", return_value="node"):
            for url in (
                "https://api.deepseek.com.attacker.test",
                "http://api.deepseek.com",
                "http://www.fastaitoken.com/v1",
                "https://user@www.fastaitoken.com/v1",
            ):
                with self.subTest(url=url), self.assertRaises(KernelUnavailable):
                    build_dsh_launch(
                        self.deepseek_connection(url),
                        patch_path=db.DATA_DIR / "p.yml",
                    )

    def test_build_launch_requires_node_and_vendored_runtime(self) -> None:
        with patch.object(manager.shutil, "which", return_value=None):
            with self.assertRaises(KernelUnavailable):
                build_dsh_launch(self.deepseek_connection(), patch_path=db.DATA_DIR / "p.yml")
        bin_js = self.vendored_bin()
        with patch.object(manager.shutil, "which", return_value="node"):
            launch = build_dsh_launch(
                self.deepseek_connection(),
                patch_path=db.DATA_DIR / "p.yml",
            )
            self.assertEqual(launch.bin, "node")
            bin_js.unlink()
            with self.assertRaises(KernelUnavailable):
                build_dsh_launch(
                    self.deepseek_connection(),
                    patch_path=db.DATA_DIR / "p.yml",
                )

    async def test_acquire_reuses_live_session_and_terminate_closes(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(client_factory=FakeClient)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            first = runtime.acquire(1, self.deepseek_connection())
            second = runtime.acquire(1, self.deepseek_connection())
            self.assertIs(first, second)
            runtime.terminate(1)
            third = runtime.acquire(1, self.deepseek_connection())
            self.assertIsNot(first, third)
        await runtime.close_all()

    async def test_acquire_replaces_session_for_each_execution_configuration_change(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(client_factory=FakeClient)
        self.addAsyncCleanup(runtime.close_all)
        base = {
            **self.deepseek_connection(),
            "profile_id": "profile-a",
            "profile_revision": 1,
            "connection_id": "connection-a",
            "connection_revision": 1,
            "credential_fingerprint": "fingerprint-a",
        }
        changes = {
            "model_name": "deepseek-v4-pro",
            "model_base_url": "https://api.deepseek.com/v1",
            "profile_id": "profile-b",
            "profile_revision": 2,
            "connection_id": "connection-b",
            "connection_revision": 2,
            "credential_fingerprint": "fingerprint-b",
        }
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            for conversation_id, (field, value) in enumerate(changes.items(), start=1):
                with self.subTest(field=field):
                    first = runtime.acquire(conversation_id, base)
                    same = runtime.acquire(conversation_id, {**base, "config_revision": 2})
                    self.assertIs(first, same)
                    second = runtime.acquire(conversation_id, {**base, field: value})
                    self.assertIsNot(first, second)
                    await second.start()
                    self.assertTrue(first.client.closed)

    async def test_acquire_keeps_an_active_session_when_configuration_changes(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(client_factory=FakeClient)
        self.addAsyncCleanup(runtime.close_all)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            connection = self.deepseek_connection()
            session = runtime.acquire(1, connection)
            session.in_use = True
            with self.assertRaises(KernelUnavailable):
                runtime.acquire(1, {**connection, "model_name": "deepseek-v4-pro"})
            session.in_use = False
            self.assertIs(session, runtime.acquire(1, connection))
            self.assertFalse(session.client.closed)

    async def test_replacement_waits_for_retired_client_before_writing_patch(self) -> None:
        self.vendored_bin()
        close_started = asyncio.Event()
        allow_close = asyncio.Event()
        owner_loop = asyncio.get_running_loop()

        class SlowCloseClient(FakeClient):
            async def close(self) -> None:
                assert asyncio.get_running_loop() is owner_loop
                close_started.set()
                await allow_close.wait()
                await super().close()

        runtime = DshRuntimeManager(client_factory=SlowCloseClient)
        self.addAsyncCleanup(runtime.close_all)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            first = runtime.acquire(1, self.deepseek_connection())
            await first.start()
            await asyncio.to_thread(runtime.terminate, 1)
            second = runtime.acquire(1, self.deepseek_connection("https://api.deepseek.com/v1"))
            patch_path = first.home / "tuantuan.patch.yml"
            preparation = asyncio.create_task(second.start())
            try:
                await asyncio.wait_for(close_started.wait(), timeout=2)
                self.assertFalse(preparation.done())
                self.assertIn("baseURL: 'https://api.deepseek.com'", patch_path.read_text(encoding="utf-8"))
            finally:
                allow_close.set()
                await asyncio.wait_for(preparation, timeout=2)
            self.assertTrue(first.client.closed)
            self.assertIn("baseURL: 'https://api.deepseek.com/v1'", patch_path.read_text(encoding="utf-8"))

    async def test_threaded_reset_closes_a_session_that_is_still_starting(self) -> None:
        self.vendored_bin()
        start_entered = asyncio.Event()
        allow_start = asyncio.Event()
        calls = []

        class SlowStartingClient(DormantClient):
            async def start(self) -> None:
                start_entered.set()
                await allow_start.wait()
                await super().start()
                calls.append("started")

            async def close(self) -> None:
                calls.append("closed")
                await super().close()

        runtime = DshRuntimeManager(client_factory=SlowStartingClient)
        self.addAsyncCleanup(runtime.close_all)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            first = runtime.acquire(1, self.deepseek_connection())
            starting = asyncio.create_task(first.start())
            try:
                await asyncio.wait_for(start_entered.wait(), timeout=2)
                await asyncio.to_thread(runtime.terminate, 1)
                second = runtime.acquire(1, self.deepseek_connection("https://api.deepseek.com/v1"))
            finally:
                allow_start.set()
            with self.assertRaises(KernelUnavailable):
                await asyncio.wait_for(starting, timeout=2)
            await asyncio.wait_for(second.start(), timeout=2)
            self.assertEqual(calls, ["started", "closed", "started"])
            self.assertFalse(first.client.running)

    async def test_acquire_closes_a_non_running_replaced_session(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(client_factory=FakeClient)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            first = runtime.acquire(1, self.deepseek_connection())
            first.client.running = False
            first.initialized = True
            second = runtime.acquire(1, self.deepseek_connection())
            self.assertIsNot(first, second)
            await asyncio.sleep(0)
            self.assertTrue(first.client.closed)
        await runtime.close_all()

    async def test_acquire_keeps_a_session_reserved_for_initialization(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(client_factory=DormantClient)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            first = runtime.acquire(1, self.deepseek_connection())
            second = runtime.acquire(1, self.deepseek_connection())
            self.assertIs(first, second)
        await runtime.close_all()

    async def test_same_conversation_id_is_isolated_between_users(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(client_factory=FakeClient)
        with patch.object(manager.shutil, "which", return_value="node"):
            with patch.object(manager, "current_user_id", return_value=1):
                first = runtime.acquire(1, self.deepseek_connection())
            with patch.object(manager, "current_user_id", return_value=2):
                second = runtime.acquire(1, self.deepseek_connection())
            self.assertIsNot(first, second)
            with patch.object(manager, "current_user_id", return_value=1):
                self.assertIs(first, runtime.acquire(1, self.deepseek_connection()))
                runtime.terminate(1)
            await asyncio.sleep(0)
            self.assertTrue(first.client.closed)
            self.assertFalse(second.client.closed)
        await runtime.close_all()

    async def test_reap_idle_terminates_stale_sessions(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(idle_seconds=60.0, client_factory=FakeClient)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            session = runtime.acquire(1, self.deepseek_connection())
            session.last_active -= 120
            self.assertEqual(runtime.reap_idle(), [1])
            await asyncio.sleep(0)
            self.assertTrue(session.client.closed)
            session.last_active = 0
            runtime.acquire(1, self.deepseek_connection())
            self.assertEqual(runtime.reap_idle(), [])
        await runtime.close_all()

    async def test_reap_idle_keeps_a_session_with_an_active_turn(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(idle_seconds=60.0, client_factory=FakeClient)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            session = runtime.acquire(1, self.deepseek_connection())
            session.last_active -= 120
            session.in_use = True
            self.assertEqual(runtime.reap_idle(), [])
            self.assertFalse(session.client.closed)
        await runtime.close_all()

    async def test_purge_removes_conversation_state(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(client_factory=FakeClient)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            runtime.acquire(2, self.deepseek_connection())
            home = dsh_home(2)
            self.assertTrue(home.exists())
            runtime.purge(2)
            self.assertFalse(home.exists())
        await runtime.close_all()

    async def test_reset_for_history_change_marks_the_next_session_for_rebuild(self) -> None:
        self.vendored_bin()
        runtime = DshRuntimeManager(client_factory=FakeClient)
        with patch.object(manager, "current_user_id", return_value=0), patch.object(manager.shutil, "which", return_value="node"):
            runtime.acquire(2, self.deepseek_connection())
            home = dsh_home(2)
            runtime.reset_for_history_change(2)
            self.assertFalse(home.exists())
            rebuilt = runtime.acquire(2, self.deepseek_connection())
            self.assertTrue(rebuilt.needs_history_rebuild)
        await runtime.close_all()


if __name__ == "__main__":
    unittest.main()
