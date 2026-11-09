"""Real worker/ledger/confirmation orchestration with no vendor or model execution."""
import asyncio
import hashlib
import json
from types import SimpleNamespace

import pytest

from app import db
from app.execution.builtin_runtime import UPSTREAM_COMMIT
from app.execution.contracts import ProcessResult
from app.execution.workspace_files import WorkspaceFiles
from app.extensions.contracts import ExtensionContext
from app.extensions.runtime_snapshot import ExtensionRunSnapshot
from app.jobs.repository import JobConflict
from app.jobs.service import JobService
from app.jobs.worker import JobControl, JobWorker
from app.presentations.confirmation import ConfirmationFlow, project_root
from app.presentations.model_runner import PptModelRunner
from app.presentations.receipts import canonical_sha256
from app.workspace import current_workspace_root, use_workspace
from test_ppt_generate import PROSE, recommendation
from test_ppt_stage2_contracts import stage2


@pytest.fixture
def pipeline(tmp_path, monkeypatch):
    from app.presentations import worker
    from app.presentations.generation import STAGE2_REFERENCES
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "local")
    monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", "true")
    monkeypatch.setenv("TUANTUAN_PPT_GENERATION_ENABLED", "false")
    with use_workspace(1, tmp_path / "account"):
        db.init_db()
        context = ExtensionContext.current()
        jobs = JobService(clock=lambda: 1000.0)
        worker.register_preparation_handler(jobs)
        resources = WorkspaceFiles(tmp_path / "fake-runtime")
        hashes = {}
        for name in STAGE2_REFERENCES:
            path = f"vendor/ppt-master/{name}"
            content = f"fixed test reference: {name}".encode()
            resources.write(path, content)
            hashes[path] = hashlib.sha256(content).hexdigest()
        runtime = SimpleNamespace(digest="a" * 64, manifest={"skill": "vendor/ppt-master", "files": hashes},
                                  path=resources.path)
        state = SimpleNamespace(jobs=jobs, context=context, calls=[], handles=[], output=recommendation(),
                                on_generate=None)

        class Handle:
            def __init__(self, job_id):
                self.files = WorkspaceFiles(current_workspace_root() / "jobs" / job_id)
                self.runtime = runtime
                self.commands = []
                self.stopped = False

            async def run(self, command, args):
                self.commands.append(command)
                assert command == "init"
                self.files.path(args["project"]).mkdir()
                return ProcessResult(0, "ok", "")

            async def stop(self):
                self.stopped = True

        async def prepare(backend, account, job_id, **kwargs):
            assert account == context and kwargs["runtime_digest"] == runtime.digest
            kwargs["fence"]()
            handle = Handle(job_id)
            state.handles.append(handle)
            return handle

        class Provider:
            async def generate(self, request):
                from app.domain import ModelResponse
                state.calls.append(request)
                if state.on_generate:
                    state.on_generate()
                return ModelResponse(content=json.dumps(state.output, ensure_ascii=False))

        monkeypatch.setattr("app.execution.local_builtin.LocalBuiltinBackend.prepare", prepare)
        monkeypatch.setattr(worker, "PptModelRunner", lambda *args: PptModelRunner(
            *args, provider_factory=lambda selection: Provider()))
        snapshot = ExtensionRunSnapshot(
            version=2, user_id=context.user_id, grants=("builtin.ppt-master.execute",),
            model_selection={"profile_id": "p", "profile_revision": 1, "connection_id": "c", "connection_revision": 1},
            execution={"backend": "local_builtin", "adapter": "ppt-master", "runtime_digest": runtime.digest,
                       "upstream_commit": UPSTREAM_COMMIT},
        )
        state.job = jobs.repository.enqueue("ppt.generate", {"topic": "季度项目复盘"},
                                            snapshot.model_dump(mode="json"), context, "prepare")
        yield state


def run_worker(p):
    return asyncio.run(JobWorker(p.jobs).run_once(p.context.user_id, current_workspace_root()))


def test_model_authentication_failure_keeps_code_and_stops_without_replay(pipeline):
    from app.models.base import ModelProviderError
    from app.presentations.service import public_presentation
    p = pipeline

    def denied():
        raise ModelProviderError("authentication_failed", "模型服务认证失败，请检查 API Key")

    p.on_generate = denied
    result = run_worker(p)
    assert result["status"] == "failed"
    assert result["checkpoint"]["model_error_code"] == "authentication_failed"
    assert result["checkpoint"]["external_outcome"] == "unknown"
    assert public_presentation(result)["error_code"] == "authentication_failed"
    assert len(p.calls) == 1 and p.handles[0].stopped
    assert run_worker(p) is None


@pytest.mark.parametrize("diagnostic_error", [JobConflict, ValueError])
def test_optional_error_diagnostics_do_not_prevent_releasing_a_failed_job(pipeline, monkeypatch, diagnostic_error):
    from app.models.base import ModelProviderError
    p = pipeline
    original = p.jobs.repository.checkpoint

    def checkpoint(job_id, token, value, context):
        if "model_error_code" in value:
            raise diagnostic_error("optional checkpoint cannot be written")
        return original(job_id, token, value, context)

    monkeypatch.setattr(p.jobs.repository, "checkpoint", checkpoint)

    def denied():
        raise ModelProviderError("authentication_failed", "模型服务认证失败")

    p.on_generate = denied
    assert run_worker(p)["status"] == "failed"


def confirm_stage1(p):
    """Test-only authenticated prior POST; never used by production orchestration."""
    waiting = p.jobs.get(p.job["id"], p.context)
    assert waiting["status"] == "waiting_user"
    scope = SimpleNamespace(user_id=p.context.user_id, job_id=waiting["id"], stage_id=waiting["stage_id"],
                            revision=waiting["revision"], source_version=waiting["checkpoint"]["source_version"],
                            manifest_sha256=waiting["checkpoint"]["manifest_sha256"])
    files = WorkspaceFiles(project_root(waiting))
    selection = {"schema_version": 1, "phase": "template", "status": "confirmed", "mode": "free_design",
                 "selections": [], "options_sha256": "a" * 64, "root_snapshots": [],
                 "confirmed_at": "2026-11-03T00:00:00Z"}
    selection["selection_sha256"] = canonical_sha256({key: selection[key] for key in (
        "mode", "selections", "options_sha256", "root_snapshots")})
    result = {"stage": "stage1", "status": "stage1-confirmed", **{key: "" for key in PROSE},
              "stage1_sha256": canonical_sha256(p.output), "selection_sha256": selection["selection_sha256"]}
    files.write("confirm_ui/result.json", json.dumps(result).encode())
    files.write("confirm_ui/template_selection.json", json.dumps(selection).encode())
    flow = ConfirmationFlow(p.jobs.repository)
    flow.reserve_submission(scope, p.context)
    confirmed = flow.accept(scope, p.context)
    p.output = stage2()
    p.output["selection_sha256"] = selection["selection_sha256"]
    return confirmed


def test_worker_stops_at_each_real_confirmation_and_never_succeeds(pipeline):
    from app.presentations.model_ledger import ModelCallLedger
    from app.presentations.service import public_presentation
    p = pipeline
    first = run_worker(p)
    assert first["status"] == "waiting_user" and first["checkpoint"]["stage"] == "stage1_recommended"
    assert first["result"] is None and first["confirmation"] is None
    assert first["execution"]["stopped"] and p.handles[0].stopped
    assert len(p.calls) == 1 and p.handles[0].commands == ["init"]
    files = WorkspaceFiles(project_root(first))
    assert not files.path("confirm_ui/result.json").exists()
    assert run_worker(p) is None
    with pytest.raises(JobConflict, match="真实确认"):
        p.jobs.confirm(first["id"], first["stage_id"], first["revision"], {}, p.context)
    confirmed = confirm_stage1(p)
    immutable = {name: files.read(name) for name in confirmed["confirmation"]["answer"]["receipt_paths"]}
    second = run_worker(p)
    assert second["status"] == "waiting_user" and second["checkpoint"]["stage"] == "stage2_recommended"
    assert second["stage_id"] != first["stage_id"] and second["result"] is None
    assert second["execution"]["stopped"] and all(handle.stopped for handle in p.handles)
    assert len(p.calls) == 2 and p.handles[1].commands == []
    assert all(files.read(name) == content for name, content in immutable.items())
    assert public_presentation(second)["generation_available"] is False
    assert "succeeded" not in [event["type"] for event in p.jobs.events(first["id"], p.context)]
    with db.connect() as conn:
        assert conn.execute("SELECT active_started FROM presentation_job_budgets WHERE job_id=?",
                            (first["id"],)).fetchone()[0] is None
    assert ModelCallLedger(p.jobs.repository).status(first["id"], p.context)["calls_used"] == 2


@pytest.mark.parametrize("stage", ["stage1", "stage2"])
def test_interruption_after_recommendation_recovers_without_another_model_call(pipeline, monkeypatch, stage):
    p = pipeline
    if stage == "stage2":
        run_worker(p)
        confirm_stage1(p)
    original = JobControl.wait_for_user

    async def interrupt(control, *args, **kwargs):
        raise asyncio.CancelledError()

    monkeypatch.setattr(JobControl, "wait_for_user", interrupt)
    interrupted = run_worker(p)
    assert interrupted["status"] == "interrupted"
    assert interrupted["checkpoint"]["stage"] == f"{stage}_recommended"
    calls = len(p.calls)
    monkeypatch.setattr(JobControl, "wait_for_user", original)
    p.jobs.repository.resume(interrupted["id"], p.context)
    resumed = run_worker(p)
    assert resumed["status"] == "waiting_user" and resumed["checkpoint"]["stage"] == f"{stage}_recommended"
    assert len(p.calls) == calls
    assert all(handle.stopped for handle in p.handles)


@pytest.mark.parametrize("restriction", ["disabled", "hosted", "legacy", "unknown", "reserved", "final"])
def test_unavailable_or_unsafe_preparation_never_starts_execution(pipeline, monkeypatch, restriction):
    p = pipeline
    if restriction == "disabled":
        monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", "false")
    elif restriction == "hosted":
        monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    elif restriction == "legacy":
        with db.connect() as conn:
            conn.execute("UPDATE background_jobs SET snapshot_json=? WHERE id=?",
                         (json.dumps({"version": 1, "user_id": p.context.user_id}), p.job["id"]))
    else:
        claimed = p.jobs.repository.claim(p.context)
        checkpoint = {"unknown": {"external_outcome": "unknown"},
                      "reserved": {"confirmation_submission": {"status": "reserved"}},
                      "final": {"stage": "final_confirmed"}}[restriction]
        p.jobs.repository.checkpoint(claimed["id"], claimed["owner_token"], checkpoint, p.context)
        p.jobs.repository.release(claimed["id"], claimed["owner_token"], "interrupted", "test", p.context)
        # Simulate persisted queued input; public resume correctly rejects unknown.
        with db.connect() as conn:
            conn.execute("UPDATE background_jobs SET status='queued' WHERE id=?", (claimed["id"],))
    result = run_worker(p)
    assert result["status"] == "failed" and result["result"] is None
    assert not p.calls and not p.handles


def test_cancellation_before_response_persistence_never_publishes_recommendation(pipeline):
    p = pipeline
    p.on_generate = lambda: p.jobs.cancel(p.job["id"], p.context)
    result = run_worker(p)
    assert result["status"] == "cancelled" and result["result"] is None
    assert result["checkpoint"]["stage"] == "sources_ready"
    assert result["checkpoint"]["external_outcome"] == "unknown"
    assert all(handle.stopped for handle in p.handles)
    assert not WorkspaceFiles(project_root(result)).path("confirm_ui/recommendations.stage1.json").exists()


@pytest.mark.parametrize("deployment,enabled", [("local", "false"), ("hosted", "true")])
def test_registration_requires_explicit_local_preparation_opt_in(monkeypatch, deployment, enabled):
    from app.presentations.worker import register_preparation_handler
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", deployment)
    monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", enabled)
    jobs = JobService()
    assert register_preparation_handler(jobs) is False and jobs.handlers == {}


def test_registration_is_idempotent_but_never_replaces_another_adapter(monkeypatch):
    from app.presentations.worker import register_preparation_handler
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "local")
    monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", "true")
    jobs = JobService()
    assert register_preparation_handler(jobs) is True
    handler = jobs.handlers["ppt.generate"]
    assert register_preparation_handler(jobs) is True and jobs.handlers["ppt.generate"] is handler
    other = object()
    jobs.handlers["ppt.generate"] = other
    with pytest.raises(JobConflict, match="适配器"):
        register_preparation_handler(jobs)
    assert jobs.handlers["ppt.generate"] is other


def test_final_production_requires_local_preparation_and_its_own_opt_in(monkeypatch):
    from app.presentations.worker import production_enabled
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "local")
    monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", "false")
    monkeypatch.setenv("TUANTUAN_PPT_GENERATION_ENABLED", "true")
    assert production_enabled() is False
    monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", "true")
    assert production_enabled() is True
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    assert production_enabled() is False
