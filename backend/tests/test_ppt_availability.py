"""Product readiness must agree with creation without making a model call."""
from types import SimpleNamespace

import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict
from app.jobs.service import JobService
from app.presentations.contracts import PresentationRequest
from app.presentations.service import PresentationService, preparation_enabled, production_enabled
from app.workspace import use_workspace


@pytest.fixture
def ready(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    runtime = SimpleNamespace(digest="a" * 64, manifest={"files": {"host/render_preview.py": "b" * 64}}, verify=lambda: None)
    connection = {"profile_id": "p", "profile_revision": 1, "connection_id": "c", "connection_revision": 1,
                  "resolved_model_protocol": "openai", "api_key_configured": True, "api_key": "private-key"}
    service = PresentationService(JobService({"ppt.generate": object()}), runtime_loader=lambda: runtime,
                                  model_resolver=lambda: connection)
    with use_workspace(1, tmp_path / "account"):
        db.init_db()
        yield service, ExtensionContext.current(), runtime, connection


def test_local_generation_is_enabled_by_default_and_can_be_disabled(monkeypatch):
    assert preparation_enabled() and production_enabled()
    monkeypatch.setenv("TUANTUAN_PPT_GENERATION_ENABLED", "false")
    assert preparation_enabled() and not production_enabled()
    monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", "false")
    assert not preparation_enabled()


def test_ready_status_allows_real_job_creation_without_exposing_binding_or_credentials(ready):
    service, context, _, _ = ready
    status = service.capabilities(context)
    assert status["available"] is True and status["code"] == "ready"
    assert status["limits"]["max_pages"] == 20
    assert not any(value in str(status) for value in ("private-key", "api_key", "runtime_digest", "profile_id"))
    assert service.create(PresentationRequest(topic="季度汇报"), context, "new")["status"] == "queued"


@pytest.mark.parametrize("condition,code", [("hosted", "hosted_disabled"), ("disabled", "generation_disabled"),
    ("handler", "worker_unavailable"), ("missing", "runtime_missing"), ("invalid", "runtime_invalid"),
    ("old", "runtime_invalid"), ("model", "model_unavailable"), ("images", "model_unavailable"),
    ("protocol", "model_unavailable"), ("key", "model_unavailable")])
def test_readiness_reports_actionable_safe_failures_before_any_job(ready, monkeypatch, condition, code):
    service, context, runtime, connection = ready
    if condition == "hosted":
        monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    elif condition == "disabled":
        monkeypatch.setenv("TUANTUAN_PPT_GENERATION_ENABLED", "false")
    elif condition == "handler":
        service.jobs.handlers.clear()
    elif condition in {"missing", "invalid", "model"}:
        def fail():
            raise (FileNotFoundError if condition == "missing" else ValueError)("private-key /private/path")
        if condition == "model":
            service.model_resolver = fail
        else:
            service.runtime_loader = fail
    elif condition == "old":
        runtime.manifest["files"].clear()
    elif condition in {"images", "protocol"}:
        connection["resolved_model_protocol"] = "images" if condition == "images" else "unknown"
    else:
        connection["api_key_configured"] = False
    status = service.capabilities(context)
    assert status["available"] is False and status["code"] == code
    assert status["reason"] and "private-key" not in str(status) and "/private/path" not in str(status)
    assert service.jobs.repository.list(context) == []
    with pytest.raises(JobConflict):
        service.create(PresentationRequest(topic="汇报"), context, "blocked")
    assert service.jobs.repository.list(context) == []


def test_ollama_does_not_require_an_api_key(ready):
    service, context, _, connection = ready
    connection.update(resolved_model_protocol="ollama", api_key_configured=False)
    assert service.capabilities(context)["available"] is True


def test_missing_model_is_reported_without_hashing_a_large_runtime(ready):
    service, context, _, connection = ready
    calls = []
    service.runtime_loader = lambda: calls.append("loaded")
    connection.clear()
    assert service.capabilities(context)["code"] == "model_unavailable"
    assert calls == []
