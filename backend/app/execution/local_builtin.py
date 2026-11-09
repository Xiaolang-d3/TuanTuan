from __future__ import annotations

import asyncio
import json
import os
import subprocess
import uuid
from pathlib import Path

from ..branding import env
from ..extensions.contracts import ExtensionContext
from ..workspace import current_workspace_root
from .builtin_runtime import BuiltinRuntime
from .contracts import BackendStatus, ExecutionUnavailable, ProcessResult
from .local_processes import ProcessTree, process_identity
from .process_launcher import create_subprocess_exec
from .workspace_files import WorkspaceFiles


def _safe_env() -> dict[str, str]:
    # os.environ normalizes names to uppercase on Windows. Winsock needs
    # SYSTEMROOT even when WINDIR is present (otherwise socket() fails 10106).
    allowed = {"SYSTEMROOT", "WINDIR"}
    result = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    result.update({"PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"})
    return result


class BuiltinHandle:
    def __init__(self, runtime: BuiltinRuntime, root: Path, environment: dict[str, str] | None = None, *, record_identity=None, fence=None):
        self.runtime = runtime
        self.files = WorkspaceFiles(root, boundary=root)
        self.environment = dict(environment or _safe_env())
        self.process: asyncio.subprocess.Process | None = None
        self.tree = None
        self.record_identity = record_identity
        self.fence = fence
        self.busy = False
        self.spawn_done = asyncio.Event()
        self.spawn_done.set()
        self.starting = False
        self.stop_requested = False
        temporary = self.files.root / ".tmp"
        temporary.mkdir(exist_ok=True)
        self.environment.update(TEMP=str(temporary), TMP=str(temporary))
        # Official tools call Path.home() at import time. Supply a task-private
        # home instead of inheriting real user settings, credentials or caches.
        home = self.files.path(".home")
        private_dirs = {
            "HOME": home, "USERPROFILE": home,
            "APPDATA": home / "AppData/Roaming", "LOCALAPPDATA": home / "AppData/Local",
            "XDG_CONFIG_HOME": home / ".config", "XDG_CACHE_HOME": home / ".cache",
        }
        for key, path in private_dirs.items():
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.environment[key] = str(path)

    async def run(self, command_id: str, args: dict, *, timeout: float = 300, output_limit: int = 65_536) -> ProcessResult:
        if self.busy:
            raise ExecutionUnavailable("已有本机 PPT 命令正在执行")
        argv = self.runtime.command(command_id, args, self.files.root)
        if self.fence:
            self.fence()
        self.busy = True
        self.stop_requested = False
        self.starting = True
        self.spawn_done.clear()
        try:
            tree = self.tree = ProcessTree()
        except BaseException:
            self.busy = False
            self.starting = False
            self.spawn_done.set()
            raise
        nonce = uuid.uuid4().hex
        supervisor = Path(__file__).with_name("local_supervisor.py")
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        try:
            self.process = await create_subprocess_exec(
                argv[0], "-I", "-B", str(supervisor),
                cwd=str(self.files.root),
                env=self.environment,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                creationflags=creationflags,
                start_new_session=(os.name != "nt"),
            )
            tree.attach(self.process.pid)
            if self.stop_requested:
                raise ExecutionUnavailable("本机任务启动时已请求停止")
            if self.record_identity:
                identity = process_identity(self.process.pid)
                if identity is None:
                    raise ExecutionUnavailable("本机执行进程启动后意外退出")
                self.record_identity({**identity, "nonce": nonce, "runtime_digest": self.runtime.digest})
            if self.fence:
                self.fence()
            self.process.stdin.write(json.dumps({"argv": argv, "nonce": nonce}).encode() + b"\n")
            await self.process.stdin.drain()
        except BaseException:
            self.starting = False
            self.spawn_done.set()
            await self.stop()
            self.process = None
            self.busy = False
            raise
        self.starting = False
        self.spawn_done.set()

        async def read(stream):
            parts, size = [], 0
            while chunk := await stream.read(4096):
                size += len(chunk)
                if size > output_limit:
                    raise ValueError("PPT 执行输出超过传输限制")
                parts.append(chunk)
            return b"".join(parts).decode("utf-8", "replace")

        process = self.process
        try:
            stdout, stderr = await asyncio.wait_for(asyncio.gather(read(process.stdout), read(process.stderr)), timeout=timeout)
            returncode = await asyncio.wait_for(process.wait(), timeout=5)
            if self.fence:
                self.fence()
            return ProcessResult(returncode, stdout, stderr)
        except asyncio.TimeoutError as exc:
            await self.stop()
            raise TimeoutError("PPT 本机命令执行超时") from exc
        except BaseException:
            await self.stop()
            raise
        finally:
            await self.stop()
            self.process = None
            self.busy = False

    async def stop(self) -> None:
        self.stop_requested = True
        if self.starting:
            await self.spawn_done.wait()
        process = self.process
        if self.tree:
            self.tree.close()
            self.tree = None
        if process is None:
            return
        if process.returncode is None:
            if process.stdin:
                process.stdin.close()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


class LocalBuiltinBackend:
    def __init__(self, *, runtime: BuiltinRuntime | None = None):
        self.runtime = runtime

    def probe(self) -> BackendStatus:
        if env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() != "local":
            return BackendStatus(False, "hosted_disabled", "本机 PPT 执行仅支持本地部署")
        try:
            runtime = self.runtime or BuiltinRuntime.load()
            runtime.verify()
            return BackendStatus(True, "resources_ready", "PPT 本机资源已校验，适配器尚未完成完整工作流验收", runtime.digest)
        except FileNotFoundError:
            return BackendStatus(False, "runtime_missing", "PPT 专用运行包尚未准备好")
        except (ValueError, OSError, KeyError, TypeError) as exc:
            return BackendStatus(False, "runtime_invalid", str(exc))

    async def prepare(self, context: ExtensionContext, job_id: str, *, root: Path | None = None, runtime_digest: str | None = None, fence=None, record_identity=None) -> BuiltinHandle:
        context.check_workspace()
        if env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() != "local":
            raise ExecutionUnavailable("本机 PPT 执行仅支持本地部署")
        if not job_id or any(char not in "0123456789abcdef" for char in job_id) or len(job_id) != 32:
            raise ValueError("无效任务标识")
        runtime = self.runtime or BuiltinRuntime.load()
        await asyncio.to_thread(runtime.verify)
        if runtime_digest and runtime.digest != runtime_digest:
            raise ExecutionUnavailable("任务绑定的 PPT 运行资源版本已变化")
        if fence:
            fence()
        target = current_workspace_root() / "jobs" / job_id
        if root is not None and root.resolve() != target.resolve():
            raise ValueError("本机任务目录必须属于当前用户工作区")
        return BuiltinHandle(runtime, target, _safe_env(), record_identity=record_identity, fence=fence)
