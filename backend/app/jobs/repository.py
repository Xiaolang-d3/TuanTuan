from __future__ import annotations

import hashlib
import json
import time
import uuid

from ..db import connect
from ..extensions.contracts import ExtensionContext
from .confirmation import validate_answer, validate_schema


class JobNotFound(ValueError):
    pass


class JobConflict(ValueError):
    pass


class JobExecutionError(JobConflict):
    """Actionable, deliberately safe text authored by a trusted adapter."""


def encoded(value) -> str:
    result = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
    if len(result.encode()) > 100_000:
        raise ValueError("任务数据超过 100 KB")
    return result


def decode(row) -> dict:
    result = dict(row)
    for name in ("request", "snapshot", "checkpoint", "execution", "confirmation", "result", "answer_schema"):
        value = result.pop(name + "_json")
        result[name] = json.loads(value) if value is not None else None
    result["cancel_requested"] = bool(result["cancel_requested"])
    return result


def public_job(job: dict) -> dict:
    if job["kind"] == "ppt.quick_generate":
        return {key: job[key] for key in ("id", "kind", "status", "revision", "created_at", "updated_at", "error", "cancel_requested")} | {
            "request": {"topic": job["request"]["topic"], "conversation_id": job["request"]["conversation_id"]},
        }
    return {key: value for key, value in job.items() if key not in {"owner_token", "lease_expires", "snapshot", "execution"}}


class JobRepository:
    def __init__(self, *, clock=time.time, lease_seconds: float = 30):
        self.clock, self.lease_seconds = clock, lease_seconds

    def get(self, job_id: str, context: ExtensionContext) -> dict:
        context.check_workspace()
        with connect() as conn:
            row = conn.execute("SELECT * FROM background_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None:
            raise JobNotFound("任务不存在")
        return decode(row)

    def list(self, context: ExtensionContext) -> list[dict]:
        context.check_workspace()
        with connect() as conn:
            return [decode(row) for row in conn.execute("SELECT * FROM background_jobs ORDER BY created_at DESC, id DESC LIMIT 100")]

    def event(self, conn, job_id: str, kind: str, data: dict | None = None) -> None:
        conn.execute("INSERT INTO background_job_events(job_id,type,data_json) VALUES(?,?,?)", (job_id, kind, encoded(data or {})))

    def enqueue(self, kind: str, request: dict, snapshot: dict, context: ExtensionContext, idempotency_key: str) -> dict:
        context.check_workspace()
        if not idempotency_key or len(idempotency_key) > 128:
            raise ValueError("需要有效的幂等请求标识")
        serialized = encoded(request)
        identity = hashlib.sha256((kind + "\n" + serialized).encode()).hexdigest()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute("SELECT id,request_hash FROM background_jobs WHERE idempotency_key=?", (idempotency_key,)).fetchone()
            if existing:
                if existing["request_hash"] != identity:
                    raise JobConflict("相同请求标识不能用于不同任务内容")
                job_id = existing["id"]
            else:
                job_id = uuid.uuid4().hex
                conn.execute("INSERT INTO background_jobs(id,kind,idempotency_key,request_hash,request_json,snapshot_json,status) VALUES(?,?,?,?,?,?,'queued')", (job_id, kind, idempotency_key, identity, serialized, encoded(snapshot)))
                self.event(conn, job_id, "queued")
        return self.get(job_id, context)

    def claim(self, context: ExtensionContext) -> dict | None:
        context.check_workspace()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT id FROM background_jobs WHERE status='queued' AND cancel_requested=0 ORDER BY created_at,id LIMIT 1").fetchone()
            if row is None:
                return None
            job_id, token = row["id"], uuid.uuid4().hex
            conn.execute("UPDATE background_jobs SET status='running',owner_token=?,lease_expires=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", (token, self.clock() + self.lease_seconds, job_id))
            self.event(conn, job_id, "running")
        return self.get(job_id, context)

    def assert_owner(self, conn, job_id: str, token: str, *, allow_cancel_requested: bool = False) -> None:
        row = conn.execute("SELECT status,owner_token,lease_expires,cancel_requested FROM background_jobs WHERE id=?", (job_id,)).fetchone()
        if row is None or row["status"] != "running" or row["owner_token"] != token or row["lease_expires"] <= self.clock() or (row["cancel_requested"] and not allow_cancel_requested):
            raise JobConflict("任务租约已失效或已请求取消")

    def heartbeat(self, job_id: str, token: str, context: ExtensionContext) -> bool:
        context.check_workspace()
        with connect() as conn:
            updated = conn.execute("UPDATE background_jobs SET lease_expires=? WHERE id=? AND status='running' AND owner_token=? AND lease_expires>? AND cancel_requested=0", (self.clock() + self.lease_seconds, job_id, token, self.clock())).rowcount
        return bool(updated)

    def checkpoint(self, job_id: str, token: str, checkpoint: dict, context: ExtensionContext) -> None:
        context.check_workspace()
        serialized = encoded(checkpoint)
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.assert_owner(conn, job_id, token)
            conn.execute("UPDATE background_jobs SET checkpoint_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (serialized, job_id))

    def finish(self, job_id: str, token: str, result: dict, context: ExtensionContext) -> dict:
        context.check_workspace()
        serialized = encoded(result)
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.assert_owner(conn, job_id, token)
            conn.execute("UPDATE background_jobs SET status='succeeded',result_json=?,owner_token=NULL,lease_expires=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", (serialized, job_id))
            self.event(conn, job_id, "succeeded", {"result": result})
        return self.get(job_id, context)

    def wait_for_user(self, job_id: str, token: str, prompt: str, answer_schema: dict, context: ExtensionContext) -> dict:
        context.check_workspace()
        if not prompt or len(prompt) > 2000:
            raise ValueError("确认提示需要在 2000 字以内")
        validate_schema(answer_schema)
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.assert_owner(conn, job_id, token)
            stage_id = uuid.uuid4().hex
            conn.execute("UPDATE background_jobs SET status='waiting_user',stage_id=?,prompt=?,answer_schema_json=?,confirmation_json=NULL,owner_token=NULL,lease_expires=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", (stage_id, prompt, encoded(answer_schema), job_id))
            self.event(conn, job_id, "waiting_user", {"stage_id": stage_id, "prompt": prompt})
        return self.get(job_id, context)

    def confirm(self, job_id: str, stage_id: str, revision: int, answer: dict, context: ExtensionContext) -> dict:
        context.check_workspace()
        confirmation = {"stage_id": stage_id, "revision": revision, "answer": answer}
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status,stage_id,revision,answer_schema_json FROM background_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None or (row["status"], row["stage_id"], row["revision"]) != ("waiting_user", stage_id, revision):
                raise JobConflict("确认页面已过期或任务状态已经改变，请刷新后重试")
            validate_answer(json.loads(row["answer_schema_json"]), answer)
            updated = conn.execute("UPDATE background_jobs SET status='queued',confirmation_json=?,stage_id=NULL,prompt='',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='waiting_user' AND stage_id=? AND revision=? AND cancel_requested=0", (encoded(confirmation), job_id, stage_id, revision)).rowcount
            if not updated:
                raise JobConflict("确认页面已过期或任务状态已经改变，请刷新后重试")
            self.event(conn, job_id, "confirmed", confirmation)
        return self.get(job_id, context)

    def cancel(self, job_id: str, context: ExtensionContext) -> dict:
        self.get(job_id, context)
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status,cancel_requested,execution_json FROM background_jobs WHERE id=?", (job_id,)).fetchone()
            execution = json.loads(row["execution_json"])
            if row["status"] in {"queued", "waiting_user", "interrupted"} and execution and not execution.get("stopped"):
                if not row["cancel_requested"]:
                    conn.execute("UPDATE background_jobs SET cancel_requested=1,revision=revision+1 WHERE id=?", (job_id,))
                    self.event(conn, job_id, "cancel_requested")
            elif row["status"] in {"queued", "waiting_user", "interrupted"}:
                conn.execute("UPDATE background_jobs SET status='cancelled',cancel_requested=1,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", (job_id,))
                self.event(conn, job_id, "cancelled")
            elif row["status"] == "running" and not row["cancel_requested"]:
                conn.execute("UPDATE background_jobs SET cancel_requested=1,revision=revision+1 WHERE id=?", (job_id,))
                self.event(conn, job_id, "cancel_requested")
        return self.get(job_id, context)

    def release(self, job_id: str, token: str, status: str, error: str, context: ExtensionContext) -> None:
        context.check_workspace()
        if status not in {"failed", "cancelled", "interrupted"}:
            raise ValueError("不允许的释放状态")
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            updated = conn.execute("UPDATE background_jobs SET status=?,error=?,owner_token=NULL,lease_expires=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='running' AND owner_token=?", (status, error[:2000], job_id, token)).rowcount
            if updated:
                self.event(conn, job_id, status, {"error": error[:2000]})

    def interrupt_expired(self, context: ExtensionContext) -> None:
        context.check_workspace()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute("SELECT id,cancel_requested,execution_json FROM background_jobs WHERE status='running' AND lease_expires<=?", (self.clock(),)).fetchall()
            for row in rows:
                execution = json.loads(row["execution_json"])
                stopped = not execution or execution.get("stopped")
                status = "cancelled" if row["cancel_requested"] and stopped else "interrupted"
                conn.execute("UPDATE background_jobs SET status=?,owner_token=NULL,lease_expires=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?", (status, row["id"]))
                self.event(conn, row["id"], status, {"reason": "lease_expired"})

    def resume(self, job_id: str, context: ExtensionContext) -> dict:
        self.get(job_id, context)
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status,checkpoint_json,execution_json,cancel_requested FROM background_jobs WHERE id=?", (job_id,)).fetchone()
            execution = json.loads(row["execution_json"])
            if row["cancel_requested"] or (execution and not execution.get("stopped")):
                raise JobConflict("原执行环境尚未确认停止，请稍后刷新再恢复")
            if row["status"] != "interrupted" or json.loads(row["checkpoint_json"]).get("external_outcome") == "unknown":
                raise JobConflict("任务当前不能恢复，不能自动重试结果不明的外部操作")
            conn.execute("UPDATE background_jobs SET status='queued',cancel_requested=0,revision=revision+1 WHERE id=?", (job_id,))
            self.event(conn, job_id, "resumed")
        return self.get(job_id, context)

    def set_execution(self, job_id: str, token: str, execution: dict, context: ExtensionContext) -> None:
        context.check_workspace()
        if execution.get("attempt") != token:
            raise JobConflict("执行环境不属于当前任务租约")
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.assert_owner(conn, job_id, token)
            conn.execute("UPDATE background_jobs SET execution_json=? WHERE id=?", (encoded(execution), job_id))

    def mark_execution_stopped(self, job_id: str, attempt: str, context: ExtensionContext) -> None:
        context.check_workspace()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT execution_json,status,cancel_requested FROM background_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None: raise JobNotFound("任务不存在")
            execution = json.loads(row["execution_json"])
            if execution.get("attempt") != attempt:
                return
            execution["stopped"] = True
            conn.execute("UPDATE background_jobs SET execution_json=? WHERE id=?", (encoded(execution), job_id))
            if row["status"] != "running" and row["cancel_requested"]:
                conn.execute("UPDATE background_jobs SET status='cancelled',revision=revision+1 WHERE id=?", (job_id,))
                self.event(conn, job_id, "cancelled")

    def cleanup_candidates(self, context: ExtensionContext) -> list[dict]:
        context.check_workspace()
        with connect() as conn:
            rows = conn.execute("SELECT * FROM background_jobs WHERE status='interrupted' OR (cancel_requested=1 AND status IN ('queued','waiting_user')) LIMIT 100").fetchall()
        return [item for row in rows if (item := decode(row))["execution"] and not item["execution"].get("stopped")]

    def check_owner(self, job_id: str, token: str, context: ExtensionContext) -> None:
        context.check_workspace()
        with connect() as conn:
            self.assert_owner(conn, job_id, token)

    def events(self, job_id: str, context: ExtensionContext, *, after: int = 0) -> list[dict]:
        self.get(job_id, context)
        with connect() as conn:
            rows = conn.execute("SELECT cursor,type,data_json,created_at FROM background_job_events WHERE job_id=? AND cursor>? ORDER BY cursor LIMIT 200", (job_id, after)).fetchall()
        return [{"cursor": row["cursor"], "type": row["type"], "data": json.loads(row["data_json"]), "created_at": row["created_at"]} for row in rows]
