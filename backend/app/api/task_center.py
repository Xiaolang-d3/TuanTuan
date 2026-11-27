"""Account-local, read-only task and notification projection."""
from __future__ import annotations

import hashlib
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from ..chat.studio_generate import current_task_id
from ..db import connect
from ..extensions.contracts import ExtensionContext

router = APIRouter(tags=["task-center"])

TaskStatus = Literal[
    "queued", "running", "awaiting_confirmation", "completed", "failed",
    "outcome_unknown", "cancelled", "interrupted",
]

_TITLES = {
    "ppt.generate": "PPT 制作",
    "ppt.quick_generate": "快速生成 PPT",
    "document.review": "文档审阅",
    "document.export": "文档导出",
    "library.source_backfill": "资料正文提取",
    "image.generate": "图片生成",
    "image.edit": "图片编辑",
}


class TaskSource(BaseModel):
    kind: Literal["image", "chat"]
    id: str


class TaskItem(BaseModel):
    kind: str
    id: str
    title: str
    status: TaskStatus
    updated_at: str
    source: TaskSource | None
    notification_key: str


class TaskCenterResponse(BaseModel):
    items: list[TaskItem]
    has_more: bool


# All branches read the same workspace and database snapshot. Only source IDs
# are extracted from job data; prompts, results, errors and model details are
# not part of the projection. Do not list jobs through the creation-order cap of
# /jobs: old jobs waiting on a user should still outrank recent completed jobs.
_TASKS = """
WITH jobs AS (
    SELECT j.id, j.kind,
           CASE j.status WHEN 'waiting_user' THEN 'awaiting_confirmation'
                         WHEN 'succeeded' THEN 'completed' ELSE j.status END AS status,
           j.updated_at AS recorded_at,
           'chat' AS source_kind,
           CAST(c.id AS TEXT) AS source_id,
           j.revision AS revision
    FROM background_jobs j
    LEFT JOIN authored_documents d ON j.kind='document.export'
         AND d.id=json_extract(j.request_json, '$.document_id')
    LEFT JOIN attachments a ON j.kind='library.source_backfill'
         AND json_extract(j.request_json, '$.source_kind')='attachment'
         AND a.id=json_extract(j.request_json, '$.source_key')
    LEFT JOIN conversations c ON c.id=coalesce(d.conversation_id, a.conversation_id,
        CASE WHEN json_type(j.request_json, '$.conversation_id')='integer'
             THEN json_extract(j.request_json, '$.conversation_id') END)
), studio AS (
    SELECT t.id, CASE WHEN t.source_asset_id IS NULL THEN 'image.generate'
                      ELSE 'image.edit' END AS kind,
           CASE WHEN EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id=t.id)
                    THEN 'completed'
                WHEN t.status='running' AND t.id IS :live_studio_task THEN 'running'
                WHEN t.status IN ('running', 'uncertain') THEN 'outcome_unknown'
                ELSE t.status END AS status,
           coalesce((SELECT max(m.created_at) FROM chat_image_assets a
                     JOIN chat_messages m ON m.id=a.message_id
                     WHERE a.operation_id=t.id), t.created_at) AS recorded_at,
           'image' AS source_kind,
           t.id AS source_id,
           NULL AS revision
    FROM image_studio_tasks t
    WHERE t.status!='done' OR EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id=t.id)
), chat_images AS (
    SELECT o.id, CASE WHEN json_type(o.selection_json, '$.edit_digest') IS NULL
                      THEN 'image.generate' ELSE 'image.edit' END AS kind,
           CASE WHEN o.status='done' THEN 'completed'
                WHEN r.status='running' THEN 'running'
                ELSE 'outcome_unknown' END AS status,
           coalesce((SELECT max(m.created_at) FROM chat_image_assets a
                     JOIN chat_messages m ON m.id=a.message_id
                     WHERE a.operation_id=o.id), r.updated_at, o.created_at) AS recorded_at,
           'chat' AS source_kind,
           CAST(o.conversation_id AS TEXT) AS source_id,
           NULL AS revision
    FROM chat_image_operations o
    LEFT JOIN agent_execution_runs r ON r.run_id=o.id AND r.conversation_id=o.conversation_id
    WHERE NOT EXISTS (SELECT 1 FROM image_studio_tasks t WHERE t.id=o.id)
      AND (o.status!='done' OR EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id=o.id))
), tasks AS (
    SELECT * FROM jobs UNION ALL SELECT * FROM studio UNION ALL SELECT * FROM chat_images
)
SELECT id, kind, status, strftime('%Y-%m-%dT%H:%M:%fZ', recorded_at) AS updated_at,
       source_kind, source_id, revision
FROM tasks
ORDER BY CASE WHEN status IN ('queued', 'running', 'awaiting_confirmation', 'outcome_unknown') THEN 0 ELSE 1 END,
         updated_at DESC, id DESC, kind DESC
LIMIT :limit OFFSET :offset
"""


def _task_item(row) -> TaskItem:
    kind, task_id, status, updated_at = (row[field] for field in ("kind", "id", "status", "updated_at"))
    # A job can return to the same status within one SQLite timestamp tick.
    # Its existing revision disambiguates those transitions; polling the same
    # persisted version never changes the key.
    identity = json.dumps([kind, task_id, status, updated_at, row["revision"]], separators=(",", ":"))
    return TaskItem(
        kind=kind, id=task_id, title=_TITLES.get(kind, "后台任务"), status=status, updated_at=updated_at,
        source=TaskSource(kind=row["source_kind"], id=row["source_id"]) if row["source_id"] is not None else None,
        notification_key=hashlib.sha256(identity.encode()).hexdigest(),
    )


@router.get("/task-center")
def task_center(
    response: Response,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0, le=2**31 - 1),
) -> TaskCenterResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        ExtensionContext.current()
    except PermissionError as exc:
        raise HTTPException(403, str(exc), headers={"Cache-Control": "no-store"}) from None
    # A restarted process cannot prove that a paid request failed. Project its
    # receipt as unknown without converting it, requeueing it or calling a model.
    live_studio_task = current_task_id()
    with connect() as conn:
        rows = conn.execute(_TASKS, {"live_studio_task": live_studio_task, "limit": limit + 1, "offset": offset}).fetchall()
    return TaskCenterResponse(items=[_task_item(row) for row in rows[:limit]], has_more=len(rows) > limit)
