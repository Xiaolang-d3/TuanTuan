import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import httpx
import pytest

from app.execution.builtin_runtime import BuiltinRuntime
from app.presentations.confirmation_server import (
    ConfirmationServerError, ConfirmationServerManager, MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
)

JOB = "a" * 32


class Runtime:
    digest = "a" * 64
    manifest = {"skill": "vendor/ppt-master", "files": {
        "vendor/ppt-master/scripts/confirm_ui/static/app.js": "hash",
        "vendor/ppt-master/references/ai-image-comparison/rendering/test.webp": "hash",
    }}

    def __init__(self):
        self.verified = 0

    def verify(self):
        self.verified += 1

    def confirmation_command(self, root, port):
        return [sys.executable, "fixed-server", str(root), str(port)]


class Stream(httpx.AsyncByteStream):
    def __init__(self, content):
        self.content = content

    async def __aiter__(self):
        yield self.content


class Harness:
    def __init__(self, root):
        self.root = root.resolve()
        self.events = []
        self.processes = []
        self.requests = []
        self.response = (200, {}, b"ok")
        self.health_project = str(self.root)
        self.attach_error = False
        self.on_spawn = None
        self.runtime = Runtime()
        self.manager = ConfirmationServerManager(
            spawn=self.spawn, tree_factory=self.tree, port_factory=lambda: 12345,
            transport=httpx.MockTransport(self.http), startup_timeout=0.2,
            request_timeout=0.2,
        )

    def tree(self):
        harness = self

        class Tree:
            process = None

            def attach(self, pid):
                harness.events.append("attach")
                self.process = harness.processes[-1]
                if harness.attach_error:
                    raise OSError("private/path")

            def close(self):
                harness.events.append("tree-close")
                if self.process:
                    self.process.exit()

        return Tree()

    async def spawn(self, *argv, **kwargs):
        harness = self
        harness.events.append("spawn")
        harness.argv, harness.kwargs = argv, kwargs
        if self.on_spawn:
            await self.on_spawn()

        class Pipe:
            def write(self, data):
                harness.events.append("handshake")
                harness.handshake = json.loads(data)
                (harness.root / ".confirm_ui.lock").write_text(json.dumps({"pid": 102, "port": 12345}))

            async def drain(self):
                pass

            def close(self):
                harness.events.append("stdin-close")

        class Process:
            pid = 101
            returncode = None
            stdin = Pipe()

            def __init__(self):
                self.done = asyncio.Event()

            async def wait(self):
                await self.done.wait()
                return self.returncode

            def exit(self):
                self.returncode = 0
                self.done.set()

            kill = exit

        process = Process()
        self.processes.append(process)
        return process

    async def http(self, request):
        self.requests.append(request)
        if request.url.path == "/api/health":
            body = json.dumps({"service": "confirm_ui", "project": self.health_project, "pid": 102}).encode()
            return httpx.Response(200, stream=Stream(body), headers={"content-type": "application/json"})
        status, headers, body = self.response
        return httpx.Response(status, headers=headers, stream=Stream(body))

    async def get(self, route="/", **kwargs):
        return await self.manager.request(1, JOB, self.root, self.runtime, "stage1", "GET", route, **kwargs)


def test_reuse_private_environment_fixed_supervisor_and_close(tmp_path, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://secret.invalid")
    monkeypatch.setenv("MODEL_API_KEY", "secret")
    h = Harness(tmp_path)

    async def run():
        assert (await h.get()).body == b"ok"
        await h.get("/static/app.js")
        assert len(h.processes) == h.runtime.verified == 1
        assert h.events[:3] == ["spawn", "attach", "handshake"]
        assert h.argv[1:3] == ("-I", "-B")
        assert Path(h.argv[3]).name == "local_supervisor.py"
        assert "MODEL_API_KEY" not in h.kwargs["env"]
        assert "HTTP_PROXY" not in h.kwargs["env"]
        assert Path(h.kwargs["env"]["HOME"]).is_relative_to(tmp_path)
        assert h.kwargs["stderr"] == asyncio.subprocess.DEVNULL
        assert h.handshake["argv"][1] == "fixed-server"
        assert all(r.url.host == "127.0.0.1" for r in h.requests)
        assert all("cookie" not in r.headers and "authorization" not in r.headers for r in h.requests)
        await h.manager.close_job(1, JOB)
        await h.manager.close_job(1, JOB)
        assert h.processes[0].returncode == 0
        await h.manager.close_all()
        with pytest.raises(ConfirmationServerError):
            await h.get()
    asyncio.run(run())


@pytest.mark.parametrize("method,route", [
    ("GET", "//evil.test/"), ("GET", "/api/shutdown"), ("POST", "/api/shutdown"),
    ("HEAD", "/"), ("GET", "/static/../server.py"), ("GET", "/static/%2e%2e/server.py"),
    ("GET", "/static/app.js?q=1"), ("GET", "/static/not-listed.js"),
    ("GET", "http://evil.test/"), ("GET", "/api/session#test"),
])
def test_route_allowlist_before_spawn(tmp_path, method, route):
    h = Harness(tmp_path)
    with pytest.raises(ValueError):
        asyncio.run(h.manager.request(1, JOB, tmp_path, h.runtime, "stage1", method, route))
    assert not h.events


def test_body_bounds_and_stage_before_spawn(tmp_path):
    h = Harness(tmp_path)

    async def run():
        for body in (b"[]", b"not-json", b'{"stage":"final"}', b"x" * (MAX_REQUEST_BYTES + 1)):
            with pytest.raises(ValueError):
                await h.manager.request(1, JOB, tmp_path, h.runtime, "stage1", "POST", "/api/confirm", body)
        with pytest.raises(ValueError):
            await h.get(body=b"unexpected")
    asyncio.run(run())
    assert not h.events


def test_reservation_runs_after_startup_and_before_post(tmp_path):
    h = Harness(tmp_path)
    reserved = []

    def reserve():
        assert h.runtime.verified == 1
        assert [r.method for r in h.requests] == ["GET"]
        reserved.append(True)

    async def run():
        await h.manager.request(1, JOB, tmp_path, h.runtime, "stage1", "POST", "/api/confirm",
                                b'{"stage":"stage1"}', before_submit=reserve)
        assert reserved == [True]
        assert h.requests[-1].method == "POST"
        await h.manager.close_all()
    asyncio.run(run())


@pytest.mark.parametrize("failure", ["capacity", "integrity", "project"])
def test_startup_failure_never_reserves_submission(tmp_path, failure):
    h = Harness(tmp_path)
    reserved = []
    root = tmp_path
    if failure == "capacity":
        h.manager._max_servers = 0
    elif failure == "integrity":
        def broken():
            raise ValueError("private runtime")
        h.runtime.verify = broken
    else:
        root = tmp_path / "missing"

    async def run():
        with pytest.raises((ConfirmationServerError, ValueError)):
            await h.manager.request(1, JOB, root, h.runtime, "stage1", "POST", "/api/confirm",
                                    b'{"stage":"stage1"}', before_submit=lambda: reserved.append(True))
        assert not reserved
        assert not [r for r in h.requests if r.method == "POST"]
        await h.manager.close_all()
    asyncio.run(run())


def test_rejected_reservation_does_not_stop_an_existing_writer(tmp_path):
    from app.jobs.repository import JobConflict
    h = Harness(tmp_path)

    def duplicate():
        raise JobConflict("duplicate")

    async def run():
        await h.get()
        server = h.manager._servers[(1, JOB)]
        generation = h.manager._generation.get((1, JOB), 0)
        with pytest.raises(JobConflict):
            await h.manager.request(1, JOB, tmp_path, h.runtime, "stage1", "POST", "/api/confirm",
                                    b'{"stage":"stage1"}', before_submit=duplicate)
        assert h.manager._servers[(1, JOB)] is server
        assert h.manager._generation.get((1, JOB), 0) == generation
        assert h.processes[0].returncode is None
        assert not [r for r in h.requests if r.method == "POST"]
        await h.manager.close_all()
    asyncio.run(run())


def test_post_forwarded_once_and_error_sanitized(tmp_path):
    h = Harness(tmp_path)
    h.response = (409, {"set-cookie": "secret=1", "location": "http://evil.test"}, b'{"error":"D:/private/file"}')

    async def run():
        body = b'{"stage":"stage1","template_selection":{"mode":"free_design","selection_keys":[]}}'
        response = await h.manager.request(1, JOB, tmp_path, h.runtime, "stage1", "POST", "/api/confirm", body)
        assert response.status_code == 409
        assert b"private" not in response.body
        assert len([r for r in h.requests if r.method == "POST"]) == 1
        assert h.requests[-1].content == body
        await h.get()
        assert "cookie" not in h.requests[-1].headers
        await h.manager.close_all()
    asyncio.run(run())


@pytest.mark.parametrize("response", [
    (302, {"location": "http://evil.test"}, b""),
    (200, {"content-length": str(MAX_RESPONSE_BYTES + 1)}, b""),
    (200, {}, b"x" * (MAX_RESPONSE_BYTES + 1)),
    (200, {"content-encoding": "gzip"}, b""),
])
def test_invalid_response_stops_without_redirect(tmp_path, response):
    h = Harness(tmp_path)
    h.response = response

    async def run():
        with pytest.raises(ConfirmationServerError):
            await h.get()
        assert len(h.requests) == 2
        assert h.processes[0].returncode == 0
        assert not h.manager._servers
    asyncio.run(run())


def test_wrong_health_identity_and_attach_failure_stop(tmp_path):
    async def run():
        for failure in ("health", "attach"):
            h = Harness(tmp_path)
            if failure == "health":
                h.health_project = "D:/other-user"
            else:
                h.attach_error = True
            with pytest.raises(ConfirmationServerError) as error:
                await h.get()
            assert "private" not in str(error.value)
            assert h.processes[0].returncode == 0
            if failure == "attach":
                assert "handshake" not in h.events
    asyncio.run(run())


def test_restart_cleans_old_tree_on_stage_and_unexpected_exit(tmp_path):
    h = Harness(tmp_path)

    async def run():
        await h.get()
        await h.manager.request(1, JOB, tmp_path, h.runtime, "stage2", "GET", "/")
        assert len(h.processes) == 2 and h.processes[0].returncode == 0
        h.processes[-1].exit()
        await asyncio.sleep(0)
        await h.manager.request(1, JOB, tmp_path, h.runtime, "stage2", "GET", "/")
        assert len(h.processes) == 3
        await h.manager.close_all()
        assert all(p.returncode == 0 for p in h.processes)
    asyncio.run(run())


@pytest.mark.parametrize("cancel", [False, True])
def test_stop_or_cancel_during_spawn_does_not_release_child(tmp_path, cancel):
    h = Harness(tmp_path)

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()

        async def block():
            entered.set()
            await release.wait()

        h.on_spawn = block
        task = asyncio.create_task(h.get())
        await entered.wait()
        if cancel:
            task.cancel()
            closing = None
        else:
            closing = asyncio.create_task(h.manager.close_job(1, JOB))
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(asyncio.CancelledError if cancel else ConfirmationServerError):
            await task
        if closing:
            await closing
        assert "handshake" not in h.events
        assert h.processes[0].returncode == 0
    asyncio.run(run())


def test_timeout_does_not_retry_post(tmp_path):
    h = Harness(tmp_path)
    original = h.http

    async def slow(request):
        if request.method == "POST":
            h.requests.append(request)
            await asyncio.Event().wait()
        return await original(request)

    h.manager._transport = httpx.MockTransport(slow)

    async def run():
        with pytest.raises(ConfirmationServerError):
            await h.manager.request(1, JOB, tmp_path, h.runtime, "stage1", "POST", "/api/confirm", b'{"stage":"stage1"}')
        assert len([r for r in h.requests if r.method == "POST"]) == 1
        assert h.processes[0].returncode == 0
    asyncio.run(run())


def test_close_fences_inflight_and_queued_requests(tmp_path):
    h = Harness(tmp_path)
    original = h.http

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()

        async def blocked(request):
            if request.url.path == "/":
                entered.set()
                await release.wait()
            return await original(request)

        h.manager._transport = httpx.MockTransport(blocked)
        inflight = asyncio.create_task(h.get())
        await entered.wait()
        queued = asyncio.create_task(h.get())
        await asyncio.sleep(0)
        closing = asyncio.create_task(h.manager.close_job(1, JOB))
        await asyncio.sleep(0)
        release.set()
        for task in (inflight, queued):
            with pytest.raises(ConfirmationServerError):
                await task
        await closing
        assert len(h.processes) == 1 and h.processes[0].returncode == 0
    asyncio.run(run())


def test_hosted_mode_never_starts(tmp_path, monkeypatch):
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    h = Harness(tmp_path)
    with pytest.raises(ConfirmationServerError):
        asyncio.run(h.get())
    assert not h.events


def test_absolute_lifetime_is_terminal_even_with_polling(tmp_path):
    h = Harness(tmp_path)
    async def run():
        await h.get()
        server = h.manager._servers[(1, JOB)]
        original_deadline = server.deadline
        await h.get("/api/session")
        assert server.deadline == original_deadline
        await h.manager._deadline(server, asyncio.get_running_loop().time() - 1)
        await server.expiry
        assert server.expired and h.processes[0].returncode == 0
        with pytest.raises(ConfirmationServerError, match="过期"):
            await h.get()
        assert len(h.processes) == 1
        await h.manager.close_all()
    asyncio.run(run())


def test_user_job_bindings_are_isolated_and_integrity_is_required(tmp_path):
    h = Harness(tmp_path)

    async def run():
        await h.get()
        other = tmp_path / "other"
        other.mkdir()
        # A second binding cannot borrow the first process, even with same job id.
        h.root = other.resolve()
        h.health_project = str(h.root)
        await h.manager.request(2, JOB, other, h.runtime, "stage1", "GET", "/")
        await h.manager.close_job(1, JOB)
        assert h.processes[0].returncode == 0
        assert h.processes[1].returncode is None
        await h.manager.close_all()
        assert h.processes[1].returncode == 0
    asyncio.run(run())

    h = Harness(tmp_path)

    def broken():
        raise ValueError("private/runtime/path")

    h.runtime.verify = broken
    with pytest.raises(ConfirmationServerError) as error:
        asyncio.run(h.get())
    assert "private" not in str(error.value) and not h.processes


def test_session_expiry_only_shortens_and_closes_watchers(tmp_path):
    h = Harness(tmp_path)

    async def run():
        await h.get(expires_at=time.time() + 100)
        server = h.manager._servers[(1, JOB)]
        first = server.deadline
        watcher = server.expiry
        await h.get(expires_at=time.time() + 800)
        assert server.deadline == first and server.expiry is watcher
        await h.get(expires_at=time.time() + 50)
        assert server.deadline < first and watcher.done()
        shorter = server.expiry
        await h.manager.close_job(1, JOB)
        assert shorter.done() and h.processes[0].returncode == 0
    asyncio.run(run())


def test_expired_session_never_starts_and_stops_existing(tmp_path):
    h = Harness(tmp_path)

    async def run():
        with pytest.raises(ConfirmationServerError, match="过期"):
            await h.get(expires_at=time.time() - 1)
        assert not h.processes
        await h.get()
        with pytest.raises(ConfirmationServerError, match="过期"):
            await h.get(expires_at=time.time() - 1)
        assert h.processes[0].returncode == 0
        await h.manager.close_all()
    asyncio.run(run())


@pytest.mark.parametrize("value", [float("nan"), float("inf"), True, "later"])
def test_invalid_expiry_never_starts(tmp_path, value):
    h = Harness(tmp_path)
    with pytest.raises(ValueError):
        asyncio.run(h.get(expires_at=value))
    assert not h.processes


def test_revocation_sweep_closes_without_browser_request(tmp_path):
    h = Harness(tmp_path)

    async def run():
        await h.get()
        server = h.manager._servers[(1, JOB)]
        watcher = server.expiry
        assert await h.manager.close_invalid(lambda *scope: True) == 0

        async def revoked(user_id, job_id, stage):
            assert (user_id, job_id, stage) == (1, JOB, "stage1")
            raise PermissionError("revoked parent login")

        assert await h.manager.close_invalid(revoked) == 1
        assert h.processes[0].returncode == 0 and watcher.done()
        with pytest.raises(ConfirmationServerError, match="过期"):
            await h.get()
        await h.manager.close_all()
    asyncio.run(run())


def test_fixed_runtime_command_and_nested_entry_allowlist(tmp_path):
    runtime_root = tmp_path / "runtime"
    project = tmp_path / "project"
    project.mkdir()
    skill = "vendor/ppt-master"
    names = ["python.exe", "host/builtin_entry.py", f"{skill}/scripts/confirm_ui/server.py"]
    runtime = BuiltinRuntime(runtime_root, {"skill": skill, "python": names[0], "files": dict.fromkeys(names, "hash")}, "digest")
    command = runtime.confirmation_command(project, 12345)
    assert command[-5:] == ["--port", "12345", "--no-browser", "--timeout", "900"]
    assert "--daemon" not in command and "--host" not in command
    for port in (True, 0, 80, 65536, "12345"):
        with pytest.raises(ValueError):
            runtime.confirmation_command(project, port)
    entry_source = Path(__file__).parents[1] / "app/execution/builtin_entry.py"
    entry = runtime_root / names[1]
    entry.parent.mkdir(parents=True)
    entry.write_bytes(entry_source.read_bytes())
    for relative, allowed in (("confirm_ui/server.py", True), ("confirm_ui/other.py", False), ("other/server.py", False), ("project_manager.py", True)):
        script = runtime_root / skill / "scripts" / relative
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text("print('allowed')", encoding="utf-8")
        result = subprocess.run([sys.executable, "-I", "-B", str(entry), str(script)], capture_output=True, timeout=10)
        assert (result.returncode == 0) == allowed
