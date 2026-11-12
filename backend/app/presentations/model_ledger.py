"""Durable model-call and active-time budgets, fenced by the job lease.

No prompts, response bodies, provider errors or credentials belong in this ledger.
An uncompleted reservation deliberately blocks replay, even after a process crash.
"""
from __future__ import annotations

import json
import re
import time
import uuid

from ..db import connect
from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobConflict, JobRepository, encoded
from .retry import unresolved_calls


MAX_MODEL_CALLS = 48
MAX_ACTIVE_SECONDS = 1800


class PresentationBudgetExceeded(JobConflict):
    pass


class ModelCallLedger:
    def __init__(self, repository: JobRepository, *, clock=time.time):
        self.repository, self.clock = repository, clock

    @staticmethod
    def _ensure(conn, job_id: str) -> dict:
        job = conn.execute("SELECT kind FROM background_jobs WHERE id=?", (job_id,)).fetchone()
        if job is None or not job["kind"].startswith("ppt."):
            raise JobConflict("演示文稿任务不存在")
        conn.execute("INSERT OR IGNORE INTO presentation_job_budgets(job_id) VALUES(?)", (job_id,))
        return dict(conn.execute("SELECT * FROM presentation_job_budgets WHERE job_id=?", (job_id,)).fetchone())

    def status(self, job_id: str, context: ExtensionContext) -> dict:
        context.check_workspace()
        with connect() as conn:
            budget = self._ensure(conn, job_id)
        seconds = budget["active_seconds"]
        if budget["active_started"] is not None:
            seconds += max(0, min(self.clock(), budget["active_until"]) - budget["active_started"])
        return {"calls_used": budget["calls_used"], "active_seconds": seconds}

    def assert_stage_unused(self, job_id: str, stage: str, context: ExtensionContext) -> None:
        """Do not rebill a completed-but-uncommitted authoring stage on recovery."""
        self.repository.get(job_id, context)
        with connect() as conn:
            if unresolved_calls(conn, job_id) or conn.execute("SELECT 1 FROM presentation_model_calls WHERE job_id=? AND stage=?", (job_id, stage)).fetchone():
                raise JobConflict("该阶段已有模型请求记录，需要明确恢复，不能自动重放")

    def reserve(self, job_id: str, attempt: str, stage: str, context: ExtensionContext) -> str:
        context.check_workspace()
        if not re.fullmatch(r"[a-z][a-z0-9_.:-]{0,79}", stage):
            raise ValueError("无效的模型阶段")
        request_id = uuid.uuid4().hex
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.repository.assert_owner(conn, job_id, attempt)
            budget = self._ensure(conn, job_id)
            if unresolved_calls(conn, job_id):
                raise JobConflict("上次模型请求结果不明，不能自动重试")
            if budget["calls_used"] >= MAX_MODEL_CALLS:
                raise PresentationBudgetExceeded("已达到 48 次模型请求上限")
            checkpoint = json.loads(conn.execute("SELECT checkpoint_json FROM background_jobs WHERE id=?", (job_id,)).fetchone()[0])
            checkpoint.update(external_outcome="unknown", model_request_id=request_id)
            conn.execute("UPDATE background_jobs SET checkpoint_json=? WHERE id=?", (encoded(checkpoint), job_id))
            conn.execute("UPDATE presentation_job_budgets SET calls_used=calls_used+1 WHERE job_id=?", (job_id,))
            conn.execute("INSERT INTO presentation_model_calls(id,job_id,attempt,stage,state) VALUES(?,?,?,?,'reserved')", (request_id, job_id, attempt, stage))
        return request_id

    def _call(self, conn, request_id: str, attempt: str) -> dict:
        row = conn.execute("SELECT * FROM presentation_model_calls WHERE id=?", (request_id,)).fetchone()
        if row is None or row["attempt"] != attempt:
            raise JobConflict("模型请求不属于当前任务租约")
        self.repository.assert_owner(conn, row["job_id"], attempt)
        return dict(row)

    def complete(self, request_id: str, attempt: str, result_hash: str, usage: dict, context: ExtensionContext) -> None:
        context.check_workspace()
        if not re.fullmatch(r"[0-9a-f]{64}", result_hash):
            raise ValueError("模型结果需要 SHA-256 哈希")
        if set(usage) - {"input_tokens", "output_tokens", "total_tokens"} or any(type(value) is not int or value < 0 for value in usage.values()):
            raise ValueError("模型用量只能包含非负 token 数")
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            call = self._call(conn, request_id, attempt)
            if call["state"] == "completed":
                if call["result_hash"] != result_hash or call["usage_json"] != encoded(usage):
                    raise JobConflict("已登记的模型结果不能改写")
                return
            if call["state"] != "reserved":
                raise JobConflict("结果不明的模型请求不能自动改写")
            checkpoint = json.loads(conn.execute("SELECT checkpoint_json FROM background_jobs WHERE id=?", (call["job_id"],)).fetchone()[0])
            if checkpoint.get("model_request_id") != request_id:
                raise JobConflict("模型请求检查点不匹配")
            checkpoint.pop("model_request_id")
            checkpoint.pop("external_outcome", None)
            conn.execute("UPDATE presentation_model_calls SET state='completed',result_hash=?,usage_json=?,completed_at=CURRENT_TIMESTAMP WHERE id=?", (result_hash, encoded(usage), request_id))
            conn.execute("UPDATE background_jobs SET checkpoint_json=? WHERE id=?", (encoded(checkpoint), call["job_id"]))

    def mark_unknown(self, request_id: str, attempt: str, context: ExtensionContext) -> None:
        context.check_workspace()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            call = self._call(conn, request_id, attempt)
            if call["state"] == "reserved":
                conn.execute("UPDATE presentation_model_calls SET state='unknown' WHERE id=?", (request_id,))

    def mark_failed(self, request_id: str, attempt: str, context: ExtensionContext) -> None:
        """Resolve a reservation whose provider answered with a definite error.

        An error response (e.g. an HTTP 5xx from the gateway) means no model
        compute happened, so the outcome is known: the call is recorded as an
        unknown-shaped row flagged ``definite_failure`` and the job checkpoint
        fence is cleared like :meth:`complete` does. Unlike :meth:`mark_unknown`,
        this never blocks a bounded automatic retry or a later user retry.
        """
        context.check_workspace()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            call = self._call(conn, request_id, attempt)
            if call["state"] != "reserved":
                raise JobConflict("结果不明的模型请求不能自动改写")
            checkpoint = json.loads(conn.execute("SELECT checkpoint_json FROM background_jobs WHERE id=?", (call["job_id"],)).fetchone()[0])
            if checkpoint.get("model_request_id") != request_id:
                raise JobConflict("模型请求检查点不匹配")
            checkpoint.pop("model_request_id")
            checkpoint.pop("external_outcome", None)
            conn.execute("UPDATE presentation_model_calls SET state='unknown', definite_failure=1 WHERE id=?", (request_id,))
            conn.execute("UPDATE background_jobs SET checkpoint_json=? WHERE id=?", (encoded(checkpoint), call["job_id"]))

    def start_activity(self, job_id: str, attempt: str, context: ExtensionContext) -> None:
        self._activity(job_id, attempt, context, operation="start")

    def refresh_activity(self, job_id: str, attempt: str, context: ExtensionContext) -> None:
        """Call after every lease heartbeat while the presentation is active."""
        self._activity(job_id, attempt, context, operation="refresh")

    def stop_activity(self, job_id: str, attempt: str, context: ExtensionContext) -> None:
        self._activity(job_id, attempt, context, operation="stop")

    def _activity(self, job_id: str, attempt: str, context: ExtensionContext, *, operation: str) -> None:
        context.check_workspace()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.repository.assert_owner(conn, job_id, attempt)
            budget = self._ensure(conn, job_id)
            now = self.clock()
            seconds = budget["active_seconds"]
            if budget["active_started"] is not None:
                # A lost attempt cannot report when it stopped. Conservatively
                # account through the last lease observed by its heartbeat.
                end = min(now, budget["active_until"]) if budget["active_attempt"] == attempt else budget["active_until"]
                seconds += max(0, end - budget["active_started"])
            if operation != "stop" and seconds >= MAX_ACTIVE_SECONDS:
                raise PresentationBudgetExceeded("已达到 1800 秒活动执行上限")
            if operation == "stop":
                conn.execute("UPDATE presentation_job_budgets SET active_seconds=?,active_attempt=NULL,active_started=NULL,active_until=NULL WHERE job_id=?", (seconds, job_id))
            else:
                until = conn.execute("SELECT lease_expires FROM background_jobs WHERE id=?", (job_id,)).fetchone()[0]
                conn.execute("UPDATE presentation_job_budgets SET active_seconds=?,active_attempt=?,active_started=?,active_until=? WHERE job_id=?", (seconds, attempt, now, until, job_id))
