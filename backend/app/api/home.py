from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr

from ..changelog import HIGHLIGHTS
from ..chat.conversations import list_conversations
from ..feeds.service import FeedCacheError, get_feed, save_preferences, set_item_state, start_refresh
from ..extensions.contracts import ExtensionContext
from ..jobs.service import job_service
from ..library.sources import list_sources
from .schemas import HomeWorkspaceBlock, HomeWorkspaceJobs, HomeWorkspaceResponse, HomeWorkspaceWeixin


router = APIRouter()

_JOB_LABELS = {
    "document.review": "文档评审",
    "document.export": "文档导出",
    "ppt.": "PPT 制作",
}

_WORKSPACE_CONVERSATION_LIMIT = 3
_WORKSPACE_JOBS_LIMIT = 5
_WORKSPACE_LIBRARY_LIMIT = 3
_WORKSPACE_SKILLS_LIMIT = 3
_WORKSPACE_CHANGELOG_LIMIT = 6


def _block(loader) -> HomeWorkspaceBlock:
    """独立容错：单个区块失败只影响自己，不拖垮整个首页。"""
    try:
        return HomeWorkspaceBlock(items=loader(), error=None)
    except Exception as exc:  # noqa: BLE001 - 聚合接口要求每块降级而非整体失败
        return HomeWorkspaceBlock(items=[], error=str(exc)[:200])


def _job_brief(job: dict) -> dict[str, Any]:
    request = job.get("request") or {}
    title = request.get("title") or request.get("summary")
    if not title:
        kind = job.get("kind") or ""
        title = _JOB_LABELS.get(kind) or next((label for prefix, label in _JOB_LABELS.items() if kind.startswith(prefix)), kind)
    return {
        "id": job.get("id") or "",
        "kind": job.get("kind") or "",
        "display_title": str(title)[:60],
        "status": job.get("status") or "",
        "created_at": job.get("created_at") or "",
    }


def _workspace_jobs(context: ExtensionContext) -> HomeWorkspaceJobs:
    def load():
        jobs = job_service.repository.list(context)
        running = [_job_brief(job) for job in jobs if job.get("status") == "running"][:_WORKSPACE_JOBS_LIMIT]
        pending = [_job_brief(job) for job in jobs if job.get("status") == "waiting_user"][:_WORKSPACE_JOBS_LIMIT]
        return {"running": running, "pending_confirmations": pending}

    try:
        return HomeWorkspaceJobs(**load())
    except Exception:  # noqa: BLE001
        return HomeWorkspaceJobs()


def _workspace_weixin() -> HomeWorkspaceWeixin:
    try:
        from ..channels.weixin import manager

        status = manager.current().status()
        return HomeWorkspaceWeixin(connected=bool(status.get("connected")), unread_count=int(status.get("unread_count") or 0))
    except Exception as exc:  # noqa: BLE001 - 未绑定/未登录时视为未连接
        return HomeWorkspaceWeixin(connected=False, unread_count=0, error=str(exc)[:200])


def _home_workspace_snapshot() -> dict[str, Any]:
    context = ExtensionContext.current()

    conversations = _block(lambda: [
        {
            "id": item["id"],
            "title": item.get("title") or "新对话",
            "last_message_at": item.get("last_message_at"),
            "task_status": item.get("task_status") or "active",
        }
        for item in list_conversations()[:_WORKSPACE_CONVERSATION_LIMIT]
    ])

    def load_skills():
        from ..extensions.skills import SkillService

        items = SkillService().list(context, enabled_only=True)
        result = []
        for item in reversed(items[-_WORKSPACE_SKILLS_LIMIT:]):
            description = (item.get("description") or "").strip().splitlines()
            result.append({
                "name": item.get("name") or "未命名技能",
                "summary": (description[0] if description else "")[:80],
                "source": "",
            })
        return result

    library_recent = _block(lambda: [
        {"id": item["id"], "title": item.get("title") or "资料", "kind": item.get("source_kind") or "upload", "created_at": item.get("created_at") or ""}
        for item in list_sources()[:_WORKSPACE_LIBRARY_LIMIT]
    ])

    payload = HomeWorkspaceResponse(
        generated_at=datetime.now(timezone.utc).isoformat(),
        conversations=conversations,
        jobs=_workspace_jobs(context),
        weixin=_workspace_weixin(),
        changelog=_block(lambda: [dict(item) for item in HIGHLIGHTS[:_WORKSPACE_CHANGELOG_LIMIT]]),
        skills=_block(load_skills),
        library_recent=library_recent,
    )
    return payload.model_dump()


@router.get("/home/workspace")
def home_workspace_get(response: Response) -> dict[str, Any]:
    response.headers["Cache-Control"] = "no-store"
    return _home_workspace_snapshot()


class HomePreferencesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topics: list[StrictStr] = Field(max_length=6)
    repositories: list[StrictStr] = Field(max_length=8)
    digest_profile_id: StrictStr | None = Field(default=None, max_length=64)
    curation_enabled: StrictBool | None = None


class HomeItemStateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bookmarked: StrictBool | None = None
    hidden: StrictBool | None = None


@router.get("/home/feed")
def home_feed_get() -> dict[str, Any]:
    try:
        return get_feed()
    except FeedCacheError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/home/feed/refresh")
def home_feed_refresh() -> dict[str, Any]:
    try:
        start_refresh(force=True)
        return get_feed(refresh_if_due=False)
    except FeedCacheError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.put("/home/preferences")
def home_preferences_put(payload: HomePreferencesIn) -> dict[str, Any]:
    try:
        return save_preferences(payload.topics, payload.repositories, payload.digest_profile_id, curation_enabled=payload.curation_enabled)
    except FeedCacheError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/home/feed/digest")
def home_feed_digest_post() -> dict[str, Any]:
    from ..feeds import digest

    try:
        digest.regenerate()
        return get_feed(refresh_if_due=False)
    except FeedCacheError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/home/feed/curation")
def home_feed_curation_post() -> dict[str, Any]:
    from ..feeds import curation

    try:
        curation.regenerate()
        return get_feed(refresh_if_due=False)
    except FeedCacheError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/home/feed/items/{item_id}/state")
def home_item_state_patch(item_id: str, payload: HomeItemStateIn) -> dict[str, Any]:
    try:
        return set_item_state(item_id, payload.model_dump(exclude_unset=True))
    except FeedCacheError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
