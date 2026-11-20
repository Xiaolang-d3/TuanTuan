"""One explicit, non-retriable paid image generation in the current workspace."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import threading
from pathlib import Path
from uuid import UUID

from openai import APIStatusError
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..agent.image_design_skill import image_design_prompt
from ..agent.image_selection import bind_image_selection
from ..agent.model_purposes import resolve_purpose_connection, selection_catalog
from ..db import connect, json_dump
from ..domain import AgentMessage, ModelRequest
from ..model_protocol import model_protocol_for_profile
from ..models import ModelProviderError
from ..models.image_adapters import ImageAdapter, ImageSize, connection_image_adapter, image_adapter
from ..models.selection import select_model_for_purpose
from ..observability.model_context import model_call_scope
from ..workspace import resolve_db_path
from .image_assets import begin_generation, persist_images

log = logging.getLogger(__name__)
_UNCERTAIN = "暂未确认生成结果。请先检查所属对话或服务记录，不会自动重新生成。"
_active: dict[Path, tuple[str, int, asyncio.Task]] = {}
# Short-lived generation reservations (until scheduled) and in-flight edits.
_reservations: dict[Path, tuple[str, int]] = {}
_lock = threading.RLock()


class StudioConflict(ValueError):
    pass


class GenerateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: UUID
    prompt: str = Field(min_length=1, max_length=8000)
    profile_id: str | None = Field(default=None, min_length=1, max_length=120)
    size: ImageSize = "auto"
    comparison_key: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @field_validator("prompt")
    @classmethod
    def nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("请填写画面描述")
        return value.strip()


def studio_options() -> dict:
    catalog = selection_catalog()
    selected = select_model_for_purpose(catalog, "image", strict_capabilities=catalog["strict_capabilities"])
    excluded = {p["profile_id"] for p in selected["excluded"]}
    edit_selection = select_model_for_purpose(catalog, "image", strict_capabilities=catalog["strict_capabilities"], action="image_edit")
    sources = {source["id"]: source for source in catalog["connections"]}
    models = []
    for profile in catalog["profiles"]:
        if profile["id"] in excluded:
            continue
        source = sources[profile["connection_id"]]
        base = source["effective_base_url"]
        name = profile["model_name"]
        protocol = model_protocol_for_profile(name, source["protocol"], profile.get("capabilities"), base)
        adapter = image_adapter(name, protocol, base)
        if adapter is not None:
            models.append({"id": profile["id"], "name": name, "sizes": adapter.generate_sizes,
                           "capabilities": adapter.public_capabilities()})
    return {"default_profile_id": selected["profile_id"], "models": models, "can_edit": edit_selection["eligible"]}


def _live_generation(workspace: Path):
    item = _active.get(workspace)
    return item if item and not item[2].done() else None


def try_reserve_edit(operation_id: str, conversation_id: int) -> bool:
    return _reserve(resolve_db_path(), operation_id, conversation_id)


def _reserve(workspace: Path, operation_id: str, conversation_id: int) -> bool:
    with _lock:
        if workspace in _reservations or _live_generation(workspace):
            return False
        _reservations[workspace] = (operation_id, conversation_id)
        return True


def release_edit(operation_id: str) -> None:
    workspace = resolve_db_path()
    with _lock:
        edit = _reservations.get(workspace)
        if edit and edit[0] == operation_id:
            del _reservations[workspace]


def _current() -> tuple[str, int] | None:
    workspace = resolve_db_path()
    with _lock:
        generation = _live_generation(workspace)
        return generation[:2] if generation else _reservations.get(workspace)


def current_task_id() -> str | None:
    item = _current()
    return item[0] if item else None


def is_running(task_id: str) -> bool:
    return current_task_id() == task_id


def is_conversation_running(conversation_id: int) -> bool:
    item = _current()
    return bool(item and item[1] == conversation_id)


async def shutdown_generations() -> None:
    loop = asyncio.get_running_loop()
    with _lock:
        tasks = [task for _, _, task in _active.values() if task.get_loop() is loop]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def _existing(conn, task_id: str, digest: str) -> bool:
    if conn.execute("SELECT 1 FROM image_studio_deleted_requests WHERE id=?", (task_id,)).fetchone():
        raise StudioConflict("这次创作已删除，不会重新提交")
    row = conn.execute("SELECT request_hash FROM image_studio_tasks WHERE id=?", (task_id,)).fetchone()
    if row and row[0] != digest:
        raise StudioConflict("此请求编号已用于其他创作")
    return row is not None


async def submit(request: GenerateIn) -> str:
    workspace = resolve_db_path()
    task_id = str(request.request_id)
    # Bind the caller's explicit intent; replay with a null pin must not depend
    # on a changed/deleted default model or require re-reading its secret.
    digest = hashlib.sha256(json_dump([request.prompt, request.profile_id, request.size]).encode()).hexdigest()
    with connect() as conn:
        if _existing(conn, task_id, digest):
            return task_id
    connection = bind_image_selection("image.generate", request.profile_id,
                                      comparison_key=request.comparison_key, resolver=resolve_purpose_connection)
    adapter = connection_image_adapter(connection)
    wire_size = adapter.size_for_wire("generate", request.size)

    reserved = False
    try:
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if _existing(conn, task_id, digest):
                return task_id
            if conn.execute("SELECT 1 FROM chat_image_operations WHERE id=?", (task_id,)).fetchone():
                raise StudioConflict("此请求编号已用于其他图片操作")
            # Make creation of the conversation, user turn and receipt atomic.
            cid = conn.execute("INSERT INTO conversations(title,kernel) VALUES ('图片创作','tuantuan')").lastrowid
            # Never acquire SQLite locks with the in-memory reservation lock held.
            reserved = _reserve(workspace, task_id, cid)
            if not reserved:
                raise StudioConflict("已有图片任务在运行，请等待本轮完成")
            conn.execute("INSERT INTO conversation_tasks(conversation_id,title) VALUES (?,'当前任务')", (cid,))
            conn.execute("INSERT INTO chat_messages(conversation_id,role,content,payload_json) VALUES (?,'user',?,'{}')",
                         (cid, request.prompt))
            conn.execute("INSERT INTO image_studio_tasks(id,request_hash,conversation_id,prompt,profile_id,model_name,size,status) "
                         "VALUES (?,?,?,?,?,?,?,'running')", (task_id, digest, cid, request.prompt,
                         connection["profile_id"], connection["model_name"], request.size))
        # create_task copies contextvars, including the authenticated workspace.
        task = asyncio.create_task(_execute(task_id, cid, request, connection, adapter, wire_size), name=f"image-studio-{task_id}")
        with _lock:
            _active[workspace] = (task_id, cid, task)
        task.add_done_callback(lambda finished: _retire(workspace, finished))
    finally:
        if reserved:
            release_edit(task_id)
    return task_id


def _retire(workspace: Path, task: asyncio.Task) -> None:
    with _lock:
        active = _active.get(workspace)
        if active and active[2] is task:
            del _active[workspace]
    if not task.cancelled() and task.exception() is not None:
        # Never log a provider response, user prompt or key. A stale running
        # receipt appears uncertain and is never automatically resumed.
        log.error("图片任务未能写入最终状态")


def _set_error(task_id: str, status: str, message: str) -> None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        changed = conn.execute("UPDATE image_studio_tasks SET status=?,error=? WHERE id=? AND status='running'",
                               (status, message, task_id))
        if changed.rowcount:
            # The linked conversation must not look unanswered, but an unknown
            # outcome is not proof of failure. Publish the same safe explanation.
            conn.execute("INSERT INTO chat_messages(conversation_id,role,content,payload_json) "
                         "SELECT conversation_id,'assistant',?,'{}' FROM image_studio_tasks WHERE id=?",
                         (message, task_id))


def _publish(task_id: str, cid: int, result: dict, provider: str) -> None:
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        agent = {**result, "provider": provider, "platform": "local", "rounds": 1, "status": "done", "events": []}
        message_id = conn.execute("INSERT INTO chat_messages(conversation_id,role,content,payload_json) VALUES (?,'assistant',?,?)",
                                  (cid, result["content"], json_dump({"agent": agent}))).lastrowid
        conn.execute("UPDATE chat_image_assets SET message_id=? WHERE operation_id=?", (message_id, task_id))
        conn.execute("UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?", (cid,))
        conn.execute("UPDATE image_studio_tasks SET status='done',error='' WHERE id=?", (task_id,))


async def _execute(task_id: str, cid: int, request: GenerateIn, connection: dict,
                   adapter: ImageAdapter, wire_size: str | None) -> None:
    sent = False
    try:
        effective_prompt = image_design_prompt(request.prompt)
        call = ModelRequest(messages=[AgentMessage(role="user", content=effective_prompt)], image_generation=True,
                            image_size=wire_size, allow_option_fallback=False)
        async with adapter.open(connection) as provider:
            cached = begin_generation(task_id, cid, connection)
            if cached is None:
                with model_call_scope(connection, task_id, selection_reason=connection.get("selection_reason", "")):
                    sent = True
                    response = await provider.generate(call)
                cached = persist_images(task_id, response, connection["model_name"], prompt=effective_prompt)
            _publish(task_id, cid, cached, provider.name)
    except asyncio.CancelledError:
        _set_error(task_id, "uncertain" if sent else "failed", _UNCERTAIN if sent else "任务已在调用前停止。")
        raise
    except Exception as exc:
        # Downstream storage/decoding failures, timeout, disconnect and 5xx do
        # not prove non-execution. Never store arbitrary upstream error strings.
        cause = exc.__cause__
        rejected = isinstance(exc, ModelProviderError) and isinstance(cause, APIStatusError) and cause.status_code in {400,401,403,404,405,422}
        if rejected or not sent:
            message = "服务拒绝了所选模型或参数。请检查模型权限和画幅。" if rejected else "尚未调用生图服务，请检查模型配置。"
            _set_error(task_id, "failed", message)
        else:
            _set_error(task_id, "uncertain", _UNCERTAIN)
