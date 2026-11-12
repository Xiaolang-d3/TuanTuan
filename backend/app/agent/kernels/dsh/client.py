"""DeepSeek Harness SDK 协议的 stdio JSON-RPC 客户端。"""

from __future__ import annotations

import asyncio
import json
import os
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


JsonValue = Any


class DshClientError(Exception):
    """客户端运行错误。"""


class DshProtocolError(DshClientError):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


class DshTimeoutError(DshClientError):
    pass


@dataclass(frozen=True)
class DshLaunch:
    bin: str
    args: tuple[str, ...] = ()
    env: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Notification:
    method: str
    params: dict[str, Any]


class DshJsonRpcClient:
    """换行分隔 JSON-RPC 2.0 客户端；同时服务通知流与服务器发起的请求。"""

    def __init__(
        self,
        launch: DshLaunch,
        *,
        tmp_dir: str | Path | None = None,
        request_timeout: float = 120.0,
        shutdown_timeout: float = 5.0,
    ) -> None:
        self._launch = launch
        self._tmp_dir = tmp_dir
        self._request_timeout = request_timeout
        self._shutdown_timeout = shutdown_timeout
        self._process: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task | None = None
        self._stderr_task: asyncio.Task | None = None
        self._next_id = 1
        self._pending: dict[int, asyncio.Future[JsonValue]] = {}
        self._notifications: asyncio.Queue[Notification | None] = asyncio.Queue()
        self._requests: asyncio.Queue[Notification | None] = asyncio.Queue()
        self._stderr_tail: deque[str] = deque(maxlen=200)
        self._closed = False

    @property
    def stderr_tail(self) -> list[str]:
        return list(self._stderr_tail)

    @property
    def running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def start(self) -> None:
        if self._process is not None:
            return
        env = os.environ.copy()
        if self._tmp_dir:
            path = str(Path(self._tmp_dir).resolve())
            env["TMP"] = path
            env["TEMP"] = path
        env.update(self._launch.env)
        self._process = await asyncio.create_subprocess_exec(
            self._launch.bin,
            *self._launch.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
        self._reader_task = asyncio.create_task(self._reader())
        self._stderr_task = asyncio.create_task(self._stderr_reader())

    async def _reader(self) -> None:
        assert self._process is not None and self._process.stdout is not None
        while True:
            line = await self._process.stdout.readline()
            if not line:
                break
            try:
                message = json.loads(line.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                continue
            if not isinstance(message, dict):
                continue
            if "method" in message:
                notification = Notification(str(message["method"]), message.get("params") or {})
                if message["method"] in {"approval/request", "user-question/ask"}:
                    self._requests.put_nowait(notification)
                else:
                    self._notifications.put_nowait(notification)
                continue
            if "id" in message:
                pending = self._pending.pop(message["id"], None)
                if pending is None or pending.done():
                    continue
                if "error" in message:
                    error = message["error"] or {}
                    pending.set_exception(DshProtocolError(int(error.get("code", -32000)), str(error.get("message", "协议错误"))))
                else:
                    pending.set_result(message.get("result"))
        for pending in self._pending.values():
            if not pending.done():
                pending.set_exception(DshClientError("DeepSeek Harness 运行时已关闭"))
        self._pending.clear()
        self._notifications.put_nowait(None)
        self._requests.put_nowait(None)

    async def _stderr_reader(self) -> None:
        assert self._process is not None and self._process.stderr is not None
        while True:
            line = await self._process.stderr.readline()
            if not line:
                break
            self._stderr_tail.append(line.decode("utf-8", errors="replace").rstrip("\n"))

    async def request(self, method: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> JsonValue:
        await self.start()
        request_id = self._next_id
        self._next_id += 1
        future: asyncio.Future[JsonValue] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            payload["params"] = params
        await self._write(payload)
        try:
            return await asyncio.wait_for(future, timeout or self._request_timeout)
        except TimeoutError as exc:
            self._pending.pop(request_id, None)
            raise DshTimeoutError(f"{method} 请求超时") from exc

    async def _write(self, payload: dict[str, Any]) -> None:
        assert self._process is not None and self._process.stdin is not None
        data = json.dumps(payload, ensure_ascii=False) + "\n"
        self._process.stdin.write(data.encode("utf-8"))
        await self._process.stdin.drain()

    async def initialize(self, params: dict[str, Any], *, timeout: float | None = None) -> JsonValue:
        return await self.request("initialize", params, timeout=timeout)

    async def session_query(self, session_id: str, blocks: list[dict[str, Any]]) -> JsonValue:
        return await self.request("session/query", {"sessionId": session_id, "contentBlocks": blocks})

    async def session_prompt(self, session_id: str, blocks: list[dict[str, Any]]) -> JsonValue:
        return await self.request("session/prompt", {"sessionId": session_id, "contentBlocks": blocks})

    async def session_resume(self, session_id: str) -> JsonValue:
        return await self.request("session/resume", {"sessionId": session_id})

    async def session_wait(self, session_id: str) -> JsonValue:
        return await self.request("session/wait", {"sessionId": session_id})

    async def respond(self, request_id: str | int, result: dict[str, Any]) -> None:
        assert self._process is not None and self._process.stdin is not None
        data = json.dumps({"jsonrpc": "2.0", "id": request_id, "result": result}, ensure_ascii=False) + "\n"
        self._process.stdin.write(data.encode("utf-8"))
        await self._process.stdin.drain()

    async def next_notification(self) -> Notification:
        item = await self._notifications.get()
        if item is None:
            raise DshClientError("DeepSeek Harness 运行时已关闭")
        return item

    async def next_request(self, *, timeout: float | None = None) -> Notification:
        item: Notification | None
        try:
            item = await asyncio.wait_for(self._requests.get(), timeout)
        except TimeoutError as exc:
            raise DshTimeoutError("等待运行时请求超时") from exc
        if item is None:
            raise DshClientError("DeepSeek Harness 运行时已关闭")
        return item

    async def shutdown(self, *, timeout: float | None = None) -> None:
        if self._process is None or self._process.returncode is not None:
            return
        try:
            await self.request("shutdown", None, timeout=timeout or self._shutdown_timeout)
        except (DshClientError, DshTimeoutError):
            pass

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self.shutdown()
        process = self._process
        if process is None:
            return
        if process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), self._shutdown_timeout)
            except TimeoutError:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), 3.0)
                except TimeoutError:
                    process.kill()
                    await process.wait()
        if self._reader_task:
            self._reader_task.cancel()
        if self._stderr_task:
            self._stderr_task.cancel()
