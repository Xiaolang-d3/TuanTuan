"""用户记忆管理接口：条目、规则、一键清除与开关状态。

记忆只存本地 SQLite，接口不需要会话上下文；开关复用 PUT /agent/settings。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from ..agent.memory import service as memory_service
from ..agent.memory.service import MemoryLimitError
from ..agent.settings import get_agent_settings
from .schemas import MemoryItemIn, MemoryRuleIn, MemoryRuleUpdate

router = APIRouter(prefix="/memory", tags=["memory"])


def _public_item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "summary": row["summary"],
        "source_conversation_id": row["source_conversation_id"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


@router.get("")
def memory_overview() -> dict[str, Any]:
    try:
        enabled = bool(get_agent_settings().get("user_memory_enabled", True))
    except Exception:
        enabled = True
    items = [_public_item(row) for row in memory_service.list_memory_items()]
    rules = memory_service.list_memory_rules()
    return {"enabled": enabled, "items": items, "rules": rules}


@router.get("/items")
def memory_items_get() -> list[dict[str, Any]]:
    return [_public_item(row) for row in memory_service.list_memory_items()]


@router.post("/items", status_code=201)
def memory_items_post(payload: MemoryItemIn) -> dict[str, Any]:
    try:
        item = memory_service.add_memory_item(payload.kind, payload.summary)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _public_item(item)


@router.delete("/items/{item_id}")
def memory_items_delete(item_id: int) -> dict[str, bool]:
    if not memory_service.delete_memory_item(item_id):
        raise HTTPException(status_code=404, detail="记忆不存在")
    return {"deleted": True}


@router.get("/rules")
def memory_rules_get() -> dict[str, Any]:
    return {"rules": memory_service.list_memory_rules()}


@router.post("/rules", status_code=201)
def memory_rules_post(payload: MemoryRuleIn) -> dict[str, Any]:
    try:
        return memory_service.add_memory_rule(payload.rule)
    except MemoryLimitError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.put("/rules/{rule_id}")
def memory_rules_put(rule_id: int, payload: MemoryRuleUpdate) -> dict[str, Any]:
    try:
        rule = memory_service.update_memory_rule(
            rule_id, rule=payload.rule, enabled=payload.enabled
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if rule is None:
        raise HTTPException(status_code=404, detail="规则不存在")
    return rule


@router.delete("/rules/{rule_id}")
def memory_rules_delete(rule_id: int) -> dict[str, bool]:
    if not memory_service.delete_memory_rule(rule_id):
        raise HTTPException(status_code=404, detail="规则不存在")
    return {"deleted": True}


@router.delete("")
def memory_clear() -> dict[str, int]:
    return memory_service.clear_all_memory()
