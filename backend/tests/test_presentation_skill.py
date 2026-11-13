from __future__ import annotations

import asyncio

import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.extensions.repository import ExtensionRepository
from app.extensions.skills import SkillService
from app.presentations.service import PresentationUnavailable
from app.tools import presentation as presentation_tools
from app.tools.base import ToolContext
from app.workspace import use_workspace


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1, tmp_path / "one"):
        db.init_db()
        yield ExtensionContext.current()


def builtin_item(context):
    return next(item for item in SkillService().list(context) if item["id"] == "ppt-master")


class FakeService:
    def __init__(self, *, fail: PresentationUnavailable | None = None):
        self.fail = fail
        self.created: list[tuple] = []
        self.requested: tuple | None = None

    def create(self, request, context, idempotency_key):
        if self.fail is not None:
            raise self.fail
        self.created.append((request, context, idempotency_key))
        return {"id": "a" * 32}

    def get(self, job_id, context):
        self.requested = (job_id, context)
        return {"id": job_id}


def tool_context() -> ToolContext:
    return ToolContext(platform_name="local", agent_run_id="run-1", conversation_id=7)


def test_builtin_ppt_skill_is_seeded_idempotently(scope):
    item = builtin_item(scope)
    assert item["source"] == "builtin"
    assert item["kind"] == "skill"
    assert item["enabled"] is True
    assert item["user_invocable"] is True
    assert item["model_invocable"] is False
    assert item["name"] == "PPT Master"

    db.init_db()
    assert len([entry for entry in SkillService().list(scope) if entry["id"] == "ppt-master"]) == 1


def test_builtin_ppt_skill_keeps_disabled_choice(scope):
    repository = ExtensionRepository()
    repository.set_enabled("ppt-master", False, scope)
    db.init_db()
    item = builtin_item(scope)
    assert item["enabled"] is False
    assert len([entry for entry in ExtensionRepository().list(scope) if entry["id"] == "ppt-master"]) == 1


def test_builtin_rows_sort_after_user_skills(scope):
    repository = ExtensionRepository()
    repository.add("skill", {"name": "周报助手", "description": "汇总每周工作"}, "整理材料", {}, scope)
    assert [entry["id"] for entry in repository.list(scope)][-1] == "ppt-master"


def test_seed_refreshes_changed_content_without_reordering(scope):
    repository = ExtensionRepository()
    repository.seed_builtin("skill", "ppt-master", {"name": "PPT Master", "description": "更新后的说明"}, "新的正文")
    item = repository.get("ppt-master", scope)
    assert item["description"] == "更新后的说明"
    assert item["content"] == "新的正文"


def test_create_presentation_tool_creates_job_for_current_conversation(scope, monkeypatch):
    fake = FakeService()
    monkeypatch.setattr(presentation_tools, "presentation_service", fake)
    monkeypatch.setattr(presentation_tools, "public_presentation", lambda job: job)
    tool = presentation_tools.CreatePresentationTool()

    result = asyncio.run(tool.execute({"topic": "季度产品复盘", "page_count": 6}, tool_context()))

    assert result.ok is True
    assert result.data["job"]["id"] == "a" * 32
    (request, context, key), = fake.created
    assert request.topic == "季度产品复盘"
    assert request.conversation_id == 7
    assert request.options.page_count == 6
    assert context.user_id == scope.user_id
    assert context.conversation_id == 7
    assert len(key) == 64


def test_create_presentation_tool_reports_unavailable(scope, monkeypatch):
    fake = FakeService(fail=PresentationUnavailable("model_unavailable", "请先配置可用且有固定版本的文本模型"))
    monkeypatch.setattr(presentation_tools, "presentation_service", fake)
    tool = presentation_tools.CreatePresentationTool()

    result = asyncio.run(tool.execute({"topic": "季度产品复盘"}, tool_context()))

    assert result.ok is False
    assert result.status == "failed"
    assert result.error is not None and result.error.code == "model_unavailable"
    assert fake.created == []


def test_create_presentation_tool_requires_conversation(scope, monkeypatch):
    monkeypatch.setattr(presentation_tools, "presentation_service", FakeService())
    tool = presentation_tools.CreatePresentationTool()

    result = asyncio.run(tool.execute({"topic": "季度产品复盘"}, ToolContext(platform_name="local")))

    assert result.ok is False
    assert result.error is not None and result.error.code == "presentation_context_missing"


def test_get_presentation_tool_reads_bound_context(scope, monkeypatch):
    fake = FakeService()
    monkeypatch.setattr(presentation_tools, "presentation_service", fake)
    monkeypatch.setattr(presentation_tools, "public_presentation", lambda job: job)
    tool = presentation_tools.GetPresentationTool()

    result = asyncio.run(tool.execute({"job_id": "b" * 32}, tool_context()))

    assert result.ok is True
    assert result.data["job"]["id"] == "b" * 32
    job_id, context = fake.requested
    assert job_id == "b" * 32
    assert context.conversation_id == 7


def test_bootstrap_registers_presentation_tool_surface(scope):
    from app.agent.bootstrap import _build_tool_registry

    registry = _build_tool_registry(object())
    assert "create_presentation" in registry.names()
    assert "get_presentation" in registry.names()
    assert registry.spec("create_presentation").risk == "local_pending_write"
    assert registry.spec("get_presentation").risk == "read_only"


def test_presentation_tools_are_visible_only_for_ppt_skill_binding(scope):
    from app.agent.runtime import AgentRuntime
    from app.models import ModelProviderRegistry
    from app.tools.base import ToolRegistry

    tools = ToolRegistry()
    tools.register_handler(presentation_tools.CreatePresentationTool())
    tools.register_handler(presentation_tools.GetPresentationTool())
    runtime = AgentRuntime(
        models=ModelProviderRegistry(),
        tools=tools,
        model_provider="test",
        platform_name="test",
        max_tool_rounds=1,
    )

    assert runtime._interrupt_tools() == frozenset()

    token = runtime._skill_context.set({"id": "ppt-master"})
    try:
        assert runtime._interrupt_tools() == frozenset({"create_presentation", "get_presentation"})
    finally:
        runtime._skill_context.reset(token)

    token = runtime._skill_context.set({"id": "another-skill"})
    try:
        assert runtime._interrupt_tools() == frozenset()
    finally:
        runtime._skill_context.reset(token)


def test_ppt_skill_bypasses_route_planning(scope):
    from app.agent.capability_resolver import TaskRoute
    from app.agent.runtime import AgentRuntime
    from app.models import ModelProviderRegistry
    from app.tools.base import ToolRegistry

    runtime = AgentRuntime(
        models=ModelProviderRegistry(),
        tools=ToolRegistry(),
        model_provider="test",
        platform_name="test",
        max_tool_rounds=1,
    )
    route = TaskRoute(
        kind="content_creation",
        needs_plan=True,
        allowed_tools=("get_library_context",),
    )

    assert runtime._plan_mode(route, None) in {"static", "llm"}

    token = runtime._skill_context.set({"id": "ppt-master"})
    try:
        assert runtime._plan_mode(route, None) == "none"
    finally:
        runtime._skill_context.reset(token)
