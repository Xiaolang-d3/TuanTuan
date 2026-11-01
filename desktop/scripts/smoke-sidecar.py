"""Exercise a packaged runtime with synthetic data, then verify it exits."""
from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import ProxyHandler, Request, build_opener


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend" / "tests"))
from fake_llm_server import FakeLLMServer  # noqa: E402 - loopback model server for the LiteLLM check


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path, default=ROOT / "desktop/src-tauri/resources/tuantuan-runtime/tuantuan-runtime")
    args = parser.parse_args()
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    instance_id = str(uuid.uuid4())
    version = json.loads((ROOT / "desktop/src-tauri/tauri.conf.json").read_text())["version"]
    opener = build_opener(ProxyHandler({}))

    def request(path: str, payload=None, token: str = "", timeout: float = 2):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        data = json.dumps(payload).encode() if payload is not None else None
        with opener.open(Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers), timeout=timeout) as response:
            if response.status == 204:
                return None
            return json.load(response)

    def assert_revoked(token: str) -> None:
        try:
            request("/library", token=token)
        except HTTPError as error:
            assert error.code == 401, error.code
        else:
            raise AssertionError("A revoked credential still accesses the library")

    with tempfile.TemporaryDirectory(prefix="tuantuan-sidecar-smoke-") as directory:
        with (Path(directory) / "runtime.log").open("w+") as log:
            started = time.monotonic()
            process = subprocess.Popen(
                [str(args.executable.resolve()), "--data-dir", directory, "--port", str(port), "--instance-id", instance_id],
                cwd=directory, stdout=log, stderr=log,
                env={**os.environ, "EMBEDDING_BACKEND": "hash", "ATTACHMENT_STORAGE": "local", "OPENAI_API_KEY": "", "MODEL_PROTOCOL": "openai", "WEB_RESEARCH_ENABLED": "false",
                     # Synthetic smoke key only; never touch the real keychain.
                     "TUANTUAN_SECRET_BACKEND": "memory", "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"},
            )
            try:
                # macOS scans a freshly built bundle on its first launch (~20s observed); warm starts take <1s.
                deadline = time.monotonic() + 60
                while True:
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(f"Runtime exited during startup:\n{log.read()}")
                    try:
                        health = request("/health")
                        break
                    except (URLError, TimeoutError):
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Runtime startup timed out")
                        time.sleep(0.1)
                cold_start = time.monotonic() - started
                assert health == {"status": "ok", "service": "tuantuan", "version": version, "instance_id": instance_id}, health
                print(f"Packaged runtime: cold start to /health {cold_start:.2f}s")
                account = request("/auth/register", {"email": "smoke@local.test", "password": "synthetic-smoke-password"})
                token = account["access_token"]
                assert request("/library", token=token)["sources"] == []
                request("/library/sources", {"title": "Smoke note", "content": "本地资料无需模型配置即可保存。"}, token)
                assert len(request("/library", token=token)["sources"]) == 1
                assert request("/agent/capabilities", token=token)["configured"] is False
                changed = request("/auth/me/password", {
                    "current_password": "synthetic-smoke-password", "new_password": "synthetic-updated-password",
                }, token)
                assert_revoked(token)
                refreshed = changed["access_token"]
                assert len(request("/library", token=refreshed)["sources"]) == 1
                request("/auth/logout", {}, refreshed)
                assert_revoked(refreshed)
                signed_in = request("/auth/login", {"email": "smoke@local.test", "password": "synthetic-updated-password"})
                assert len(request("/library", token=signed_in["access_token"])["sources"]) == 1
                smoke_model_layer(request, signed_in["access_token"])
                print("Packaged runtime: health identity, registration/login, password rotation, logout revocation, SQLite/library and missing-model mode passed.")
            except BaseException:
                log.flush()
                log.seek(0)
                print(f"--- runtime log (tail) ---\n{log.read()[-8000:]}", file=sys.stderr)
                raise
            finally:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                    raise RuntimeError("Runtime did not exit on termination")
            with socket.socket() as probe:
                probe.settimeout(1)
                assert probe.connect_ex(("127.0.0.1", port)) != 0, "Runtime port is still open"
            print("Packaged runtime: process exit and loopback port release passed.")


# One real call per protocol through the bundled LiteLLM: a partial bundle
# (missing submodules or data files) fails here instead of in the user's app.
SMOKE_PROTOCOLS = (
    ("openai", "/v1", "gpt-4o", "/v1/chat/completions"),
    ("responses", "/v1", "gpt-5", "/v1/responses"),
    ("anthropic", "", "claude-sonnet-4-5", "/v1/messages"),
    ("gemini", "", "gemini-2.5-flash", ":generateContent"),
    ("ollama", "", "qwen3", "/api/chat"),
)


def smoke_model_layer(request, token: str) -> None:
    """The bundled LiteLLM layer imports offline and completes a real call per protocol."""
    layer = request("/agent/model-layer", token=token)
    assert layer["backend"] == "litellm" and layer["litellm_version"] and layer["offline_cost_map"], layer
    first_call = None
    with FakeLLMServer() as server:
        for protocol, suffix, model, path in SMOKE_PROTOCOLS:
            seen = len(server.requests)
            catalog = request("/agent/model-connections", {
                "name": f"smoke-{protocol}", "model_base_url": f"{server.url}{suffix}", "model_protocol": protocol,
                "api_key": "synthetic-smoke-key", "model_name": model,
            }, token)
            connection = next(item for item in catalog["connections"] if item["name"] == f"smoke-{protocol}")
            started = time.monotonic()
            check = request(f"/agent/model-connections/{connection['id']}/check", {}, token, timeout=60)
            first_call = first_call if first_call is not None else time.monotonic() - started
            assert check["available"] is True, (protocol, check)
            assert any(path in entry["path"] for entry in server.requests[seen:]), (protocol, server.requests[seen:])
            if protocol == "openai":
                profile = next(item for item in catalog["profiles"] if item["connection_id"] == connection["id"])
                report = request(f"/agent/model-profiles/{profile['id']}/capabilities", token=token, timeout=30)
                assert report["litellm_known"] is True and report["context_window"]["tokens"], report
    layer = request("/agent/model-layer", token=token)
    print(f"Packaged runtime: LiteLLM {layer['litellm_version']} first model call {first_call:.2f}s "
          f"(import {layer['litellm_import_seconds']:.2f}s); {len(SMOKE_PROTOCOLS)} protocols, cost map and capabilities passed.")

if __name__ == "__main__":
    main()
