from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from pydantic import ValidationError

from ..db import connect
from ..domain import AgentRunResult, AgentRunSnapshot, ToolCall, ToolError, ToolResult
from ..search_options import WebSearchOptions, web_search_options_from_payload
from ..tooling import ToolSpec
from .model_binding import internal_model_selection


TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled"})
REPLAYABLE_RUN_STATUSES = TERMINAL_RUN_STATUSES | {"waiting_user"}
SAFE_RETRY_RISKS = frozenset({"read_only", "derived_analysis", "external_read"})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _parse_timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed
    except (TypeError, ValueError):
        return None


@dataclass(frozen=True)
class ToolExecutionDecision:
    action: Literal["execute", "replay", "block"]
    result: ToolResult | None = None


def _safe_row_to_dict(row: Any) -> dict[str, Any] | None:
    """Decode a SQLite row without letting stale or truncated JSON fail the request."""
    if row is None:
        return None
    decoded: dict[str, Any] = dict(row)
    for key, value in list(decoded.items()):
        if not key.endswith("_json"):
            continue
        name = key.removesuffix("_json")
        del decoded[key]
        if value is None:
            decoded[name] = None
            continue
        if not isinstance(value, str) or not value.strip():
            decoded[name] = None
            continue
        try:
            decoded[name] = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            decoded[name] = None
            decoded[f"{name}_invalid"] = True
    return decoded


class AgentRunStore:
    """SQLite-backed run, checkpoint and tool-idempotency ledger."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        self._db_path = db_path

    @property
    def db_path(self) -> str | Path | None:
        return self._db_path

    def start_run(
        self,
        run_id: str,
        *,
        conversation_id: int | None,
        task_id: int | None,
        user_content: str,
        model_selection: dict[str, Any] | None = None,
        web_search_options: WebSearchOptions | None = None,
        kernel: str = "tuantuan",
    ) -> dict:
        with connect(self._db_path) as conn:
            conn.execute(
                """
                INSERT INTO agent_execution_runs
                    (run_id, conversation_id, task_id, user_content, status, kernel, model_selection_json, checkpoint_json)
                VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)
                ON CONFLICT(run_id) DO NOTHING
                """,
                (run_id, conversation_id, task_id, user_content, kernel, json.dumps(internal_model_selection(model_selection)),
                 json.dumps({"binding_only": True, "web_search_options": web_search_options.model_dump()})
                 if web_search_options is not None else "{}"),
            )
            row = conn.execute(
                "SELECT * FROM agent_execution_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError("Agent run 创建失败")
            if (
                row["conversation_id"] is not None
                and conversation_id is not None
                and int(row["conversation_id"]) != conversation_id
            ):
                raise ValueError("run_id 已属于其他对话")
            stored_selection = _safe_row_to_dict(row).get("model_selection") or {}
            if model_selection and stored_selection and internal_model_selection(model_selection) != stored_selection:
                raise ValueError("run_id 已绑定其他模型配置，不能重新选择")
            if row["status"] in {"queued", "interrupted"}:
                conn.execute(
                    """
                    UPDATE agent_execution_runs
                    SET status = 'running', started_at = COALESCE(started_at, ?),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE run_id = ?
                    """,
                    (_utc_now(), run_id),
                )
                row = conn.execute(
                    "SELECT * FROM agent_execution_runs WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
        return self._decode_run_with_search_options(_safe_row_to_dict(row))

    def get_run(self, run_id: str) -> dict | None:
        with connect(self._db_path) as conn:
            row = conn.execute(
                "SELECT * FROM agent_execution_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        return self._decode_run_with_search_options(_safe_row_to_dict(row)) if row is not None else None

    def latest_for_conversation(self, conversation_id: int) -> dict | None:
        with connect(self._db_path) as conn:
            row = conn.execute(
                """
                SELECT * FROM agent_execution_runs
                WHERE conversation_id = ? ORDER BY updated_at DESC LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
        return self._decode_run_with_search_options(_safe_row_to_dict(row)) if row is not None else None

    def _decode_run_with_search_options(self, raw: dict) -> dict:
        run = self._decode_run(raw)
        if run["web_search_options"] is None and run.get("user_message_id"):
            with connect(self._db_path) as conn:
                row = conn.execute(
                    "SELECT payload_json FROM chat_messages WHERE id = ? AND conversation_id = ? AND role = 'user'",
                    (run["user_message_id"], run.get("conversation_id")),
                ).fetchone()
            if row is not None:
                payload = _safe_row_to_dict(row).get("payload")
                run["web_search_options"] = web_search_options_from_payload(payload)
        return run

    def list_steps(self, run_id: str) -> list[dict]:
        with connect(self._db_path) as conn:
            rows = conn.execute(
                """
                SELECT * FROM agent_run_steps
                WHERE run_id = ? ORDER BY position, id
                """,
                (run_id,),
            ).fetchall()
        return [_safe_row_to_dict(row) for row in rows]

    def list_tool_executions(self, run_id: str) -> list[dict]:
        with connect(self._db_path) as conn:
            rows = conn.execute(
                """
                SELECT * FROM agent_tool_executions
                WHERE run_id = ? ORDER BY id
                """,
                (run_id,),
            ).fetchall()
        return [_safe_row_to_dict(row) for row in rows]

    def bind_messages(
        self,
        run_id: str,
        *,
        user_message_id: int | None = None,
        assistant_message_id: int | None = None,
    ) -> None:
        with connect(self._db_path) as conn:
            conn.execute(
                """
                UPDATE agent_execution_runs
                SET user_message_id = COALESCE(user_message_id, ?),
                    assistant_message_id = COALESCE(assistant_message_id, ?),
                    updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ?
                """,
                (user_message_id, assistant_message_id, run_id),
            )

    def checkpoint(
        self,
        run_id: str,
        snapshot: AgentRunSnapshot,
    ) -> None:
        existing = self.get_run(run_id)
        original_options = existing.get("web_search_options") if existing is not None else None
        snapshot = snapshot.model_copy(update={
            "model_selection": internal_model_selection(snapshot.model_selection),
            "web_search_options": original_options or snapshot.web_search_options,
        })
        with connect(self._db_path) as conn:
            updated = conn.execute(
                """
                UPDATE agent_execution_runs
                SET status = 'running', route_kind = ?, round_number = ?,
                    checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ? AND status IN ('queued', 'running', 'interrupted')
                """,
                (
                    snapshot.route_kind,
                    snapshot.rounds_used,
                    snapshot.model_dump_json(),
                    run_id,
                ),
            )
            if snapshot.plan is not None and updated.rowcount > 0:
                for position, step in enumerate(snapshot.plan.steps):
                    conn.execute(
                        """
                        INSERT INTO agent_run_steps
                            (run_id, step_id, position, title, tool_name, risk, status,
                             started_at, completed_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?,
                                CASE WHEN ? != 'pending' THEN CURRENT_TIMESTAMP ELSE NULL END,
                                CASE WHEN ? IN ('done', 'failed', 'blocked')
                                     THEN CURRENT_TIMESTAMP ELSE NULL END)
                        ON CONFLICT(run_id, step_id) DO UPDATE SET
                            position = excluded.position,
                            title = excluded.title,
                            tool_name = excluded.tool_name,
                            risk = excluded.risk,
                            status = excluded.status,
                            started_at = COALESCE(agent_run_steps.started_at, excluded.started_at),
                            completed_at = excluded.completed_at,
                            updated_at = CURRENT_TIMESTAMP
                        """,
                        (
                            run_id,
                            step.id,
                            position,
                            step.title,
                            step.tool_name,
                            step.risk,
                            step.status,
                            step.status,
                            step.status,
                        ),
                    )

    def finish(self, run_id: str, result: AgentRunResult) -> None:
        with connect(self._db_path) as conn:
            # Serialize the timestamp read with its write so concurrent finish
            # calls cannot replace the first recorded completion time.
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT status, started_at, completed_at, result_json, checkpoint_json FROM agent_execution_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row is not None:
                stored_result = self._decode_model(AgentRunResult, _safe_row_to_dict(row).get("result"))
                started_at = _parse_timestamp(row["started_at"])
                reuse_completion = row["status"] in TERMINAL_RUN_STATUSES or (
                    row["status"] == "waiting_user" and result.status == "waiting_user"
                )
                previous_completion = (row["completed_at"] or (
                    stored_result.completed_at if stored_result is not None else None
                )) if reuse_completion else None
                completed_at = _parse_timestamp(previous_completion) or _parse_timestamp(_utc_now())
                if completed_at is not None:
                    result.completed_at = completed_at.isoformat(timespec="milliseconds")
                if started_at is not None and completed_at is not None:
                    # Keep the runtime result and persisted terminal message in sync.
                    result.started_at = started_at.isoformat(timespec="milliseconds")
                    result.duration_ms = max(0, round((completed_at - started_at).total_seconds() * 1000))
            result = result.model_copy(update={
                "model_selection": internal_model_selection(result.model_selection),
                "snapshot": (result.snapshot.model_copy(update={
                    "model_selection": internal_model_selection(result.snapshot.model_selection),
                }) if result.snapshot is not None else None),
            })
            status = {
                "done": "completed",
                "failed": "failed",
                "waiting_user": "waiting_user",
                "cancelled": "cancelled",
            }[result.status]
            checkpoint_json = (
                result.snapshot.model_dump_json() if result.snapshot is not None else None
            )
            if checkpoint_json is None and row is not None:
                original_checkpoint = _safe_row_to_dict(row).get("checkpoint")
                if isinstance(original_checkpoint, dict) and original_checkpoint.get("web_search_options") is not None:
                    checkpoint_json = json.dumps({
                        "binding_only": True,
                        "web_search_options": web_search_options_from_payload(original_checkpoint).model_dump(),
                    })
            conn.execute(
                """
                UPDATE agent_execution_runs
                SET status = ?, round_number = ?, result_json = ?, stop_reason = ?,
                    checkpoint_json = COALESCE(?, checkpoint_json),
                    completed_at = CASE
                        WHEN ? IN ('completed', 'failed', 'cancelled')
                        THEN ? ELSE NULL END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ?
                """,
                (
                    status,
                    result.rounds,
                    result.model_dump_json(),
                    result.stop_reason,
                    checkpoint_json,
                    status,
                    result.completed_at,
                    run_id,
                ),
            )

    def load_checkpoint(self, run_id: str) -> AgentRunSnapshot | None:
        run = self.get_run(run_id)
        checkpoint = run.get("checkpoint") if run else None
        return checkpoint if isinstance(checkpoint, AgentRunSnapshot) else None

    def load_result(self, run_id: str) -> AgentRunResult | None:
        run = self.get_run(run_id)
        result = run.get("result") if run else None
        return result if isinstance(result, AgentRunResult) else None

    def request_cancel(self, run_id: str) -> bool:
        with connect(self._db_path) as conn:
            changed = conn.execute(
                """
                UPDATE agent_execution_runs
                SET cancel_requested = 1, updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ?
                  AND status IN ('queued', 'running', 'waiting_user', 'interrupted')
                """,
                (run_id,),
            ).rowcount
        return bool(changed)

    def request_cancel_for_conversation(self, conversation_id: int) -> bool:
        with connect(self._db_path) as conn:
            row = conn.execute(
                """
                SELECT run_id FROM agent_execution_runs
                WHERE conversation_id = ?
                  AND status IN ('queued', 'running', 'waiting_user', 'interrupted')
                ORDER BY updated_at DESC LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
        return self.request_cancel(str(row["run_id"])) if row is not None else False

    def link_waiting_resume(self, conversation_id: int, resumed_by_run_id: str) -> str | None:
        with connect(self._db_path) as conn:
            row = conn.execute(
                """
                SELECT run_id FROM agent_execution_runs
                WHERE conversation_id = ? AND status = 'waiting_user'
                  AND resumed_by_run_id IS NULL AND run_id != ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (conversation_id, resumed_by_run_id),
            ).fetchone()
            if row is None:
                return None
            parent_run_id = str(row["run_id"])
            conn.execute(
                """
                UPDATE agent_execution_runs
                SET resumed_by_run_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ?
                """,
                (resumed_by_run_id, parent_run_id),
            )
            conn.execute(
                """
                UPDATE agent_execution_runs
                SET parent_run_id = ?, updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ?
                """,
                (parent_run_id, resumed_by_run_id),
            )
        return parent_run_id

    def is_cancel_requested(self, run_id: str) -> bool:
        with connect(self._db_path) as conn:
            row = conn.execute(
                "SELECT cancel_requested FROM agent_execution_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        return bool(row and row["cancel_requested"])

    def interrupt_active_runs(self) -> int:
        with connect(self._db_path) as conn:
            changed = conn.execute(
                """
                UPDATE agent_execution_runs
                SET status = 'interrupted', stop_reason = 'process_interrupted',
                    updated_at = CURRENT_TIMESTAMP
                WHERE status IN ('queued', 'running')
                """
            ).rowcount
            conn.execute(
                """
                UPDATE agent_tool_executions
                SET status = 'interrupted', updated_at = CURRENT_TIMESTAMP
                WHERE status = 'running'
                  AND run_id IN (
                      SELECT run_id FROM agent_execution_runs WHERE status = 'interrupted'
                  )
                """
            )
        return int(changed)

    def interrupted_write_result(self, run_id: str) -> ToolResult | None:
        with connect(self._db_path) as conn:
            risks = tuple(sorted(SAFE_RETRY_RISKS))
            placeholders = ", ".join("?" for _ in risks)
            rows = conn.execute(
                f"""
                SELECT DISTINCT tool_name FROM agent_tool_executions
                WHERE run_id = ? AND status IN ('running', 'interrupted')
                  AND risk NOT IN ({placeholders})
                LIMIT 2
                """,
                (run_id, *risks),
            ).fetchall()
        if not rows:
            return None
        return self._uncertain_write_result(rows[0]["tool_name"] if len(rows) == 1 else None)

    def prepare_tool_call(
        self,
        run_id: str,
        fingerprint: str,
        tool_call: ToolCall,
        spec: ToolSpec,
    ) -> ToolExecutionDecision:
        with connect(self._db_path) as conn:
            row = conn.execute(
                """
                SELECT * FROM agent_tool_executions
                WHERE run_id = ? AND fingerprint = ?
                """,
                (run_id, fingerprint),
            ).fetchone()
            if row is None:
                conn.execute(
                    """
                    INSERT INTO agent_tool_executions
                        (run_id, fingerprint, tool_call_id, tool_name, arguments_json, risk)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        fingerprint,
                        tool_call.id,
                        tool_call.name,
                        json.dumps(tool_call.arguments, ensure_ascii=False, sort_keys=True),
                        spec.risk,
                    ),
                )
                return ToolExecutionDecision("execute")

            status = str(row["status"])
            stored = self._decode_tool_result(str(row["result_json"] or ""))
            if status == "done" and stored is not None:
                return ToolExecutionDecision("replay", self._replayed_result(stored))
            if status in {"waiting_approval", "blocked"} and stored is not None:
                return ToolExecutionDecision("replay", stored)
            if status == "failed" and spec.risk not in SAFE_RETRY_RISKS:
                return ToolExecutionDecision("replay", stored or self._uncertain_write_result(tool_call.name))
            if status in {"running", "interrupted"} and spec.risk not in SAFE_RETRY_RISKS:
                return ToolExecutionDecision("block", self._uncertain_write_result(tool_call.name))

            conn.execute(
                """
                UPDATE agent_tool_executions
                SET status = 'running', tool_call_id = ?, attempt_count = attempt_count + 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ? AND fingerprint = ?
                """,
                (tool_call.id, run_id, fingerprint),
            )
        return ToolExecutionDecision("execute")

    def record_tool_result(
        self,
        run_id: str,
        fingerprint: str,
        result: ToolResult,
    ) -> None:
        with connect(self._db_path) as conn:
            conn.execute(
                """
                UPDATE agent_tool_executions
                SET status = ?, result_json = ?,
                    completed_at = CASE WHEN ? != 'running' THEN CURRENT_TIMESTAMP ELSE NULL END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE run_id = ? AND fingerprint = ?
                """,
                (
                    result.status,
                    result.model_dump_json(),
                    result.status,
                    run_id,
                    fingerprint,
                ),
            )

    @staticmethod
    def _decode_model(model: type, raw: Any) -> Any | None:
        if not isinstance(raw, dict) or not raw:
            return None
        try:
            return model.model_validate(raw)
        except (ValidationError, TypeError, ValueError):
            return None

    @classmethod
    def _decode_run(cls, run: dict | None) -> dict | None:
        if run is None:
            return None
        for field in ("started_at", "completed_at"):
            timestamp = _parse_timestamp(run.get(field))
            if timestamp is not None:
                run[field] = timestamp.isoformat(timespec="milliseconds")
        raw_checkpoint = run.get("checkpoint")
        raw_result = run.get("result")
        binding_only = isinstance(raw_checkpoint, dict) and raw_checkpoint.get("binding_only") is True
        checkpoint = None if binding_only else cls._decode_model(AgentRunSnapshot, raw_checkpoint)
        result = cls._decode_model(AgentRunResult, raw_result)
        run["checkpoint"] = checkpoint
        run["result"] = result
        run["checkpoint_invalid"] = bool(run.get("checkpoint_invalid")) or (
            not binding_only and isinstance(raw_checkpoint, dict) and bool(raw_checkpoint) and checkpoint is None
        )
        run["result_invalid"] = bool(run.get("result_invalid")) or (
            isinstance(raw_result, dict) and bool(raw_result) and result is None
        )
        run["cancel_requested"] = bool(run.get("cancel_requested"))
        options_payload = raw_checkpoint if isinstance(raw_checkpoint, dict) and raw_checkpoint.get("web_search_options") is not None else None
        if options_payload is None and result is not None and result.snapshot is not None:
            options_payload = {"web_search_options": result.snapshot.web_search_options} if result.snapshot.web_search_options is not None else None
        run["web_search_options"] = web_search_options_from_payload(options_payload) if options_payload is not None else None
        if not isinstance(run.get("model_selection"), dict):
            if run.get("model_selection") is not None:
                run["model_selection_invalid"] = True
            run["model_selection"] = {}
        return run

    @staticmethod
    def _decode_tool_result(raw: str) -> ToolResult | None:
        if not raw:
            return None
        try:
            return ToolResult.model_validate_json(raw)
        except (ValidationError, TypeError, ValueError):
            return None

    @staticmethod
    def _replayed_result(result: ToolResult) -> ToolResult:
        return result.model_copy(
            update={"data": {**result.data, "idempotent_replay": True}}
        )

    @staticmethod
    def _uncertain_write_result(tool_name: str | None) -> ToolResult:
        destination = (
            "文件库 → 知识中的待确认和已确认记录"
            if tool_name == "propose_library_knowledge"
            else "本次操作的目标位置"
        )
        message = (
            "上次写入中断，无法确认是否已保存。为避免重复写入，系统不会自动重试。"
            f"请先到{destination}核对。如果已保存，无需再次提交；确认缺失后，再单独提交缺失的内容。"
        )
        return ToolResult(
            ok=False,
            status="blocked",
            data={"status": "blocked", "uncertain_previous_execution": True},
            message=message,
            error=ToolError(
                code="tool_execution_uncertain",
                message=message,
                retryable=False,
            ),
        )
