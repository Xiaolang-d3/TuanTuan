from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from ..attachments.service import get_attachment
from ..branding import env
from ..db import connect
from ..execution.container_backend import ContainerBackend
from ..extensions.runtime_snapshot import ExtensionRunSnapshot
from ..jobs.repository import JobConflict, JobNotFound, decode
from ..library.source_versions import get_attachment_version, source_state
from ..privacy import scan_and_redact
from .service import PresentationUnavailable, PresentationService

KIND = "ppt.quick_generate"
GRANT = "builtin.ppt-quick.execute"
MAX_SOURCE_CHARS = 32_000
SUPPORTED = {".docx", ".pdf", ".txt", ".md"}
AttachmentId = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class QuickInput(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    topic: str = Field(default="", max_length=16_000)
    attachment_ids: list[AttachmentId] = Field(default_factory=list, max_length=8)
    conversation_id: int = Field(gt=0, strict=True)
    idempotency_key: str = Field(min_length=1, max_length=128)

    @field_validator("attachment_ids")
    @classmethod
    def unique_attachments(cls, ids):
        if len(set(ids)) != len(ids):
            raise ValueError("请勿重复添加同一份资料")
        return ids


def runner_image() -> str:
    return env("TUANTUAN_QUICK_PPT_IMAGE", "").strip()


def uses_composer() -> bool:
    return bool(runner_image()) or env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() != "local"


async def check_runner(service):
    if KIND not in service.jobs.handlers or not runner_image():
        raise PresentationUnavailable("runner_unavailable", "此服务器尚未启用 PPT 制作，请联系管理员。")
    image = runner_image()
    readiness = await ContainerBackend(image=image).probe()
    if not readiness.available:
        raise PresentationUnavailable("runner_unavailable", "PPT 制作服务暂不可用，请联系管理员检查生成环境。")
    return image


async def capabilities(context, conversation_id, *, service: PresentationService):
    context.check_workspace()
    conversation = service._conversation(conversation_id)
    if not uses_composer():
        return {"composer": False, "available": False, "code": "legacy", "reason": ""}
    try:
        await check_runner(service)
        selection = service._model(conversation.get("model_profile_id") if conversation else None)
    except PresentationUnavailable as exc:
        return {"composer": True, "available": False, "code": exc.code, "reason": str(exc)}
    return {"composer": True, "available": True, "code": "ready", "reason": "", "model_name": selection["model_name"]}


def resolve_sources(conversation_id: int, references: list[dict], topic: str) -> tuple[list[dict], list[dict]]:
    pinned, inputs = [], []
    size = len(topic)
    for index, ref in enumerate(references, 1):
        attachment_id = ref["id"]
        attachment = get_attachment(attachment_id)
        if attachment is None or attachment.get("conversation_id") != conversation_id:
            raise JobNotFound(f"第 {index} 份资料不在当前对话，请重新上传。")
        name = attachment["original_filename"]
        if attachment.get("kind") != "document" or Path(name).suffix.lower() not in SUPPORTED:
            raise ValueError(f"第 {index} 份资料格式不受支持。请选择 DOCX、文字版 PDF、TXT 或 Markdown。")
        revision = ref.get("revision") or source_state("attachment", attachment_id)["source_revision"]
        if not revision:
            raise ValueError(f"第 {index} 份资料未读到正文，请重新上传可复制文字的文件。")
        version = get_attachment_version(attachment_id, revision, conversation_id=conversation_id)
        if not version["complete"] or not version["redacted_text"].strip():
            raise ValueError(f"第 {index} 份资料没有可用正文，或部分页面无法读取。请改用文字版 PDF 或 Word。")
        size += max(len(version["text"]), len(version["redacted_text"]))
        if size > MAX_SOURCE_CHARS:
            raise ValueError("要求与资料合计超过 32,000 字，请保留重点内容或拆分文件。")
        pinned.append({"id": attachment_id, "revision": revision})
        inputs.append({"source": index, "text": version["redacted_text"]})
    return pinned, inputs


async def create(payload: QuickInput, context, *, service: PresentationService):
    context.check_workspace()
    ids = payload.attachment_ids
    if not payload.topic and not ids:
        raise ValueError("请填写主题、粘贴内容，或添加一份资料。")
    topic = scan_and_redact(payload.topic)[1]
    topic_hash = hashlib.sha256(payload.topic.encode()).hexdigest()
    if len(topic) > MAX_SOURCE_CHARS:
        raise ValueError("要求过长，请精简后再发送。")
    with connect() as conn:
        existing = conn.execute("SELECT * FROM background_jobs WHERE idempotency_key=?", (payload.idempotency_key,)).fetchone()
    if existing:
        job = decode(existing)
        request = job["request"]
        if (job["kind"] != KIND or request["conversation_id"] != payload.conversation_id or request["topic_hash"] != topic_hash
                or [item["id"] for item in request["sources"]] != ids):
            raise JobConflict("相同请求标识不能用于不同任务内容")
        return job
    conversation = service._conversation(payload.conversation_id)
    pinned, _ = await asyncio.to_thread(resolve_sources, payload.conversation_id, [{"id": value} for value in ids], topic)
    image = await check_runner(service)
    selection = service._model(conversation.get("model_profile_id"))
    snapshot = ExtensionRunSnapshot(user_id=context.user_id, model_selection=selection, grants=(GRANT,), dependency_digest=image)
    request = {"topic": topic, "topic_hash": topic_hash, "conversation_id": payload.conversation_id, "sources": pinned}
    return service.jobs.repository.enqueue(KIND, request, snapshot.model_dump(mode="json"), context, payload.idempotency_key)
