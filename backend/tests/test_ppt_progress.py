"""Safe progress is a read-only view of committed files and the current call."""
import json

import pytest

from app import db
from app.execution.workspace_files import WorkspaceFiles
from app.presentations.manifest import ProjectManifestStore
from app.presentations.service import public_presentation
from test_ppt_manifest import running as manifest_running
from test_ppt_model_ledger import running
from test_ppt_production import plan


def public_job(repository, context, job):
    return public_presentation(repository.get(job["id"], context))


def test_no_progress_is_invented_from_requested_page_count(running):
    _, repository, context, job, _ = running
    assert public_job(repository, context, job)["progress"] == {
        "activity": None, "started_at": None, "pages_completed": 0,
        "pages_total": None, "outcome_uncertain": False,
    }


@pytest.mark.parametrize(("stage", "activity"), [
    ("stage1", "正在分析演示需求"),
    ("stage2", "正在规划内容与设计"),
    ("design_spec", "正在编写设计规格"),
    ("design_spec_audit", "正在核对设计规格"),
    ("spec_lock", "正在整理执行规范"),
    ("spec_lock_audit", "正在核对执行规范"),
    ("page.p03", "正在生成第 3 页"),
    ("page.p03.repair2", "正在修复第 3 页"),
    ("page.p03.quality1", "正在完善第 3 页"),
    ("speaker_notes", "正在编写逐页讲稿"),
    ("private.some-path", None),
    ("page.p99", None),
])
def test_only_current_whitelisted_model_activity_is_public(running, stage, activity):
    ledger, repository, context, job, _ = running
    request_id = ledger.reserve(job["id"], job["owner_token"], stage, context)
    with db.connect() as conn:
        conn.execute("UPDATE presentation_model_calls SET created_at='2026-11-05 01:02:03' WHERE id=?", (request_id,))
    progress = public_job(repository, context, job)["progress"]
    assert progress["activity"] == activity
    assert progress["started_at"] == ("2026-11-05 01:02:03" if activity else None)
    assert progress["outcome_uncertain"] is False
    # Projection never finishes, mutates or dispatches the reserved request.
    with db.connect() as conn:
        assert conn.execute("SELECT state FROM presentation_model_calls WHERE id=?", (request_id,)).fetchone()[0] == "reserved"


def test_request_id_cannot_project_another_jobs_activity(running):
    ledger, repository, context, job, _ = running
    request_id = ledger.reserve(job["id"], job["owner_token"], "design_spec", context)
    other = repository.enqueue("ppt.generate", {}, {}, context, "other-progress")
    other = repository.claim(context)
    repository.checkpoint(other["id"], other["owner_token"], {"model_request_id": request_id}, context)
    progress = public_job(repository, context, other)["progress"]
    assert progress["activity"] is progress["started_at"] is None


@pytest.mark.parametrize(("status", "outcome", "uncertain"), [
    ("running", "unknown", False), ("failed", "unknown", True),
    ("interrupted", "unknown", True), ("cancelled", "unknown", False),
    ("succeeded", "unknown", False), ("failed", None, False),
])
def test_unknown_outcome_only_warns_for_failed_or_interrupted_jobs(running, status, outcome, uncertain):
    ledger, repository, context, job, _ = running
    ledger.reserve(job["id"], job["owner_token"], "design_spec", context)
    record = repository.get(job["id"], context)
    record["status"] = status
    record["checkpoint"]["external_outcome"] = outcome
    progress = public_presentation(record)["progress"]
    assert progress["outcome_uncertain"] is uncertain
    if status != "running":
        assert progress["activity"] is progress["started_at"] is None


@pytest.mark.parametrize(("stage", "completed"), [
    ("page_4_ready", 4), ("pages_ready", 0), ("page_21_ready", 0),
    ("page_0_ready", 0), ("page_01_ready", 0), ("spec_ready", 0),
])
def test_legacy_progress_conservatively_uses_committed_page_stage(running, stage, completed):
    _, repository, context, job, _ = running
    repository.checkpoint(job["id"], job["owner_token"], {"production": {"stage": stage}}, context)
    record = repository.get(job["id"], context)
    record["status"] = "interrupted"
    progress = public_presentation(record)["progress"]
    assert progress["pages_completed"] == completed
    assert progress["pages_total"] is None


def test_production_commit_projects_only_hashed_page_files_and_validated_plan(manifest_running):
    original, repository, job, root, _ = manifest_running
    files = WorkspaceFiles(root)
    actual_plan = plan()
    actual_plan["slides"] = actual_plan["slides"][:3]
    files.write("production/plan.json", json.dumps(actual_plan).encode())
    files.write("svg_output/P01.svg", b"committed first page")
    files.write("svg_output/P02.svg", b"committed second page")
    files.write("svg_output/P03.svg", b"uncommitted candidate")
    files.write("candidates/P04.svg", b"rejected candidate")
    store = ProjectManifestStore(repository, job, original.context, root, namespace="production")
    store.commit("page_2_ready", ["production/plan.json", "svg_output/P01.svg", "svg_output/P02.svg", "candidates/P04.svg"])
    checkpoint = repository.get(job["id"], original.context)["checkpoint"]["production"]
    assert checkpoint["pages_completed"] == 2
    assert checkpoint["pages_total"] == 3
    record = repository.get(job["id"], original.context)
    record["status"] = "failed"
    assert public_presentation(record)["progress"]["pages_completed"] == 2
    assert public_presentation(record)["progress"]["pages_total"] == 3
    # Published state is a cheap projection; polling never opens project files.
    (root / "production/plan.json").unlink()
    assert public_presentation(record)["progress"]["pages_total"] == 3


def test_invalid_plan_never_becomes_public_total(manifest_running):
    original, repository, job, root, _ = manifest_running
    files = WorkspaceFiles(root)
    files.write("production/plan.json", b'{"slides":[{"id":"P01"}]}')
    store = ProjectManifestStore(repository, job, original.context, root, namespace="production")
    store.commit("spec_ready", ["production/plan.json"])
    progress = public_job(repository, original.context, job)["progress"]
    assert progress["pages_total"] is None
    assert progress["pages_completed"] == 0


def test_lost_lease_never_publishes_page_metadata(manifest_running, monkeypatch):
    original, repository, job, root, now = manifest_running
    files = WorkspaceFiles(root)
    files.write("svg_output/P01.svg", b"page")
    store = ProjectManifestStore(repository, job, original.context, root, namespace="production")
    write = store.files.write

    def lose_lease(*args, **kwargs):
        write(*args, **kwargs)
        now[0] += 31

    monkeypatch.setattr(store.files, "write", lose_lease)
    from app.jobs.repository import JobConflict
    with pytest.raises(JobConflict):
        store.commit("page_1_ready", ["svg_output/P01.svg"])
    assert "production" not in repository.get(job["id"], original.context)["checkpoint"]
