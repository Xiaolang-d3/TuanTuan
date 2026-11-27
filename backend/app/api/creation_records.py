"""Read-only index across the authenticated workspace's creation surfaces."""
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel

from ..chat.studio_generate import current_task_id
from ..db import connect

router = APIRouter()
CreationKind = Literal["chat", "image", "document", "presentation"]


class CreationRecord(BaseModel):
    kind: CreationKind
    id: str
    title: str
    updated_at: str
    conversation_id: int | None
    status: str | None


class CreationPage(BaseModel):
    items: list[CreationRecord]
    has_more: bool


# Normalize SQLite UTC timestamps (including the Studio's fractional seconds)
# before sorting, so equal instants compare equally across sources.
_UTC = "%Y-%m-%dT%H:%M:%fZ"
_SOURCES = {
    "chat": f"""
        SELECT 'chat' AS kind, CAST(c.id AS TEXT) AS id, c.title AS title,
               MAX(strftime('{_UTC}', c.updated_at),
                   COALESCE(MAX(strftime('{_UTC}', m.created_at)), '')) AS updated_at,
               c.id AS conversation_id, c.status AS status
        FROM conversations c
        JOIN chat_messages m ON m.conversation_id = c.id AND m.role IN ('user', 'assistant')
        WHERE NOT EXISTS (
            SELECT 1 FROM image_studio_tasks studio
            WHERE studio.conversation_id = c.id AND studio.source_asset_id IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM agent_execution_runs run
                  WHERE run.conversation_id = c.id AND run.user_message_id IS NOT NULL
                    AND run.run_id <> studio.id
              )
        )
        GROUP BY c.id
    """,
    "image": f"""
        SELECT 'image' AS kind, t.id, COALESCE(NULLIF(substr(trim(t.prompt), 1, 120), ''), '图片创作') AS title,
               strftime('{_UTC}', t.created_at) AS updated_at, t.conversation_id,
               CASE WHEN EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id = t.id) THEN 'done'
                    WHEN t.status = 'running' AND t.id IS NOT ? THEN 'uncertain'
                    ELSE t.status END AS status
        FROM image_studio_tasks t
        WHERE t.status <> 'done' OR EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id = t.id)
    """,
    "document": f"""
        SELECT 'document' AS kind, d.id, COALESCE(NULLIF(d.title, ''), '文档') AS title,
               strftime('{_UTC}', COALESCE(v.created_at, d.created_at)) AS updated_at,
               d.conversation_id, NULL AS status
        FROM authored_documents d
        LEFT JOIN authored_document_versions v ON v.document_id = d.id AND v.version = d.latest_version
    """,
    "presentation": f"""
        SELECT 'presentation' AS kind, j.id,
               COALESCE(NULLIF(substr(trim(json_extract(j.request_json, '$.topic')), 1, 120), ''), '演示文稿') AS title,
               strftime('{_UTC}', j.updated_at) AS updated_at,
               json_extract(j.request_json, '$.conversation_id') AS conversation_id, j.status
        FROM background_jobs j
        WHERE j.kind IN ('ppt.generate', 'ppt.quick_generate')
    """,
}
# Studio roots (including the legacy backfill) have no source asset and start a
# dedicated chat. An edit alone isn't a root; a separate bound chat run marks
# a conversation as also used for chat. Do not infer provenance from its title.
# Keep the image projection's status/visibility in sync with Studio history:
# assets outrank receipts, and an orphaned running task is never retried here.


@router.get("/creation-records")
def creation_records_index(
    response: Response,
    kind: CreationKind | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 24,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CreationPage:
    response.headers["Cache-Control"] = "no-store"
    sources = _SOURCES if kind is None else {kind: _SOURCES[kind]}
    params = (current_task_id(),) if "image" in sources else ()
    query = " UNION ALL ".join(sources.values()) + " ORDER BY updated_at DESC, kind, id DESC LIMIT ? OFFSET ?"
    # SQLite's parameter binding accepts only signed 64-bit integers.
    with connect() as conn:
        rows = conn.execute(query, (*params, limit + 1, min(offset, 2**63 - 1))).fetchall()
    return CreationPage(
        items=[CreationRecord(**dict(row)) for row in rows[:limit]],
        has_more=len(rows) > limit,
    )
