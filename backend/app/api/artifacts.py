from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from typing import Literal

from ..artifacts.service import ArtifactService, public_artifact
from ..artifacts.documents import DocumentStore, DocumentConflict, DocumentNotFound
from ..chat.artifacts import ArtifactConflict
from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobNotFound, JobConflict
from ..jobs.service import job_service
from ..artifacts.document_export import enqueue_export, export_status, export_capabilities

router = APIRouter(tags=["artifacts"])
artifacts = ArtifactService()
documents = DocumentStore()


def execute(operation):
    try:
        return operation(ExtensionContext.current())
    except (FileNotFoundError, JobNotFound, DocumentNotFound):
        raise HTTPException(404, "文件成果不存在", headers={"Cache-Control": "no-store"}) from None
    except PermissionError:
        raise HTTPException(403, "无权读取此成果", headers={"Cache-Control": "no-store"}) from None
    except (DocumentConflict, ArtifactConflict, JobConflict) as exc:
        raise HTTPException(409, str(exc), headers={"Cache-Control": "no-store"}) from None
    except ValueError as exc:
        raise HTTPException(400, str(exc), headers={"Cache-Control": "no-store"}) from None


@router.get("/jobs/{job_id}/artifacts")
def job_artifacts(job_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: {"artifacts": [public_artifact(item) for item in artifacts.list_for_job(job_id, context)]})


@router.get("/artifacts/{artifact_id}/versions/{version}")
def artifact_detail(artifact_id: str, version: int, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: public_artifact(artifacts.get(artifact_id, version, context)))


@router.get("/artifacts/{artifact_id}/versions/{version}/file")
def artifact_file(artifact_id: str, version: int):
    def resolve(context):
        item = artifacts.get(artifact_id, version, context)
        path = artifacts.resolve(artifact_id, version, context)
        return FileResponse(path, filename=item["filename"], media_type=item["media_type"], headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    return execute(resolve)


class DocumentCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message_id: int = Field(gt=0, strict=True)
    snapshot: str = Field(pattern=r"^[a-f0-9]{64}$")
    idempotency_key: str = Field(min_length=1, max_length=128)


class DocumentSaveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_version: int = Field(gt=0, strict=True)
    markdown: str = Field(max_length=200_000)
    idempotency_key: str = Field(min_length=1, max_length=128)


class DocumentArchiveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filename: str = Field(min_length=1, max_length=200)
    folder_id: int | None = Field(default=None, gt=0)
    enabled: bool = False
    idempotency_key: str = Field(min_length=1, max_length=128)


class DocumentAttachIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: int = Field(gt=0, strict=True)
    idempotency_key: str = Field(min_length=1, max_length=128)


class DocumentExportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["docx", "pdf"]


@router.get("/document-export-capabilities")
def document_export_capabilities(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: export_capabilities())


@router.get("/documents/{document_id}/versions/{version}/exports")
def document_export_status(document_id: str, version: int, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: {"exports": export_status(document_id, version, context, jobs=job_service)})


@router.post("/documents/{document_id}/versions/{version}/exports", status_code=202)
def document_export_create(document_id: str, version: int, payload: DocumentExportIn, response: Response):
    response.headers["Cache-Control"] = "no-store"
    result = execute(lambda context: enqueue_export(document_id, version, payload.format, context, jobs=job_service))
    if result["artifact"]:
        response.status_code = 200
    return result


@router.post("/conversations/{conversation_id}/documents", status_code=201)
def document_create(conversation_id: int, payload: DocumentCreateIn, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: documents.create(conversation_id=conversation_id, **payload.model_dump(), context=context))


@router.get("/documents")
def document_list(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: {"documents": documents.list(context)})


@router.get("/documents/{document_id}")
def document_latest(document_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: documents.latest(document_id, context))


@router.get("/documents/{document_id}/versions")
def document_versions(document_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: {"versions": documents.versions(document_id, context)})


@router.get("/documents/{document_id}/versions/{version}")
def document_version(document_id: str, version: int, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: documents.get(document_id, version, context))


@router.post("/documents/{document_id}/versions", status_code=201)
def document_save(document_id: str, payload: DocumentSaveIn, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: documents.save(document_id, **payload.model_dump(), context=context))


@router.post("/documents/{document_id}/versions/{version}/archive")
def document_archive(document_id: str, version: int, payload: DocumentArchiveIn, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: documents.archive(document_id, version, **payload.model_dump(), context=context))


@router.post("/documents/{document_id}/versions/{version}/attachments", status_code=201)
def document_attach(document_id: str, version: int, payload: DocumentAttachIn, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: documents.attach(document_id, version, **payload.model_dump(), context=context))


@router.get("/documents/{document_id}/resources/{resource_id}/file")
def document_resource(document_id: str, resource_id: str):
    def resolve(context):
        path, filename, mime_type = documents.resource(document_id, resource_id, context)
        return FileResponse(path, filename=filename, media_type=mime_type, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    return execute(resolve)


@router.delete("/documents/{document_id}")
def document_delete(document_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: documents.delete(document_id, context))
