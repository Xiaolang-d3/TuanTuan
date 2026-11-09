from __future__ import annotations

import asyncio
import json
from dataclasses import asdict
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from ..execution.container_backend import ContainerBackend
from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobConflict, JobNotFound, public_job
from ..jobs.service import job_service
from ..streaming import until_shutdown
from ..workspace import current_workspace_root, use_workspace

router = APIRouter(tags=["jobs"])


class JobInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: str = Field(min_length=1, max_length=80)
    request: dict = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=1, max_length=128)


class ConfirmationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    stage_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    revision: int = Field(ge=1)
    answer: dict


def execute(operation):
    try:
        return operation(ExtensionContext.current())
    except JobNotFound as exc:
        raise HTTPException(404, str(exc), headers={"Cache-Control": "no-store"}) from None
    except JobConflict as exc:
        raise HTTPException(409, str(exc), headers={"Cache-Control": "no-store"}) from None
    except PermissionError as exc:
        raise HTTPException(403, str(exc), headers={"Cache-Control": "no-store"}) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc), headers={"Cache-Control": "no-store"}) from None


def public_result(job, context):
    if job["kind"] == "document.review":
        from ..library.document_review import public_document_review
        return public_document_review(job, context, jobs=job_service)
    return public_job(job)


@router.get("/execution/status")
async def execution_status(response: Response, backend: Literal["container", "local_builtin"] = "container", adapter: Literal["ppt-master"] = "ppt-master"):
    response.headers["Cache-Control"] = "no-store"
    if backend == "local_builtin":
        from ..execution.local_builtin import LocalBuiltinBackend
        return asdict(await asyncio.to_thread(LocalBuiltinBackend().probe))
    return asdict(await ContainerBackend().probe())


@router.get("/jobs")
def list_jobs(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: {"jobs": [public_job(job) for job in job_service.repository.list(context)]})


@router.post("/jobs", status_code=201)
def enqueue_job(payload: JobInput):
    return execute(lambda context: public_job(job_service.enqueue(payload.kind, payload.request, context, payload.idempotency_key)))


@router.get("/jobs/{job_id}")
def get_job(job_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return execute(lambda context: public_result(job_service.get(job_id, context), context))


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    return execute(lambda context: public_result(job_service.cancel(job_id, context), context))


@router.post("/jobs/{job_id}/resume")
def resume_job(job_id: str):
    return execute(lambda context: public_result(job_service.resume(job_id, context), context))


@router.post("/jobs/{job_id}/confirm")
def confirm_job(job_id: str, payload: ConfirmationInput):
    return execute(lambda context: public_result(job_service.confirm(job_id, payload.stage_id, payload.revision, payload.answer, context), context))


@router.get("/jobs/{job_id}/events")
def job_events(job_id: str, request: Request, after: int = Query(default=0, ge=0, le=2**63 - 1)):
    context = ExtensionContext.current()
    execute(lambda context: job_service.get(job_id, context))
    if "text/event-stream" not in request.headers.get("accept", ""):
        return Response(json.dumps(execute(lambda context: {"events": job_service.events(job_id, context, after=after)}), ensure_ascii=False), media_type="application/json", headers={"Cache-Control": "no-store"})
    last_id = request.headers.get("last-event-id")
    if last_id is not None:
        try:
            after = max(after, int(last_id))
            if after > 2**63 - 1 or after < 0:
                raise ValueError()
        except ValueError:
            raise HTTPException(422, "Last-Event-ID 必须是有效事件游标") from None
    root = current_workspace_root()
    async def stream():
        cursor = after
        ticks = 0
        while True:
            # Streaming can outlive the request middleware's context manager.
            with use_workspace(context.user_id, root):
                events = job_service.events(job_id, context, after=cursor)
                job = job_service.get(job_id, context)
            for event in events:
                cursor = event["cursor"]
                yield f"id: {cursor}\nevent: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
            if job["status"] in {"succeeded", "failed", "cancelled", "interrupted", "waiting_user"} and len(events) < 200:
                return
            if ticks % 10 == 0:
                yield ": heartbeat\n\n"
            ticks += 1
            await asyncio.sleep(0.5)
    return StreamingResponse(until_shutdown(stream(), request), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
