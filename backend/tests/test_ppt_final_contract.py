"""Retain authenticated final values, never infer consent from working files."""
import asyncio
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict
from app.presentations.confirmation import ConfirmationFlow
from app.presentations.manifest import ProjectManifestStore
from app.workspace import use_workspace
from test_ppt_generate import confirmed_free_design, preparation


@pytest.fixture
def finalized(preparation):
    p = preparation
    stage1 = confirmed_free_design(p)
    asyncio.run(p.preparer.prepare_stage2())
    waiting = p.repository.wait_for_user(p.job["id"], p.job["owner_token"], "确认制作参数", {}, p.context)
    scope = SimpleNamespace(user_id=p.context.user_id, job_id=waiting["id"], stage_id=waiting["stage_id"],
                            revision=waiting["revision"], source_version=waiting["checkpoint"]["source_version"],
                            manifest_sha256=waiting["checkpoint"]["manifest_sha256"])
    result = {**stage1, "stage": "final", "status": "confirmed", "canvas": "ppt169", "primary_language": "zh-CN",
              "page_count": "", "image_notes": "  ", "generation_mode": "continuous", "refine_spec": False,
              "design_spec_depth": "brief", "proactive_speaker_notes": True,
              "proactive_custom_animations": False, "proactive_narration_audio": False,
              "image_usage": ["none"],
              "typography": {"body_size": 19.5, "sizes": {"title": 37, "subtitle": 25.5, "annotation": 12},
                             "heading": {"primary": "用户标题字体", "english": "User Heading", "css": "user-heading"},
                             "body": {"primary": "用户正文字体", "english": "User Body", "css": "user-body"}},
              "user_extension": {"literal": "保留用户非常规字段，不恢复推荐"}}
    # Test-only prior user submission; production must never author these files.
    p.preparer.files.write("confirm_ui/result.json", json.dumps(result, ensure_ascii=False).encode())
    flow = ConfirmationFlow(p.repository)
    flow.reserve_submission(scope, p.context)
    final = flow.accept(scope, p.context)
    p.job = p.repository.claim(p.context)
    yield SimpleNamespace(p=p, final=final, stage1=stage1, result=result)


def load(state):
    from app.presentations.final_contract import load_final_contract
    return load_final_contract(state.p.repository, state.p.job, state.p.context)


def test_final_contract_retains_all_user_values_and_ignores_working_receipts(finalized):
    s, p = finalized, finalized.p
    before = deepcopy(p.repository.get(p.job["id"], p.context))
    # Neither a stale nor a malicious mutable working receipt is authority.
    p.preparer.files.write("confirm_ui/result.json", b'{"page_count":"999"}')
    p.preparer.files.write("confirm_ui/template_selection.json", b'{}')
    retained = load(s)
    assert retained.final == s.result and retained.stage1 == s.stage1
    assert retained.final["page_count"] == "" and retained.final["image_notes"] == "  "
    assert retained.final["proactive_speaker_notes"] is True
    assert retained.final["typography"]["body_size"] == 19.5
    assert retained.final["typography"]["heading"]["css"] == "user-heading"
    assert retained.final["image_usage"] == ["none"]
    assert retained.selection["mode"] == "free_design"
    assert retained.stage2_recommendation == p.output[0]
    assert retained.source_version == before["checkpoint"]["source_version"]
    assert retained.manifest_sha256 == before["checkpoint"]["manifest_sha256"]
    assert p.repository.get(p.job["id"], p.context) == before
    assert len(p.calls) == 2
    assert not p.preparer.files.path("design_spec.md").exists()
    assert not p.preparer.files.path("spec_lock.md").exists()


@pytest.mark.parametrize("path", ["final_result", "final_selection", "stage1_result", "stage1_selection", "stage1_rec", "stage2_rec"])
def test_modified_committed_contract_sources_are_rejected(finalized, path):
    s, p = finalized, finalized.p
    with db.connect() as conn:
        events = [json.loads(row[0]) for row in conn.execute(
            "SELECT data_json FROM background_job_events WHERE job_id=? AND type='confirmed' ORDER BY cursor", (p.job["id"],))]
    paths = {"final_result": events[1]["answer"]["receipt_paths"][0],
             "final_selection": events[1]["answer"]["receipt_paths"][1],
             "stage1_result": events[0]["answer"]["receipt_paths"][0],
             "stage1_selection": events[0]["answer"]["receipt_paths"][1],
             "stage1_rec": "confirm_ui/recommendations.stage1.json", "stage2_rec": "confirm_ui/recommendations.stage2.json"}
    p.preparer.files.write(paths[path], b'{}')
    with pytest.raises(ValueError):
        load(s)
    assert len(p.calls) == 2


@pytest.mark.parametrize("field", ["stage", "status", "manifest_sha256", "source_version", "result_sha256",
                                   "selection_receipt_sha256", "selection_sha256", "stage1_sha256", "stage2_sha256", "receipt_paths"])
def test_final_binding_cannot_be_changed_independently_of_authenticated_event(finalized, field):
    s, p = finalized, finalized.p
    binding = deepcopy(p.job["confirmation"])
    binding["answer"][field] = [] if field == "receipt_paths" else "changed"
    with db.connect() as conn:
        conn.execute("UPDATE background_jobs SET confirmation_json=? WHERE id=?", (json.dumps(binding), p.job["id"]))
    with pytest.raises(JobConflict):
        load(s)


@pytest.mark.parametrize("change", ["missing_stage1", "missing_final", "duplicate_stage1", "different_selection", "different_result", "invalid_event"])
def test_both_authenticated_confirmation_events_are_required(finalized, change):
    s, p = finalized, finalized.p
    with db.connect() as conn:
        rows = conn.execute("SELECT cursor,data_json FROM background_job_events WHERE job_id=? AND type='confirmed' ORDER BY cursor", (p.job["id"],)).fetchall()
        if change in {"missing_stage1", "missing_final"}:
            conn.execute("DELETE FROM background_job_events WHERE cursor=?", (rows[0 if change == "missing_stage1" else 1][0],))
        elif change == "duplicate_stage1":
            conn.execute("INSERT INTO background_job_events(job_id,type,data_json) VALUES(?,'confirmed',?)", (p.job["id"], rows[0][1]))
        else:
            event = json.loads(rows[0][1])
            if change == "invalid_event":
                event = ["not a binding"]
            else:
                event["answer"]["selection_sha256" if change == "different_selection" else "result_sha256"] = "b" * 64
            conn.execute("UPDATE background_job_events SET data_json=? WHERE cursor=?", (json.dumps(event), rows[0][0]))
    with pytest.raises(JobConflict):
        load(s)


@pytest.mark.parametrize("fence", ["expired", "cancelled", "unknown", "submission", "wrong_stage", "wrong_attempt", "model_request"])
def test_final_contract_requires_live_unblocked_owner(finalized, fence):
    s, p = finalized, finalized.p
    if fence == "expired":
        p.now[0] += 31
    elif fence == "cancelled":
        p.repository.cancel(p.job["id"], p.context)
    elif fence == "wrong_attempt":
        p.job = {**p.job, "owner_token": "stale"}
    else:
        checkpoint = dict(p.job["checkpoint"])
        checkpoint.update({
            "unknown": {"external_outcome": "unknown"},
            "submission": {"confirmation_submission": {"status": "reserved"}},
            "model_request": {"model_request_id": "unreconciled"},
            "wrong_stage": {"stage": "stage2_recommended"},
        }[fence])
        p.repository.checkpoint(p.job["id"], p.job["owner_token"], checkpoint, p.context)
    with pytest.raises(JobConflict):
        load(s)
    assert len(p.calls) == 2


@pytest.mark.parametrize("change", ["stage_id", "revision", "missing_hash", "wrong_hash_type", "extra_field", "wrong_paths",
                                    "same_stage", "reversed_revision", "same_source_version", "checkpoint_digest"])
def test_matching_final_event_and_current_binding_still_require_valid_version_chain(finalized, change):
    s, p = finalized, finalized.p
    with db.connect() as conn:
        rows = conn.execute("SELECT cursor,data_json FROM background_job_events WHERE job_id=? AND type='confirmed' ORDER BY cursor", (p.job["id"],)).fetchall()
        first, event = [json.loads(row[1]) for row in rows]
        if change == "stage_id":
            event["stage_id"] = "../untrusted"
        elif change == "revision":
            event["revision"] = True
        elif change == "missing_hash":
            event["answer"].pop("stage2_sha256")
        elif change == "wrong_hash_type":
            event["answer"]["result_sha256"] = []
        elif change == "extra_field":
            event["answer"]["user_content"] = "must not be in host binding"
        elif change == "wrong_paths":
            event["answer"]["receipt_paths"] = ["confirm_ui/result.json", "confirm_ui/template_selection.json"]
        elif change == "same_stage":
            event["stage_id"] = first["stage_id"]
            event["answer"]["receipt_paths"] = first["answer"]["receipt_paths"]
        elif change == "reversed_revision":
            event["revision"] = first["revision"]
        elif change == "same_source_version":
            event["answer"]["source_version"] = first["answer"]["source_version"]
        else:
            event["answer"]["manifest_sha256"] = "c" * 64
        conn.execute("UPDATE background_job_events SET data_json=? WHERE cursor=?", (json.dumps(event), rows[1][0]))
        conn.execute("UPDATE background_jobs SET confirmation_json=? WHERE id=?", (json.dumps(event), p.job["id"]))
    with pytest.raises(JobConflict):
        load(s)


def test_confirmations_after_hundreds_of_other_events_are_not_lost(finalized):
    s, p = finalized, finalized.p
    with db.connect() as conn:
        rows = conn.execute("SELECT data_json FROM background_job_events WHERE job_id=? AND type='confirmed' ORDER BY cursor", (p.job["id"],)).fetchall()
        conn.execute("DELETE FROM background_job_events WHERE job_id=? AND type='confirmed'", (p.job["id"],))
        for _ in range(205):
            p.repository.event(conn, p.job["id"], "progress", {"message": "working"})
        for row in rows:
            p.repository.event(conn, p.job["id"], "confirmed", json.loads(row[0]))
    assert load(s).final == s.result


@pytest.mark.parametrize("state", ["reserved", "unknown"])
def test_ledger_fence_cannot_be_bypassed_by_removing_checkpoint_flag(finalized, state):
    s, p = finalized, finalized.p
    with db.connect() as conn:
        conn.execute("INSERT INTO presentation_model_calls(id,job_id,attempt,stage,state) VALUES(?,?,?,?,?)",
                     ("pending", p.job["id"], p.job["owner_token"], "design_spec", state))
    with pytest.raises(JobConflict):
        load(s)


@pytest.mark.parametrize("change", ["deleted", "changed"])
def test_stage1_historical_manifest_is_bound_by_confirmation_event(finalized, change):
    s, p = finalized, finalized.p
    with db.connect() as conn:
        event = json.loads(conn.execute("SELECT data_json FROM background_job_events WHERE job_id=? AND type='confirmed' ORDER BY cursor LIMIT 1", (p.job["id"],)).fetchone()[0])
    name = f"manifests/{event['answer']['manifest_sha256']}.json"
    if change == "deleted":
        p.preparer.files.path(name).unlink()
    else:
        p.preparer.files.write(name, b'{}')
    with pytest.raises(JobConflict):
        load(s)


@pytest.mark.parametrize("change", ["cancel", "lease", "checkpoint", "confirmation", "events"])
def test_concurrent_database_change_during_files_read_is_rejected(finalized, monkeypatch, change):
    s, p = finalized, finalized.p
    original = ProjectManifestStore.load

    def raced(store):
        manifest = original(store)
        if change == "cancel":
            p.repository.cancel(p.job["id"], p.context)
        elif change == "lease":
            p.now[0] += 31
        elif change == "checkpoint":
            p.repository.checkpoint(p.job["id"], p.job["owner_token"], {**p.job["checkpoint"], "new": True}, p.context)
        else:
            with db.connect() as conn:
                if change == "confirmation":
                    conn.execute("UPDATE background_jobs SET confirmation_json=NULL WHERE id=?", (p.job["id"],))
                else:
                    conn.execute("DELETE FROM background_job_events WHERE job_id=? AND type='confirmed'", (p.job["id"],))
        return manifest

    monkeypatch.setattr(ProjectManifestStore, "load", raced)
    with pytest.raises(JobConflict):
        load(s)
    assert len(p.calls) == 2


def test_file_changed_after_manifest_validation_cannot_change_returned_contract(finalized, monkeypatch):
    s, p = finalized, finalized.p
    original = ProjectManifestStore.load

    def raced(store):
        manifest = original(store)
        path = p.job["confirmation"]["answer"]["receipt_paths"][0]
        p.preparer.files.write(path, json.dumps({**s.result, "page_count": "999"}).encode())
        return manifest

    monkeypatch.setattr(ProjectManifestStore, "load", raced)
    with pytest.raises(JobConflict):
        load(s)


def test_cross_account_rejected_before_reading_final_contract(finalized, tmp_path, monkeypatch):
    from app.presentations.final_contract import load_final_contract
    p = finalized.p

    def forbidden(*args):
        pytest.fail("must reject account before reading project files")

    monkeypatch.setattr(ProjectManifestStore, "load", forbidden)
    with use_workspace(2, tmp_path / "other"):
        db.init_db()
        with pytest.raises(PermissionError):
            load_final_contract(p.repository, p.job, p.context)
        with pytest.raises(ValueError):
            load_final_contract(p.repository, p.job, ExtensionContext.current())
