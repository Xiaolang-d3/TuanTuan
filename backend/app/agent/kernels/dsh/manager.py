"""DSH 子进程管理器：按对话隔离的运行时生命周期。"""

from __future__ import annotations

import asyncio
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from .... import db
from ....workspace import current_user_id
from ..base import KernelUnavailable, is_deepseek_official_endpoint
from .client import DshJsonRpcClient, DshLaunch
from .composition import write_patch


DshSessionKey = tuple[int, int]


def _data_dir() -> Path:
    return Path(db.DATA_DIR)


def dsh_runtime_root() -> Path:
    return _data_dir() / "dsh"


def dsh_home(conversation_id: int | str) -> Path:
    user_id = current_user_id() or 0
    return dsh_runtime_root() / str(user_id) / str(conversation_id)


def _session_key(conversation_id: int) -> DshSessionKey:
    return (int(current_user_id() or 0), int(conversation_id))


def _vendored_bin_js() -> Path:
    return _data_dir() / "dsh-runtime" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"


def build_dsh_launch(connection: dict[str, Any], *, patch_path: Path, patch_args: tuple[str, ...] = ()) -> DshLaunch:
    """把团团模型连接映射为 DSH 子进程启动参数。"""
    base_url = str(connection.get("model_base_url") or "").strip()
    if not is_deepseek_official_endpoint(base_url):
        raise KernelUnavailable("DSH 内核暂仅支持 DeepSeek 官方端点")
    node = shutil.which("node")
    if node is None:
        raise KernelUnavailable("DSH 内核需要系统 Node（>= 24.9）")
    bin_js = _vendored_bin_js()
    if not bin_js.is_file():
        raise KernelUnavailable("DSH 运行时未安装，请先执行 vendor 脚本")
    env = {
        "DSH_HOME": str(patch_path.parent),
        "DEEPSEEK_BASE_URL": base_url,
    }
    api_key = str(connection.get("api_key") or "")
    if api_key:
        env["DEEPSEEK_API_KEY"] = api_key
    args = (str(bin_js), "--profile", "sdk", "--patch", str(patch_path), *patch_args)
    return DshLaunch(bin=node, args=args, env=env)


class DshSession:
    def __init__(
        self,
        conversation_id: int,
        client: DshJsonRpcClient,
        home: Path,
        *,
        needs_history_rebuild: bool = False,
    ) -> None:
        self.conversation_id = conversation_id
        self.client = client
        self.home = home
        self.last_active = time.monotonic()
        self.initialized = False
        self.in_use = False
        self.needs_history_rebuild = needs_history_rebuild


class DshRuntimeManager:
    def __init__(self, *, idle_seconds: float = 600.0, client_factory: Any = DshJsonRpcClient) -> None:
        self._idle_seconds = idle_seconds
        self._client_factory = client_factory
        self._sessions: dict[DshSessionKey, DshSession] = {}
        self._history_rebuilds: set[DshSessionKey] = set()
        self._lock = threading.RLock()

    def acquire(self, conversation_id: int, connection: dict[str, Any]) -> DshSession:
        stale: DshSession | None = None
        key = _session_key(conversation_id)
        with self._lock:
            existing = self._sessions.get(key)
            if existing is not None and (existing.client.running or not existing.initialized):
                existing.last_active = time.monotonic()
                return existing
            if existing is not None:
                stale = self._sessions.pop(key)
            home = dsh_home(conversation_id)
            patch_path = home / "tuantuan.patch.yml"
            write_patch(patch_path, str(connection.get("model_base_url") or ""))
            launch = build_dsh_launch(connection, patch_path=patch_path)
            client = self._client_factory(launch, tmp_dir=home / "tmp")
            session = DshSession(
                conversation_id,
                client,
                home,
                needs_history_rebuild=key in self._history_rebuilds,
            )
            self._sessions[key] = session
            self._history_rebuilds.discard(key)
        if stale is not None:
            self._close_session(stale)
        return session

    def terminate(self, conversation_id: int) -> None:
        key = _session_key(conversation_id)
        with self._lock:
            session = self._sessions.pop(key, None)
        if session is None:
            return
        self._close_session(session)

    @staticmethod
    def _close_session(session: DshSession) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(session.client.close())
        else:
            loop.create_task(session.client.close())

    def cancel_run(self, conversation_id: int) -> None:
        """停止一轮：终止子进程；会话状态保留，下次消息走重建。"""
        self.terminate(conversation_id)

    def purge(self, conversation_id: int, *, keep_history_rebuild: bool = False) -> None:
        key = _session_key(conversation_id)
        if not keep_history_rebuild:
            with self._lock:
                self._history_rebuilds.discard(key)
        self.terminate(conversation_id)
        home = dsh_home(conversation_id)
        if home.is_relative_to(dsh_runtime_root()) and home.exists():
            shutil.rmtree(home, ignore_errors=True)

    def reset_for_history_change(self, conversation_id: int) -> None:
        """Discard a stale DSH session and require the next prompt to rebuild from SQL history."""
        key = _session_key(conversation_id)
        with self._lock:
            self._history_rebuilds.add(key)
        self.purge(conversation_id, keep_history_rebuild=True)

    def reap_idle(self, *, now: float | None = None) -> list[int]:
        deadline = (time.monotonic() if now is None else now) - self._idle_seconds
        idle_ids: list[int] = []
        idle_sessions: list[DshSession] = []
        with self._lock:
            for key, session in list(self._sessions.items()):
                if not session.in_use and session.last_active <= deadline:
                    idle_ids.append(session.conversation_id)
                    idle_sessions.append(session)
                    self._sessions.pop(key, None)
        for session in idle_sessions:
            self._close_session(session)
        return idle_ids

    async def close_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
            self._history_rebuilds.clear()
        await asyncio.gather(*(session.client.close() for session in sessions), return_exceptions=True)
