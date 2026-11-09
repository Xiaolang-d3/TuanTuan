"""Lease-fenced reservations and activity accounting for trusted job adapters.

The existing model-service events remain the actual usage history. This ledger
stores only budget counters, immutable result hashes and replay fences.
"""
from __future__ import annotations

import hashlib
import json
import re
import time
import uuid

from ..db import connect
from ..extensions.contracts import ExtensionContext
from .confirmation import validate_answer
from .repository import JobConflict, JobRepository, encoded

DEFAULT_BUDGET = {"calls": 32, "input_tokens": 200000, "output_tokens": 32000, "active_seconds": 1800}
MAX_ADDITION = {"calls": 256, "input_tokens": 2000000, "output_tokens": 256000, "active_seconds": 14400}
BUDGET_SCHEMA = {"type": "object", "properties": {name: {"type": "integer", "minimum": 1, "maximum": maximum} for name, maximum in MAX_ADDITION.items()}, "required": list(DEFAULT_BUDGET), "additionalProperties": False}
ADDITION_SCHEMA = {"type": "object", "properties": {"budget": BUDGET_SCHEMA, "idempotency_key": {"type": "string", "minLength": 1, "maxLength": 128}}, "required": ["budget", "idempotency_key"], "additionalProperties": False}


class JobBudgetExceeded(JobConflict):
    pass


class JobModelCallLedger:
    def __init__(self, repository: JobRepository, *, clock=time.time):
        self.repository, self.clock = repository, clock

    @staticmethod
    def _ensure(conn, job_id: str) -> dict:
        job = conn.execute("SELECT request_json,snapshot_json FROM background_jobs WHERE id=?", (job_id,)).fetchone()
        if job is None or "jobs.model_budget" not in json.loads(job["snapshot_json"]).get("grants", []):
            raise JobConflict("此任务没有可信的模型预算授权")
        budget = conn.execute("SELECT * FROM job_model_budgets WHERE job_id=?", (job_id,)).fetchone()
        if budget is None:
            limits = {**DEFAULT_BUDGET, **json.loads(job["request_json"]).get("budget", {})}
            validate_answer(BUDGET_SCHEMA, limits)
            conn.execute("INSERT OR IGNORE INTO job_model_budgets(job_id,calls_limit,input_tokens_limit,output_tokens_limit,active_seconds_limit) VALUES(?,?,?,?,?)", (job_id, *(limits[name] for name in DEFAULT_BUDGET)))
            budget = conn.execute("SELECT * FROM job_model_budgets WHERE job_id=?", (job_id,)).fetchone()
        return dict(budget)

    def _seconds(self, budget: dict) -> float:
        return budget["active_seconds"] + (max(0, min(self.clock(), budget["active_until"]) - budget["active_started"]) if budget["active_started"] is not None else 0)

    def status(self, job_id: str, context: ExtensionContext) -> dict:
        context.check_workspace()
        with connect() as conn:
            budget = self._ensure(conn, job_id)
        return {**{key: value for key, value in budget.items() if key.endswith(("_limit", "_used"))}, "active_seconds": self._seconds(budget)}

    def check_budget(self, job_id: str, context: ExtensionContext) -> None:
        budget = self.status(job_id, context)
        if budget["active_seconds"] >= budget["active_seconds_limit"]:
            raise JobBudgetExceeded("活动执行时间预算已用完")
        for name in ("calls", "input_tokens", "output_tokens"):
            if budget[name + "_used"] > budget[name + "_limit"]:
                raise JobBudgetExceeded("实际模型用量已超过本次预算，需要追加后继续")

    def reserve(self, job_id: str, attempt: str, stage: str, context: ExtensionContext, *, input_tokens: int, output_tokens: int) -> str:
        context.check_workspace()
        if not re.fullmatch(r"[a-z][a-z0-9_.:-]{0,79}", stage):
            raise ValueError("无效的模型阶段")
        if type(input_tokens) is not int or input_tokens < 0 or type(output_tokens) is not int or output_tokens < 1:
            raise ValueError("模型发送前必须提供非负输入预留和正数输出上限")
        request_id = uuid.uuid4().hex
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.repository.assert_owner(conn, job_id, attempt)
            budget = self._ensure(conn, job_id)
            if conn.execute("SELECT 1 FROM job_model_calls WHERE job_id=? AND (state<>'completed' OR stage=?)", (job_id, stage)).fetchone():
                raise JobConflict("此任务已有未决请求或已登记阶段，不能自动重复调用")
            if self._seconds(budget) >= budget["active_seconds_limit"]:
                raise JobBudgetExceeded("活动执行时间预算已用完")
            for name, amount, label in (("calls", 1, "调用次数"), ("input_tokens", input_tokens, "输入 token"), ("output_tokens", output_tokens, "输出 token")):
                if budget[name + "_used"] + amount > budget[name + "_limit"]:
                    raise JobBudgetExceeded(f"{label}预算不足，发送前已暂停")
            checkpoint = json.loads(conn.execute("SELECT checkpoint_json FROM background_jobs WHERE id=?", (job_id,)).fetchone()[0])
            checkpoint.update(external_outcome="unknown", model_request_id=request_id)
            conn.execute("UPDATE background_jobs SET checkpoint_json=? WHERE id=?", (encoded(checkpoint), job_id))
            conn.execute("UPDATE job_model_budgets SET calls_used=calls_used+1,input_tokens_used=input_tokens_used+?,output_tokens_used=output_tokens_used+? WHERE job_id=?", (input_tokens, output_tokens, job_id))
            conn.execute("INSERT INTO job_model_calls(id,job_id,attempt,stage,state,input_reserved,output_reserved) VALUES(?,?,?,?,'reserved',?,?)", (request_id, job_id, attempt, stage, input_tokens, output_tokens))
        return request_id

    def _call(self, conn, request_id: str, attempt: str) -> dict:
        row = conn.execute("SELECT * FROM job_model_calls WHERE id=?", (request_id,)).fetchone()
        if row is None or row["attempt"] != attempt:
            raise JobConflict("模型请求不属于当前租约")
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
                    raise JobConflict("已提交模型结果不能改写")
                return
            if call["state"] != "reserved":
                raise JobConflict("结果不明的模型请求不能自动改写")
            checkpoint = json.loads(conn.execute("SELECT checkpoint_json FROM background_jobs WHERE id=?", (call["job_id"],)).fetchone()[0])
            if checkpoint.get("model_request_id") != request_id:
                raise JobConflict("模型请求检查点不匹配")
            checkpoint.pop("model_request_id")
            checkpoint.pop("external_outcome", None)
            reported_input, reported_output = usage.get("input_tokens", 0), usage.get("output_tokens", 0)
            charged_input = reported_input or call["input_reserved"]
            charged_output = reported_output or call["output_reserved"]
            extra = max(0, usage.get("total_tokens", 0) - reported_input - reported_output)
            if extra:
                if not reported_input or reported_output:
                    charged_input = max(charged_input, reported_input + extra)
                if not reported_output or reported_input:
                    charged_output = max(charged_output, reported_output + extra)
            conn.execute("UPDATE job_model_budgets SET input_tokens_used=input_tokens_used+?,output_tokens_used=output_tokens_used+? WHERE job_id=?", (charged_input - call["input_reserved"], charged_output - call["output_reserved"], call["job_id"]))
            conn.execute("UPDATE job_model_calls SET state='completed',result_hash=?,usage_json=?,completed_at=CURRENT_TIMESTAMP WHERE id=?", (result_hash, encoded(usage), request_id))
            conn.execute("UPDATE background_jobs SET checkpoint_json=? WHERE id=?", (encoded(checkpoint), call["job_id"]))

    def mark_unknown(self, request_id: str, attempt: str, context: ExtensionContext) -> None:
        context.check_workspace()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            call = self._call(conn, request_id, attempt)
            if call["state"] == "reserved":
                conn.execute("UPDATE job_model_calls SET state='unknown' WHERE id=?", (request_id,))

    def start_activity(self, job_id: str, attempt: str, context: ExtensionContext) -> None:
        self._activity(job_id, attempt, context, operation="start")

    def refresh_activity(self, job_id: str, attempt: str, context: ExtensionContext) -> None:
        self._activity(job_id, attempt, context, operation="refresh")

    def stop_activity(self, job_id: str, attempt: str, context: ExtensionContext) -> None:
        self._activity(job_id, attempt, context, operation="stop")

    def _activity(self, job_id: str, attempt: str, context: ExtensionContext, *, operation: str) -> None:
        context.check_workspace()
        exceeded = False
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            # Closing a known-stopped interval is allowed after a cancellation
            # request. New reservations and results retain the strict fence.
            self.repository.assert_owner(conn, job_id, attempt, allow_cancel_requested=operation == "stop")
            budget = self._ensure(conn, job_id)
            now, seconds = self.clock(), budget["active_seconds"]
            if budget["active_started"] is not None:
                end = min(now, budget["active_until"]) if budget["active_attempt"] == attempt else budget["active_until"]
                seconds += max(0, end - budget["active_started"])
            until = conn.execute("SELECT lease_expires FROM background_jobs WHERE id=?", (job_id,)).fetchone()[0]
            stopped = operation == "stop"
            conn.execute("UPDATE job_model_budgets SET active_seconds=?,active_attempt=?,active_started=?,active_until=? WHERE job_id=?", (seconds, None if stopped else attempt, None if stopped else now, None if stopped else until, job_id))
            exceeded = not stopped and seconds >= budget["active_seconds_limit"]
        # Commit elapsed time even when raising. The pause path must be allowed
        # to settle activity without hitting this same check again.
        if exceeded:
            raise JobBudgetExceeded("活动执行时间预算已用完")

    def add_budget(self, job_id: str, stage_id: str, revision: int, answer: dict, context: ExtensionContext) -> dict:
        context.check_workspace()
        validate_answer(ADDITION_SCHEMA, answer)
        answer_hash = hashlib.sha256(encoded(answer).encode()).hexdigest()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self._ensure(conn, job_id)
            receipt = conn.execute("SELECT * FROM job_budget_confirmations WHERE job_id=? AND (stage_id=? OR idempotency_key=?)", (job_id, stage_id, answer["idempotency_key"])).fetchone()
            if receipt:
                if (receipt["stage_id"], receipt["revision"], receipt["answer_hash"]) != (stage_id, revision, answer_hash):
                    raise JobConflict("预算确认回执与原请求不匹配")
            else:
                job = conn.execute("SELECT status,stage_id,revision,checkpoint_json,cancel_requested FROM background_jobs WHERE id=?", (job_id,)).fetchone()
                checkpoint = json.loads(job["checkpoint_json"])
                if (job["status"], job["stage_id"], job["revision"]) != ("waiting_user", stage_id, revision) or job["cancel_requested"] or not checkpoint.get("budget_exhausted"):
                    raise JobConflict("预算确认页面已过期，请刷新当前任务")
                if conn.execute("SELECT 1 FROM job_model_calls WHERE job_id=? AND state<>'completed'", (job_id,)).fetchone():
                    raise JobConflict("模型请求结果待核对，不能用追加预算自动重放")
                addition = answer["budget"]
                conn.execute("UPDATE job_model_budgets SET calls_limit=calls_limit+?,input_tokens_limit=input_tokens_limit+?,output_tokens_limit=output_tokens_limit+?,active_seconds_limit=active_seconds_limit+? WHERE job_id=?", (*(addition[name] for name in DEFAULT_BUDGET), job_id))
                checkpoint.pop("budget_exhausted", None)
                confirmation = {"stage_id": stage_id, "revision": revision, "answer": answer}
                conn.execute("INSERT INTO job_budget_confirmations(job_id,stage_id,revision,idempotency_key,answer_hash) VALUES(?,?,?,?,?)", (job_id, stage_id, revision, answer["idempotency_key"], answer_hash))
                conn.execute("UPDATE background_jobs SET status='queued',confirmation_json=?,stage_id=NULL,prompt='',checkpoint_json=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", (encoded(confirmation), encoded(checkpoint), job_id))
                self.repository.event(conn, job_id, "confirmed", confirmation)
        return self.repository.get(job_id, context)
