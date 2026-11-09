import asyncio
import json
import os
from pathlib import Path

import pytest

from app.execution.container_backend import ContainerBackend
from app.execution.contracts import ExecutionUnavailable, ProcessResult
from app.execution.workspace_files import WorkspaceFiles
from app.extensions.contracts import ExtensionContext
from app.workspace import use_workspace


@pytest.fixture(autouse=True)
def portable_mock_host(monkeypatch):
    from app.execution import container_backend as module
    monkeypatch.setattr(module, "host_uid", lambda: None)


def test_missing_engine_never_falls_back_to_host_process(tmp_path):
    called = []
    backend = ContainerBackend(image="example@sha256:" + "a" * 64, executable=None, runner=lambda *args, **kwargs: called.append(args))
    status = asyncio.run(backend.probe())
    assert not status.available and status.code == "engine_missing"
    with use_workspace(1, tmp_path):
        with pytest.raises(ExecutionUnavailable):
            asyncio.run(backend.prepare(ExtensionContext.current(), "a" * 32))
    assert called == []


def test_mutable_image_tag_and_remote_daemon_are_rejected():
    assert asyncio.run(ContainerBackend(image="python:latest", executable="docker").probe()).code == "image_unpinned"


def test_workspace_paths_reject_escape_and_symlinks(tmp_path):
    files = WorkspaceFiles(tmp_path / "job")
    files.write("slides/page.txt", "内容".encode())
    assert files.read("slides/page.txt") == "内容".encode()
    for path in ("../secret", "/etc/passwd", "C:/secret", "a/../secret", "a\\secret"):
        with pytest.raises(ValueError):
            files.read(path)
    link = files.root / "alias"
    try:
        link.symlink_to(tmp_path, target_is_directory=True)
    except OSError:
        pytest.skip("当前 Windows 用户没有创建 symlink 的权限")
    with pytest.raises(ValueError):
        files.write("alias/secret.txt", b"no")


def test_container_argv_limits_mounts_network_and_environment(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setenv("OPENAI_API_KEY", "must-not-inherit")
    async def run(argv, **kwargs):
        calls.append((argv, kwargs))
        if "info" in argv:
            return ProcessResult(returncode=0, stdout=json.dumps({"OSType": "linux", "SecurityOptions": ["name=seccomp,profile=builtin"]}), stderr="")
        if "inspect" in argv:
            return ProcessResult(returncode=0, stdout=json.dumps([{"RepoDigests": ["example@sha256:" + "a" * 64]}]), stderr="")
        return ProcessResult(returncode=0, stdout="ok", stderr="")
    backend = ContainerBackend(image="example@sha256:" + "a" * 64, executable="docker", runner=run)
    with use_workspace(9, tmp_path / "nine"):
        handle = asyncio.run(backend.prepare(ExtensionContext.current(), "b" * 32))
        asyncio.run(handle.exec(["python3", "-c", "print('ok')"]))
        asyncio.run(handle.stop())
    creation = next(argv for argv, _ in calls if "create" in argv)
    assert "--network=none" in creation and "--read-only" in creation and "--cap-drop=ALL" in creation
    assert "--memory=512m" in creation and "--pids-limit=128" in creation and "--security-opt=no-new-privileges" in creation
    assert not any("docker.sock" in str(part) for part in creation)
    assert all("OPENAI_API_KEY" not in kwargs.get("env", {}) for _, kwargs in calls)
    assert any("rm" in argv and "--force" in argv for argv, _ in calls)


def test_exec_cancel_stops_container_workload(tmp_path):
    async def scenario():
        entered = asyncio.Event()
        calls = []
        async def run(argv, **kwargs):
            calls.append(argv)
            if "info" in argv:
                return ProcessResult(returncode=0, stdout='{"OSType":"linux","SecurityOptions":["name=seccomp"]}', stderr="")
            if "exec" in argv:
                entered.set()
                await asyncio.Event().wait()
            return ProcessResult(returncode=0, stdout=json.dumps([{"RepoDigests": ["image@sha256:" + "a" * 64]}]), stderr="")
        with use_workspace(1, tmp_path):
            handle = await ContainerBackend(image="image@sha256:" + "a" * 64, executable="docker", runner=run).prepare(ExtensionContext.current(), "c" * 32)
            task = asyncio.create_task(handle.exec(["python3", "long_task.py"]))
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert any("rm" in argv and "--force" in argv for argv in calls)
    asyncio.run(scenario())


def test_root_linux_host_is_reported_unsupported_before_claiming_ready(monkeypatch):
    from app.execution import container_backend as module
    monkeypatch.setattr(module, "host_uid", lambda: 0, raising=False)
    async def run(*args, **kwargs):
        return ProcessResult(0, '[{"RepoDigests":["image@sha256:' + "a" * 64 + '"]}]', '')
    status = asyncio.run(ContainerBackend(image="image@sha256:" + "a" * 64, executable="docker", runner=run).probe())
    assert not status.available and status.code == "root_host_unsupported"


def test_file_transfer_has_separate_bounded_output_budget(tmp_path):
    import base64
    from app.execution.container_backend import ContainerHandle
    data = b"x" * 1_000_000
    class Backend:
        async def call(self, argv, **kwargs):
            if "exec" in argv:
                assert kwargs.get("output_limit", 65536) >= len(base64.b64encode(data))
                return ProcessResult(0, base64.b64encode(data).decode(), "")
            return ProcessResult(0, "", "")
    with use_workspace(1, tmp_path):
        handle = ContainerHandle(Backend(), "fixture", ExtensionContext.current(), WorkspaceFiles(tmp_path / "job"))
        assert asyncio.run(handle.read("large.svg")) == data
        assert not handle.stopped


def test_container_names_are_fenced_by_attempt_so_old_cleanup_cannot_kill_replacement(tmp_path):
    calls = []
    async def run(argv, **kwargs):
        calls.append(argv)
        if "info" in argv: return ProcessResult(0, '{"OSType":"linux","SecurityOptions":["name=seccomp"]}', "")
        if "inspect" in argv: return ProcessResult(0, json.dumps([{"RepoDigests": ["image@sha256:" + "a" * 64]}]), "")
        return ProcessResult(0, "ok", "")
    async def scenario():
        with use_workspace(1, tmp_path):
            backend = ContainerBackend(image="image@sha256:" + "a" * 64, executable="docker", runner=run)
            old = await backend.prepare(ExtensionContext.current(), "d" * 32, attempt="1" * 32)
            new = await backend.prepare(ExtensionContext.current(), "d" * 32, attempt="2" * 32)
            await old.stop()
            assert old.name != new.name and calls[-1][-1] == old.name and not new.stopped
            await new.stop()
    asyncio.run(scenario())
