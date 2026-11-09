from __future__ import annotations

import asyncio
from typing import Any, Literal
from pydantic import BaseModel, Field
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status, Query, Response
from fastapi.responses import FileResponse, JSONResponse
from ..library.repository import save_metadata
from ..jobs.service import job_service
from ..library.document_review import DocumentReviewInput, create_document_review, public_document_review
from .jobs import execute as execute_job
from ..library.knowledge import list_knowledge, merge_knowledge, propose_knowledge, review_knowledge
from ..library.sources import (
    create_text_source,
    delete_source,
    get_source,
    get_source_file,
    import_file_source,
    list_sources,
    update_source,
)
from ..library.service import get_library
from ..library.organization import FolderIn, OrganizationIn, create_folder, list_folders, organize_source
from ..library.conversations import LibraryConversationIn, prepare_conversation
from ..library.collections import (
    CollectionIn, CollectionSourcesIn, delete_collection, list_collections,
    save_collection, update_collection_sources,
)
from ..documents import service as document_service
from ..documents.parser import MAX_DOCUMENT_BYTES
from .schemas import (
    LibraryKnowledgeIn,
    LibraryKnowledgeMergeIn,
    LibraryKnowledgeReviewIn,
    LibrarySourceIn,
    LibrarySourceUpdateIn,
    LibraryMetadataIn,
    PrivacyScanIn,
)


router = APIRouter()


class SourceReindexIn(BaseModel):
    request_id: str = Field(min_length=1, max_length=128)


@router.get("/library/sources/{source_id}/versions/{revision}/blocks/{block_id}")
def library_source_block(source_id: int, revision: str, block_id: str) -> JSONResponse:
    from ..documents.blocks import DocumentTarget
    from ..library.evidence import preview_block
    try:
        return JSONResponse(preview_block(DocumentTarget(source_kind="library", source_id=source_id, source_revision=revision), block_id),
                            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/library/sources/{source_id}/reindex")
def library_source_reindex(source_id: int, payload: SourceReindexIn) -> dict[str, Any]:
    from ..extensions.contracts import ExtensionContext
    from ..jobs.repository import public_job
    from ..jobs.service import job_service
    from ..library.source_backfill import enqueue_backfill
    try:
        return public_job(enqueue_backfill(source_id, ExtensionContext.current(), job_service, payload.request_id))
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/library/collections")
def library_collections_get() -> list[dict[str, Any]]:
    return list_collections()


@router.post("/library/collections")
def library_collection_post(payload: CollectionIn) -> dict[str, Any]:
    try:
        return save_collection(payload.name, source_ids=payload.source_ids)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/library/collections/{collection_id}")
def library_collection_patch(collection_id: int, payload: CollectionIn) -> dict[str, Any]:
    try:
        return save_collection(payload.name, collection_id=collection_id)
    except ValueError as exc:
        raise HTTPException(status_code=404 if "不存在" in str(exc) else 422, detail=str(exc)) from exc


@router.patch("/library/collections/{collection_id}/sources")
def library_collection_sources_patch(collection_id: int, payload: CollectionSourcesIn) -> dict[str, bool]:
    try:
        update_collection_sources(collection_id, payload.source_ids, action=payload.action)
        return {"updated": True}
    except ValueError as exc:
        raise HTTPException(status_code=404 if "不存在" in str(exc) else 422, detail=str(exc)) from exc


@router.delete("/library/collections/{collection_id}")
def library_collection_delete(collection_id: int) -> dict[str, bool]:
    try:
        delete_collection(collection_id)
        return {"deleted": True}
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/library/conversations")
def library_conversation_post(payload: LibraryConversationIn) -> dict[str, Any]:
    try:
        return prepare_conversation(payload.source_ids)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail="文件暂时无法加入对话，请稍后重试") from exc


@router.post("/library/document/parse")
async def parse_library_document(
    file: UploadFile = File(...),
    mode: str = Form(default="fast"),
) -> dict[str, Any]:
    filename = (file.filename or "document").strip()
    try:
        content = await file.read(MAX_DOCUMENT_BYTES + 1)
        result = await asyncio.to_thread(document_service.parse_document_upload, filename, content, mode)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail="无法解析该资料，请确认文件或截图清晰、未损坏且包含可识别文字",
        ) from exc
    finally:
        await file.close()


@router.post("/library/privacy/scan")
def scan_library_privacy(payload: PrivacyScanIn) -> dict[str, Any]:
    return document_service.scan_document_privacy(payload.text)


@router.get("/library")
def library_get() -> dict[str, Any]:
    return get_library()


@router.put("/library")
def library_put(payload: LibraryMetadataIn) -> dict[str, Any]:
    save_metadata(**payload.model_dump())
    return get_library()


@router.get("/library/sources")
def library_sources_get(q: str = "") -> list[dict[str, Any]]:
    return list_sources(query=q)


@router.get("/library/folders")
def library_folders_get() -> list[dict[str, Any]]:
    return list_folders()


@router.post("/library/folders")
def library_folders_post(payload: FolderIn) -> dict[str, Any]:
    try:
        return create_folder(payload.name)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/library/sources/{source_id}/organization")
def library_source_organize(source_id: int, payload: OrganizationIn) -> dict[str, Any]:
    try:
        return organize_source(source_id, payload.model_dump(exclude_unset=True))
    except ValueError as exc:
        raise HTTPException(status_code=404 if "不存在" in str(exc) else 422, detail=str(exc)) from exc


@router.post("/library/sources")
def library_sources_post(payload: LibrarySourceIn) -> dict[str, Any]:
    try:
        source = create_text_source(
            title=payload.title,
            content=payload.content,
            source_uri=payload.source_uri,
            privacy_mode=payload.privacy_mode,
            enabled=payload.enabled,
        )
        return {"source": source, "proposals": []}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/library/sources/import")
async def library_sources_import(
    files: list[UploadFile] = File(...),
    mode: str = Form(default="fast"),
    privacy_mode: Literal["redacted", "original"] = Form(default="redacted"),
    enabled: bool = Form(default=False),
) -> dict[str, Any]:
    results: list[dict[str, Any]] = []
    for file in files:
        filename = (file.filename or "document").strip()
        try:
            source = await asyncio.to_thread(import_file_source,
                filename=filename,
                content_bytes=await file.read(MAX_DOCUMENT_BYTES + 1),
                mode=mode,
                privacy_mode=privacy_mode,
                enabled=enabled,
            )
            results.append({"filename": filename, "ok": True, "source": source})
        except Exception as exc:
            results.append({
                "filename": filename,
                "ok": False,
                "error": str(exc) if isinstance(exc, ValueError) else "无法解析或保存该资料",
            })
        finally:
            await file.close()
    return {"results": results}


@router.get("/library/sources/{source_id}")
def library_source_get(source_id: int) -> dict[str, Any]:
    try:
        return get_source(source_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/library/sources/{source_id}/file")
def library_source_file_get(source_id: int) -> FileResponse:
    try:
        path, filename, mime_type = get_source_file(source_id)
        return FileResponse(path, filename=filename, media_type=mime_type)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/library/sources/{source_id}/assets/{asset_id}/file")
def library_image_file_get(source_id: int, asset_id: str) -> FileResponse:
    from ..library.sources import get_source_asset
    try:
        path, filename, mime = get_source_asset(source_id, asset_id)
        return FileResponse(path, filename=filename, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.patch("/library/sources/{source_id}")
def library_source_patch(source_id: int, payload: LibrarySourceUpdateIn) -> dict[str, Any]:
    try:
        return update_source(
            source_id,
            **payload.model_dump(exclude_unset=True),
        )
    except ValueError as exc:
        status_code = 404 if "不存在" in str(exc) else 422
        raise HTTPException(status_code=status_code, detail=str(exc)) from exc


@router.delete("/library/sources/{source_id}")
def library_source_delete(source_id: int) -> dict[str, bool]:
    try:
        return {"deleted": delete_source(source_id)}
    except ValueError as exc:
        raise HTTPException(status_code=404 if "不存在" in str(exc) else 422, detail=str(exc)) from exc


@router.get("/library/facts")
def library_facts_get(
    status: Literal["pending", "confirmed", "disputed", "retracted"] | None = None,
    category: str | None = None,
) -> list[dict[str, Any]]:
    try:
        return list_knowledge(status=status, category=category)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/library/facts")
def library_facts_post(payload: LibraryKnowledgeIn) -> dict[str, Any]:
    try:
        return propose_knowledge(**payload.model_dump())
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/library/facts/{fact_id}/review")
def library_fact_review(
    fact_id: int,
    payload: LibraryKnowledgeReviewIn,
) -> dict[str, Any]:
    try:
        result = review_knowledge(fact_id, action=payload.action, statement=payload.statement)
        return result
    except ValueError as exc:
        raise HTTPException(status_code=404 if "不存在" in str(exc) else 422, detail=str(exc)) from exc


@router.post("/library/facts/{fact_id}/merge")
def library_fact_merge(
    fact_id: int,
    payload: LibraryKnowledgeMergeIn,
) -> dict[str, Any]:
    try:
        return merge_knowledge(fact_id, payload.target_fact_id)
    except ValueError as exc:
        raise HTTPException(status_code=404 if "不存在" in str(exc) else 422, detail=str(exc)) from exc


@router.post("/document-reviews", status_code=201)
def document_reviews_create(payload: DocumentReviewInput, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute_job(lambda context: public_document_review(create_document_review(payload, context, jobs=job_service), context, jobs=job_service))


@router.get("/document-reviews")
def document_reviews_list(response: Response, conversation_id: int | None = Query(default=None, gt=0)):
    response.headers["Cache-Control"] = "no-store"
    return execute_job(lambda context: {"jobs": [public_document_review(job, context, jobs=job_service) for job in job_service.repository.list(context)
        if job["kind"] == "document.review" and (conversation_id is None or job["request"].get("conversation_id") == conversation_id)]})


@router.get("/document-reviews/{job_id}")
def document_reviews_get(job_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute_job(lambda context: public_document_review(job_service.get(job_id, context), context, jobs=job_service))
