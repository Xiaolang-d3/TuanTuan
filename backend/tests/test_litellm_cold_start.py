"""First LiteLLM import from a sync endpoint must not wedge the server.

Regression: litellm/_logging.py attaches filters to uvicorn/asyncio loggers
during ``import litellm``; those filters import LiteLLM submodules. With the
first import in a threadpool worker and the event loop logging access lines,
the two threads deadlocked on module locks, ``litellm`` vanished from
sys.modules and every later log call raised ``KeyError: 'litellm'`` - the whole
server, /health included, stopped answering.
"""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.request import Request, urlopen

BACKEND = Path(__file__).resolve().parents[1]

RACE = """
import logging, sys, threading, time
logging.basicConfig(level=logging.INFO, stream=open(__import__('os').devnull, 'w'))
from app.models.litellm_core import get_litellm
result = {}
def worker():
    try:
        get_litellm(); result['ok'] = True
    except BaseException as exc:
        result['error'] = repr(exc)
thread = threading.Thread(target=worker, daemon=True); thread.start()
access, errors = logging.getLogger('uvicorn.access'), []
deadline = time.time() + 60
while thread.is_alive() and time.time() < deadline:
    try:
        access.info('%s - "%s %s HTTP/1.1" %d', '127.0.0.1', 'GET', '/health', 200)
    except BaseException as exc:
        errors.append(repr(exc))
    time.sleep(0.0005)
names = [type(f).__name__ for f in logging.getLogger('uvicorn.access').filters]
print(result, errors[:3], 'litellm' in sys.modules, names)
assert result == {'ok': True} and not errors and 'litellm' in sys.modules, (result, errors)
assert 'AccessLogRedactionFilter' in names, names  # LiteLLM's filters attached after the import
"""


def _environment(data_dir: Path) -> dict[str, str]:
    return {**os.environ, "TUANTUAN_DATA_DIR": str(data_dir), "TUANTUAN_SECRET_BACKEND": "memory",
            "EMBEDDING_BACKEND": "hash", "TUANTUAN_MODEL_BACKEND": "litellm", "PYTHONPATH": str(BACKEND),
            "NO_PROXY": "*", "no_proxy": "*"}


def test_import_in_worker_thread_while_main_thread_logs(tmp_path):
    result = subprocess.run([sys.executable, "-c", RACE], cwd=BACKEND, env=_environment(tmp_path),
                            capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr[-3000:]


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def test_cold_start_capabilities_first_keeps_server_responsive(tmp_path):
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    log_path = tmp_path / "server.log"

    def call(path: str, body: dict | None = None, token: str | None = None, timeout: float = 10):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(body).encode() if body is not None else None
        request = Request(base + path, data=data, headers=headers, method="POST" if data else "GET")
        with urlopen(request, timeout=timeout) as response:
            return response.status, json.loads(response.read() or b"null")

    with log_path.open("w+") as log:
        server = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
            cwd=BACKEND, env=_environment(tmp_path / "data"), stdout=log, stderr=subprocess.STDOUT,
        )
        try:
            deadline = time.monotonic() + 60
            while True:
                try:
                    call("/health", timeout=2)
                    break
                except OSError:
                    assert server.poll() is None and time.monotonic() < deadline, log_path.read_text()[-3000:]
                    time.sleep(0.1)
            token = call("/auth/register", {"email": "cold@local.test", "password": "synthetic-cold-password"})[1]["access_token"]
            catalog = call("/agent/model-connections", {"name": "cold", "model_base_url": "http://127.0.0.1:9/v1",
                                              "model_protocol": "openai", "api_key": "synthetic-cold-key",
                                              "model_name": "gpt-4o"}, token)[1]
            profile = next(item for item in catalog["profiles"] if item["model_name"] == "gpt-4o")
            call("/agent/model-default", {"profile_id": profile["id"]}, token)
            assert call("/agent/model-layer", token=token)[1]["litellm_loaded"] is False  # still a cold import

            stop, health_errors = threading.Event(), []

            def hammer() -> None:  # keep the event loop writing access-log lines during the import
                while not stop.is_set():
                    try:
                        call("/health", timeout=10)
                    except OSError as exc:
                        health_errors.append(repr(exc))
                    time.sleep(0.005)

            threads = [threading.Thread(target=hammer) for _ in range(4)]
            for thread in threads:
                thread.start()
            try:
                # The browser's first request after login; it performs the first LiteLLM import.
                status, report = call("/agent/models/capabilities", token=token, timeout=30)
            finally:
                stop.set()
                for thread in threads:
                    thread.join()
            assert status == 200 and report["model_name"]
            assert call("/health", timeout=5)[1]["status"] == "ok"
            assert call("/agent/model-layer", token=token)[1]["litellm_loaded"] is True
            assert not health_errors, health_errors[:3]
        finally:
            server.terminate()
            try:
                server.wait(10)
            except subprocess.TimeoutExpired:
                server.kill()
    output = log_path.read_text()
    assert "KeyError" not in output and "Deadlock" not in output, output[-3000:]
