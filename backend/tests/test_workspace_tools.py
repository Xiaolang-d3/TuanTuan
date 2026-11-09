import asyncio

from app.agent.tool_executor import ToolExecutor
from app.domain import ToolCall
from app.extensions.contracts import ExtensionContext
from app.execution.contracts import ProcessResult
from app.tools import ToolContext
from app.tools.workspace import workspace_tools


def test_workspace_execution_uses_existing_tool_boundary_and_scope():
    class Handle:
        context = ExtensionContext(user_id=7)
        name = "test-container"
        async def read(self, path):
            return b"source content"
        async def write(self, path, content):
            self.saved = (path, content)
        async def exec(self, argv, **kwargs):
            self.called = (argv, kwargs)
            return ProcessResult(returncode=0, stdout="completed", stderr="")
    handle = Handle()
    registry = workspace_tools(handle, revision="image@sha256:" + "a" * 64)
    assert registry.snapshot_for_run(ExtensionContext(user_id=8)).names() == []
    executor = ToolExecutor(registry, 5)
    result = asyncio.run(executor.execute(ToolCall(id="exec", name="workspace_exec", arguments={"argv": ["python3", "task.py"]}), ToolContext(platform_name="manual"), round_number=1, conversation_id=None))
    assert result.ok and "completed" in result.message
    assert handle.called[0] == ["python3", "task.py"]
    rejected = asyncio.run(executor.execute(ToolCall(id="empty", name="workspace_exec", arguments={"argv": []}), ToolContext(platform_name="manual"), round_number=1, conversation_id=None))
    assert not rejected.ok and rejected.error.code == "invalid_arguments"
