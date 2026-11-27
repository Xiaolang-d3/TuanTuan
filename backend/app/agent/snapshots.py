from __future__ import annotations

import json
import sqlite3
from contextlib import nullcontext
from pathlib import Path

from pydantic import ValidationError

from ..db import connect
from ..domain import AgentRunSnapshot
from ..search_options import web_search_options_from_payload
from .model_binding import internal_model_selection


def save_run_snapshot(
    conversation_id: int,
    snapshot: AgentRunSnapshot,
    db_path: str | Path | None = None,
    *,
    connection: sqlite3.Connection | None = None,
) -> None:
    """Save a snapshot, using the caller's transaction when supplied."""
    payload = snapshot.model_dump_json()
    transaction = nullcontext(connection) if connection is not None else connect(db_path)
    with transaction as conn:
        conn.execute(
            """
            INSERT INTO agent_run_snapshots (conversation_id, snapshot_json)
            VALUES (?, ?)
            ON CONFLICT(conversation_id) DO UPDATE SET
                snapshot_json = excluded.snapshot_json,
                updated_at = CURRENT_TIMESTAMP
            """,
            (conversation_id, payload),
        )


def load_run_snapshot(
    conversation_id: int,
    db_path: str | Path | None = None,
) -> AgentRunSnapshot | None:
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT snapshot_json FROM agent_run_snapshots WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()
    if row is None:
        return None
    raw = row["snapshot_json"]
    if not raw:
        return None
    try:
        snapshot = AgentRunSnapshot.model_validate_json(raw)
    except (ValidationError, TypeError, ValueError):
        return None
    if snapshot.web_search_options is None:
        # Prefer a durable run's bound original message. A newer user turn can
        # exist while this snapshot survives a crash and must not grant consent.
        with connect(db_path) as conn:
            candidates = conn.execute(
                "SELECT user_message_id, checkpoint_json FROM agent_execution_runs WHERE conversation_id = ? AND status = 'waiting_user' AND resumed_by_run_id IS NULL ORDER BY updated_at DESC LIMIT 10",
                (conversation_id,),
            ).fetchall()
            message = None
            for candidate in candidates:
                try:
                    checkpoint = AgentRunSnapshot.model_validate_json(candidate["checkpoint_json"])
                except (ValidationError, TypeError, ValueError):
                    continue
                if (internal_model_selection(checkpoint.model_selection) != internal_model_selection(snapshot.model_selection)
                        or checkpoint.model_dump(exclude={"web_search_options", "model_selection"})
                        != snapshot.model_dump(exclude={"web_search_options", "model_selection"})):
                    continue
                message = conn.execute(
                    "SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ? AND role = 'user'",
                    (candidate["user_message_id"], conversation_id),
                ).fetchone()
                break
        original_user = next((item for item in reversed(snapshot.messages) if item.role == "user"), None)
        if message is not None:
            try:
                original_payload = json.loads(message["payload_json"] or "{}")
            except (TypeError, ValueError):
                original_payload = None
        else:
            original_payload = original_user.payload if original_user is not None else None
        options = web_search_options_from_payload(
            original_payload,
        )
        snapshot = snapshot.model_copy(update={"web_search_options": options})
    return snapshot


def clear_run_snapshot(
    conversation_id: int,
    db_path: str | Path | None = None,
    *,
    connection: sqlite3.Connection | None = None,
) -> None:
    """Clear a snapshot, using the caller's transaction when supplied."""
    transaction = nullcontext(connection) if connection is not None else connect(db_path)
    with transaction as conn:
        conn.execute(
            "DELETE FROM agent_run_snapshots WHERE conversation_id = ?",
            (conversation_id,),
        )
