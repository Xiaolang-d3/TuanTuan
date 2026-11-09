"""The actual Windows reload server must support the PPT subprocess API."""
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest


@pytest.mark.skipif(sys.platform != "win32", reason="Windows reload selects a platform-specific event loop")
def test_reload_server_can_execute_ppt_subprocess(tmp_path):
    from app.execution.local_processes import ProcessTree

    fixture = tmp_path / "ppt_loop_fixture.py"
    fixture.write_text('''import asyncio
import os
import sys
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from app.execution.local_builtin import BuiltinHandle
from app.streaming import until_shutdown
app = FastAPI()
@app.get("/events")
async def events(request: Request):
    async def stream():
        yield ": connected\\n\\n"
        await asyncio.Event().wait()
    return StreamingResponse(until_shutdown(stream(), request), media_type="text/event-stream")
class Runtime:
    digest = "a" * 64
    def command(self, command, args, root):
        return [sys.executable, "-c", "print('ppt-ready')"]
@app.get("/probe")
async def probe():
    handle = BuiltinHandle(Runtime(), Path(__file__).parent / "task", os.environ.copy())
    result = await handle.run("probe", {})
    return {"loop": type(asyncio.get_running_loop()).__name__, "output": result.stdout.strip(), "pid": os.getpid()}
''', encoding="utf-8")
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    backend = Path(__file__).parents[1]
    environment = dict(os.environ, PYTHONPATH=str(backend), PYTHON_DOTENV_DISABLED="1")
    tree = ProcessTree()
    # Uvicorn's Windows reloader sends CTRL_C_EVENT to its console. Isolate a
    # hidden console so a real reload cannot interrupt the pytest parent.
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    with (tmp_path / "server.log").open("wb") as log:
        process = subprocess.Popen([sys.executable, "-m", "app.server", "ppt_loop_fixture:app",
            "--app-dir", str(tmp_path), "--host", "127.0.0.1", "--port", str(port),
            "--reload", "--reload-dir", str(tmp_path), "--log-level", "info"],
            cwd=backend, env=environment, stdout=log, stderr=log,
            creationflags=subprocess.CREATE_NEW_CONSOLE, startupinfo=startup)
        try:
            tree.attach(process.pid)
            deadline = time.monotonic() + 15
            with httpx.Client(trust_env=False, timeout=2) as client:
                while True:
                    try:
                        response = client.get(f"http://127.0.0.1:{port}/probe")
                        break
                    except httpx.TransportError:
                        if process.poll() is not None or time.monotonic() >= deadline:
                            pytest.fail("Reload server did not start: " + (tmp_path / "server.log").read_text(encoding="utf-8", errors="replace"))
                        time.sleep(.1)
            assert response.status_code == 200, response.text
            assert response.json()["output"] == "ppt-ready"
            first_pid = response.json()["pid"]
            with httpx.Client(trust_env=False, timeout=15) as client, ThreadPoolExecutor(max_workers=1) as pool:
                with client.stream("GET", f"http://127.0.0.1:{port}/events") as stream:
                    assert stream.status_code == 200
                    lines = stream.iter_lines()
                    assert next(lines) == ": connected"
                    fixture.write_text(fixture.read_text(encoding="utf-8") + "\nRELOADED = True\n", encoding="utf-8")
                    # Reload must finish the response, rather than truncate it
                    # after the graceful timeout or hang on the live stream.
                    drained = pool.submit(list, lines)
                    deadline = time.monotonic() + 15
                    with httpx.Client(trust_env=False, timeout=2) as probe:
                        while time.monotonic() < deadline:
                            try:
                                reloaded = probe.get(f"http://127.0.0.1:{port}/probe")
                                if reloaded.status_code == 200 and reloaded.json()["pid"] != first_pid:
                                    break
                            except httpx.TransportError:
                                pass
                            time.sleep(.1)
                        else:
                            pytest.fail("Reload worker did not restart with subprocess support")
                    drained.result(timeout=2)
            assert reloaded.json()["output"] == "ppt-ready"
            server_log = (tmp_path / "server.log").read_text(encoding="utf-8", errors="replace")
            assert "ERROR:" not in server_log and "Traceback" not in server_log
        finally:
            tree.close()
            process.wait(timeout=5)
