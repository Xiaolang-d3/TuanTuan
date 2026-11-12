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
from ..base import KernelUnavailable
from .client import DshJsonRpcClient, DshLaunch
from .composition import write_patch


def _data_dir() -> Path:
    return Path(db.DATA_DIR)


def dsh_runtime_root() -> Path:
    return _data_dir() / "dsh"


def dsh_home(conversation_id: int | str) -> Path:
    user_id = current_user_id() or 0
    return dsh_runtime_root() / str(user_id) / str(conversation_id)


def _vendored_bin_js() -> Path:
    return _data_dir() / "dsh-runtime" / "node_modules" / "@deepseek-ai" / "dsh" / "lib" / "bin.js"


def _is_deepseek_endpoint(base_url: str) -> bool:
    return "deepseek.com" in (base_url or "").lower()


def build_dsh_launch(connection: dict[str, Any], *, patch_path: Path, patch_args: tuple[str, ...] = ()) -> DshLaunch:
    """把团团模型连接映射为 DSH 子进程启动参数。"""
    base_url = str(connection.get("model_base_url") or "").strip()
    if not _is_deepseek_endpoint(base_url):
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
    def __init__(self, conversation_id: int, client: DshJsonRpcClient, home: Path) -> None:
        self.conversation_id = conversation_id
        self.client = client
        self.home = home
        self.last_active = time.monotonic()


class DshRuntimeManager:
    def __init__(self, *, idle_seconds: float = 600.0, client_factory: Any = DshJsonRpcClient) -> None:
        self._idle_seconds = idle_seconds
        self._client_factory = client_factory
        self._sessions: dict[int, DshSession] = {}
        self._lock = threading.RLock()

    def acquire(self, conversation_id: int, connection: dict[str, Any]) -> DshSession:
        with self._lock:
            existing = self._sessions.get(conversation_id)
            if existing is not None and existing.client.running:
                existing.last_active = time.monotonic()
                return existing
            home = dsh_home(conversation_id)
            patch_path = home / "tuantuan.patch.yml"
            write_patch(patch_path, str(connection.get("model_base_url") or ""))
            launch = build_dsh_launch(connection, patch_path=patch_path)
            client = self._client_factory(launch, tmp_dir=home / "tmp")
            session = DshSession(conversation_id, client, home)
            self._sessions[conversation_id] = session
            return session

    def terminate(self, conversation_id: int) -> None:
        with self._lock:
            session = self._sessions.pop(conversation_id, None)
        if session is None:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(session.client.close())
        else:
            loop.create_task(session.client.close())

    def cancel_run(self, conversation_id: int) -> None:
        """停止一轮：终止子进程；会话状态保留，下次消息走重建。"""
        self.terminate(conversation_id)

    def purge(self, conversation_id: int) -> None:
        self.terminate(conversation_id)
        home = dsh_home(conversation_id)
        if home.is_relative_to(dsh_runtime_root()) and home.exists():
            shutil.rmtree(home, ignore_errors=True)

    def reap_idle(self, *, now: float | None = None) -> list[int]:
        deadline = (time.monotonic() if now is None else now) - self._idle_seconds
        idle_ids: list[int] = []
        with self._lock:
            for conversation_id, session in list(self._sessions.items()):
                if session.last_active <= deadline:
                    idle_ids.append(conversation_id)
                    self._sessions.pop(conversation_id, None)
        for conversation_id in idle_ids:
            self.terminate(conversation_id)
        return idle_ids

    async def close_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        await asyncio.gather(*(session.client.close() for session in sessions), return_exceptions=True)
