"""Supply-chain posture, backend flag, capabilities, migration and API for the LiteLLM layer."""
from __future__ import annotations

import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import db, secret_store
from app.agent import settings
from app.agent.model_routing import merge_capabilities
from app.db import DB_SCHEMA_VERSION, init_db
from app.main import app
from app.models.factory import build_model_provider, model_backend
from app.models.litellm_core import capability_defaults, estimate_cost_usd
from api_client import create_authenticated_client


BACKEND = Path(__file__).resolve().parents[1]


# ---------------------------------------------------------- supply chain
OFFLINE_SCRIPT = r"""
import socket, sys, time
attempts = []
def deny(*args, **kwargs):
    attempts.append(args[:1])
    raise OSError("network disabled in test")
socket.socket.connect = deny
socket.socket.connect_ex = deny
socket.getaddrinfo = deny
socket.create_connection = deny
from app.models import litellm_core
assert "litellm" not in sys.modules, "importing the core module must not import litellm"
started = time.perf_counter()
litellm = litellm_core.get_litellm()
elapsed = time.perf_counter() - started
import os
assert os.environ["LITELLM_LOCAL_MODEL_COST_MAP"] == "True"
assert litellm.model_cost and "gpt-4o" in litellm.model_cost
info = litellm.get_model_info("anthropic/claude-sonnet-4-5")
assert info["max_input_tokens"]
assert litellm.drop_params is True
assert not litellm.callbacks and not litellm.success_callback
assert attempts == [], attempts
assert "litellm.rust_bridge._native" not in sys.modules
print(f"IMPORT_SECONDS={elapsed:.3f}")
"""


def test_litellm_imports_offline_without_network_attempts():
    env = {**os.environ, "PYTHONPATH": str(BACKEND)}
    for key in [key for key in env if key.startswith("LITELLM_")]:
        env.pop(key)
    result = subprocess.run([sys.executable, "-c", OFFLINE_SCRIPT], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-2000:]
    seconds = float(re.search(r"IMPORT_SECONDS=([\d.]+)", result.stdout).group(1))
    print(f"litellm cold import: {seconds:.2f}s")
    assert seconds < 30


def test_only_litellm_core_imports_litellm():
    importers = []
    for path in (BACKEND / "app").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if re.search(r"^\s*(import litellm|from litellm)", text, re.MULTILINE):
            importers.append(path.relative_to(BACKEND).as_posix())
    assert importers == ["app/models/litellm_core.py"]


def _pins(text: str) -> dict[str, str]:
    found = re.findall(r"^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?==([^\s;\\]+)", text, re.MULTILINE)
    return {re.sub(r"[-_.]+", "-", name).lower(): version for name, version in found}


def _lock(name: str) -> dict[str, str]:
    lock = (BACKEND / name).read_text(encoding="utf-8")
    entries = re.split(r"\n(?=[A-Za-z0-9])", lock)
    requirement_entries = [entry for entry in entries if re.match(r"^[A-Za-z0-9_.\-]+==", entry)]
    assert requirement_entries, name
    for entry in requirement_entries:
        assert "--hash=sha256:" in entry, (name, entry.splitlines()[0])
    return _pins(lock)


def test_requirements_are_hash_pinned():
    """Runtime, dev and build locks: every entry hashed, shared packages at one version."""
    runtime, dev, build = (_lock(name) for name in
                           ("requirements-lock.txt", "requirements-dev-lock.txt", "requirements-build-lock.txt"))
    assert re.match(r"\d+\.\d+\.\d+$", runtime["litellm"]) and len(runtime) > 50
    for name, version in _pins((BACKEND / "requirements.txt").read_text(encoding="utf-8")).items():
        assert runtime.get(name) == version, ("requirements.txt", name, version, runtime.get(name))
    for name, version in _pins((BACKEND / "requirements-litellm.in").read_text(encoding="utf-8")).items():
        assert runtime.get(name) == version, ("requirements-litellm.in", name, version)
    for name, version in _pins((BACKEND / "requirements-dev.txt").read_text(encoding="utf-8")).items():
        assert dev.get(name) == version, ("requirements-dev.txt", name, version, dev.get(name))
    # Deployments never get development tools; dev and build agree with runtime.
    for tool in ("pytest", "pyinstaller", "pluggy", "iniconfig"):
        assert tool not in runtime, tool
    assert "pytest" not in build and build["pyinstaller"] == dev["pyinstaller"]
    for name, version in {**runtime, **build}.items():
        assert dev.get(name) == version, name
    assert not (BACKEND / "requirements-litellm.txt").exists()

# ---------------------------------------------------------- backend flag
def test_backend_flag_selects_native_or_litellm(monkeypatch):
    from app.models.auto_negotiating import AutoNegotiatingModelProvider
    from app.models.litellm_provider import LiteLLMProvider
    from app.models.openai_compatible import OpenAICompatibleProvider

    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "native")
    assert model_backend() == "native"
    native = build_model_provider(api_key="k", model="m", base_url="https://x.example.test/v1", timeout_seconds=5, protocol="openai")
    assert isinstance(native, OpenAICompatibleProvider)
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "litellm")
    assert model_backend() == "litellm"
    lite = build_model_provider(api_key="k", model="m", base_url="https://x.example.test/v1", timeout_seconds=5, protocol="openai")
    assert isinstance(lite, LiteLLMProvider)
    auto = build_model_provider(api_key="k", model="m", base_url="https://x.example.test/v1", timeout_seconds=5, protocol="auto")
    assert isinstance(auto, AutoNegotiatingModelProvider)
    assert all(isinstance(candidate, LiteLLMProvider) for _name, candidate in auto._providers)
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "something-else")
    assert model_backend() == "litellm"

def test_unknown_backend_value_warns_once_and_uses_litellm(monkeypatch, caplog):
    from app.models import factory

    monkeypatch.setattr(factory, "_warned", set())
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "LiteLLM-v2")
    with caplog.at_level("WARNING", logger="app.models.factory"):
        assert model_backend() == "litellm"
        assert model_backend() == "litellm"
    warnings = [record.getMessage() for record in caplog.records if "Unknown TUANTUAN_MODEL_BACKEND" in record.getMessage()]
    assert len(warnings) == 1 and "'LiteLLM-v2'" in warnings[0]
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", " Native ")
    assert model_backend() == "native"


def test_missing_litellm_falls_back_to_native(monkeypatch, caplog):
    from app.models import factory, litellm_core
    from app.models.openai_compatible import OpenAICompatibleProvider

    monkeypatch.setattr(factory, "_warned", set())
    monkeypatch.setattr(litellm_core, "litellm_available", lambda: False)
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "litellm")
    with caplog.at_level("WARNING", logger="app.models.factory"):
        assert model_backend() == "native"
        provider = build_model_provider(api_key="k", model="m", base_url="https://x.example.test/v1", timeout_seconds=5, protocol="openai")
    assert isinstance(provider, OpenAICompatibleProvider)
    assert sum("LiteLLM is not installed" in record.getMessage() for record in caplog.records) == 1


def test_building_a_provider_does_not_import_litellm():
    script = (
        "import os, sys; os.environ['TUANTUAN_MODEL_BACKEND']='litellm';"
        "from app.models.factory import build_model_provider;"
        "build_model_provider(api_key='k', model='m', base_url=None, timeout_seconds=5, protocol='auto');"
        "print('litellm' in sys.modules)"
    )
    result = subprocess.run([sys.executable, "-c", script], cwd=BACKEND, env={**os.environ, "PYTHONPATH": str(BACKEND)}, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-1500:]
    assert result.stdout.strip() == "False"


# ---------------------------------------------------------- capabilities and cost
def test_capability_defaults_come_from_local_map():
    data = capability_defaults("anthropic", "claude-sonnet-4-5")
    assert data["known"] is True
    assert data["capabilities"]["vision"] is True and data["capabilities"]["tools"] is True
    assert data["capabilities"]["reasoning"] is True
    assert data["max_input_tokens"] >= 200_000 and data["max_output_tokens"]
    # A gateway prefix like "openrouter/" style ids fall back to the last segment.
    assert capability_defaults("openai", "some-gateway/gpt-4o")["known"] is True
    assert capability_defaults("openai", "definitely-not-a-model")["known"] is False


def test_capability_priority_user_then_probe_then_litellm_then_heuristic():
    litellm_data = {"known": True, "capabilities": {"vision": False, "tools": True, "reasoning": None}, "max_input_tokens": 128000, "max_output_tokens": 8192}
    records = {"user": {"tools": {"status": "unsupported"}}, "probe": {"vision": {"status": "supported", "detail": "实测"}, "tools": {"status": "supported"}}}
    merged = merge_capabilities(model_name="deepseek-reasoner", litellm_data=litellm_data, records=records)
    caps = merged["capabilities"]
    assert caps["tools"]["status"] == "unsupported" and caps["tools"]["source"] == "user" and caps["tools"]["overridden"]
    assert caps["vision"]["status"] == "supported" and caps["vision"]["source"] == "probe"
    assert caps["vision"]["litellm_status"] == "unsupported"
    assert caps["reasoning"]["source"] == "heuristic" and caps["reasoning"]["status"] == "supported"
    assert caps["pdf"]["status"] == "unknown"
    assert merged["context_window"] == {"tokens": 128000, "source": "litellm"}
    assert merged["max_output_tokens"] == {"tokens": 8192, "source": "litellm"}
    assert merge_capabilities(model_name="x", litellm_data=litellm_data, records={}, context_limit=32000)["context_window"] == {"tokens": 32000, "source": "user"}


def test_cost_estimation_rules():
    assert estimate_cost_usd(None, protocol="ollama", model="qwen3", input_tokens=10, output_tokens=10) == 0.0
    assert estimate_cost_usd(None, protocol="openai", model="x", input_tokens=1_000_000, output_tokens=0, price_per_million_input=2.0) == pytest.approx(2.0)
    hidden = SimpleNamespace(_hidden_params={"response_cost": 0.5})
    assert estimate_cost_usd(hidden, protocol="openai", model="gpt-4o", input_tokens=1, output_tokens=1) == 0.5
    computed = estimate_cost_usd(None, protocol="openai", model="gpt-4o", input_tokens=1000, output_tokens=1000)
    assert computed and computed > 0
    assert estimate_cost_usd(None, protocol="openai", model="definitely-not-a-model", input_tokens=10, output_tokens=10) is None


# ---------------------------------------------------------- migration
# Real v27/v28 workspaces are upgraded in test_schema_fixtures.py.

# ---------------------------------------------------------- API
@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "litellm")
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "layer.db")
    monkeypatch.setattr(settings, "get_settings", lambda: SimpleNamespace(
        model_name="initial-model", model_base_url=None, model_protocol="auto", openai_api_key=None,
    ))
    monkeypatch.setattr(secret_store, "_MEMORY_SECRETS", {})
    init_db()
    authenticated = create_authenticated_client(app)
    yield authenticated
    authenticated.close()


def _profile(client, name, model_name, protocol="openai"):
    response = client.post("/agent/model-connections", json={
        "name": name, "model_base_url": f"https://{name}.example.test/v1", "model_protocol": protocol,
        "api_key": f"synthetic-{name}-key", "model_name": model_name,
    })
    assert response.status_code == 200, response.text
    catalog = response.json()
    connection = next(item for item in catalog["connections"] if item["name"] == name)
    return next(item for item in catalog["profiles"] if item["connection_id"] == connection["id"])


def test_model_layer_endpoint_reports_backend(client):
    body = client.get("/agent/model-layer").json()
    assert body["backend"] == "litellm"
    assert body["litellm_version"]
    assert body["offline_cost_map"] is True


def test_fallback_policy_api_round_trip_and_validation(client):
    primary = _profile(client, "primary", "gpt-4o")
    backup = _profile(client, "backup", "claude-sonnet-4-5", "anthropic")
    initial = client.get("/agent/model-fallbacks").json()
    assert initial["enabled"] is False and initial["revision"] == 0
    saved = client.put("/agent/model-fallbacks", json={
        "expected_revision": 0, "enabled": True, "fallback_profile_ids": [backup["id"]],
        "context_window_profile_ids": [backup["id"]], "retry_policy": {"timeout": 1, "rate_limit": 2, "server_error": 1},
        "allowed_fails": 2, "cooldown_seconds": 30,
    })
    assert saved.status_code == 200, saved.text
    policy = saved.json()
    assert policy["revision"] == 1 and policy["fallback_profile_ids"] == [backup["id"]]
    assert policy["retry_policy"] == {"timeout": 1, "rate_limit": 2, "server_error": 1}
    stale = client.put("/agent/model-fallbacks", json={"expected_revision": 0, "enabled": False})
    assert stale.status_code == 409
    unknown = client.put("/agent/model-fallbacks", json={"fallback_profile_ids": ["nope"]})
    assert unknown.status_code == 400
    too_many_retries = client.put("/agent/model-fallbacks", json={"retry_policy": {"timeout": 9}})
    assert too_many_retries.status_code == 422
    assert primary["id"] != backup["id"]


def test_capability_report_and_overrides(client):
    profile = _profile(client, "vision", "gpt-4o")
    report = client.get(f"/agent/model-profiles/{profile['id']}/capabilities").json()
    assert report["capabilities"]["vision"]["source"] == "litellm"
    assert report["capabilities"]["vision"]["label"] == "视觉"
    assert report["context_window"]["tokens"] >= 128000
    assert report["max_output_tokens"]["tokens"]
    overridden = client.put(f"/agent/model-profiles/{profile['id']}/capabilities", json={"overrides": {"vision": "unsupported", "pdf": "supported"}}).json()
    assert overridden["capabilities"]["vision"]["status"] == "unsupported" and overridden["capabilities"]["vision"]["source"] == "user"
    assert overridden["capabilities"]["pdf"]["status"] == "supported"
    cleared = client.put(f"/agent/model-profiles/{profile['id']}/capabilities", json={"overrides": {"vision": None}}).json()
    assert cleared["capabilities"]["vision"]["source"] == "litellm"
    bad = client.put(f"/agent/model-profiles/{profile['id']}/capabilities", json={"overrides": {"teleport": "supported"}})
    assert bad.status_code == 422


def test_runtime_uses_router_only_when_fallbacks_configured(client):
    from app.agent.bootstrap import get_agent_runtime, reload_agent_components
    from app.models.litellm_router import RoutedModelProvider

    primary = _profile(client, "primary", "gpt-4o")
    backup = _profile(client, "backup", "claude-sonnet-4-5", "anthropic")
    reload_agent_components()

    def model_of(runtime):
        model = runtime._models.get(runtime._model_provider)
        while hasattr(model, "_provider") and not isinstance(model, RoutedModelProvider):
            model = model._provider
        return model

    assert not isinstance(model_of(get_agent_runtime(primary["id"])), RoutedModelProvider)
    client.put("/agent/model-fallbacks", json={"enabled": True, "fallback_profile_ids": [backup["id"]]})
    routed = model_of(get_agent_runtime(primary["id"]))
    assert isinstance(routed, RoutedModelProvider)
    assert [target.profile_id for target in routed._fallbacks["general"]] == [backup["id"]]
    client.put("/agent/model-fallbacks", json={"enabled": False})
    assert not isinstance(model_of(get_agent_runtime(primary["id"])), RoutedModelProvider)
