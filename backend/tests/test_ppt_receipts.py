"""Host validates receipt bytes and version bindings without running vendor code."""
import json

import pytest

from app.execution.workspace_files import WorkspaceFiles
from app.jobs.repository import JobConflict
from app.presentations.receipts import canonical_sha256, validate_stage1_receipt


@pytest.fixture
def receipts(tmp_path):
    files = WorkspaceFiles(tmp_path / "project")
    recommendation = {"stage": "stage1", "audience": {"value": ""}}
    selection = {
        "schema_version": 1, "phase": "template", "status": "confirmed",
        "mode": "free_design", "selections": [], "root_snapshots": [],
        "options_sha256": "a" * 64, "confirmed_at": "2026-11-03T12:00:00",
    }
    selection["selection_sha256"] = canonical_sha256({key: selection[key] for key in (
        "mode", "selections", "options_sha256", "root_snapshots")})
    result = {
        "stage": "stage1", "status": "stage1-confirmed",
        "stage1_sha256": canonical_sha256(recommendation),
        "selection_sha256": selection["selection_sha256"], "audience": "",
    }

    def save():
        for name, value in [("recommendations.stage1.json", recommendation),
                            ("template_selection.json", selection), ("result.json", result)]:
            files.write(f"confirm_ui/{name}", json.dumps(value, ensure_ascii=False).encode())
    save()
    return files, recommendation, selection, result, save


def test_matching_stage1_binding_keeps_user_contract_out_of_public_record(receipts):
    files, recommendation, selection, result, _ = receipts
    binding = validate_stage1_receipt(files.root, recommendation=recommendation)
    assert binding["selection_sha256"] == selection["selection_sha256"]
    assert binding["status"] == "confirmed" and "audience" not in binding
    assert result["audience"] == ""


@pytest.mark.parametrize("field,value", [
    ("mode", "unknown"), ("schema_version", True), ("schema_version", 2),
    ("options_sha256", "invalid"), ("selections", [{}]), ("root_snapshots", [{}]),
    ("confirmed_at", ""),
])
def test_malformed_or_tampered_selection_is_rejected(receipts, field, value):
    files, recommendation, selection, _, save = receipts
    selection[field] = value
    save()
    with pytest.raises(JobConflict):
        validate_stage1_receipt(files.root, recommendation=recommendation)


def test_rehashed_unmatched_template_snapshot_is_rejected(receipts):
    files, recommendation, selection, result, save = receipts
    selection.update(mode="templates", selections=[{
        "source": "library", "kind": "style", "id": "fixture", "workspace_root": "/not-a-trusted-runtime",
    }])
    selection["selection_sha256"] = canonical_sha256({key: selection[key] for key in (
        "mode", "selections", "options_sha256", "root_snapshots")})
    result["selection_sha256"] = selection["selection_sha256"]
    save()
    with pytest.raises(JobConflict):
        validate_stage1_receipt(files.root, recommendation=recommendation)


def test_recommendation_is_always_checked_even_without_explicit_argument(receipts):
    files, recommendation, _, _, save = receipts
    recommendation["audience"]["value"] = "new revision"
    save()
    with pytest.raises(JobConflict):
        validate_stage1_receipt(files.root)


def test_mismatched_receipt_pair_is_rejected(receipts):
    files, recommendation, _, result, save = receipts
    result["selection_sha256"] = "b" * 64
    save()
    with pytest.raises(JobConflict):
        validate_stage1_receipt(files.root, recommendation=recommendation)


def test_final_receipt_binds_both_recommendations_and_preserves_blank_answers(receipts):
    from app.presentations.receipts import validate_final_receipt
    files, recommendation, selection, result, save = receipts
    stage2 = {"stage": "stage2", "selection_sha256": selection["selection_sha256"]}
    result.update(stage="final", status="confirmed")
    save()
    files.write("confirm_ui/recommendations.stage2.json", json.dumps(stage2).encode())
    checked = validate_final_receipt(files.root, stage1=recommendation, stage2=stage2)
    assert checked["contract"]["audience"] == ""
    assert checked["binding"]["stage"] == "final"
    assert checked["binding"]["stage2_sha256"] == canonical_sha256(stage2)
    # The final receipt must not silently authorize a different selection.
    stage2["selection_sha256"] = "c" * 64
    with pytest.raises(JobConflict):
        validate_final_receipt(files.root, stage1=recommendation, stage2=stage2)


def test_json_duplicate_keys_are_not_accepted_as_receipts(receipts):
    files, recommendation, _, _, _ = receipts
    files.write("confirm_ui/result.json", b'{"stage":"stage1","stage":"final"}')
    with pytest.raises(JobConflict):
        validate_stage1_receipt(files.root, recommendation=recommendation)
