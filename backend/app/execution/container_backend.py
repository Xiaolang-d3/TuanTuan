from __future__ import annotations

from ..branding import env

import asyncio
import base64
import json
import os
import re
import shutil
import uuid
from pathlib import Path

from ..db import DATA_DIR
from ..extensions.contracts import ExtensionContext
from ..extensions.manifest import safe_resource_path
from ..workspace import current_workspace_root
from .contracts import BackendStatus, ExecutionUnavailable, ProcessResult
from .processes import run_process
from .workspace_files import WorkspaceFiles

_AUTO = object()
_PINNED_IMAGE = re.compile(r"[A-Za-z0-9._:/-]+@sha256:[a-f0-9]{64}\Z")


def host_uid():
    return os.getuid() if hasattr(os, "getuid") else None


def container_name(context: ExtensionContext, job_id: str, attempt: str) -> str:
    if not re.fullmatch(r"[a-f0-9]{32}", job_id) or not re.fullmatch(r"[a-f0-9]{32}", attempt):
        raise ValueError("执行任务或租约标识无效")
    return f"tuantuan-{context.user_id}-{job_id}-{attempt}"
_FILE_PROGRAM = """import sys,json,base64,pathlib
request=json.load(sys.stdin)
root=pathlib.Path('/workspace').resolve()
name=request['path']
if not name or name.startswith('/') or '\\\\' in name or ':' in name or any(x in ('','.','..') for x in name.split('/')): raise ValueError('invalid path')
path=root/name
if not path.resolve().is_relative_to(root): raise ValueError('path escape')
if request['action']=='read':
    with path.open('rb') as f: data=f.read(1000001)
    if len(data)>1000000: raise ValueError('file too large')
    print(base64.b64encode(data).decode())
else:
    data=base64.b64decode(request['data'],validate=True)
    if len(data)>1000000: raise ValueError('file too large')
    path.parent.mkdir(parents=True,exist_ok=True)
    if not path.parent.resolve().is_relative_to(root): raise ValueError('path escape')
    path.write_bytes(data)
"""


class ContainerBackend:
    def __init__(self, *, image: str | None = None, executable=_AUTO, runner=run_process, config_dir: Path | None = None):
        self.image = image if image is not None else env("TUANTUAN_EXECUTION_IMAGE", "")
        self.executable = shutil.which("docker") if executable is _AUTO else executable
        self.runner = runner
        self.config_dir = config_dir or DATA_DIR / "execution" / "docker-config"
        self.env = {key: os.environ[key] for key in ("PATH", "SystemRoot", "WINDIR", "TEMP", "TMP") if key in os.environ}
        self.env.update(LANG="C.UTF-8", LC_ALL="C.UTF-8")

    async def call(self, arguments: list[str], *, timeout: float = 15, input: bytes | None = None, output_limit: int = 65_536) -> ProcessResult:
        if not self.executable:
            raise ExecutionUnavailable("未安装 Docker，不会改用宿主进程执行")
        self.config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        # An empty explicit config avoids inheriting Docker registry credentials,
        # remote contexts, DOCKER_HOST, TLS keys or model/API environment values.
        return await self.runner([str(self.executable), "--config", str(self.config_dir), *arguments], env=dict(self.env), timeout=timeout, input=input, output_limit=output_limit)

    async def probe(self) -> BackendStatus:
        if not self.executable:
            return BackendStatus(False, "engine_missing", "未安装 Docker，执行型技能暂不可用")
        if not _PINNED_IMAGE.fullmatch(self.image):
            return BackendStatus(False, "image_unpinned", "需要配置带 sha256 digest 的固定执行镜像")
        if host_uid() == 0:
            return BackendStatus(False, "root_host_unsupported", "请使用非 root 账号运行后端，再启用容器执行")
        try:
            info = await self.call(["info", "--format", "{{json .}}"], timeout=5)
            if info.returncode:
                return BackendStatus(False, "engine_unreachable", "Docker 引擎未运行或不可访问")
            details = json.loads(info.stdout)
            if not isinstance(details, dict):
                raise ValueError("无效引擎状态")
            if details.get("OSType") != "linux" or not any("seccomp" in option for option in details.get("SecurityOptions", [])):
                return BackendStatus(False, "isolation_unsupported", "需要启用默认 seccomp 的 Linux 容器引擎")
            image = await self.call(["image", "inspect", self.image], timeout=5)
            records = json.loads(image.stdout) if image.returncode == 0 else []
            if not records or self.image not in records[0].get("RepoDigests", []):
                return BackendStatus(False, "image_missing", "固定执行镜像尚未在本机准备好")
        except (OSError, ValueError, asyncio.TimeoutError):
            return BackendStatus(False, "probe_failed", "执行环境检查失败，请检查 Docker 与固定镜像配置")
        return BackendStatus(True, "ready", "隔离执行环境已就绪", self.image)

    async def prepare(self, context: ExtensionContext, job_id: str, *, attempt: str | None = None, fence=None) -> "ContainerHandle":
        context.check_workspace()
        if not re.fullmatch(r"[a-f0-9]{32}", job_id):
            raise ValueError("无效任务标识")
        status = await self.probe()
        if not status.available:
            raise ExecutionUnavailable(status.reason)
        root = current_workspace_root()
        files = WorkspaceFiles(root / "jobs" / job_id, boundary=root)
        attempt = attempt or uuid.uuid4().hex
        name = container_name(context, job_id, attempt)
        handle = ContainerHandle(self, name, context, files, fence=fence)
        user = f"{host_uid()}:{os.getgid()}" if host_uid() is not None else "65532:65532"
        try:
            if fence: fence()
            result = await self.call(["create", "--name", name, "--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--memory-swap=512m", "--cpus=1", "--pids-limit=128", "--user", user, "--tmpfs", "/tmp:rw,nosuid,nodev,size=64m", "--mount", f"type=bind,source={files.root},target=/workspace", "--workdir", "/workspace", self.image, "python3", "-I", "-c", "import time; time.sleep(86400)"])
            if result.returncode:
                raise ExecutionUnavailable("无法创建隔离执行容器")
            if fence: fence()
            result = await self.call(["start", name])
            if result.returncode:
                raise ExecutionUnavailable("无法启动隔离执行容器")
            if fence: fence()
        except BaseException:
            await handle.stop()
            raise
        return handle


class ContainerHandle:
    def __init__(self, backend: ContainerBackend, name: str, context: ExtensionContext, files: WorkspaceFiles, *, fence=None):
        self.backend, self.name, self.context, self.files = backend, name, context, files
        self.stopped = False
        self.fence = fence

    async def exec(self, argv: list[str], *, cwd: str = "", timeout: float = 60, input: bytes | None = None, output_limit: int = 65_536) -> ProcessResult:
        self.context.check_workspace()
        if self.stopped:
            raise ExecutionUnavailable("执行容器已停止")
        if not argv or any(not isinstance(arg, str) or "\x00" in arg or len(arg) > 8192 for arg in argv) or sum(map(len, argv)) > 32768:
            raise ValueError("执行参数无效或过长")
        if not 0 < timeout <= 300:
            raise ValueError("执行超时必须在 0–300 秒以内")
        if not 0 < output_limit <= 1_400_000:
            raise ValueError("文件传输预算无效")
        directory = "/workspace" + ("/" + safe_resource_path(cwd) if cwd else "")
        try:
            if self.fence: self.fence()
            result = await self.backend.call(["exec", *( ["--interactive"] if input is not None else []), "--workdir", directory, self.name, *argv], timeout=timeout, input=input, output_limit=output_limit)
            if self.fence: self.fence()
            return result
        except (asyncio.CancelledError, asyncio.TimeoutError, ValueError):
            # Killing the CLI alone leaves descendants running in the daemon.
            await self.stop()
            raise

    async def read(self, path: str) -> bytes:
        safe_resource_path(path)
        result = await self.exec(["python3", "-I", "-c", _FILE_PROGRAM], input=json.dumps({"action": "read", "path": path}).encode(), output_limit=1_400_000)
        if result.returncode:
            raise ValueError("无法读取任务文件")
        return base64.b64decode(result.stdout.strip(), validate=True)

    async def write(self, path: str, content: bytes) -> None:
        safe_resource_path(path)
        if len(content) > 1_000_000:
            raise ValueError("单次写入超过 1 MB")
        result = await self.exec(["python3", "-I", "-c", _FILE_PROGRAM], input=json.dumps({"action": "write", "path": path, "data": base64.b64encode(content).decode()}).encode())
        if result.returncode:
            raise ValueError("无法写入任务文件")

    async def stop(self) -> None:
        if self.stopped:
            return
        result = await self.backend.call(["rm", "--force", self.name], timeout=10)
        if result.returncode and "No such container" not in result.stderr:
            raise ExecutionUnavailable("无法确认执行容器已经停止")
        self.stopped = True
