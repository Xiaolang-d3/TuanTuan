"""Confirmed receipts advance atomically; data on disk alone is not consent."""
import hashlib
import json
from types import SimpleNamespace

import pytest

from app import db
from app.execution.workspace_files import WorkspaceFiles
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict, JobRepository
from app.presentations.confirmation import ConfirmationFlow, project_root
from app.presentations.manifest import ProjectManifestStore
from app.presentations.receipts import canonical_sha256
from app.workspace import use_workspace


@pytest.fixture
def flow(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1, tmp_path / "account"):
        db.init_db()
        context = ExtensionContext.current()
        repository = JobRepository()
        repository.enqueue("ppt.generate", {}, {}, context, "flow")
        job = repository.claim(context)
        root = project_root(job)
        files = WorkspaceFiles(root)
        recommendation = {"stage": "stage1", "audience": {"value": ""}}
        files.write("confirm_ui/recommendations.stage1.json", json.dumps(recommendation).encode())
        ProjectManifestStore(repository, job, context, root).commit("stage1_recommended", ["confirm_ui/recommendations.stage1.json"])
        job = repository.wait_for_user(job["id"], job["owner_token"], "确认需求", {}, context)
        scope = SimpleNamespace(user_id=1, job_id=job["id"], stage_id=job["stage_id"], revision=job["revision"],
                                source_version=job["checkpoint"]["source_version"], manifest_sha256=job["checkpoint"]["manifest_sha256"])
        selection = {"schema_version": 1, "phase": "template", "status": "confirmed", "mode": "free_design",
                     "selections": [], "options_sha256": "a" * 64, "root_snapshots": [], "confirmed_at": "2026-11-03T00:00:00Z"}
        selection["selection_sha256"] = canonical_sha256({key: selection[key] for key in ("mode", "selections", "options_sha256", "root_snapshots")})
        result = {"stage": "stage1", "status": "stage1-confirmed", "audience": "", "stage1_sha256": canonical_sha256(recommendation),
                  "selection_sha256": selection["selection_sha256"]}
        files.write("confirm_ui/template_selection.json", json.dumps(selection).encode())
        files.write("confirm_ui/result.json", json.dumps(result).encode())
        yield SimpleNamespace(flow=ConfirmationFlow(repository), context=context, scope=scope, repository=repository,
                              files=files, job=job, root=root, result=result)


def test_files_without_authenticated_submission_cannot_queue(flow):
    p = flow
    with pytest.raises(JobConflict, match="可信"):
        p.flow.accept(p.scope, p.context)
    assert p.repository.get(p.job["id"], p.context)["status"] == "waiting_user"


def test_receipt_copies_and_manifest_committed_with_queue(flow):
    p = flow
    p.flow.reserve_submission(p.scope, p.context)
    job = p.flow.accept(p.scope, p.context)
    assert job["status"] == "queued" and job["stage_id"] is None
    assert job["checkpoint"]["stage"] == "stage1_confirmed"
    assert job["checkpoint"]["source_version"] == p.scope.source_version + 1
    manifest = ProjectManifestStore(p.repository, job, p.context, p.root).load()
    paths = job["confirmation"]["answer"]["receipt_paths"]
    assert all(name in manifest["files"] for name in paths)
    assert json.loads(p.files.read(paths[0]))["audience"] == ""
    # The official next stage can replace its working result without changing
    # the immutable prior user contract in the committed source set.
    p.files.write("confirm_ui/result.json", b'{}')
    ProjectManifestStore(p.repository, job, p.context, p.root).load()
    assert "audience" not in job["confirmation"]["answer"]
    assert len([event for event in p.repository.events(job["id"], p.context) if event["type"] == "confirmed"]) == 1
    with pytest.raises(JobConflict):
        p.flow.accept(p.scope, p.context)


def test_final_confirmation_keeps_both_immutable_contracts_and_never_delivers(flow):
    p = flow
    p.flow.reserve_submission(p.scope, p.context)
    stage1 = p.flow.accept(p.scope, p.context)
    original_paths = stage1["confirmation"]["answer"]["receipt_paths"]
    original_contracts = {name: p.files.read(name) for name in original_paths}
    claimed = p.repository.claim(p.context)
    stage2 = {"stage": "stage2", "selection_sha256": p.result["selection_sha256"]}
    p.files.write("confirm_ui/recommendations.stage2.json", json.dumps(stage2).encode())
    manifest = ProjectManifestStore(p.repository, claimed, p.context, p.root).load()
    ProjectManifestStore(p.repository, claimed, p.context, p.root).commit(
        "stage2_recommended", [*manifest["files"], "confirm_ui/recommendations.stage2.json"])
    waiting = p.repository.wait_for_user(claimed["id"], claimed["owner_token"], "确认制作参数", {}, p.context)
    scope = SimpleNamespace(user_id=p.context.user_id, job_id=waiting["id"], stage_id=waiting["stage_id"],
                            revision=waiting["revision"], source_version=waiting["checkpoint"]["source_version"],
                            manifest_sha256=waiting["checkpoint"]["manifest_sha256"])
    result = {**p.result, "stage": "final", "status": "confirmed", "page_count": "",
              "image_notes": "保持用户空白", "proactive_speaker_notes": True}
    p.files.write("confirm_ui/result.json", json.dumps(result).encode())
    # Files alone cannot advance the second gate either.
    with pytest.raises(JobConflict, match="可信"):
        p.flow.accept(scope, p.context)
    p.flow.reserve_submission(scope, p.context)
    final = p.flow.accept(scope, p.context)
    assert final["status"] == "queued" and final["result"] is None
    assert final["checkpoint"]["stage"] == "final_confirmed"
    assert "confirmation_submission" not in final["checkpoint"]
    binding = final["confirmation"]["answer"]
    assert binding["stage"] == "final" and binding["stage2_sha256"] == canonical_sha256(stage2)
    assert not {"page_count", "image_notes", "proactive_speaker_notes"} & binding.keys()
    assert binding["receipt_paths"] != original_paths
    assert json.loads(p.files.read(binding["receipt_paths"][0])) == result
    assert all(p.files.read(name) == content for name, content in original_contracts.items())
    final_manifest = ProjectManifestStore(p.repository, final, p.context, p.root).load()
    assert all(name in final_manifest["files"] for name in [*original_paths, *binding["receipt_paths"]])
    assert "succeeded" not in [event["type"] for event in p.repository.events(final["id"], p.context)]
    with pytest.raises(JobConflict):
        p.flow.accept(scope, p.context)


def test_reserved_or_unknown_submission_never_automatically_replayed(flow):
    p = flow
    p.flow.reserve_submission(p.scope, p.context)
    with pytest.raises(JobConflict, match="重复"):
        p.flow.reserve_submission(p.scope, p.context)
    assert p.repository.get(p.job["id"], p.context)["status"] == "waiting_user"


def test_cancellation_prevents_old_receipt_advancement(flow):
    p = flow
    p.flow.reserve_submission(p.scope, p.context)
    p.repository.cancel(p.job["id"], p.context)
    with pytest.raises(JobConflict):
        p.flow.accept(p.scope, p.context)
    assert p.repository.get(p.job["id"], p.context)["status"] == "cancelled"


def test_changed_source_or_receipt_cannot_advance(flow):
    p = flow
    p.flow.reserve_submission(p.scope, p.context)
    p.files.write("confirm_ui/recommendations.stage1.json", b'{}')
    with pytest.raises(ValueError):
        p.flow.accept(p.scope, p.context)
    assert p.repository.get(p.job["id"], p.context)["status"] == "waiting_user"


def test_cross_workspace_rejected_before_reading_receipts(flow, tmp_path):
    p = flow
    with use_workspace(2, tmp_path / "other"):
        db.init_db()
        with pytest.raises(PermissionError):
            p.flow.load(p.scope, ExtensionContext.current())


def test_cancel_between_candidate_write_and_transaction_never_queues(flow, monkeypatch):
    p = flow
    p.flow.reserve_submission(p.scope, p.context)
    original = WorkspaceFiles.write

    def cancel(files, name, content, **kwargs):
        original(files, name, content, **kwargs)
        if name.startswith("manifests/"):
            p.repository.cancel(p.job["id"], p.context)

    monkeypatch.setattr(WorkspaceFiles, "write", cancel)
    with pytest.raises(JobConflict):
        p.flow.accept(p.scope, p.context)
    job = p.repository.get(p.job["id"], p.context)
    assert job["status"] == "cancelled"
    assert job["checkpoint"]["manifest_sha256"] == p.scope.manifest_sha256


def test_invalid_receipt_stays_waiting_and_does_not_publish_confirmation(flow):
    p = flow
    p.flow.reserve_submission(p.scope, p.context)
    p.result["selection_sha256"] = "b" * 64
    p.files.write("confirm_ui/result.json", json.dumps(p.result).encode())
    with pytest.raises(JobConflict):
        p.flow.accept(p.scope, p.context)
    job = p.repository.get(p.job["id"], p.context)
    assert job["status"] == "waiting_user" and job["confirmation"] is None
