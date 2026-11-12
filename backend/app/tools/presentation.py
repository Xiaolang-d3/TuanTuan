from __future__ import annotations

import hashlib

from pydantic import BaseModel, ConfigDict, Field

from ..domain import ToolDefinition, ToolError, ToolResult
from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobNotFound
from ..presentations.contracts import PresentationOptions, PresentationRequest
from ..presentations.service import PresentationUnavailable, presentation_service, public_presentation
from ..tooling import ToolSpec
from .base import ToolContext

_MAX_TOPIC = 8000


class CreatePresentationArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    topic: str = Field(min_length=1, max_length=_MAX_TOPIC)
    page_count: int = Field(default=8, ge=1, le=20)


class GetPresentationArguments(BaseModel):
    model_config = ConfigDict(extra="forbid")

    job_id: str = Field(pattern=r"^[a-f0-9]{32}$")


def _context(context: ToolContext) -> ExtensionContext | None:
    if context.conversation_id is None:
        return None
    from ..workspace import current_user_id

    user_id = current_user_id()
    if user_id is None:
        return None
    return ExtensionContext(user_id=user_id, conversation_id=context.conversation_id, run_id=context.agent_run_id)


class CreatePresentationTool:
    arguments_model = CreatePresentationArguments
    spec = ToolSpec(name="create_presentation", title="制作演示文稿", risk="local_pending_write", capabilities=frozenset({"presentation.create"}))

    def __init__(self) -> None:
        self.definition = ToolDefinition(
            name="create_presentation",
            description=(
                "为当前对话创建一个 PPT 后台制作任务。先向用户确认主题和页数（1–20，默认 8 页），"
                "再调用本工具。任务进度由聊天中的 PPT 任务卡展示，本工具只返回任务信息。"
            ),
            input_schema=self.arguments_model.model_json_schema(),
        )

    async def execute(self, arguments: dict, context: ToolContext) -> ToolResult:
        parsed = self.arguments_model.model_validate(arguments)
        extension = _context(context)
        if extension is None:
            return ToolResult(
                ok=False,
                status="failed",
                message="制作演示文稿需要明确的对话与用户工作区。",
                error=ToolError(code="presentation_context_missing", message="缺少对话上下文", retryable=False),
            )
        topic = parsed.topic.strip()
        if not topic:
            return ToolResult(
                ok=False,
                status="failed",
                message="请先确定演示主题。",
                error=ToolError(code="presentation_topic_missing", message="演示主题不能为空", retryable=True),
            )
        request = PresentationRequest(
            topic=topic,
            conversation_id=extension.conversation_id,
            options=PresentationOptions(page_count=parsed.page_count),
        )
        key = hashlib.sha256(
            f"{context.agent_run_id or ''}\n{extension.conversation_id}\n{topic}\n{parsed.page_count}".encode()
        ).hexdigest()
        try:
            job = presentation_service.create(request, extension, key)
        except PresentationUnavailable as error:
            return ToolResult(
                ok=False,
                status="failed",
                message=str(error),
                error=ToolError(code=error.code, message=str(error), retryable=False),
            )
        except ValueError as error:
            return ToolResult(
                ok=False,
                status="failed",
                message=str(error),
                error=ToolError(code="presentation_create_failed", message=str(error), retryable=False),
            )
        started = public_presentation(job)
        return ToolResult(
            ok=True,
            status="done",
            message=f"已开始制作演示文稿《{topic}》，共 {parsed.page_count} 页。任务卡会自动显示进度；需要时可查询任务状态。",
            data={"job": started},
        )


class GetPresentationTool:
    arguments_model = GetPresentationArguments
    spec = ToolSpec(name="get_presentation", title="查看演示文稿任务", risk="read_only", capabilities=frozenset({"presentation.read"}))

    def __init__(self) -> None:
        self.definition = ToolDefinition(
            name="get_presentation",
            description="读取当前对话中某个 PPT 制作任务的最新状态、阶段与交付文件。",
            input_schema=self.arguments_model.model_json_schema(),
        )

    async def execute(self, arguments: dict, context: ToolContext) -> ToolResult:
        parsed = self.arguments_model.model_validate(arguments)
        extension = _context(context)
        if extension is None:
            return ToolResult(
                ok=False,
                status="failed",
                message="读取演示文稿任务需要明确的对话与用户工作区。",
                error=ToolError(code="presentation_context_missing", message="缺少对话上下文", retryable=False),
            )
        try:
            job = presentation_service.get(parsed.job_id, extension)
        except (JobNotFound, PresentationUnavailable) as error:
            return ToolResult(
                ok=False,
                status="failed",
                message=str(error),
                error=ToolError(code="presentation_not_found", message=str(error), retryable=False),
            )
        return ToolResult(ok=True, status="done", message=f"任务当前状态：{job.get('status', 'unknown')}。", data={"job": public_presentation(job)})
