from __future__ import annotations

import sqlite3
from typing import Any
from ag_ui.core import RunAgentInput
from fastapi import HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse, Response
from pydantic import ValidationError
from .dependencies import require_conversation
from ..chat.contracts import ChatMessageIn, RestoreChatMessagesIn
from ..chat.conversations import end_active_task, reset_conversation_kernel_state
from ..db import connect, json_dump, row_to_dict, rows_to_dicts
from ..agent.snapshots import clear_run_snapshot
from ..chat.service import (
    default_conversation_id as _default_conversation_id,
    refresh_conversation_summary as _refresh_conversation_summary,
)
from fastapi import APIRouter
from ..chat import execution
from ..chat.execution import stream_chat_response, is_chat_running
from ..chat.artifacts import ArtifactConflict, SaveArtifactIn, message_artifacts, save_artifact
from ..chat.image_assets import with_generation_prompts


from ..chat.image_editing import ImageEditIn, edit_generated_image
from ..models import ModelProviderError
from ..secret_store import SecretStoreUnavailable

router = APIRouter()


@router.get("/chat-assets/{asset_id}/file")
def generated_image_file(asset_id: str):
    from ..chat.image_assets import asset_file
    try:
        path, filename, mime = asset_file(asset_id)
        return FileResponse(path, filename=filename, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/chat-assets/{asset_id}/thumbnail")
def generated_image_thumbnail(asset_id: str):
    from ..chat.image_assets import asset_thumbnail
    try:
        return Response(asset_thumbnail(asset_id), media_type="image/webp", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except (ValueError, OSError) as exc:
        raise HTTPException(status_code=404, detail="生成图片预览不可用") from exc


@router.get("/chat/messages/{message_id}/artifacts")
def chat_message_artifacts(message_id: int) -> dict[str, Any]:
    try:
        return message_artifacts(message_id)
    except ValueError as exc:
        raise HTTPException(status_code=409 if isinstance(exc, ArtifactConflict) else 404, detail=str(exc)) from exc


@router.post("/chat/messages/{message_id}/save-to-library")
def chat_message_save(message_id: int, payload: SaveArtifactIn) -> dict[str, Any]:
    try:
        return save_artifact(message_id, payload)
    except ValueError as exc:
        code = 409 if isinstance(exc, ArtifactConflict) else 404 if str(exc) == "消息不存在" else 422
        raise HTTPException(status_code=code, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=503, detail="本地文件保存失败，请检查磁盘空间后重试") from exc


@router.get("/chat/messages")
def list_chat_messages(conversation_id: int | None = None) -> list[dict[str, Any]]:
    resolved_id = conversation_id or _default_conversation_id()
    require_conversation(resolved_id)
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC",
            (resolved_id,),
        ).fetchall()
    return with_generation_prompts(rows_to_dicts(rows), resolved_id)


@router.delete("/chat/messages/{message_id}/tail")
def rewind_chat_messages(message_id: int, conversation_id: int | None = None) -> dict[str, Any]:
    """Remove a user turn and everything after it before editing or regenerating."""
    resolved_id = conversation_id or _default_conversation_id()
    require_conversation(resolved_id)
    if is_chat_running(resolved_id):
        raise HTTPException(status_code=409, detail="请先停止当前生成任务")

    with connect() as conn:
        message = conn.execute(
            "SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?",
            (message_id, resolved_id),
        ).fetchone()
        if message is None:
            raise HTTPException(status_code=404, detail="消息不存在")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="只能从用户消息开始回退")
        removed = _delete_message_range(conn, resolved_id, message_id, None)
        conversation = conn.execute(
            "SELECT title FROM conversations WHERE id = ?", (resolved_id,)
        ).fetchone()
        previous_title = conversation["title"] if conversation else None
        generated_title = " ".join(message["content"].strip().split())[:28] or "新对话"
        next_title = "新对话" if conversation and conversation["title"] == generated_title else conversation["title"]
        conn.execute(
            """
            UPDATE conversations
            SET title = ?, context_cutoff_message_id = MIN(context_cutoff_message_id, ?),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (next_title, max(message_id - 1, 0), resolved_id),
        )

    end_active_task(resolved_id)
    clear_run_snapshot(resolved_id)
    reset_conversation_kernel_state(resolved_id)
    _refresh_conversation_summary(resolved_id)
    return {
        "rewound": True,
        "deleted": len(removed),
        "source_message": row_to_dict(message),
        "messages": removed,
        "previous_title": previous_title,
    }


@router.delete("/chat/messages/{message_id}/turn")
def delete_chat_turn(message_id: int, conversation_id: int | None = None) -> dict[str, Any]:
    """Delete one user question and the assistant replies before the next user message."""
    resolved_id = conversation_id or _default_conversation_id()
    require_conversation(resolved_id)
    if is_chat_running(resolved_id):
        raise HTTPException(status_code=409, detail="请先停止当前生成任务")

    with connect() as conn:
        message = conn.execute(
            "SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?",
            (message_id, resolved_id),
        ).fetchone()
        if message is None:
            raise HTTPException(status_code=404, detail="消息不存在")
        if message["role"] != "user":
            raise HTTPException(status_code=400, detail="只能删除用户消息所在的一轮")
        nxt = conn.execute(
            """
            SELECT id FROM chat_messages
            WHERE conversation_id = ? AND id > ? AND role = 'user'
            ORDER BY id ASC LIMIT 1
            """,
            (resolved_id, message_id),
        ).fetchone()
        end_exclusive = nxt["id"] if nxt else None
        removed = _delete_message_range(conn, resolved_id, message_id, end_exclusive)
        if end_exclusive is None:
            conversation = conn.execute(
                "SELECT title FROM conversations WHERE id = ?", (resolved_id,)
            ).fetchone()
            generated_title = " ".join(message["content"].strip().split())[:28] or "新对话"
            next_title = "新对话" if conversation and conversation["title"] == generated_title else conversation["title"]
            conn.execute(
                """
                UPDATE conversations
                SET title = ?, context_cutoff_message_id = MIN(context_cutoff_message_id, ?),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (next_title, max(message_id - 1, 0), resolved_id),
            )

    if end_exclusive is None:
        end_active_task(resolved_id)
    clear_run_snapshot(resolved_id)
    reset_conversation_kernel_state(resolved_id)
    _refresh_conversation_summary(resolved_id)
    return {"deleted": len(removed), "messages": removed}


@router.post("/chat/messages/restore")
def restore_chat_messages(payload: RestoreChatMessagesIn) -> dict[str, Any]:
    """Write previously rewound text rows back by their original ids."""
    require_conversation(payload.conversation_id)
    if is_chat_running(payload.conversation_id):
        raise HTTPException(status_code=409, detail="请先停止当前生成任务")
    ids = [item.id for item in payload.messages]
    if len(ids) != len(set(ids)):
        raise HTTPException(status_code=422, detail="消息 ID 不能重复")
    start = min(ids)
    from ..chat.image_assets import delete_images
    delete_images(payload.conversation_id, message_cutoff=start)
    try:
        with connect() as conn:
            conn.execute(
                "DELETE FROM chat_messages WHERE conversation_id = ? AND id >= ?",
                (payload.conversation_id, start),
            )
            existing_tasks = {
                row["id"]
                for row in conn.execute(
                    "SELECT id FROM conversation_tasks WHERE conversation_id = ?",
                    (payload.conversation_id,),
                ).fetchall()
            }
            for item in sorted(payload.messages, key=lambda message: message.id):
                created_at = item.created_at.strip() if item.created_at else None
                conn.execute(
                    """
                    INSERT INTO chat_messages
                        (id, conversation_id, task_id, role, content, payload_json, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
                    """,
                    (
                        item.id,
                        payload.conversation_id,
                        item.task_id if item.task_id in existing_tasks else None,
                        item.role,
                        item.content,
                        json_dump(item.payload or {}),
                        created_at or None,
                    ),
                )
            if payload.previous_title is not None:
                title = payload.previous_title.strip()[:80] or "新对话"
                conn.execute(
                    "UPDATE conversations SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (title, payload.conversation_id),
                )
    except sqlite3.IntegrityError as exc:
        raise HTTPException(status_code=409, detail="这些消息无法按原编号恢复") from exc
    clear_run_snapshot(payload.conversation_id)
    reset_conversation_kernel_state(payload.conversation_id)
    _refresh_conversation_summary(payload.conversation_id)
    return {"restored": len(payload.messages)}


def _delete_message_range(conn, conversation_id: int, start_id: int, end_exclusive: int | None) -> list[dict[str, Any]]:
    if end_exclusive is None:
        rows = conn.execute(
            "SELECT * FROM chat_messages WHERE conversation_id = ? AND id >= ? ORDER BY id ASC",
            (conversation_id, start_id),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT * FROM chat_messages
            WHERE conversation_id = ? AND id >= ? AND id < ?
            ORDER BY id ASC
            """,
            (conversation_id, start_id, end_exclusive),
        ).fetchall()
    from ..chat.image_assets import delete_images
    delete_images(conversation_id, message_cutoff=start_id, message_before=end_exclusive)
    if end_exclusive is None:
        conn.execute(
            "DELETE FROM chat_messages WHERE conversation_id = ? AND id >= ?",
            (conversation_id, start_id),
        )
    else:
        conn.execute(
            "DELETE FROM chat_messages WHERE conversation_id = ? AND id >= ? AND id < ?",
            (conversation_id, start_id, end_exclusive),
        )
    return rows_to_dicts(rows)


def _ag_ui_message_content(payload: RunAgentInput) -> str:
    for message in reversed(payload.messages):
        if message.role != "user":
            continue
        if isinstance(message.content, str):
            return message.content.strip()
        text_parts = []
        for part in message.content:
            if getattr(part, "type", None) == "text":
                text_parts.append(getattr(part, "text", ""))
        return "\n".join(text_parts).strip()
    return ""


def _ag_ui_attachment_ids(payload: RunAgentInput) -> list[str]:
    forwarded = payload.forwarded_props or {}
    raw_ids = forwarded.get("attachmentIds", []) if isinstance(forwarded, dict) else []
    if not isinstance(raw_ids, list) or any(not isinstance(item, str) for item in raw_ids):
        raise HTTPException(status_code=422, detail="attachmentIds 必须是附件 ID 数组")
    return raw_ids[:8]


def _ag_ui_vision_attachment_ids(payload: RunAgentInput) -> list[str]:
    forwarded = payload.forwarded_props or {}
    raw_ids = forwarded.get("visionAttachmentIds", []) if isinstance(forwarded, dict) else []
    if not isinstance(raw_ids, list) or any(not isinstance(item, str) for item in raw_ids):
        raise HTTPException(status_code=422, detail="visionAttachmentIds 必须是附件 ID 数组")
    return raw_ids[:4]


def _ag_ui_web_search_fields(payload: RunAgentInput) -> dict[str, Any]:
    forwarded = payload.forwarded_props or {}
    if not isinstance(forwarded, dict):
        return {}
    mapping = {
        "webSearch": "web_search",
        "webSearchMode": "web_search_mode",
        "webSearchTopic": "web_search_topic",
        "webSearchSourcePreference": "web_search_source_preference",
        "webSearchProvider": "web_search_provider",
    }
    # Omitting a key must remain distinguishable from choosing false/auto/none.
    return {field: forwarded[key] for key, field in mapping.items() if key in forwarded}


@router.post("/ag-ui")
async def run_ag_ui(payload: dict[str, Any], request: Request) -> StreamingResponse:
    """AG-UI standard HTTP/SSE endpoint."""
    try:
        ag_ui_input = RunAgentInput.model_validate(payload)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False)) from exc
    try:
        conversation_id = int(ag_ui_input.thread_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="threadId 必须是本地对话 ID") from exc
    content = _ag_ui_message_content(ag_ui_input)
    if not content:
        raise HTTPException(status_code=422, detail="messages 中缺少用户文本消息")
    forwarded = ag_ui_input.forwarded_props or {}
    model_selection = {}
    if isinstance(forwarded, dict) and "skillId" in forwarded:
        model_selection["skill_id"] = forwarded["skillId"]
    if isinstance(forwarded, dict) and "modelProfileId" in forwarded:
        selected = forwarded["modelProfileId"]
        if selected is not None and (not isinstance(selected, str) or not selected.strip() or len(selected) > 120):
            raise HTTPException(status_code=422, detail="modelProfileId 必须是模型档案 ID 或 null")
        model_selection["model_profile_id"] = selected
    try:
        chat_input = ChatMessageIn(
            content=content,
            conversation_id=conversation_id,
            attachment_ids=_ag_ui_attachment_ids(ag_ui_input),
            vision_attachment_ids=_ag_ui_vision_attachment_ids(ag_ui_input),
            **_ag_ui_web_search_fields(ag_ui_input),
            **model_selection,
        )
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors(include_url=False)) from exc
    return await stream_chat_response(
        chat_input,
        ag_ui_input=ag_ui_input,
        accept=request.headers.get("accept"),
    )


@router.post("/agent/tasks/current/cancel")
async def cancel_current_agent_task(conversation_id: int | None = None) -> dict[str, Any]:
    return await execution.cancel_current_agent_task(conversation_id)


@router.get("/agent/runs/current")
def current_durable_agent_run(conversation_id: int | None = None) -> dict[str, Any]:
    return execution.current_durable_agent_run(conversation_id)


@router.post("/agent/runs/{run_id}/cancel")
def cancel_durable_agent_run(run_id: str) -> dict[str, Any]:
    return execution.cancel_durable_agent_run(run_id)


@router.post("/chat-assets/{asset_id}/edits")
async def generated_image_edit(asset_id: str, payload: ImageEditIn):
    try:
        return await edit_generated_image(asset_id, payload)
    except ModelProviderError as exc:
        raise HTTPException(status_code=409 if exc.code in {"image_operation_conflict", "image_generation_uncertain"} else 502, detail=str(exc)) from exc
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
