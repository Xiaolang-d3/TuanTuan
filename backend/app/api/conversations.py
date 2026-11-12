from __future__ import annotations

from typing import Any
from fastapi import APIRouter, HTTPException
from ..attachments.service import delete_conversation_attachments
from ..agent.snapshots import clear_run_snapshot
from ..agent.kernels.base import DEFAULT_KERNEL, is_kernel_available
from ..agent.settings import get_agent_settings
from ..chat.conversations import (
    create_conversation,
    delete_conversation,
    fork_conversation,
    list_conversations,
    reset_conversation_context,
    update_conversation,
)
from ..agent.run_store import AgentRunStore, TERMINAL_RUN_STATUSES
from .dependencies import require_conversation
from .schemas import ConversationForkIn, ConversationIn
from .model_contracts import ConversationModelUpdate


router = APIRouter()


@router.get("/conversations")
def conversations_index(q: str | None = None) -> list[dict[str, Any]]:
    return list_conversations(query=q)


@router.post("/conversations")
def conversations_create(payload: ConversationIn) -> dict[str, Any]:
    kernel = payload.kernel or str(get_agent_settings().get("default_kernel") or DEFAULT_KERNEL)
    if not is_kernel_available(kernel):
        if payload.kernel is None:
            kernel = DEFAULT_KERNEL
        else:
            raise HTTPException(status_code=400, detail="所选内核当前不可用")
    try:
        return create_conversation(payload.title, kernel=kernel)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/conversations/{conversation_id}/fork")
def conversations_fork(
    conversation_id: int,
    payload: ConversationForkIn,
) -> dict[str, Any]:
    """Keep the source task intact and start an empty, context-seeded branch."""
    require_conversation(conversation_id)
    if not is_kernel_available(payload.kernel):
        raise HTTPException(status_code=400, detail="所选内核当前不可用")
    active_run = AgentRunStore().latest_for_conversation(conversation_id)
    exclude_from_message_id = None
    if (
        active_run is not None
        and active_run.get("status") not in TERMINAL_RUN_STATUSES
        and active_run.get("user_message_id")
    ):
        exclude_from_message_id = int(active_run["user_message_id"])
    try:
        return fork_conversation(
            conversation_id,
            kernel=payload.kernel,
            exclude_from_message_id=exclude_from_message_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.patch("/conversations/{conversation_id}")
def conversations_update(
    conversation_id: int,
    payload: ConversationModelUpdate,
) -> dict[str, Any]:
    require_conversation(conversation_id)
    if "kernel" in payload.model_fields_set and not is_kernel_available(payload.kernel):
        raise HTTPException(status_code=400, detail="所选内核当前不可用")
    try:
        return update_conversation(
            conversation_id,
            title=payload.title,
            status=payload.status,
            model_profile_id=payload.model_profile_id,
            model_profile_selected="model_profile_id" in payload.model_fields_set,
            kernel=payload.kernel,
            kernel_selected="kernel" in payload.model_fields_set,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.delete("/conversations/{conversation_id}")
def conversations_delete(conversation_id: int) -> dict[str, Any]:
    require_conversation(conversation_id)
    try:
        delete_conversation_attachments(conversation_id)
        from ..chat.image_assets import delete_images
        delete_images(conversation_id)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"对话附件清理失败，已保留对话记录：{exc}",
        ) from exc
    clear_run_snapshot(conversation_id)
    if not delete_conversation(conversation_id):
        raise HTTPException(status_code=404, detail="对话不存在")
    remaining = list_conversations()
    if not remaining:
        remaining = [create_conversation()]
    return {"deleted": True, "next_conversation": remaining[0]}


@router.post("/conversations/{conversation_id}/context/reset")
def conversation_context_reset(conversation_id: int) -> dict[str, Any]:
    require_conversation(conversation_id)
    conversation = reset_conversation_context(conversation_id)
    return {
        "reset": True,
        "context_cutoff_message_id": conversation["context_cutoff_message_id"],
        "conversation": conversation,
    }
