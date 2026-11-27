"""DSH 子进程管理器：按对话隔离的运行时生命周期。"""

from __future__ import annotations

import asyncio
import shutil
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .... import db
from ....workspace import current_user_id
from ...model_binding import selection_identity
from ..base import KernelUnavailable, is_dsh_safe_endpoint
from .client import DshJsonRpcClient, DshLaunch, Notification
from .composition import write_patch


DshSessionKey = tuple[int, int]
DshClose = asyncio.Task[None] | Future[None]


async def _wait_for_close(close: DshClose) -> None:
    await asyncio.shield(asyncio.wrap_future(close) if isinstance(close, Future) else close)


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


def require_dsh_compatible_auth(connection: dict[str, Any]) -> None:
    if (connection.get("auth_kind") == "chatgpt_subscription"
            or connection.get("secret_ref") == "chatgpt_subscription"):
        raise KernelUnavailable("ChatGPT 订阅仅支持团团对话内核，不可用于 DSH")


def _execution_configuration(connection: dict[str, Any]) -> tuple[Any, ...]:
    return (
        *selection_identity(connection),
        str(connection.get("model_name") or ""),
        str(connection.get("model_base_url") or "").strip(),
        connection.get("credential_fingerprint"),
    )


def build_dsh_launch(connection: dict[str, Any], *, patch_path: Path, patch_args: tuple[str, ...] = ()) -> DshLaunch:
    """把团团模型连接映射为 DSH 子进程启动参数。"""
    require_dsh_compatible_auth(connection)
    base_url = str(connection.get("model_base_url") or "").strip()
    if not is_dsh_safe_endpoint(base_url):
        raise KernelUnavailable("DSH 内核需要安全的 HTTPS 端点")
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


@dataclass(frozen=True)
class DshPendingRequest:
    token: str
    request_id: str | int
    request: Notification


class DshSession:
    def __init__(
        self,
        conversation_id: int,
        client: DshJsonRpcClient,
        home: Path,
        *,
        execution_configuration: tuple[Any, ...] | None = None,
        needs_history_rebuild: bool = False,
    ) -> None:
        self.conversation_id = conversation_id
        self.client = client
        self.home = home
        self.execution_configuration = execution_configuration
        self.previous_close: DshClose | None = None
        self.loop: asyncio.AbstractEventLoop | None = None
        self.pending_patch: tuple[Path, str] | None = None
        self.retired = False
        self._process_lock = asyncio.Lock()
        self.last_active = time.monotonic()
        self.initialized = False
        self.in_use = False
        self.pending: DshPendingRequest | None = None
        self.needs_history_rebuild = needs_history_rebuild

    async def start(self) -> None:
        """等旧进程退出后启动。当前会话被重置时抛出 KernelUnavailable。"""
        self.loop = asyncio.get_running_loop()
        async with self._process_lock:
            if self.previous_close is not None:
                await _wait_for_close(self.previous_close)
                self.previous_close = None
            self._require_live()
            if self.pending_patch is not None:
                write_patch(*self.pending_patch)
                self.pending_patch = None
            await self.client.start()
            self._require_live()

    async def close(self) -> None:
        """等启动和前序进程退出后，再关闭此会话的客户端。"""
        # 重置可能发生在子进程创建期间，此时客户端还没有可关闭的句柄。
        async with self._process_lock:
            try:
                if self.previous_close is not None:
                    await _wait_for_close(self.previous_close)
            finally:
                await self.client.close()

    def _require_live(self) -> None:
        if self.retired:
            raise KernelUnavailable("当前 DeepSeek Harness 会话已关闭")


class DshRuntimeManager:
    def __init__(self, *, idle_seconds: float = 600.0, client_factory: Any = DshJsonRpcClient) -> None:
        self._idle_seconds = idle_seconds
        self._client_factory = client_factory
        self._sessions: dict[DshSessionKey, DshSession] = {}
        self._closing: dict[DshSessionKey, DshClose] = {}
        self._history_rebuilds: set[DshSessionKey] = set()
        self._lock = threading.RLock()

    def acquire(self, conversation_id: int, connection: dict[str, Any]) -> DshSession:
        """为普通轮次选择匹配配置的会话。对话已有执行时抛出 KernelUnavailable。"""
        require_dsh_compatible_auth(connection)
        key = _session_key(conversation_id)
        configuration = _execution_configuration(connection)
        with self._lock:
            existing = self._sessions.get(key)
            if existing is not None:
                if existing.in_use:
                    raise KernelUnavailable("当前 DeepSeek Harness 对话已有正在执行的任务")
                if (
                    existing.execution_configuration == configuration
                    and existing.pending is None
                    and (existing.client.running or not existing.initialized)
                ):
                    existing.last_active = time.monotonic()
                    return existing
            home = dsh_home(conversation_id)
            patch_path = home / "tuantuan.patch.yml"
            launch = build_dsh_launch(connection, patch_path=patch_path)
            base_url = str(connection.get("model_base_url") or "").strip()
            client = self._client_factory(launch, tmp_dir=home / "tmp")
            session = DshSession(
                conversation_id,
                client,
                home,
                execution_configuration=configuration,
                needs_history_rebuild=key in self._history_rebuilds,
            )
            if existing is not None:
                self._close_session(key, existing)
            # 同一对话共享 DSH_HOME，旧进程退出后才能覆盖配置并启动新进程。
            session.previous_close = self._closing.get(key)
            if session.previous_close is None:
                write_patch(patch_path, base_url)
            else:
                session.pending_patch = (patch_path, base_url)
            self._sessions[key] = session
            self._history_rebuilds.discard(key)
        return session

    def resume(self, conversation_id: int, token: str | None) -> DshSession | None:
        """Reserve only the live process that owns the exact persisted wait."""
        with self._lock:
            session = self._sessions.get(_session_key(conversation_id))
            if (
                session is None or session.in_use or not session.initialized
                or not session.client.running or session.pending is None
                or not token or session.pending.token != token
            ):
                return None
            session.in_use = True
            session.last_active = time.monotonic()
            return session

    def terminate(self, conversation_id: int) -> None:
        key = _session_key(conversation_id)
        with self._lock:
            session = self._sessions.pop(key, None)
            if session is not None:
                self._close_session(key, session)

    def _close_session(self, key: DshSessionKey, session: DshSession) -> None:
        session.retired = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            loop = None
        owner = session.loop or loop
        if session.loop is None and isinstance(session.previous_close, asyncio.Task):
            owner = session.previous_close.get_loop()
        if owner is None:
            asyncio.run(session.close())
            return
        if owner is loop:
            task = owner.create_task(session.close())
        else:
            # 同步 API 可能在线程池中清理对话，子进程须在所属事件循环上关闭。
            task = asyncio.run_coroutine_threadsafe(session.close(), owner)
        self._closing[key] = task
        task.add_done_callback(lambda completed: self._forget_close(key, completed))

    def _forget_close(self, key: DshSessionKey, task: DshClose) -> None:
        with self._lock:
            if self._closing.get(key) is task:
                self._closing.pop(key)

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
        with self._lock:
            for key, session in list(self._sessions.items()):
                if not session.in_use and session.last_active <= deadline:
                    idle_ids.append(session.conversation_id)
                    self._close_session(key, self._sessions.pop(key))
        return idle_ids

    async def close_all(self) -> None:
        with self._lock:
            for key, session in self._sessions.items():
                self._close_session(key, session)
            self._sessions.clear()
            self._history_rebuilds.clear()
            closing = list(self._closing.values())
        await asyncio.gather(*(_wait_for_close(task) for task in closing), return_exceptions=True)
