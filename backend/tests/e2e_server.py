"""Isolated browser-test server with the real API, SQLite and Agent runtime.

Model generation and public feeds are replaced; no external requests are made.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="tuantuan-e2e-") as data_dir:
        os.environ.update({
            "TUANTUAN_DATA_DIR": data_dir, "MODEL_PROTOCOL": "ollama",
            "MODEL_NAME": "e2e-local-model", "EMBEDDING_BACKEND": "hash",
            "OPENAI_API_KEY": "", "ATTACHMENT_STORAGE": "local",
            "WEB_RESEARCH_ENABLED": "false", "BIND_HOST": "127.0.0.1",
        })
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from app.main import app
        from app.agent.bootstrap import _build_tool_registry
        from app.agent.runtime import AgentRuntime
        from app.agent.run_store import AgentRunStore
        from app.config import get_settings
        from app.domain import ModelResponse, ToolCall
        from app.models import ModelProviderRegistry
        from app.chat import execution
        from app.feeds import sources as feed_sources
        import uvicorn

        class LocalTestModel:
            name = "e2e"

            async def generate(self, request):
                if not request.tools:
                    prompt = request.messages[-1].content
                    if '"kind"' in prompt and "判断" in prompt:
                        return ModelResponse(content='{"kind":"conversation"}')
                    tools = ["get_library_context"]
                    if "propose_library_knowledge" in prompt:
                        tools.append("propose_library_knowledge")
                    return ModelResponse(content=json.dumps({"goal": "处理阅读资料", "steps": [
                        {"id": f"step-{i}", "title": name, "tool_name": name}
                        for i, name in enumerate(tools)
                    ]}))
                executed = {message.tool_call_id for message in request.messages if message.role == "tool"}
                available = {tool.name for tool in request.tools}
                if "get_library_context" in available and "e2e-read" not in executed:
                    return ModelResponse(tool_calls=[ToolCall(id="e2e-read", name="get_library_context")])
                if "propose_library_knowledge" in available and "e2e-write" not in executed:
                    return ModelResponse(tool_calls=[ToolCall(
                        id="e2e-write", name="propose_library_knowledge",
                        arguments={"statements": ["每周整理一次阅读笔记"]},
                    )])
                documents = []
                for message in request.messages:
                    if message.role == "tool":
                        context = message.payload
                        if context.get("document"):
                            documents.append(context["document"])
                if "e2e-write" in executed:
                    return ModelResponse(content="知识已提交，等待你确认。")
                return ModelResponse(content="已根据资料库完成：" + "\n".join(documents))

        def test_runtime(profile_id=None, *, selection=None, user_content=None):
            """Mirror get_agent_runtime's signature: e2e always uses the local test model."""
            models = ModelProviderRegistry()
            models.register("e2e", LocalTestModel())
            return AgentRuntime(
                models=models, tools=_build_tool_registry(get_settings()),
                model_provider="e2e", platform_name="local", max_tool_rounds=5,
                run_store=AgentRunStore(),
            )

        execution.get_agent_runtime = test_runtime
        feed_sources.fetch_source = lambda source: []
        uvicorn.run(app, host="127.0.0.1", port=4184, log_level="warning")


if __name__ == "__main__":
    main()
