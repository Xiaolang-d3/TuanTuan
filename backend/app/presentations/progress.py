"""Read-only, allowlisted progress from persisted presentation checkpoints."""
from __future__ import annotations

import re

from ..db import connect


_ACTIVITIES = {
    "stage1": "正在分析演示需求",
    "stage2": "正在规划内容与设计",
    "design_spec": "正在编写设计规格",
    "design_spec_audit": "正在核对设计规格",
    "spec_lock": "正在整理执行规范",
    "spec_lock_audit": "正在核对执行规范",
    "speaker_notes": "正在编写逐页讲稿",
}
_PAGE_CALL = re.compile(r"page\.p(0[1-9]|1[0-9]|20)(?:(\.repair[12])|(\.quality[1-9][0-9]?))?\Z")
_LEGACY_PAGE = re.compile(r"page_([1-9]|1[0-9]|20)_ready\Z")


def _activity(stage: str) -> str | None:
    from .retry import canonical_stage
    stage = canonical_stage(stage)
    if stage in _ACTIVITIES:
        return _ACTIVITIES[stage]
    page = _PAGE_CALL.fullmatch(stage)
    if page:
        verb = "修复" if page[2] else "完善" if page[3] else "生成"
        return f"正在{verb}第 {int(page[1])} 页"
    return None


def public_progress(job: dict) -> dict:
    """Never consult project files, providers, credentials or raw model bodies."""
    checkpoint = job["checkpoint"]
    production = checkpoint.get("production", {})
    completed = production.get("pages_completed")
    if type(completed) is not int or not 0 <= completed <= 20:
        legacy = _LEGACY_PAGE.fullmatch(production.get("stage", ""))
        completed = int(legacy[1]) if legacy else 0
    total = production.get("pages_total")
    if type(total) is not int or not max(1, completed) <= total <= 20:
        total = None
    activity = started_at = None
    request_id = checkpoint.get("model_request_id")
    if job["status"] == "running" and isinstance(request_id, str):
        with connect() as conn:
            call = conn.execute(
                "SELECT stage,created_at FROM presentation_model_calls "
                "WHERE id=? AND job_id=? AND state='reserved'",
                (request_id, job["id"]),
            ).fetchone()
        if call:
            activity = _activity(call["stage"])
            started_at = call["created_at"] if activity else None
    return {
        "activity": activity, "started_at": started_at,
        "pages_completed": completed, "pages_total": total,
        "outcome_uncertain": (job["status"] in {"failed", "interrupted"}
                              and checkpoint.get("external_outcome") == "unknown"),
    }
