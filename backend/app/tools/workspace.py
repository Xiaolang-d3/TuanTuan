from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from ..domain import ToolDefinition, ToolError, ToolResult
from ..extensions.contracts import RegistrationOwner
from ..extensions.manifest import safe_resource_path
from ..tooling import ToolSpec
from .base import ToolRegistry


class ReadFileArguments(BaseModel):
    path: str = Field(min_length=1, max_length=500)

    @field_validator("path")
    @classmethod
    def relative_path(cls, value: str) -> str:
        return safe_resource_path(value)


class WriteFileArguments(ReadFileArguments):
    content: str = Field(max_length=100_000)


class ExecuteArguments(BaseModel):
    argv: list[str] = Field(min_length=1, max_length=64)
    cwd: str = Field(default="", max_length=500)
    timeout: float = Field(default=60, gt=0, le=300)

    @field_validator("cwd")
    @classmethod
    def relative_directory(cls, value: str) -> str:
        return safe_resource_path(value) if value else ""


class WorkspaceTool:
    def __init__(self, handle, operation: str):
        self.handle, self.operation = handle, operation
        self.arguments_model = {"read": ReadFileArguments, "write": WriteFileArguments, "exec": ExecuteArguments}[operation]
        name = f"workspace_{operation}"
        title = {"read": "读取任务文件", "write": "写入任务文件", "exec": "在隔离任务目录执行"}[operation]
        self.definition = ToolDefinition(name=name, description=title + "。只能访问本任务隔离目录，不能访问宿主文件、密钥或网络。", input_schema=self.arguments_model.model_json_schema())
        self.spec = ToolSpec(name=name, title=title, risk="read_only" if operation == "read" else "derived_analysis", capabilities=frozenset({f"workspace.{operation}"}), timeout_seconds=310)

    async def execute(self, arguments, context):
        if self.operation == "read":
            data = await self.handle.read(arguments["path"])
            text = data.decode("utf-8")
            return ToolResult(ok=True, status="done", message=text, data={"path": arguments["path"], "bytes": len(data)})
        if self.operation == "write":
            await self.handle.write(arguments["path"], arguments["content"].encode())
            return ToolResult(ok=True, status="done", message=f"已写入任务文件：{arguments['path']}", data={"path": arguments["path"]})
        result = await self.handle.exec(arguments["argv"], cwd=arguments["cwd"], timeout=arguments["timeout"])
        return ToolResult(ok=result.returncode == 0, status="done" if result.returncode == 0 else "failed", message=result.stdout or result.stderr or f"进程退出码：{result.returncode}", data={"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}, error=None if result.returncode == 0 else ToolError(code="workspace_process_failed", message="隔离进程执行失败", retryable=False))


def workspace_tools(handle, *, revision: str) -> ToolRegistry:
    registry = ToolRegistry()
    owner = RegistrationOwner(extension_id="execution-workspace", revision=revision)
    for operation in ("read", "write", "exec"):
        registry.register_handler(WorkspaceTool(handle, operation), owner=owner, scope=handle.context.user_id)
    return registry
