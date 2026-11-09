from __future__ import annotations

import asyncio
from typing import Any, Literal
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response, JSONResponse
from ..attachments.service import (
    create_attachment,
    delete_attachment,
    get_attachment_file,
    get_attachment_metadata,
    list_attachments,
    parse_attachment,
    attachment_thumbnail,
)
from ..config import get_settings
from ..attachments.service import MAX_BYTES
from .dependencies import require_conversation


router = APIRouter()


@router.get("/attachments/{attachment_id}/versions/{revision}/blocks/{block_id}")
def attachment_block(attachment_id: str, revision: str, block_id: str, conversation_id: int) -> JSONResponse:
    from ..documents.blocks import DocumentTarget
    from ..library.evidence import preview_block
    require_conversation(conversation_id)
    try:
        return JSONResponse(preview_block(DocumentTarget(source_kind="attachment", attachment_id=attachment_id, source_revision=revision), block_id,
                                         conversation_id=conversation_id),
                            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/attachments/{attachment_id}/thumbnail")
def attachments_thumbnail(attachment_id: str) -> Response:
    try:
        return Response(attachment_thumbnail(attachment_id), media_type="image/webp",
                        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/attachments/{attachment_id}/file")
def attachments_file(attachment_id: str) -> FileResponse:
    try:
        path, filename, content_type = get_attachment_file(attachment_id)
        return FileResponse(
            path,
            filename=filename,
            media_type=content_type,
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/conversations/{conversation_id}/attachments")
def conversation_attachments(conversation_id: int) -> list[dict[str, Any]]:
    require_conversation(conversation_id)
    return list_attachments(conversation_id)


@router.post("/attachments")
async def attachments_upload(
    conversation_id: int = Form(...),
    kind: Literal["image", "document"] = Form(...),
    file: UploadFile = File(...),
) -> dict[str, Any]:
    try:
        attachment = await asyncio.to_thread(create_attachment,
            conversation_id,
            kind,
            (file.filename or "attachment").strip(),
            await file.read(MAX_BYTES[kind] + 1),
        )
    except ValueError as exc:
        status_code = 404 if str(exc) == "对话不存在" else 422
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    finally:
        await file.close()
    return attachment


@router.post("/attachments/{attachment_id}/parse")
def attachments_parse(
    attachment_id: str,
    mode: str = Form(default="fast"),
) -> dict[str, Any]:
    try:
        parse_attachment(attachment_id, mode=mode)
        return get_attachment_metadata(attachment_id)
    except ValueError as exc:
        status_code = 404 if str(exc) == "附件不存在" else 422
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.delete("/attachments/{attachment_id}")
def attachments_delete(attachment_id: str) -> dict[str, bool]:
    if not delete_attachment(attachment_id):
        raise HTTPException(status_code=404, detail="附件不存在")
    return {"deleted": True}


@router.get("/attachments/config")
def attachments_config() -> dict[str, Any]:
    settings = get_settings()
    minio_configured = bool(
        settings.minio_endpoint
        and settings.minio_access_key
        and settings.minio_secret_key
        and settings.minio_bucket
    )
    vision_ready = (
        settings.attachment_vision_enabled
        and (settings.attachment_storage == "local" or minio_configured)
    )
    checks = [
        {
            "key": "local_storage",
            "label": "本地附件目录",
            "status": "ok",
            "message": "可用于默认本地解析与临时附件保存",
        },
        {
            "key": "minio_private_storage",
            "label": "MinIO 私有存储",
            "status": (
                "ok"
                if settings.attachment_storage == "local" or minio_configured
                else "warning"
            ),
            "message": (
                "当前使用本地附件目录"
                if settings.attachment_storage == "local"
                else "MinIO 必要配置已填写"
                if minio_configured
                else "缺少 MINIO_ENDPOINT、MINIO_ACCESS_KEY、MINIO_SECRET_KEY 或 MINIO_BUCKET"
            ),
        },
        {
            "key": "vision_public_url",
            "label": "模型看图",
            "status": (
                "ok"
                if vision_ready
                else "warning"
                if settings.attachment_vision_enabled
                else "disabled"
            ),
            "message": (
                "图片随模型请求发送，无需公网存储地址"
                if vision_ready
                else "图片直传未启用"
                if not settings.attachment_vision_enabled
                else "请先完成附件存储配置"
            ),
        },
    ]
    return {
        "storage": settings.attachment_storage,
        "vision_enabled": settings.attachment_vision_enabled,
        "vision_ready": vision_ready,
        "vision_url_ttl_seconds": settings.attachment_vision_url_ttl_seconds,
        "requires_public_endpoint": False,
        "checks": checks,
    }


@router.get("/attachments/{attachment_id}")
def attachments_get(attachment_id: str) -> dict[str, Any]:
    try:
        return get_attachment_metadata(attachment_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
