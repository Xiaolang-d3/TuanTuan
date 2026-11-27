from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..agent.snapshots import clear_run_snapshot
from ..db import connect, row_to_dict, rows_to_dicts
from ..library.project_scope import project_context
from ..agent.kernels.base import (
    DEFAULT_KERNEL,
    KERNEL_DSH,
    is_deepseek_model_name,
    is_dsh_safe_endpoint,
    is_valid_kernel,
    normalize_kernel,
)


FORK_CONTEXT_MESSAGE_LIMIT = 12
FORK_CONTEXT_MAX_CHARS = 12_000


def _dsh_profile_id(conn: Any, preferred_profile_id: str | None = None) -> str | None:
    rows = conn.execute(
        """
        SELECT profile.id, profile.model_name, connection.base_url, connection.effective_base_url
        FROM model_profiles AS profile
        JOIN model_connections AS connection ON connection.id = profile.connection_id
        WHERE profile.enabled = 1
          AND connection.enabled = 1
          AND (connection.deleted_at IS NULL OR connection.deleted_at = '')
        ORDER BY
            CASE WHEN profile.id = ? THEN 0 ELSE 1 END,
            CASE WHEN profile.id = (
                SELECT default_model_profile_id FROM agent_settings WHERE id = 1
            ) THEN 0 ELSE 1 END,
            profile.created_at ASC,
            profile.id ASC
        """,
        (preferred_profile_id,),
    ).fetchall()
    for row in rows:
        if (
            is_deepseek_model_name(row["model_name"])
            and (
                is_dsh_safe_endpoint(row["base_url"])
                or is_dsh_safe_endpoint(row["effective_base_url"])
            )
        ):
            return str(row["id"])
    return None


def _is_dsh_profile(conn: Any, profile_id: str) -> bool:
    row = conn.execute(
        """
        SELECT profile.model_name, connection.base_url, connection.effective_base_url
        FROM model_profiles AS profile
        JOIN model_connections AS connection ON connection.id = profile.connection_id
        WHERE profile.id = ?
          AND profile.enabled = 1
          AND connection.enabled = 1
          AND (connection.deleted_at IS NULL OR connection.deleted_at = '')
        """,
        (profile_id,),
    ).fetchone()
    return row is not None and is_deepseek_model_name(row["model_name"]) and (
        is_dsh_safe_endpoint(row["base_url"])
        or is_dsh_safe_endpoint(row["effective_base_url"])
    )


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
        scoped_ids = {row[0] for row in conn.execute("SELECT conversation_id FROM conversation_project_scopes WHERE project_id IS NOT NULL")}
        for conversation in conversations:
            if conversation["id"] in scoped_ids:
                conversation["project_context"] = project_context(conn, conversation["id"])
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
        return _conversation_result(conn, row)


def _conversation_result(conn, row):
    item = row_to_dict(row)
    if item is not None:
        context = project_context(conn, item["id"])
        if context is not None:
            item["project_context"] = context
    return item


def insert_conversation(conn, title: str, kernel: str, model_profile_id: str | None = None) -> int:
    cursor = conn.execute(
        "INSERT INTO conversations (title, kernel, model_profile_id) VALUES (?, ?, ?)",
        (title.strip()[:80] or "新对话", kernel, model_profile_id),
    )
    conversation_id = int(cursor.lastrowid)
    conn.execute("INSERT INTO conversation_tasks (conversation_id, title) VALUES (?, ?)", (conversation_id, "当前任务"))
    return conversation_id


def create_conversation(title: str = "新对话", db_path: str | Path | None = None, *, kernel: str = DEFAULT_KERNEL) -> dict:
    normalized_kernel = normalize_kernel(kernel)
    if not is_valid_kernel(kernel):
        raise ValueError("内核类型无效")
    with connect(db_path) as conn:
        model_profile_id = _dsh_profile_id(conn) if normalized_kernel == KERNEL_DSH else None
        conversation_id = insert_conversation(conn, title, normalized_kernel, model_profile_id)
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
    return row_to_dict(row)


def _fork_title(source_title: str) -> str:
    return f"{(source_title.strip() or '新对话')[:76]}（分支）"[:80]


def _fork_context_snapshot(source: Any, rows: list[Any]) -> str:
    summary = str(source["summary"] or "").strip()
    parts: list[str] = []
    if summary:
        parts.append(f"原对话摘要：{summary[:2400]}")
    has_attachments = False
    for row in rows:
        content = " ".join(str(row["content"] or "").split())
        if content:
            label = "用户" if row["role"] == "user" else "团团"
            parts.append(f"{label}：{content[:1600]}")
        try:
            payload = json.loads(row["payload_json"] or "{}")
        except (TypeError, ValueError, json.JSONDecodeError):
            payload = {}
        if isinstance(payload, dict) and payload.get("attachments"):
            has_attachments = True
    if has_attachments:
        parts.append("注：原对话中的附件没有继承；如需使用，请在新对话中重新添加。")
    return "\n".join(parts)[:FORK_CONTEXT_MAX_CHARS]


def fork_conversation(
    conversation_id: int,
    *,
    kernel: str,
    exclude_from_message_id: int | None = None,
    db_path: str | Path | None = None,
) -> dict:
    """Create an empty, kernel-pinned branch with a read-only text context seed."""
    if not is_valid_kernel(kernel):
        raise ValueError("内核类型无效")
    with connect(db_path) as conn:
        source = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        if source is None:
            raise ValueError("对话不存在")
        where = [
            "conversation_id = ?",
            "id > ?",
            "role IN ('user', 'assistant')",
        ]
        params: list[object] = [
            conversation_id,
            source["context_cutoff_message_id"],
        ]
        if exclude_from_message_id is not None:
            where.append("id < ?")
            params.append(exclude_from_message_id)
        params.append(FORK_CONTEXT_MESSAGE_LIMIT)
        rows = conn.execute(
            f"""
            SELECT id, role, content, payload_json FROM chat_messages
            WHERE {' AND '.join(where)}
            ORDER BY id DESC LIMIT ?
            """,
            params,
        ).fetchall()
        snapshot = _fork_context_snapshot(source, list(reversed(rows)))
        target_kernel = normalize_kernel(kernel)
        project_scope = conn.execute("SELECT project_id FROM conversation_project_scopes WHERE conversation_id = ?", (conversation_id,)).fetchone()
        if project_scope is not None and target_kernel != DEFAULT_KERNEL:
            raise ValueError("项目对话仅支持团团内核")
        target_profile_id = source["model_profile_id"]
        if target_kernel == KERNEL_DSH:
            target_profile_id = _dsh_profile_id(conn, source["model_profile_id"])
        fork_id = insert_conversation(conn, _fork_title(str(source["title"])), target_kernel, target_profile_id)
        if project_scope is not None:
            conn.execute("INSERT INTO conversation_project_scopes VALUES (?, ?)", (fork_id, project_scope["project_id"]))
            conn.execute("""
                INSERT INTO conversation_project_sources (conversation_id, source_id)
                SELECT ?, source_id FROM conversation_project_sources WHERE conversation_id = ?
            """, (fork_id, conversation_id))
        if snapshot:
            conn.execute(
                """
                INSERT INTO conversation_context_seeds
                    (conversation_id, source_conversation_id, content)
                VALUES (?, ?, ?)
                """,
                (fork_id, conversation_id, snapshot),
            )
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (fork_id,)
        ).fetchone()
        return _conversation_result(conn, row)


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
    with connect(db_path) as conn:
        existing = conn.execute(
            "SELECT kernel, model_profile_id FROM conversations WHERE id = ?",
            (conversation_id,),
        ).fetchone()
        if existing is None:
            return None
        if kernel_selected and conn.execute(
            "SELECT 1 FROM chat_messages WHERE conversation_id = ? LIMIT 1", (conversation_id,)
        ).fetchone():
            raise ValueError("对话已有消息，内核不可更改")
        effective_kernel = normalize_kernel(kernel) if kernel_selected else normalize_kernel(existing["kernel"])
        if kernel_selected and effective_kernel != DEFAULT_KERNEL and conn.execute(
            "SELECT 1 FROM conversation_project_scopes WHERE conversation_id = ?", (conversation_id,),
        ).fetchone():
            raise ValueError("项目对话仅支持团团内核")
        if effective_kernel == KERNEL_DSH and (kernel_selected or model_profile_selected):
            selected_profile_id = model_profile_id if model_profile_selected else _dsh_profile_id(
                conn, existing["model_profile_id"]
            )
            if selected_profile_id is None or not _is_dsh_profile(conn, selected_profile_id):
                raise ValueError("DSH 内核需要选择已启用的 DeepSeek 模型档案")
            if not model_profile_selected and selected_profile_id != existing["model_profile_id"]:
                fields.append("model_profile_id = ?")
                values.append(selected_profile_id)
        fields.append("updated_at = CURRENT_TIMESTAMP")
        conn.execute(
            f"UPDATE conversations SET {', '.join(fields)} WHERE id = ?",
            (*values, conversation_id),
        )
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
        ).fetchone()
        return _conversation_result(conn, row)


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
    from ..agent.memory.service import schedule_memory_extraction

    schedule_memory_extraction(conversation_id, db_path=db_path)
    reset_conversation_kernel_state(conversation_id, db_path)
    return row_to_dict(row)


def delete_conversation(conversation_id: int, db_path: str | Path | None = None) -> bool:
    reset_conversation_kernel_state(conversation_id, db_path)
    with connect(db_path) as conn:
        cursor = conn.execute("DELETE FROM conversations WHERE id = ?", (conversation_id,))
    return cursor.rowcount > 0


def reset_conversation_kernel_state(
    conversation_id: int, db_path: str | Path | None = None
) -> None:
    conversation = get_conversation(conversation_id, db_path)
    if conversation is None or normalize_kernel(conversation.get("kernel")) != KERNEL_DSH:
        return
    from ..agent.kernels.dsh.adapter import reset_dsh_conversation_state

    reset_dsh_conversation_state(conversation_id)


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
