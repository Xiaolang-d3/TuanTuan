"""Committed model batches, coverage and recovery through the actual Worker."""
import asyncio
import json

import pytest

from app import db
from app.documents.blocks import text_document
from app.domain import ModelResponse, ModelUsage
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict
from app.jobs.service import JobService
from app.jobs.worker import JobWorker
from app.library.document_review import DocumentReviewInput, create_document_review, register_document_review_handler
from app.library.sources import create_text_source, get_source, update_source
from app.library.source_versions import save_source_version
from app.workspace import use_workspace


class Provider:
    def __init__(self):
        self.calls = []
        self.fail_stage = None
        self.long_map = False
    async def generate(self, request):
        payload = json.loads(request.messages[-1].content)
        self.calls.append(request)
        assert not request.tools and request.tool_choice == "none" and not request.allow_option_fallback
        if payload["stage"] == self.fail_stage:
            content = "invalid result, never submit this batch"
        else:
            citations = [block["citation_id"] for block in payload.get("blocks", [])][:1]
            if not citations:
                citations = list(dict.fromkeys(citation for result in payload.get("results", []) for citation in result["citations"]))[:2]
            content = json.dumps({"summary": f"已核对 {payload['stage']}。", "citations": citations}, ensure_ascii=False)
            if self.long_map and payload["stage"].startswith("map."):
                content = json.dumps({"summary": "结" * 801, "citations": citations})
        return ModelResponse(provider="test", content=content, usage=ModelUsage(input_tokens=10, output_tokens=5, total_tokens=15))


@pytest.fixture
def review(tmp_path):
    root = tmp_path / "owner"
    with use_workspace(1, root):
        db.init_db()
        context = ExtensionContext.current()
        provider = Provider()
        connection = {"profile_id": "p", "profile_revision": 1, "connection_id": "c", "connection_revision": 1,
                      "model_name": "fake", "model_protocol": "openai", "resolved_model_protocol": "openai", "parameters": {}, "context_limit": 32000}
        def resolve(profile_id=None, *, selection=None):
            return dict(connection)
        jobs = JobService()
        register_document_review_handler(jobs, provider_factory=lambda _: provider, connection_resolver=resolve)
        def create(text="正文。", budget=None, incomplete=False, privacy="redacted", missing_pages=1):
            # Explicit selection works even when a file is off for long-term memory.
            source = create_text_source(title="所选文件", content=text, privacy_mode=privacy, enabled=False)
            parsed = text_document(text)
            if incomplete:
                parsed.complete = False
                parsed.unprocessed_ranges = [{"kind": "pdf_page", "page": page, "reason": "ocr_required"} for page in range(2, missing_pages + 2)]
            version = save_source_version(source["id"], parsed)
            target = {"source_kind": "library", "source_id": source["id"], "source_revision": version["revision"]}
            payload = DocumentReviewInput(target=target, budget=budget or {}, idempotency_key=f"review-{source['id']}")
            job = create_document_review(payload, context, jobs=jobs, connection_resolver=resolve)
            return job, source, payload
        def run():
            return asyncio.run(JobWorker(jobs).run_once(1, root))
        yield {"jobs": jobs, "provider": provider, "connection": connection, "create": create, "run": run, "context": context, "resolve": resolve, "root": root}


def test_all_processable_blocks_are_model_processed_and_summary_is_budgeted(review):
    job, source, payload = review["create"]("可核对的段落。" * 1300)
    assert create_document_review(payload, review["context"], jobs=review["jobs"], connection_resolver=review["resolve"])["id"] == job["id"]
    assert not review["provider"].calls, "creating or refreshing a job must not execute a model inline"
    finished = review["run"]()
    assert finished["status"] == "succeeded"
    coverage = finished["result"]["coverage"]
    assert coverage["status"] == "complete" and coverage["completed_blocks"] == coverage["total_blocks"] > 8
    actual = [block["block_id"] for request in review["provider"].calls for block in json.loads(request.messages[-1].content).get("blocks", [])]
    assert len(actual) == len(set(actual)) == coverage["total_blocks"]
    assert any(json.loads(request.messages[-1].content).get("results") for request in review["provider"].calls)
    with db.connect() as conn:
        assert conn.execute("SELECT calls_used FROM job_model_budgets WHERE job_id=?", (job["id"],)).fetchone()[0] == len(review["provider"].calls)
    assert get_source(source["id"])["enabled"] is False


def test_budget_pause_keeps_committed_blocks_and_resume_does_not_rebill_them(review):
    job, _, _ = review["create"](budget={"calls": 1})
    paused = review["run"]()
    assert paused["status"] == "waiting_user" and paused["checkpoint"]["review"]["coverage"]["completed_blocks"] == 1
    assert len(review["provider"].calls) == 1 and paused["result"] is None
    answer = {"budget": {"calls": 2, "input_tokens": 10000, "output_tokens": 5000, "active_seconds": 60}, "idempotency_key": "continue-once"}
    review["jobs"].confirm(job["id"], paused["stage_id"], paused["revision"], answer, review["context"])
    finished = review["run"]()
    assert finished["status"] == "succeeded" and finished["result"]["coverage"]["status"] == "complete"
    assert len(review["provider"].calls) == 2


@pytest.mark.parametrize("change", ["model", "source", "privacy", "credential"])
def test_resume_rechecks_frozen_model_source_and_original_permission(review, change):
    review["connection"]["credential_fingerprint"] = "original-fingerprint"
    job, source, _ = review["create"](budget={"calls": 1}, privacy="original")
    paused = review["run"]()
    assert paused["status"] == "waiting_user"
    if change == "model":
        review["connection"]["profile_revision"] += 1
    elif change == "credential":
        review["connection"]["credential_fingerprint"] = "changed-fingerprint"
    elif change == "source":
        update_source(source["id"], content="新版本正文")
    else:
        update_source(source["id"], privacy_mode="redacted")
    answer = {"budget": {"calls": 2, "input_tokens": 10000, "output_tokens": 5000, "active_seconds": 60}, "idempotency_key": "continue-changed"}
    with pytest.raises((JobConflict, ValueError)):
        review["jobs"].confirm(job["id"], paused["stage_id"], paused["revision"], answer, review["context"])
    assert len(review["provider"].calls) == 1


def test_scanned_missing_pages_do_not_become_full_coverage(review):
    review["create"](incomplete=True)
    finished = review["run"]()
    assert finished["status"] == "succeeded" and finished["result"]["coverage"]["status"] == "partial"
    assert finished["result"]["coverage"]["unprocessed_ranges"][0]["page"] == 2


def test_failed_model_batch_is_excluded_from_summary_and_coverage(review):
    review["provider"].fail_stage = "map.00000"
    review["create"]("可核对的段落。" * 1300)
    finished = review["run"]()
    assert finished["status"] == "succeeded"
    coverage = finished["result"]["coverage"]
    assert coverage["status"] == "partial" and coverage["failed_blocks"] > 0
    assert coverage["completed_blocks"] + coverage["failed_blocks"] == coverage["total_blocks"]
    summaries = [result["summary"] for request in review["provider"].calls for result in json.loads(request.messages[-1].content).get("results", [])]
    assert summaries and all("invalid result" not in text for text in summaries)


def test_completed_result_before_coverage_checkpoint_is_recovered_by_hash(review, monkeypatch):
    from app.jobs.model_ledger import JobModelCallLedger
    original = JobModelCallLedger.complete
    once = [True]
    def crash_after_commit(*args, **kwargs):
        original(*args, **kwargs)
        if once[0]:
            once[0] = False
            raise asyncio.CancelledError()
    monkeypatch.setattr(JobModelCallLedger, "complete", crash_after_commit)
    job, _, _ = review["create"]()
    assert review["run"]()["status"] == "interrupted"
    review["jobs"].resume(job["id"], review["context"])
    assert review["run"]()["result"]["coverage"]["status"] == "complete"
    assert len(review["provider"].calls) == 2, "map result was already paid and must be reused before summary"


def test_known_context_limit_rejects_before_any_model_call(review):
    review["connection"]["context_limit"] = 1000
    review["create"]()
    result = review["run"]()
    assert result["status"] == "failed" and not review["provider"].calls
    assert "上下文" in result["error"]


def test_image_only_protocol_is_rejected_before_creating_or_billing_a_review(review):
    review["connection"].update(model_protocol="openai_images", resolved_model_protocol="openai_images")
    with pytest.raises(ValueError, match="文本"):
        review["create"]()
    assert not review["provider"].calls


def test_many_missing_pages_keep_full_ranges_in_source_but_bound_job_checkpoint(review):
    review["create"](incomplete=True, missing_pages=1999)
    finished = review["run"]()
    assert finished["status"] == "succeeded"
    coverage = finished["result"]["coverage"]
    assert coverage["status"] == "partial" and coverage["unprocessed_ranges_total"] == 1999
    assert len(coverage["unprocessed_ranges"]) <= 40


def test_intermediate_summary_size_is_bounded_before_hierarchical_reduction(review):
    review["provider"].long_map = True
    review["create"]()
    finished = review["run"]()
    assert finished["result"]["coverage"]["status"] == "partial"
    assert finished["result"]["coverage"]["failed_blocks"] == 1


def test_hash_mismatch_stops_resume_without_new_model_calls(review):
    from app.library.document_review import review_files
    job, _, _ = review["create"](budget={"calls": 1})
    paused = review["run"]()
    with db.connect() as conn:
        request_id = conn.execute("SELECT id FROM job_model_calls WHERE job_id=?", (job["id"],)).fetchone()[0]
    review_files(job["id"], review["context"]).write(f"model_responses/{request_id}.json", b"modified result")
    answer = {"budget": {"calls": 2, "input_tokens": 10000, "output_tokens": 5000, "active_seconds": 60}, "idempotency_key": "resume-tampered"}
    review["jobs"].confirm(job["id"], paused["stage_id"], paused["revision"], answer, review["context"])
    result = review["run"]()
    assert result["status"] == "failed" and "校验" in result["error"]
    assert len(review["provider"].calls) == 1


def test_cancel_during_recovery_keeps_previously_committed_partial_output(review, monkeypatch):
    job, _, _ = review["create"](budget={"calls": 1})
    paused = review["run"]()
    previous = paused["checkpoint"]["review"]
    answer = {"budget": {"calls": 2, "input_tokens": 10000, "output_tokens": 5000, "active_seconds": 60}, "idempotency_key": "cancel-recovery"}
    review["jobs"].confirm(job["id"], paused["stage_id"], paused["revision"], answer, review["context"])
    async def cancel_before_cache(*args, **kwargs):
        review["jobs"].cancel(job["id"], review["context"])
        raise asyncio.CancelledError()
    monkeypatch.setattr(review["jobs"].handlers["document.review"], "_stage", cancel_before_cache)
    cancelled = review["run"]()
    assert cancelled["status"] == "cancelled"
    assert cancelled["checkpoint"]["review"]["coverage"]["completed_blocks"] == previous["coverage"]["completed_blocks"]
    assert cancelled["checkpoint"]["review"]["summary"] == previous["summary"]
