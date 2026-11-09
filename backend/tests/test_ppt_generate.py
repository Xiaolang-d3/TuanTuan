"""Deterministic production preparation: real ledger/files, no network or receipts."""
import asyncio
import hashlib
import json
from types import SimpleNamespace

import pytest

from app import db
from app.domain import ModelResponse
from app.execution.contracts import ProcessResult
from app.execution.workspace_files import WorkspaceFiles
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict, JobRepository
from app.presentations.model_runner import PptModelRunner
from app.workspace import current_workspace_root, use_workspace


PROSE = ("audience", "communication_intent", "audience_outcome", "core_message",
         "delivery_context", "artifact_afterlife", "content_divergence")
REFERENCES = ("workflows/generate-pptx.md", "references/confirm-surface.md",
              "references/strategist.md", "references/plan-core.md", "references/canvas-formats.md")


def recommendation():
    return {"stage": "stage1", "lang": "zh", "primary_language": "zh-CN",
            "recommend": {"canvas": "ppt169"},
            **{key: {"value": "" if key == "content_divergence" else "中文建议"} for key in PROSE},
            "template_options": {"schema_version": 1, "phase": "template", "lang": "zh",
                                 "default_mode": "free_design", "explicit_workspace_roots": []}}


@pytest.fixture
def preparation(tmp_path, monkeypatch):
    from app.presentations.generation import GeneratePreparation
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    with use_workspace(1):
        db.init_db()
        context = ExtensionContext.current()
        now = [1000.0]
        repository = JobRepository(clock=lambda: now[0])
        selection = {"profile_id": "p", "profile_revision": 2, "connection_id": "c", "connection_revision": 3}
        repository.enqueue("ppt.generate", {"topic": "中文项目汇报"}, {"model_selection": selection}, context, "prepare")
        job = repository.claim(context)
        task = WorkspaceFiles(current_workspace_root() / "jobs" / job["id"])
        reads, commands, calls = [], [], []
        from app.presentations.generation import STAGE2_REFERENCES
        resources = {name: f"fixed authority: {name}".encode() for name in STAGE2_REFERENCES}
        vendor = WorkspaceFiles(tmp_path / "runtime")
        for name, content in resources.items():
            vendor.write(f"vendor/ppt-master/{name}", content)

        class Runtime:
            manifest = {"skill": "vendor/ppt-master", "files": {
                f"vendor/ppt-master/{name}": hashlib.sha256(content).hexdigest() for name, content in resources.items()}}

            def path(self, name):
                reads.append(name.removeprefix("vendor/ppt-master/"))
                return vendor.path(name)

        class Handle:
            files = task
            runtime = Runtime()

            async def run(self, command, args):
                commands.append((command, args))
                if command == "init":
                    task.path(args["project"]).mkdir(parents=True, exist_ok=True)
                return ProcessResult(0, "ok", "")

        output = [recommendation()]

        class Provider:
            async def generate(self, request):
                calls.append(request)
                return ModelResponse(content=json.dumps(output[0], ensure_ascii=False))

        handle = Handle()
        runner = PptModelRunner(repository, job, context, task.root, provider_factory=lambda bound: Provider())
        preparer = GeneratePreparation(repository, job, context, handle, runner)
        yield SimpleNamespace(preparer=preparer, repository=repository, job=job, context=context,
                              task=task, vendor=vendor, reads=reads, commands=commands, calls=calls,
                              output=output, now=now, monkeypatch=monkeypatch)


def test_generate_preserves_official_stage1_order_and_never_writes_receipts(preparation):
    p = preparation
    record = asyncio.run(p.preparer.prepare_stage1())
    assert [command for command, _ in p.commands] == ["init"]
    assert p.reads == list(REFERENCES)
    assert not any("index" in name or "templates/" in name for name in p.reads)
    assert len(p.calls) == 1
    request = p.calls[0]
    assert request.tools == []
    assert "中文项目汇报" in request.messages[1].content
    for reference in REFERENCES:
        assert f"fixed authority: {reference}" in request.messages[0].content
    manifest = p.preparer.manifests.load()
    assert manifest["stage"] == "stage1_recommended"
    assert manifest["source_version"] == record["source_version"] == 2
    assert p.preparer.files.read("confirm_ui/recommendations.stage1.json")
    assert not p.preparer.files.path("confirm_ui/result.json").exists()
    assert not p.preparer.files.path("confirm_ui/template_selection.json").exists()
    assert not p.preparer.files.path("confirm_ui/recommendations.stage2.json").exists()
    assert p.repository.get(p.job["id"], p.context)["status"] == "running"


def test_committed_stage1_resume_does_not_call_model_or_init_again(preparation):
    p = preparation
    first = asyncio.run(p.preparer.prepare_stage1())
    assert asyncio.run(p.preparer.prepare_stage1()) == first
    assert len(p.calls) == len(p.commands) == 1


def test_resume_rejects_changed_committed_source(preparation):
    p = preparation
    asyncio.run(p.preparer.prepare_stage1())
    p.preparer.files.write("request.json", b"{}")
    with pytest.raises(ValueError, match="校验"):
        asyncio.run(p.preparer.prepare_stage1())
    assert len(p.calls) == 1


@pytest.mark.parametrize("change", [
    lambda value: value.update(stage="stage2"),
    lambda value: value["recommend"].update(canvas="a4"),
    lambda value: value.update(primary_language="en-US"),
    lambda value: value.update(audience={"value": True}),
    lambda value: value.pop("core_message"),
    lambda value: value["template_options"].update(explicit_workspace_roots=["C:/outside"]),
    lambda value: value.update(result={"status": "confirmed"}),
])
def test_invalid_recommendations_never_commit_a_confirmation_stage(preparation, change):
    p = preparation
    change(p.output[0])
    with pytest.raises(ValueError):
        asyncio.run(p.preparer.prepare_stage1())
    assert p.preparer.manifests.load()["stage"] == "sources_ready"
    assert not p.preparer.files.path("confirm_ui/recommendations.stage1.json").exists()
    assert len(p.calls) == 1


def test_blank_prose_is_preserved_and_template_choice_is_not_fabricated(preparation):
    p = preparation
    for key in PROSE:
        p.output[0][key]["value"] = ""
    asyncio.run(p.preparer.prepare_stage1())
    retained = json.loads(p.preparer.files.read("confirm_ui/recommendations.stage1.json"))
    assert retained == p.output[0]


def test_new_stage1_recommendations_cannot_default_to_unimplemented_templates(preparation):
    p = preparation
    p.output[0]["template_options"]["default_mode"] = "templates"
    with pytest.raises(ValueError):
        asyncio.run(p.preparer.prepare_stage1())
    assert not p.preparer.files.path("confirm_ui/result.json").exists()


def test_changed_fixed_reference_rejected_before_model_dispatch(preparation):
    p = preparation
    p.vendor.write("vendor/ppt-master/references/plan-core.md", b"changed")
    with pytest.raises(ValueError, match="完整性"):
        asyncio.run(p.preparer.prepare_stage1())
    assert not p.calls


def test_stage2_reads_complete_reference_bundle_above_stage1_limit(preparation):
    from app.presentations.generation import STAGE1_REFERENCES, STAGE2_REFERENCES
    p = preparation
    confirmed_free_design(p)
    # The pinned bundle is 192573 bytes; Stage 1's 160 KB cap cannot serve Stage 2.
    for index, name in enumerate(STAGE2_REFERENCES):
        content = b"x" * (192573 - 14000 * (len(STAGE2_REFERENCES) - 1) if index == 0 else 14000)
        path = f"vendor/ppt-master/{name}"
        p.vendor.write(path, content)
        p.preparer.handle.runtime.manifest["files"][path] = hashlib.sha256(content).hexdigest()
    assert sum(p.vendor.path(f"vendor/ppt-master/{name}").stat().st_size for name in STAGE1_REFERENCES) < 160000
    asyncio.run(p.preparer.prepare_stage2())
    assert len(p.calls) == 2
    assert "## references/video-design.md" in p.calls[-1].messages[0].content
    assert p.preparer.manifests.load()["stage"] == "stage2_recommended"


@pytest.mark.parametrize("over_limit", ["references", "total_input"])
def test_stage2_context_limits_fail_without_dispatch_or_silent_truncation(preparation, over_limit):
    p = preparation
    confirmed_free_design(p)
    path = "vendor/ppt-master/references/video-design.md"
    content = b"x" * (200001 if over_limit == "references" else 195000)
    p.vendor.write(path, content)
    p.preparer.handle.runtime.manifest["files"][path] = hashlib.sha256(content).hexdigest()
    if over_limit == "total_input":
        p.preparer.request = p.preparer.request.model_copy(update={"topic": "中" * 18000})
    with pytest.raises(ValueError, match="限制|过大"):
        asyncio.run(p.preparer.prepare_stage2())
    assert len(p.calls) == 1
    assert p.preparer.manifests.load()["stage"] == "stage1_confirmed"
    assert not p.preparer.files.path("confirm_ui/recommendations.stage2.json").exists()


def test_failed_official_initialization_blocks_sources_and_model(preparation):
    p = preparation

    async def fail(*args):
        return ProcessResult(1, "", "official failure")

    p.preparer.handle.run = fail
    with pytest.raises(ValueError, match="初始化"):
        asyncio.run(p.preparer.prepare_stage1())
    assert not p.calls
    assert p.repository.get(p.job["id"], p.context)["checkpoint"] == {}


def test_completed_model_without_committed_recommendation_is_not_automatically_replayed(preparation):
    p = preparation
    from app.presentations.manifest import ProjectManifestStore
    original = ProjectManifestStore.commit

    def crash(store, stage, paths):
        if stage == "stage1_recommended":
            raise OSError("simulated crash before commit")
        return original(store, stage, paths)

    p.monkeypatch.setattr(ProjectManifestStore, "commit", crash)
    with pytest.raises(OSError):
        asyncio.run(p.preparer.prepare_stage1())
    p.monkeypatch.setattr(ProjectManifestStore, "commit", original)
    with pytest.raises(JobConflict, match="恢复"):
        asyncio.run(p.preparer.prepare_stage1())
    assert len(p.calls) == 1


def test_partial_initialization_is_not_overwritten_on_resume(preparation):
    p = preparation
    p.task.path(p.preparer.project).mkdir()
    with pytest.raises(JobConflict, match="恢复"):
        asyncio.run(p.preparer.prepare_stage1())
    assert not p.commands and not p.calls


def test_current_account_sources_are_read_before_recommendation(preparation):
    import app.presentations.generation as generation
    p = preparation
    attachment_id = "a" * 32
    # Replace the already validated request only to configure this fixture input.
    p.preparer.request = p.preparer.request.model_copy(update={"attachment_ids": [attachment_id]})

    def stage(ids, root, context):
        assert ids == [attachment_id] and context == p.context
        assert [command for command, _ in p.commands] == ["init"]
        content = "附件中的实际来源文字".encode()
        WorkspaceFiles(root).write(f"sources/{attachment_id}.md", content)
        return [{"attachment_id": attachment_id, "kind": "document", "path": f"sources/{attachment_id}.md",
                 "sha256": hashlib.sha256(content).hexdigest(), "size_bytes": len(content)}]

    p.monkeypatch.setattr(generation, "stage_sources", stage)
    asyncio.run(p.preparer.prepare_stage1())
    assert "附件中的实际来源文字" in p.calls[0].messages[1].content
    assert f"sources/{attachment_id}.md" in p.preparer.manifests.load()["files"]


def test_unknown_model_outcome_is_not_replayed_or_overwritten(preparation):
    p = preparation
    p.preparer.runner.ledger.reserve(p.job["id"], p.job["owner_token"], "stage1", p.context)
    with pytest.raises(JobConflict, match="恢复"):
        asyncio.run(p.preparer.prepare_stage1())
    checkpoint = p.repository.get(p.job["id"], p.context)["checkpoint"]
    assert checkpoint["external_outcome"] == "unknown"
    assert not p.commands and not p.calls


def confirmed_free_design(p):
    from app.presentations.confirmation import ConfirmationFlow
    from app.presentations.generation import GeneratePreparation
    from app.presentations.receipts import canonical_sha256
    from test_ppt_stage2_contracts import stage2
    asyncio.run(p.preparer.prepare_stage1())
    waiting = p.repository.wait_for_user(p.job["id"], p.job["owner_token"], "需求确认", {}, p.context)
    scope = SimpleNamespace(user_id=p.context.user_id, job_id=waiting["id"], stage_id=waiting["stage_id"],
                            revision=waiting["revision"], source_version=waiting["checkpoint"]["source_version"],
                            manifest_sha256=waiting["checkpoint"]["manifest_sha256"])
    selection = {"schema_version": 1, "phase": "template", "status": "confirmed", "mode": "free_design",
                 "selections": [], "options_sha256": "a" * 64, "root_snapshots": [], "confirmed_at": "2026-11-03T00:00:00Z"}
    selection["selection_sha256"] = canonical_sha256({key: selection[key] for key in ("mode", "selections", "options_sha256", "root_snapshots")})
    contract = {"stage": "stage1", "status": "stage1-confirmed", **{key: "" for key in PROSE},
                "stage1_sha256": canonical_sha256(p.output[0]), "selection_sha256": selection["selection_sha256"]}
    # Fixture represents a real prior user POST. Production never authors these.
    p.preparer.files.write("confirm_ui/result.json", json.dumps(contract).encode())
    p.preparer.files.write("confirm_ui/template_selection.json", json.dumps(selection).encode())
    p.monkeypatch.setattr("app.presentations.confirmation.project_root", lambda job: p.preparer.root)
    flow = ConfirmationFlow(p.repository)
    flow.reserve_submission(scope, p.context)
    flow.accept(scope, p.context)
    job = p.repository.claim(p.context)
    runner = PptModelRunner(p.repository, job, p.context, p.task.root,
                            provider_factory=p.preparer.runner.provider_factory)
    p.preparer = GeneratePreparation(p.repository, job, p.context, p.preparer.handle, runner)
    p.job = job
    p.output[0] = stage2()
    p.output[0]["selection_sha256"] = selection["selection_sha256"]
    return contract


def test_stage2_uses_only_trusted_confirmed_contract_without_restoring_blanks(preparation):
    from app.presentations.generation import STAGE2_REFERENCES
    p = preparation
    contract = confirmed_free_design(p)
    before = {name: p.preparer.files.read(f"confirm_ui/{name}") for name in (
        "result.json", "template_selection.json", "recommendations.stage1.json")}
    p.reads.clear()
    record = asyncio.run(p.preparer.prepare_stage2())
    assert len(p.calls) == 2
    assert p.reads == list(STAGE2_REFERENCES)
    inputs = json.loads(p.calls[-1].messages[1].content)
    assert inputs["stage1_contract"] == contract
    assert all(inputs["stage1_contract"][key] == "" for key in PROSE)
    assert "notes=true" in p.calls[-1].messages[0].content
    assert [command for command, _ in p.commands] == ["init"]
    manifest = p.preparer.manifests.load()
    assert manifest["stage"] == "stage2_recommended"
    assert all(p.preparer.files.read(f"confirm_ui/{name}") == content for name, content in before.items())
    assert asyncio.run(p.preparer.prepare_stage2()) == record
    assert len(p.calls) == 2
    assert p.repository.get(p.job["id"], p.context)["status"] == "running"


@pytest.mark.parametrize("role", ["heading", "body"])
@pytest.mark.parametrize("invalid_css", [None, "", " \t\n", "missing"])
def test_stage2_invalid_font_css_never_commits_or_replays(preparation, role, invalid_css):
    p = preparation
    confirmed_free_design(p)
    font = p.output[0]["design_directions"]["candidates"][0]["typography"][role]
    if invalid_css == "missing":
        font.pop("css")
    else:
        font["css"] = invalid_css
    before = {name: p.preparer.files.read(f"confirm_ui/{name}") for name in (
        "result.json", "template_selection.json", "recommendations.stage1.json")}
    with pytest.raises(ValueError):
        asyncio.run(p.preparer.prepare_stage2())
    assert p.preparer.manifests.load()["stage"] == "stage1_confirmed"
    assert not p.preparer.files.path("confirm_ui/recommendations.stage2.json").exists()
    assert all(p.preparer.files.read(f"confirm_ui/{name}") == content for name, content in before.items())
    assert len(p.calls) == 2
    with pytest.raises(JobConflict, match="恢复"):
        asyncio.run(p.preparer.prepare_stage2())
    assert len(p.calls) == 2


def test_stage2_cannot_skip_stage1_user_confirmation(preparation):
    p = preparation
    asyncio.run(p.preparer.prepare_stage1())
    with pytest.raises(JobConflict, match="真实"):
        asyncio.run(p.preparer.prepare_stage2())
    assert len(p.calls) == 1


@pytest.mark.parametrize("change", ["working_receipt", "immutable_receipt", "selection_binding", "provided_without_image", "missing_reference"])
def test_stage2_rejects_changed_or_incomplete_bound_inputs(preparation, change):
    p = preparation
    confirmed_free_design(p)
    if change == "working_receipt":
        p.preparer.files.write("confirm_ui/result.json", b'{}')
    elif change == "immutable_receipt":
        job = p.repository.get(p.job["id"], p.context)
        p.preparer.files.write(job["confirmation"]["answer"]["receipt_paths"][0], b'{}')
    elif change == "selection_binding":
        p.output[0]["selection_sha256"] = "b" * 64
    elif change == "provided_without_image":
        p.output[0]["recommend"]["image_usage"] = ["provided"]
    else:
        p.vendor.write("vendor/ppt-master/references/strategist-image.md", b'changed')
    with pytest.raises((JobConflict, ValueError)):
        asyncio.run(p.preparer.prepare_stage2())
    if change != "immutable_receipt":
        assert p.preparer.manifests.load()["stage"] == "stage1_confirmed"
    assert not p.preparer.files.path("confirm_ui/recommendations.stage2.json").exists()
    assert len(p.calls) == (2 if change in {"selection_binding", "provided_without_image"} else 1)


def test_stage2_completed_uncommitted_response_is_not_billed_again(preparation):
    from app.presentations.manifest import ProjectManifestStore
    p = preparation
    confirmed_free_design(p)
    original = ProjectManifestStore.commit

    def crash(store, stage, paths):
        if stage == "stage2_recommended":
            raise OSError("simulated crash")
        return original(store, stage, paths)

    p.monkeypatch.setattr(ProjectManifestStore, "commit", crash)
    with pytest.raises(OSError):
        asyncio.run(p.preparer.prepare_stage2())
    p.monkeypatch.setattr(ProjectManifestStore, "commit", original)
    with pytest.raises(JobConflict, match="恢复"):
        asyncio.run(p.preparer.prepare_stage2())
    assert len(p.calls) == 2
    assert p.preparer.manifests.load()["stage"] == "stage1_confirmed"


def test_expired_attempt_cannot_initialize_or_call_model(preparation):
    p = preparation
    p.now[0] += 31
    with pytest.raises(JobConflict):
        asyncio.run(p.preparer.prepare_stage1())
    assert not p.commands and not p.calls
