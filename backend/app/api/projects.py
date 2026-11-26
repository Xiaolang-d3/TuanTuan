"""Organize existing sources without creating, copying, or deleting them."""
import sqlite3
from datetime import datetime, timezone
from typing import Annotated, Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Path, Response
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from ..agent.kernels.base import DEFAULT_KERNEL
from ..agent.model_catalog import get_model_catalog
from ..chat.conversations import insert_conversation
from ..db import connect
from ..library.project_scope import project_context
from ..models.selection import purpose_exclusion

router = APIRouter(prefix="/projects", tags=["projects"])

_MAX_PROJECTS = 200
_MAX_ITEMS = 200
_MAX_ID_LENGTH = 128
_ID_PATTERN = r"^[^/\s\x00-\x1f\x7f]+$"

ProjectKind = Literal["chat", "image", "document", "presentation", "library", "image_work", "final_work"]
ProjectId = Annotated[str, Path(min_length=1, max_length=_MAX_ID_LENGTH)]
SourceId = Annotated[str, Path(min_length=1, max_length=_MAX_ID_LENGTH, pattern=_ID_PATTERN)]
ProjectName = Annotated[str, StringConstraints(min_length=1, max_length=120)]
ProjectDescription = Annotated[str, StringConstraints(max_length=2000)]
ProjectStatus = Literal["active", "archived"]


class ProjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: ProjectName
    description: ProjectDescription = ""

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("项目名称不能为空")
        return value.strip()


class ProjectPatch(ProjectCreate):
    # A default denotes omission, not a submitted value; explicit null fails validation.
    name: ProjectName = ""
    status: ProjectStatus = "active"
    default_model_profile_id: Annotated[str, StringConstraints(min_length=1, max_length=_MAX_ID_LENGTH)] | None = None


class ProjectConversationCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_ids: list[Annotated[int, Field(strict=True, ge=1, le=2**63 - 1)]] = Field(default_factory=list, max_length=20)


class ItemCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: ProjectKind
    source_id: str = Field(min_length=1, max_length=_MAX_ID_LENGTH, pattern=_ID_PATTERN)


class Project(BaseModel):
    id: str
    name: str
    description: str
    status: ProjectStatus
    default_model_profile_id: str | None
    updated_at: str
    created_at: str


class ProjectItem(BaseModel):
    kind: ProjectKind
    source_id: str
    title: str
    conversation_id: int | None


class ProjectDetail(Project):
    items: list[ProjectItem]


class ProjectList(BaseModel):
    items: list[Project]


# Query by native primary key and require the canonical decimal spelling for
# numeric IDs. Library membership checks existence, not search eligibility.
# Keep Studio's hidden 'done without assets' case aligned with its history.
_SOURCE_JOINS = """
    LEFT JOIN conversations c
        ON link.kind = 'chat' AND c.id = link.source_id AND CAST(c.id AS TEXT) = link.source_id
    LEFT JOIN image_studio_tasks t ON link.kind = 'image' AND t.id = link.source_id
        AND (t.status <> 'done' OR EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id = t.id))
    LEFT JOIN authored_documents d ON link.kind = 'document' AND d.id = link.source_id
    LEFT JOIN background_jobs j ON link.kind = 'presentation' AND j.id = link.source_id
        AND j.kind IN ('ppt.generate', 'ppt.quick_generate')
    LEFT JOIN image_studio_works iw ON link.kind = 'image_work' AND iw.id = link.source_id
    LEFT JOIN library_sources iw_source ON iw_source.id = iw.source_id
    LEFT JOIN final_works fw ON link.kind = 'final_work' AND fw.id = link.source_id
    LEFT JOIN library_sources l
        ON link.kind = 'library' AND l.id = link.source_id AND CAST(l.id AS TEXT) = link.source_id
        AND CASE WHEN json_valid(l.metadata_json)
                 THEN json_extract(l.metadata_json, '$.organization.trashed_at') IS NULL ELSE 0 END
"""
_ITEM_COLUMNS = """
    link.kind, link.source_id,
    CASE link.kind
        WHEN 'chat' THEN COALESCE(NULLIF(substr(trim(c.title), 1, 240), ''), '对话')
        WHEN 'image' THEN COALESCE(NULLIF(substr(trim(t.prompt), 1, 120), ''), '图片创作')
        WHEN 'document' THEN COALESCE(NULLIF(substr(trim(d.title), 1, 240), ''), '文档')
        WHEN 'presentation' THEN COALESCE(NULLIF(substr(trim(CASE WHEN json_valid(j.request_json)
             THEN CASE WHEN json_type(j.request_json, '$.topic') = 'text'
                       THEN json_extract(j.request_json, '$.topic') END END), 1, 120), ''), '演示文稿')
        WHEN 'library' THEN COALESCE(NULLIF(substr(trim(l.title), 1, 240), ''), '资料')
        WHEN 'image_work' THEN COALESCE(NULLIF(substr(trim(iw_source.title), 1, 240), ''), '图片作品')
        WHEN 'final_work' THEN substr(fw.filename, 1, 240)
    END AS title,
    COALESCE(c.id, t.conversation_id, d.conversation_id, CASE WHEN json_valid(j.request_json)
        THEN CASE WHEN json_type(j.request_json, '$.conversation_id') = 'integer'
                  THEN json_extract(j.request_json, '$.conversation_id') END END) AS conversation_id
"""
_IS_LIVE_SOURCE = ("(c.id IS NOT NULL OR t.id IS NOT NULL OR d.id IS NOT NULL OR j.id IS NOT NULL "
                   "OR l.id IS NOT NULL OR iw.id IS NOT NULL OR fw.id IS NOT NULL)")


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _project(conn: sqlite3.Connection, project_id: str) -> Project:
    row = conn.execute(
        "SELECT id, name, description, status, default_model_profile_id, created_at, updated_at FROM projects WHERE id = ?", (project_id,)
    ).fetchone()
    if row is None:
        raise HTTPException(404, "项目不存在")
    return Project(**dict(row))


@router.get("")
def list_projects() -> ProjectList:
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, name, description, status, default_model_profile_id, created_at, updated_at FROM projects "
            "ORDER BY updated_at DESC, id DESC LIMIT ?", (_MAX_PROJECTS,)
        )
        return ProjectList(items=[Project(**dict(row)) for row in rows])


@router.post("", status_code=201)
def create_project(payload: ProjectCreate) -> Project:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if conn.execute("SELECT COUNT(*) FROM projects").fetchone()[0] >= _MAX_PROJECTS:
            raise HTTPException(409, "项目数量已达上限")
        project_id = uuid4().hex
        timestamp = _timestamp()
        conn.execute(
            "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (project_id, payload.name, payload.description, timestamp, timestamp),
        )
        return _project(conn, project_id)


@router.get("/{project_id}")
def get_project(project_id: ProjectId) -> ProjectDetail:
    with connect() as conn:
        conn.execute("BEGIN")
        project = _project(conn, project_id)
        rows = conn.execute(
            f"SELECT {_ITEM_COLUMNS} FROM project_items link {_SOURCE_JOINS} "
            f"WHERE link.project_id = ? AND {_IS_LIVE_SOURCE} "
            "ORDER BY link.created_at DESC, link.kind, link.source_id LIMIT ?",
            (project_id, _MAX_ITEMS),
        )
        return ProjectDetail(**project.model_dump(), items=[ProjectItem(**dict(row)) for row in rows])


def _is_chat_profile(catalog: dict, profile_id: str) -> bool:
    profile = next((item for item in catalog["profiles"] if item["id"] == profile_id), None)
    connection = next((item for item in catalog["connections"] if profile and item["id"] == profile["connection_id"]), None)
    return profile is not None and purpose_exclusion(profile, connection, "chat") is None


@router.patch("/{project_id}")
def patch_project(project_id: ProjectId, payload: ProjectPatch) -> Project:
    if payload.default_model_profile_id and not _is_chat_profile(get_model_catalog(), payload.default_model_profile_id):
        raise HTTPException(422, "默认模型不可用或不支持对话")
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        project = _project(conn, project_id)
        changes = payload.model_dump(exclude_unset=True)
        name = changes.get("name", project.name)
        description = changes.get("description", project.description)
        status = changes.get("status", project.status)
        profile_id = changes.get("default_model_profile_id", project.default_model_profile_id)
        if (name, description, status, profile_id) == (project.name, project.description, project.status, project.default_model_profile_id):
            return project
        conn.execute(
            "UPDATE projects SET name = ?, description = ?, status = ?, default_model_profile_id = ?, updated_at = ? WHERE id = ?",
            (name, description, status, profile_id, _timestamp(), project_id),
        )
        return _project(conn, project_id)


@router.post("/{project_id}/conversations", status_code=201)
def create_project_conversation(project_id: ProjectId, payload: ProjectConversationCreate) -> dict:
    # Reading model availability can refresh local metadata; do it before the write transaction.
    with connect() as conn:
        initial = _project(conn, project_id)
    catalog = get_model_catalog() if initial.default_model_profile_id else None
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        project = _project(conn, project_id)
        if project.status != "active":
            raise HTTPException(409, "请先恢复已归档项目")
        if conn.execute("SELECT COUNT(*) FROM project_items WHERE project_id = ?", (project_id,)).fetchone()[0] >= _MAX_ITEMS:
            raise HTTPException(409, "项目来源数量已达上限")
        selected = set(payload.source_ids)
        profile_id = project.default_model_profile_id
        if profile_id != initial.default_model_profile_id:
            raise HTTPException(409, "项目默认模型已更新，请重试")
        if profile_id and not _is_chat_profile(catalog, profile_id):
            profile_id = None
        conversation_id = insert_conversation(conn, "新对话", DEFAULT_KERNEL, profile_id)
        conn.execute("INSERT INTO conversation_project_scopes VALUES (?, ?)", (conversation_id, project_id))
        # Validate the intersection before inserting to avoid FK errors for arbitrary input IDs.
        for source_id in selected:
            cursor = conn.execute("""
                INSERT INTO conversation_project_sources (conversation_id, source_id)
                SELECT ?, id FROM library_sources WHERE id = ?
            """, (conversation_id, source_id))
            if not cursor.rowcount:
                raise HTTPException(422, "请选择当前项目中可用的资料")
        context = project_context(conn, conversation_id)
        if {source["id"] for source in context["sources"]} != selected:
            raise HTTPException(422, "请选择当前项目中可用的资料")
        now = _timestamp()
        conn.execute("INSERT INTO project_items VALUES (?, 'chat', ?, ?)", (project_id, str(conversation_id), now))
        conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
        row = conn.execute("SELECT * FROM conversations WHERE id = ?", (conversation_id,)).fetchone()
        return {**dict(row), "project_context": context}


@router.delete("/{project_id}", status_code=204, response_class=Response)
def delete_project(project_id: ProjectId) -> Response:
    with connect() as conn:
        if not conn.execute("DELETE FROM projects WHERE id = ?", (project_id,)).rowcount:
            raise HTTPException(404, "项目不存在")
    return Response(status_code=204)


@router.post("/{project_id}/items", status_code=201)
def link_item(project_id: ProjectId, payload: ItemCreate) -> ProjectItem:
    with connect() as conn:
        # Validate and insert with the same write lock, so no source or project
        # can disappear between validation and recording the relation.
        conn.execute("BEGIN IMMEDIATE")
        _project(conn, project_id)
        key = (project_id, payload.kind, payload.source_id)
        item = conn.execute(
            f"SELECT {_ITEM_COLUMNS} FROM (SELECT ? AS kind, ? AS source_id) link {_SOURCE_JOINS} "
            f"WHERE {_IS_LIVE_SOURCE}", key[1:],
        ).fetchone()
        if item is None:
            raise HTTPException(404, "项目来源不存在")
        if not conn.execute(
            "SELECT 1 FROM project_items WHERE project_id = ? AND kind = ? AND source_id = ?", key,
        ).fetchone():
            if conn.execute("SELECT COUNT(*) FROM project_items WHERE project_id = ?", (project_id,)).fetchone()[0] >= _MAX_ITEMS:
                raise HTTPException(409, "项目来源数量已达上限")
            now = _timestamp()
            conn.execute(
                "INSERT INTO project_items (project_id, kind, source_id, created_at) VALUES (?, ?, ?, ?)", (*key, now),
            )
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
        return ProjectItem(**dict(item))


@router.delete("/{project_id}/items/{kind}/{source_id}", status_code=204, response_class=Response)
def unlink_item(project_id: ProjectId, kind: ProjectKind, source_id: SourceId) -> Response:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        _project(conn, project_id)
        if conn.execute(
            "DELETE FROM project_items WHERE project_id = ? AND kind = ? AND source_id = ?",
            (project_id, kind, source_id),
        ).rowcount:
            conn.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (_timestamp(), project_id))
    return Response(status_code=204)
