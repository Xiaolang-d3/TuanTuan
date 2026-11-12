from __future__ import annotations

from pathlib import Path

from ..agent.snapshots import clear_run_snapshot
from ..db import connect, row_to_dict, rows_to_dicts
from ..agent.kernels.base import DEFAULT_KERNEL, is_valid_kernel, normalize_kernel


def list_conversations(db_path: str | Path | None = None, *, query: str | None = None) -> list[dict]:
    needle = (query or "").strip().casefold()[:200]
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT c.*,
                   COUNT(m.id) AS message_count,
                   MAX(m.created_at) AS last_message_at,
                   COALESCE((
                       SELECT status FROM conversation_tasks t
                       WHERE t.conversation_id = c.id
                       ORDER BY t.id DESC LIMIT 1
                   ), 'active') AS task_status
            FROM conversations c
            LEFT JOIN chat_messages m ON m.conversation_id = c.id
            GROUP BY c.id
            ORDER BY CASE WHEN c.status = 'active' THEN 0 ELSE 1 END,
                     COALESCE(MAX(m.created_at), c.updated_at) DESC,
                     c.id DESC
            """
        ).fetchall()
        conversations = rows_to_dicts(rows)
        if not needle:
            return conversations
        matched_ids = {
            row["conversation_id"]
            for row in conn.execute("SELECT conversation_id, content FROM chat_messages").fetchall()
            if needle in (row["content"] or "").casefold()
        }
    return [
        item for item in conversations
        if needle in f"{item.get('title') or ''} {item.get('summary') or ''}".casefold() or item["id"] in matched_ids
    ]


def get_conversation(conversation_id: int, db_path: str | Path | None = None) -> dict | None:
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
    return row_to_dict(row)


def create_conversation(title: str = "新对话", db_path: str | Path | None = None, *, kernel: str = DEFAULT_KERNEL) -> dict:
    clean_title = title.strip()[:80] or "新对话"
    normalized_kernel = normalize_kernel(kernel)
    if not is_valid_kernel(kernel):
        raise ValueError("内核类型无效")
    with connect(db_path) as conn:
        cursor = conn.execute(
            "INSERT INTO conversations (title, kernel) VALUES (?, ?)", (clean_title, normalized_kernel)
        )
        conversation_id = cursor.lastrowid
        conn.execute(
            "INSERT INTO conversation_tasks (conversation_id, title) VALUES (?, ?)",
            (conversation_id, "当前任务"),
        )
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
    return row_to_dict(row)


def ensure_active_task(conversation_id: int, db_path: str | Path | None = None) -> int:
    with connect(db_path) as conn:
        row = conn.execute(
            """
            SELECT id FROM conversation_tasks
            WHERE conversation_id = ? AND status = 'active'
            ORDER BY id DESC LIMIT 1
            """,
            (conversation_id,),
        ).fetchone()
        if row is not None:
            return row["id"]
        cursor = conn.execute(
            "INSERT INTO conversation_tasks (conversation_id, title) VALUES (?, ?)",
            (conversation_id, "当前任务"),
        )
        return cursor.lastrowid


def update_conversation(
    conversation_id: int,
    *,
    title: str | None = None,
    status: str | None = None,
    model_profile_id: str | None = None,
    model_profile_selected: bool = False,
    kernel: str | None = None,
    kernel_selected: bool = False,
    db_path: str | Path | None = None,
) -> dict | None:
    fields: list[str] = []
    values: list[object] = []
    if title is not None:
        fields.append("title = ?")
        values.append(title.strip()[:80] or "新对话")
    if status is not None:
        fields.append("status = ?")
        values.append(status)
    if model_profile_selected:
        if model_profile_id is not None:
            from ..agent.model_catalog import get_model_catalog

            catalog = get_model_catalog(db_path)
            enabled_connections = {item["id"] for item in catalog["connections"] if item["enabled"]}
            if not any(item["id"] == model_profile_id and item["enabled"] and item["connection_id"] in enabled_connections for item in catalog["profiles"]):
                raise ValueError("模型档案不存在或已停用")
        fields.append("model_profile_id = ?")
        values.append(model_profile_id)
    if kernel_selected:
        if not is_valid_kernel(kernel):
            raise ValueError("内核类型无效")
        fields.append("kernel = ?")
        values.append(normalize_kernel(kernel))
    if not fields:
        return get_conversation(conversation_id, db_path)
    fields.append("updated_at = CURRENT_TIMESTAMP")
    with connect(db_path) as conn:
        if kernel_selected and conn.execute(
            "SELECT 1 FROM chat_messages WHERE conversation_id = ? LIMIT 1", (conversation_id,)
        ).fetchone():
            raise ValueError("对话已有消息，内核不可更改")
        conn.execute(
            f"UPDATE conversations SET {', '.join(fields)} WHERE id = ?",
            (*values, conversation_id),
        )
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
    return row_to_dict(row)


def end_active_task(conversation_id: int, db_path: str | Path | None = None) -> bool:
    with connect(db_path) as conn:
        cursor = conn.execute(
            """
            UPDATE conversation_tasks
            SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE conversation_id = ? AND status = 'active'
            """,
            (conversation_id,),
        )
    return cursor.rowcount > 0


def reset_conversation_context(
    conversation_id: int, db_path: str | Path | None = None
) -> dict | None:
    with connect(db_path) as conn:
        latest = conn.execute(
            "SELECT COALESCE(MAX(id), 0) AS id FROM chat_messages WHERE conversation_id = ?",
            (conversation_id,),
        ).fetchone()["id"]
        cursor = conn.execute(
            """
            UPDATE conversations
            SET context_cutoff_message_id = ?, summary = '', updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (latest, conversation_id),
        )
        if cursor.rowcount == 0:
            return None
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
    end_active_task(conversation_id, db_path)
    clear_run_snapshot(conversation_id, db_path)
    return row_to_dict(row)


def delete_conversation(conversation_id: int, db_path: str | Path | None = None) -> bool:
    with connect(db_path) as conn:
        cursor = conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    return cursor.rowcount > 0


def maybe_title_from_first_message(
    conversation_id: int, content: str, db_path: str | Path | None = None
) -> None:
    with connect(db_path) as conn:
        conversation = conn.execute(
            "SELECT title FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        count = conn.execute(
            "SELECT COUNT(*) AS count FROM chat_messages WHERE conversation_id = ? AND role = 'user'",
            (conversation_id,),
        ).fetchone()["count"]
        if conversation and conversation["title"] in {"新对话", "历史对话"} and count <= 1:
            title = " ".join(content.strip().split())[:28] or "新对话"
            conn.execute(
                "UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (title, conversation_id),
            )
