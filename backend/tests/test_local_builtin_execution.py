import asyncio
import os
import sys
import subprocess
import time
from pathlib import Path

import pytest

from app.execution.contracts import ExecutionUnavailable
from app.execution.local_builtin import BuiltinHandle, LocalBuiltinBackend


@pytest.fixture(autouse=True, params=["native", "selector"] if sys.platform == "win32" else ["native"])
def process_loop(request):
    policy = asyncio.get_event_loop_policy()
    if request.param == "selector":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        yield
    finally:
        asyncio.set_event_loop_policy(policy)


class FakeRuntime:
    digest = "a" * 64

    def command(self, command_id, args, root):
        if command_id == "echo":
            return [sys.executable, "-c", "print('ok')"]
        if command_id == "sleep":
            return [sys.executable, "-c", "import time; time.sleep(30)"]
        if command_id == "child":
            return [sys.executable, "-c", "import subprocess,sys,time; p=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); print(p.pid,flush=True); time.sleep(30)"]
        if command_id == "environment":
            return [sys.executable, "-c", "import os; print(os.getenv('PPT_TEST_SECRET', '<missing>'))"]
        raise ValueError("不允许的内置 PPT 命令")


@pytest.fixture
def handle(tmp_path):
    return BuiltinHandle(FakeRuntime(), tmp_path / "task", os.environ.copy())


def test_only_fixed_command_runs(handle):
    result = asyncio.run(handle.run("echo", {}))
    assert result.returncode == 0
    assert result.stdout.strip() == "ok"
    with pytest.raises(ValueError):
        asyncio.run(handle.run("shell", {"argv": ["whoami"]}))


def test_timeout_stops_process(handle):
    with pytest.raises(TimeoutError):
        asyncio.run(handle.run("sleep", {}, timeout=0.05))
    assert handle.process is None


def test_stop_without_process_is_idempotent(handle):
    asyncio.run(handle.stop())
    asyncio.run(handle.stop())


def test_backend_requires_local_deployment(monkeypatch):
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    status = LocalBuiltinBackend().probe()
    assert not status.available
    assert status.code == "hosted_disabled"


def test_missing_runtime_is_unavailable(monkeypatch, tmp_path):
    monkeypatch.setenv("TUANTUAN_PPT_RUNTIME", str(tmp_path / "missing"))
    status = LocalBuiltinBackend().probe()
    assert not status.available
    assert status.code == "runtime_missing"


def test_lost_identity_record_never_releases_workload(tmp_path):
    marker = tmp_path / "should-not-exist"

    class Runtime(FakeRuntime):
        def command(self, command_id, args, root):
            return [sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).touch()"]

    def reject_identity(identity):
        raise RuntimeError("lease expired")

    handle = BuiltinHandle(Runtime(), tmp_path / "task", os.environ.copy(), record_identity=reject_identity)
    with pytest.raises(RuntimeError, match="lease expired"):
        asyncio.run(handle.run("anything", {}))
    assert not marker.exists()


def test_output_overflow_terminates_process_tree(tmp_path):
    marker = tmp_path / "child-ran-after-cancel"

    class Runtime(FakeRuntime):
        def command(self, command_id, args, root):
            child = f"import time; from pathlib import Path; time.sleep(1); Path({str(marker)!r}).touch()"
            parent = f"import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',{child!r}]); print('x'*10000,flush=True); time.sleep(30)"
            return [sys.executable, "-c", parent]

    async def exercise():
        handle = BuiltinHandle(Runtime(), tmp_path / "task", os.environ.copy())
        with pytest.raises(ValueError, match="输出"):
            await handle.run("anything", {}, output_limit=100)
        await asyncio.sleep(1.2)
        assert not marker.exists()

    asyncio.run(exercise())


def test_concurrent_commands_cannot_share_one_handle(handle):
    async def exercise():
        first = asyncio.create_task(handle.run("sleep", {}, timeout=0.1))
        await asyncio.sleep(0)
        with pytest.raises(ExecutionUnavailable, match="正在执行"):
            await handle.run("echo", {})
        with pytest.raises(TimeoutError):
            await first
    asyncio.run(exercise())


def test_stop_during_spawn_never_releases_workload(tmp_path, monkeypatch):
    marker = tmp_path / "released-after-stop"

    class Runtime(FakeRuntime):
        def command(self, command_id, args, root):
            return [sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).touch()"]

    async def exercise():
        entered, resume = asyncio.Event(), asyncio.Event()
        from app.execution import local_builtin
        create = local_builtin.create_subprocess_exec

        async def delayed_create(*args, **kwargs):
            entered.set()
            await resume.wait()
            return await create(*args, **kwargs)

        monkeypatch.setattr(local_builtin, "create_subprocess_exec", delayed_create)
        handle = BuiltinHandle(Runtime(), tmp_path / "task", os.environ.copy())
        execution = asyncio.create_task(handle.run("marker", {}))
        await entered.wait()
        stopping = asyncio.create_task(handle.stop())
        await asyncio.sleep(0)
        pending_stop = not stopping.done()
        resume.set()
        await stopping
        try:
            await execution
        except ExecutionUnavailable:
            pass
        assert pending_stop
        assert not marker.exists()

    asyncio.run(exercise())


def test_home_and_config_directories_are_private_to_task(tmp_path, monkeypatch):
    monkeypatch.setenv("USERPROFILE", str(tmp_path / "real-user-home"))
    monkeypatch.setenv("HOME", str(tmp_path / "real-user-home"))

    class Runtime(FakeRuntime):
        def command(self, *args):
            return [sys.executable, "-I", "-c", "from pathlib import Path; import os,json; print(json.dumps([str(Path.home()),os.environ['APPDATA'],os.environ['LOCALAPPDATA'],os.environ['XDG_CONFIG_HOME']]))"]

    import json
    task = tmp_path / "task"
    handle = BuiltinHandle(Runtime(), task)
    result = asyncio.run(handle.run("home", {}))
    assert result.returncode == 0, result.stderr
    paths = json.loads(result.stdout)
    assert all(Path(path).is_relative_to(task) and Path(path).is_dir() for path in paths)
    assert paths[0] == str(task / ".home")


def test_empty_secret_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("PPT_TEST_SECRET", "should-not-reach-subprocess")
    handle = BuiltinHandle(FakeRuntime(), tmp_path / "task")
    result = asyncio.run(handle.run("environment", {}))
    assert result.stdout.strip() == "<missing>"


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object parent-loss integration")
def test_lost_parent_terminates_supervisor_and_workload(tmp_path):
    marker = tmp_path / "survived-parent"
    ready = tmp_path / "ready"
    parent_script = tmp_path / "parent.py"
    backend = Path(__file__).resolve().parents[1]
    child_code = f"import time; from pathlib import Path; time.sleep(1.5); Path({str(marker)!r}).touch()"
    parent_script.write_text(
        "import asyncio,sys\nfrom pathlib import Path\n"
        f"sys.path.insert(0,{str(backend)!r})\n"
        "from app.execution.local_builtin import BuiltinHandle\n"
        "class Runtime:\n digest='test'\n def command(self,*args):\n"
        f"  return [sys.executable,'-c',{child_code!r}]\n"
        "async def main():\n"
        f" handle=BuiltinHandle(Runtime(),Path({str(tmp_path / 'task')!r}))\n"
        " task=asyncio.create_task(handle.run('test',{}))\n await asyncio.sleep(.3)\n"
        f" Path({str(ready)!r}).touch()\n await task\n"
        "asyncio.run(main())\n", encoding="utf-8",
    )
    with subprocess.Popen([sys.executable, str(parent_script)], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE) as parent:
        try:
            deadline = time.monotonic() + 10
            while not ready.exists() and parent.poll() is None and time.monotonic() < deadline:
                time.sleep(.05)
            assert ready.exists(), parent.stderr.read().decode("utf-8", "replace") if parent.poll() is not None else "parent startup timeout"
            parent.kill()
            parent.wait(timeout=5)
            time.sleep(1.6)
            assert not marker.exists()
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=5)

def test_minimal_environment_preserves_windows_system_variables_case_insensitively(monkeypatch):
    from app.execution.local_builtin import _safe_env
    # Windows os.environ normalizes names to uppercase. Losing SYSTEMROOT
    # prevents Winsock from loading its provider in the confirmation process.
    monkeypatch.setattr("app.execution.local_builtin.os.environ", {
        "SYSTEMROOT": "C:\\Windows", "windir": "C:\\Windows", "OPENAI_API_KEY": "private-key", "PATH": "private-path",
    })
    environment = _safe_env()
    assert environment["SYSTEMROOT"] == "C:\\Windows"
    assert environment["windir"] == "C:\\Windows"
    assert "OPENAI_API_KEY" not in environment and "PATH" not in environment
