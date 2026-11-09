from __future__ import annotations

from ..branding import env

import os
from pathlib import Path
from typing import Any
from fastapi import HTTPException
from ..workspace import ensure_workspace, list_user_ids, use_workspace
from ..database_lifecycle import database_status, initialize_or_report, rebuild_database_v2
from ..agent.run_store import AgentRunStore
from ..version import APP_VERSION
from fastapi import APIRouter


router = APIRouter()


def _startup_workspace(user_id: int, root: Path) -> None:
    with use_workspace(user_id, root):
        AgentRunStore().interrupt_active_runs()


def startup() -> None:
    state = initialize_or_report()
    if state["status"] != "ready":
        return
    user_ids = list_user_ids()
    if not user_ids:
        # A fresh installation only has the auth database. Business tables are
        # created with the first user's workspace, so there is nothing to recover.
        return
    for user_id in user_ids:
        root = ensure_workspace(user_id)
        _startup_workspace(user_id, root)


@router.get("/health")
def health() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "tuantuan",
        "version": APP_VERSION,
        "instance_id": env("TUANTUAN_INSTANCE_ID", "web"),
    }


@router.get("/system/database-status")
def get_database_status() -> dict[str, Any]:
    return database_status()


@router.post("/system/database-rebuild")
def rebuild_database(payload: dict[str, Any]) -> dict[str, Any]:
    try:
        return rebuild_database_v2(str(payload.get("confirmation") or ""))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
