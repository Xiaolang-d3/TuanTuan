"""Explicit, idempotent retries on the original presentation task.

Retry events retain earlier content and call history. They authorize only the
named failed stage or unresolved requests; they never rewrite ledger outcomes.
"""
from __future__ import annotations

import hashlib
import json
import re

from ..db import connect
from ..jobs.repository import JobConflict, decode, encoded
from ..observability.model_context import public_model_selection
from .contracts import PresentationRequest


def retry_state(conn, job_id):
    row = conn.execute("SELECT data_json FROM background_job_events WHERE job_id=? AND type='retry_requested' ORDER BY cursor DESC LIMIT 1", (job_id,)).fetchone()
    return json.loads(row[0]) if row else {"count": 0, "generation": 0, "stage_retries": {}, "acknowledged_requests": []}


def state_for(job_id):
    with connect() as conn:
        return retry_state(conn, job_id)


def canonical_stage(stage):
    return re.sub(r"^(?:g[1-9][0-9]*\.)?(?:retry[1-9][0-9]*\.)?", "", stage)


def stage_name(stage, state):
    generation = state["generation"]
    retry = state["stage_retries"].get(stage, 0)
    return (f"g{generation}." if generation else "") + (f"retry{retry}." if retry else "") + stage


def unresolved_calls(conn, job_id):
    acknowledged = set(retry_state(conn, job_id)["acknowledged_requests"])
    # Definite failures (the provider answered with an error response) are
    # resolved: they never fence a retry, unlike reserved or unknown calls.
    return [row for row in conn.execute("SELECT id,stage,state FROM presentation_model_calls WHERE job_id=? AND state IN ('reserved','unknown') AND definite_failure=0", (job_id,)) if row["id"] not in acknowledged]


def public_retry(job):
    stopped = not job["execution"] or job["execution"].get("stopped")
    retryable = job["status"] in {"failed", "interrupted"} and stopped and not job["cancel_requested"]
    with connect() as conn:
        pending = unresolved_calls(conn, job["id"]) if retryable else []
    uncertain = bool(pending or job["checkpoint"].get("external_outcome") == "unknown" or job["checkpoint"].get("confirmation_submission"))
    return {"retryable": bool(retryable), "retry_requires_confirmation": retryable and uncertain}


def retry_presentation(repository, job_id, values, context, *, model_selection=None):
    repository.get(job_id, context)
    request_id = str(values.get("request_id") or "").strip()
    if not request_id or len(request_id) > 128:
        raise JobConflict("重试需要有效的请求标识")
    fingerprint = hashlib.sha256(encoded({key: value for key, value in values.items() if key not in {"request_id", "expected_revision"}}).encode()).hexdigest()
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        previous = conn.execute("SELECT data_json FROM background_job_events WHERE job_id=? AND type='retry_requested' AND json_extract(data_json,'$.request_id')=?", (job_id, request_id)).fetchone()
        if previous:
            if json.loads(previous[0])["fingerprint"] != fingerprint:
                raise JobConflict("同一次重试不能更改要求，请重新提交")
        else:
            job = decode(conn.execute("SELECT * FROM background_jobs WHERE id=?", (job_id,)).fetchone())
            if job["kind"] != "ppt.generate" or job["status"] not in {"failed", "interrupted"}:
                raise JobConflict("只有失败或中断的制作任务可以重试，请刷新状态")
            if values.get("expected_revision") != job["revision"]:
                raise JobConflict("任务状态已更新，请刷新后再重试")
            if job["cancel_requested"] or job["execution"] and not job["execution"].get("stopped"):
                raise JobConflict("原任务尚未停止，请稍后刷新再重试")
            checkpoint = dict(job["checkpoint"])
            pending = unresolved_calls(conn, job_id)
            uncertain = pending or checkpoint.get("external_outcome") == "unknown" or checkpoint.get("confirmation_submission")
            if uncertain and not values.get("acknowledge_uncertain"):
                raise JobConflict("上次请求结果未确认，重试可能重复调用模型；请明确确认后重试")
            request = dict(job["request"])
            if "topic" in values:
                request["topic"] = values["topic"]
            if "page_count" in values:
                request["options"] = {**request.get("options", {}), "page_count": values["page_count"]}
            request = PresentationRequest.model_validate(request).model_dump(mode="json")
            original = PresentationRequest.model_validate(job["request"]).model_dump(mode="json")
            edited = request != original
            restart = edited or bool(checkpoint.get("confirmation_submission")) or not checkpoint.get("stage")
            state = retry_state(conn, job_id)
            state = {**state, "count": state["count"] + 1, "request_id": request_id, "fingerprint": fingerprint,
                     "previous_model_selection": public_model_selection(job["snapshot"].get("model_selection")),
                     "acknowledged_requests": sorted(set(state["acknowledged_requests"]) | {row["id"] for row in pending})}
            snapshot = {**job["snapshot"], **({"model_selection": model_selection} if model_selection is not None else {})}
            if restart:
                state.update(generation=state["generation"] + 1, stage_retries={}, quality_round_limit=2)
                repository.event(conn, job_id, "requirements_updated", {"generation": state["generation"], "previous_request": job["request"], "previous_confirmation": job["confirmation"]})
                checkpoint = {}
            else:
                latest = conn.execute("SELECT stage,state FROM presentation_model_calls WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (job_id,)).fetchone()
                model_failed = pending or checkpoint.get("model_error_code") or checkpoint.get("presentation_error_code") or job["error"].startswith(("ValueError", "ValidationError", "ModelProviderError"))
                if latest and model_failed:
                    state["stage_retries"][canonical_stage(latest["stage"])] = state["count"]
                for stage in checkpoint.get("retry_stages", []):
                    state["stage_retries"][stage] = state["count"]
                if checkpoint.get("production", {}).get("stage") == "quality_repairing":
                    state["quality_round_limit"] = state.get("quality_round_limit", 2) + 2
                for key in ("external_outcome", "model_request_id", "model_error_code", "presentation_error_code", "retry_stages"):
                    checkpoint.pop(key, None)
            conn.execute("UPDATE background_jobs SET status='queued',request_json=?,snapshot_json=?,checkpoint_json=?,confirmation_json=?,error='',prompt='',stage_id=NULL,answer_schema_json='{}',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", (encoded(request), encoded(snapshot), encoded(checkpoint), None if restart else encoded(job["confirmation"]), job_id))
            repository.event(conn, job_id, "retry_requested", state)
    return repository.get(job_id, context)
