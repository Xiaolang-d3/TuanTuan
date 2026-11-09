from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field, StrictBool

from ..db import connect
from ..extensions.contracts import ExtensionContext
from ..extensions.manifest import safe_resource_path
from ..extensions.repository import ExtensionNotFound, ExtensionRepository, ExtensionUnavailable
from ..extensions.skills import MAX_ARCHIVE_BYTES, SkillService, import_plugin, list_mcp, save_mcp
from ..extensions import discovery
from ..presentations.service import presentation_service
from ..execution.builtin_runtime import UPSTREAM_COMMIT

router = APIRouter(tags=["extensions"])
repository = ExtensionRepository()
skills = SkillService()


class ContentImport(BaseModel):
    content: str = Field(min_length=1, max_length=100_000)


class EnabledInput(BaseModel):
    enabled: StrictBool


class SkillPreviewInput(BaseModel):
    source: str = Field(min_length=1, max_length=300)
    ref: str | None = Field(default=None, max_length=200)
    name: str | None = Field(default=None, max_length=100)


class SkillInstallInput(BaseModel):
    preview_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    path: str = Field(max_length=2000)


class McpInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    transport: Literal["http", "stdio"]
    endpoint: str = Field(min_length=1, max_length=2000)


def execute(operation):
    try:
        return operation(ExtensionContext.current())
    except discovery.DiscoveryUnavailable as exc:
        raise HTTPException(502, str(exc)) from None
    except ExtensionNotFound as exc:
        raise HTTPException(404, str(exc)) from None
    except ExtensionUnavailable as exc:
        raise HTTPException(409, str(exc)) from None
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None


@router.get("/extensions")
def catalog(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: {"extensions": repository.list(context), "connections": list_mcp(context),
        "execution": {**presentation_service.capabilities(context), "adapter": "ppt-master", "upstream_commit": UPSTREAM_COMMIT}})


@router.get("/skills")
def skill_catalog(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: {"skills": skills.list(context, enabled_only=True)})


@router.post("/extensions/skills", status_code=201)
def import_skill(payload: ContentImport):
    return execute(lambda context: skills.import_text(payload.content, context))


@router.get("/extensions/skills/search")
def search_skills(q: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: discovery.search(q, context))


@router.post("/extensions/skills/preview")
def preview_skills(payload: SkillPreviewInput, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: discovery.preview(payload.source, payload.ref, payload.name, context))


@router.post("/extensions/skills/install", status_code=201)
def install_skill(payload: SkillInstallInput):
    return execute(lambda context: discovery.install(payload.preview_id, payload.path, context))


@router.post("/extensions/plugins", status_code=201)
def import_plugin_manifest(payload: ContentImport):
    return execute(lambda context: import_plugin(payload.content, context))


@router.post("/extensions/import", status_code=201)
async def import_archive(file: UploadFile = File(...)):
    data = await file.read(MAX_ARCHIVE_BYTES + 1)
    return execute(lambda context: skills.import_zip(data, context))


@router.post("/extensions/mcp", status_code=201)
def create_mcp_draft(payload: McpInput):
    return execute(lambda context: save_mcp(payload.name, payload.transport, payload.endpoint, context))


@router.delete("/extensions/mcp/{connection_id}", status_code=204)
def remove_mcp_draft(connection_id: str):
    def remove(context):
        context.check_workspace()
        with connect() as conn:
            if not conn.execute("DELETE FROM extension_mcp_drafts WHERE id=?", (connection_id,)).rowcount:
                raise ExtensionNotFound("MCP 配置不存在")
    execute(remove)


@router.get("/extensions/{item_id}")
def extension_detail(item_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: repository.get(item_id, context))


@router.get("/extensions/{item_id}/resources")
def extension_resource(item_id: str, path: str):
    data = execute(lambda context: repository.resource(item_id, safe_resource_path(path), context))
    return Response(data, media_type="application/octet-stream", headers={"Cache-Control": "no-store", "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff"})


@router.patch("/extensions/{item_id}/enabled")
def change_enabled(item_id: str, payload: EnabledInput):
    return execute(lambda context: repository.set_enabled(item_id, payload.enabled, context))


@router.delete("/extensions/{item_id}", status_code=204)
def remove_extension(item_id: str):
    execute(lambda context: repository.remove(item_id, context))
