"""Managed, loopback-only transport for the pinned official confirmation UI.

This is not authorization: callers validate the user/job/stage and project root
before every request, and independently validate receipts after a successful POST.
No headers or arbitrary URLs/commands cross this boundary. A POST is never retried.
"""
from __future__ import annotations

import asyncio
import json
import inspect
import math
import time
import os
import re
import socket
import subprocess
import uuid
from dataclasses import dataclass
from pathlib import Path

import httpx

from ..branding import env
from ..execution.builtin_runtime import BuiltinRuntime
from ..execution.local_builtin import _safe_env
from ..execution.local_processes import ProcessTree
from ..execution.process_launcher import create_subprocess_exec
from ..execution.workspace_files import reject_links

MAX_REQUEST_BYTES = 256 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
GET_ROUTES = frozenset({
    "/", "/api/health", "/api/session", "/api/catalogs",
    "/api/icon-previews", "/api/ai-image-comparison", "/api/recommendations",
})


class ConfirmationServerError(RuntimeError):
    """Sanitized failure; a failed POST may already have written its receipt."""


@dataclass(frozen=True)
class ConfirmationResponse:
    status_code: int
    content_type: str
    body: bytes


@dataclass
class _Server:
    root: Path
    digest: str
    stage: str
    port: int
    process: object
    tree: ProcessTree
    reaper: asyncio.Task | None = None
    expiry: asyncio.Task | None = None
    expired: bool = False
    deadline: float = 0.0


def _port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _project(root: Path) -> Path:
    root = Path(root).absolute()
    reject_links(root, Path(root.anchor))
    if not root.is_dir():
        raise ValueError("确认服务项目目录不存在")
    # The official server follows project files, including its lock and receipts.
    # Reject links before handing it a project, not only at the entry directory.
    for path in root.rglob("*"):
        reject_links(path, root)
    return root.resolve()


def _environment(root: Path) -> dict[str, str]:
    result = _safe_env()
    home = root / ".confirmation-home"
    directories = {
        "TEMP": root / ".confirmation-tmp", "TMP": root / ".confirmation-tmp",
        "HOME": home, "USERPROFILE": home,
        "APPDATA": home / "AppData/Roaming", "LOCALAPPDATA": home / "AppData/Local",
        "XDG_CONFIG_HOME": home / ".config", "XDG_CACHE_HOME": home / ".cache",
    }
    for key, path in directories.items():
        reject_links(path, root)
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        result[key] = str(path)
    return result


def _validate_route(runtime: BuiltinRuntime, method: str, route: str) -> None:
    if not isinstance(route, str) or len(route) > 512:
        raise ValueError("不允许的确认服务路由")
    if method == "POST" and route == "/api/confirm":
        return
    if method == "GET":
        if route in GET_ROUTES:
            return
        # Exact manifest entries, never wildcard proxying, decoding or queries.
        resource = None
        if re.fullmatch(r"/static/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.(?:html|js|css|json|svg)", route):
            resource = f"{runtime.manifest['skill']}/scripts/confirm_ui{route}"
        elif re.fullmatch(r"/ai-image-comparison/rendering/[A-Za-z0-9_-]+\.webp", route):
            resource = f"{runtime.manifest['skill']}/references{route}"
        if resource is not None and resource in runtime.manifest["files"]:
            return
    raise ValueError("不允许的确认服务路由")


class ConfirmationServerManager:
    """One foreground process tree per user/job, injectable without global state.

    close_job fences requests already queued for that job; later requests may
    explicitly reopen it after the caller has checked authorization again.
    close_all permanently shuts this manager down. Use one instance per app loop.
    """

    def __init__(self, *, spawn=None, tree_factory=ProcessTree, transport=None,
                 port_factory=_port, startup_timeout=15.0, request_timeout=10.0,
                 max_servers=16, lifetime_seconds=900.0):
        self._spawn = spawn or create_subprocess_exec
        self._tree_factory = tree_factory
        self._transport = transport
        self._port_factory = port_factory
        self._startup_timeout = startup_timeout
        self._request_timeout = request_timeout
        self._max_servers = max_servers
        if not 0 < lifetime_seconds <= 900:
            raise ValueError("确认服务寿命不能超过 900 秒")
        self._lifetime_seconds = lifetime_seconds
        self._servers: dict[tuple[int, str], _Server] = {}
        self._lock = asyncio.Lock()
        self._generation: dict[tuple[int, str], int] = {}
        self._closed = False

    async def _http(self, server, method, route, body=b"") -> ConfirmationResponse:
        # A new client per request cannot retain cookies/auth from previous replies.
        async with httpx.AsyncClient(
            trust_env=False, follow_redirects=False, timeout=self._request_timeout,
            transport=self._transport,
        ) as client:
            async with client.stream(
                method, f"http://127.0.0.1:{server.port}{route}", content=body,
                headers={"Accept-Encoding": "identity", "Content-Type": "application/json"},
            ) as response:
                if 300 <= response.status_code < 400:
                    raise ConfirmationServerError("确认服务不允许重定向")
                if response.headers.get("content-encoding", "identity") != "identity":
                    raise ConfirmationServerError("确认服务响应编码无效")
                length = response.headers.get("content-length")
                if length is not None and (not length.isdecimal() or int(length) > MAX_RESPONSE_BYTES):
                    raise ConfirmationServerError("确认服务响应超过限制")
                content = bytearray()
                async for chunk in response.aiter_raw(chunk_size=65536):
                    content.extend(chunk)
                    if len(content) > MAX_RESPONSE_BYTES:
                        raise ConfirmationServerError("确认服务响应超过限制")
                content_type = response.headers.get("content-type", "application/octet-stream")
                if len(content_type) > 128 or any(ord(c) < 32 for c in content_type):
                    raise ConfirmationServerError("确认服务响应类型无效")
                if response.status_code >= 400:
                    # Official errors can contain absolute filesystem paths. Keep
                    # the status for conflict handling, never relay stderr/errors.
                    return ConfirmationResponse(response.status_code, "application/json", b'{"error":"confirmation request rejected"}')
                return ConfirmationResponse(response.status_code, content_type, bytes(content))

    async def _stop(self, server: _Server) -> None:
        if server.expiry is not None and server.expiry is not asyncio.current_task():
            server.expiry.cancel()
            await asyncio.gather(server.expiry, return_exceptions=True)
            server.expiry = None
        server.tree.close()
        process = server.process
        if process.stdin:
            process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), timeout=5)
        except asyncio.TimeoutError:
            process.kill()
            await asyncio.wait_for(process.wait(), timeout=5)
        if server.reaper is not None:
            await server.reaper

    async def _deadline(self, server: _Server, deadline: float) -> None:
        """Only shorten an existing monotonic lifetime; wall-clock jumps cannot renew it."""
        if server.deadline and deadline >= server.deadline:
            return
        if server.expiry is not None:
            server.expiry.cancel()
            await asyncio.gather(server.expiry, return_exceptions=True)
        server.deadline = deadline

        async def expire():
            await asyncio.sleep(max(0, deadline - asyncio.get_running_loop().time()))
            server.expired = True
            await self._stop(server)

        server.expiry = asyncio.create_task(expire())

    async def _start(self, root, runtime, stage, stopped, deadline) -> _Server:
        await asyncio.to_thread(runtime.verify)
        if stopped():
            raise ConfirmationServerError("确认服务已停止")
        port = self._port_factory()
        argv = runtime.confirmation_command(root, port)
        environment = _environment(root)
        tree = self._tree_factory()
        server = None
        # Shield OS spawn so cancellation cannot lose the returned process handle.
        spawning = asyncio.create_task(self._spawn(
            argv[0], "-I", "-B", str(Path(__file__).resolve().parents[1] / "execution/local_supervisor.py"),
            cwd=str(root), env=environment, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            start_new_session=(os.name != "nt"),
        ))
        try:
            try:
                process = await asyncio.shield(spawning)
            except asyncio.CancelledError:
                process = await spawning
                server = _Server(root, runtime.digest, stage, port, process, tree)
                tree.attach(process.pid)
                raise
            server = _Server(root, runtime.digest, stage, port, process, tree)
            tree.attach(process.pid)
            if stopped():
                raise ConfirmationServerError("确认服务已停止")
            process.stdin.write(json.dumps({"argv": argv, "nonce": uuid.uuid4().hex}).encode() + b"\n")
            await process.stdin.drain()

            async def reap():
                await process.wait()
                tree.close()

            server.reaper = asyncio.create_task(reap())

            await self._deadline(server, deadline)
            async with asyncio.timeout(self._startup_timeout):
                while True:
                    if stopped() or process.returncode is not None:
                        raise ConfirmationServerError("确认服务启动失败")
                    try:
                        response = await self._http(server, "GET", "/api/health")
                        data = json.loads(response.body)
                        lock_path = root / ".confirm_ui.lock"
                        reject_links(lock_path, root)
                        if lock_path.stat().st_size > 4096:
                            raise ConfirmationServerError("确认服务身份校验失败")
                        lock = json.loads(lock_path.read_text(encoding="utf-8"))
                        if (response.status_code != 200 or data.get("service") != "confirm_ui"
                                or data.get("project") != str(root) or lock.get("port") != port
                                or type(data.get("pid")) is not int or data["pid"] <= 0
                                or data["pid"] != lock.get("pid")):
                            raise ConfirmationServerError("确认服务身份校验失败")
                        return server
                    except (httpx.TransportError, FileNotFoundError):
                        await asyncio.sleep(0.05)
        except BaseException:
            if server is not None:
                await asyncio.shield(self._stop(server))
            else:
                tree.close()
            raise

    async def request(self, user_id: int, job_id: str, root: Path,
                      runtime: BuiltinRuntime, stage: str, method: str,
                      route: str, body: bytes = b"", *,
                      expires_at: float | None = None, before_submit=None) -> ConfirmationResponse:
        remaining = self._lifetime_seconds
        if expires_at is not None:
            if type(expires_at) not in {int, float} or not math.isfinite(expires_at):
                raise ValueError("确认服务会话到期时间无效")
            remaining = min(remaining, expires_at - time.time())
        deadline = asyncio.get_running_loop().time() + remaining
        if (type(user_id) is not int or user_id < 1 or not isinstance(job_id, str)
                or not re.fullmatch(r"[a-f0-9]{32}", job_id) or stage not in {"stage1", "stage2"}):
            raise ValueError("确认服务任务范围无效")
        if env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() != "local":
            raise ConfirmationServerError("确认服务仅支持本地部署")
        _validate_route(runtime, method, route)
        if not isinstance(body, bytes) or len(body) > MAX_REQUEST_BYTES or (method == "GET" and body):
            raise ValueError("确认服务请求大小或类型无效")
        if method == "POST":
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeError):
                raise ValueError("确认服务需要 JSON 对象") from None
            expected = "stage1" if stage == "stage1" else "final"
            if not isinstance(payload, dict) or payload.get("stage") != expected:
                raise ValueError("确认服务提交阶段不匹配")
        root = _project(root)
        key = (user_id, job_id)
        generation = self._generation.get(key, 0)

        def stopped():
            return (self._closed or self._generation.get(key, 0) != generation
                    or asyncio.get_running_loop().time() >= deadline)

        async with self._lock:
            server = self._servers.get(key)
            if asyncio.get_running_loop().time() >= deadline:
                if server is not None:
                    server.expired = True
                    await asyncio.shield(self._stop(server))
                raise ConfirmationServerError("确认服务会话已过期")
            if stopped():
                raise ConfirmationServerError("确认服务已停止")
            # Expiry is terminal for this binding, not an automatic restart on
            # the next poll. The host must close_job and authorize a new session.
            if server is not None and server.expired:
                raise ConfirmationServerError("确认服务会话已过期")
            if server is not None and (server.root != root or server.digest != runtime.digest
                                       or server.stage != stage or server.process.returncode is not None):
                self._servers.pop(key)
                await self._stop(server)
                server = None
            reservation_rejected = False
            try:
                if server is None:
                    if len(self._servers) >= self._max_servers:
                        raise ConfirmationServerError("确认服务数量超过限制")
                    server = await self._start(root, runtime, stage, stopped, deadline)
                    self._servers[key] = server
                else:
                    await self._deadline(server, deadline)
                if stopped():
                    raise ConfirmationServerError("确认服务已停止")
                # All startup, integrity and capacity checks have completed. A
                # synchronous host fence is persisted at the last point before
                # dispatch; no await can let another submission interleave here.
                if method == "POST" and before_submit is not None:
                    try:
                        before_submit()
                    except Exception:
                        # This request does not own a submission. In particular,
                        # a duplicate must not stop the first writer's process.
                        reservation_rejected = True
                        raise
                async with asyncio.timeout(self._request_timeout):
                    response = await self._http(server, method, route, body)
                if stopped() or server.expired:
                    raise ConfirmationServerError("确认服务已停止")
                return response
            except BaseException as exc:
                if reservation_rejected:
                    raise
                if server is None or not server.expired:
                    self._servers.pop(key, None)
                if server is not None:
                    await asyncio.shield(self._stop(server))
                if isinstance(exc, asyncio.CancelledError):
                    raise
                raise ConfirmationServerError("确认服务请求失败；提交结果需重新核验") from None

    async def close_job(self, user_id: int, job_id: str) -> None:
        key = (user_id, job_id)
        self._generation[key] = self._generation.get(key, 0) + 1
        async with self._lock:
            server = self._servers.pop(key, None)
            if server is not None:
                await asyncio.shield(self._stop(server))

    async def close_invalid(self, validate) -> int:
        """One revocation sweep, called by the host's periodic session watcher.

        validate(user_id, job_id, stage) may be sync or async; only literal True
        keeps a binding. Exceptions/timeouts fail closed. No workspace/auth context
        is inferred here. Identity checks avoid closing a replacement binding.
        """
        closed = 0
        for key, server in list(self._servers.items()):
            try:
                async with asyncio.timeout(self._request_timeout):
                    valid = validate(key[0], key[1], server.stage)
                    if inspect.isawaitable(valid):
                        valid = await valid
            except Exception:
                valid = False
            if valid is True or self._servers.get(key) is not server:
                continue
            # Fence an in-flight response before waiting for its request lock.
            self._generation[key] = self._generation.get(key, 0) + 1
            server.expired = True
            # Kill immediately rather than leaving a revoked POST running until
            # its HTTP timeout. The request's own cleanup remains idempotent.
            server.tree.close()
            async with self._lock:
                if self._servers.get(key) is not server:
                    continue
                # Keep a terminal binding until host explicitly closes/reopens it.
                await asyncio.shield(self._stop(server))
                closed += 1
        return closed

    async def close_all(self) -> None:
        self._closed = True
        async with self._lock:
            servers, self._servers = self._servers, {}
            # Schedule every stop before awaiting: cancellation of shutdown must
            # not leave the remaining service trees unvisited.
            await asyncio.shield(asyncio.gather(*(self._stop(server) for server in servers.values())))
