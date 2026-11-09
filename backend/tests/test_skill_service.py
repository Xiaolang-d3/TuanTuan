import asyncio

import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.extensions.repository import ExtensionRepository, ExtensionNotFound, ExtensionUnavailable
from app.extensions.skills import SkillService, parse_skill
from app.domain import AgentMessage, AgentRunSnapshot, ModelResponse, ToolCall
from app.tools.load_skill import LoadSkillTool
from app.tools import AskUserTool, ToolContext
from app.workspace import use_workspace
from test_agent_runtime import ScriptedModel, runtime_for


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1, tmp_path / "one"):
        db.init_db()
        yield ExtensionContext.current()


def imported(context, name="alpha", body="使用清晰的结论与行动清单"):
    service = SkillService()
    item = service.import_text(f"---\nname: {name}\ndescription: 用于测试技能加载\npermissions: [shell, network]\n---\n{body}", context)
    ExtensionRepository().set_enabled(item["id"], True, context)
    return item


def test_list_exposes_only_metadata_and_frontmatter_does_not_grant_tools(scope):
    item = imported(scope)
    listed = SkillService().list(scope)
    assert "content" not in listed[0]
    assert listed[0]["permissions"] == []
    assert listed[0]["metadata"]["permissions"] == ["shell", "network"]
    assert item["id"] == listed[0]["id"]


def test_disabled_skill_denied_to_new_run_but_existing_binding_retains_revision(scope):
    service = SkillService()
    item = imported(scope)
    binding = service.binding(item["id"], scope)
    ExtensionRepository().set_enabled(item["id"], False, scope)
    with pytest.raises(ExtensionUnavailable):
        service.binding(item["id"], scope)
    ExtensionRepository().remove(item["id"], scope)
    assert service.resolve_binding(binding, scope)["revision"] == binding["revision"]


def test_other_user_cannot_load_or_restore_a_binding(scope, tmp_path):
    item = imported(scope)
    binding = SkillService().binding(item["id"], scope)
    with use_workspace(2, tmp_path / "two"):
        db.init_db()
        other = ExtensionContext.current()
        with pytest.raises(ExtensionNotFound):
            SkillService().get(item["id"], item["revision"], other)
        with pytest.raises(PermissionError):
            SkillService().resolve_binding(binding, other)


@pytest.mark.parametrize("metadata", ["name: demo\nname: duplicate\ndescription: test", "name: &a demo\ndescription: *a", "name: !!python/object test\ndescription: test"])
def test_yaml_aliases_duplicates_and_tags_are_rejected(metadata):
    with pytest.raises(ValueError):
        parse_skill(f"---\n{metadata}\n---\nbody")


def test_manual_selection_reaches_model_without_granting_tools(scope):
    first = imported(scope, "first", "FIRST_SKILL_SENTINEL")
    imported(scope, "second", "SECOND_SKILL_SENTINEL")
    model = ScriptedModel([ModelResponse(content="完成")])
    runtime = runtime_for(model)
    binding = SkillService().binding(first["id"], scope)
    result = asyncio.run(runtime.run("你好", skill_binding=binding))
    assert result.content == "完成"
    combined = "\n".join(message.content for message in model.requests[-1].messages)
    assert "FIRST_SKILL_SENTINEL" in combined and "SECOND_SKILL_SENTINEL" not in combined
    assert not model.requests[-1].tools


def test_load_skill_is_bound_to_catalog_and_cannot_load_arbitrary_user_id(scope):
    item = imported(scope)
    tool = LoadSkillTool(SkillService().list(scope, enabled_only=True), scope)
    result = asyncio.run(tool.execute({"skill_id": item["id"], "revision": item["revision"]}, ToolContext(platform_name="test")))
    assert result.ok and result.data["content"] == item["content"]
    with pytest.raises(ExtensionNotFound):
        asyncio.run(tool.execute({"skill_id": "other", "revision": "a" * 64}, ToolContext(platform_name="test")))


def test_optional_skill_body_can_be_read_in_bounded_pages(scope):
    item = imported(scope, body="开头" * 2000 + "末尾标记")
    tool = LoadSkillTool(SkillService().list(scope, enabled_only=True), scope)
    first = asyncio.run(tool.execute({"skill_id": item["id"], "revision": item["revision"]}, ToolContext(platform_name="test")))
    assert len(first.data["content"]) <= 2500
    assert first.data["next_offset"] == 2500
    tail = asyncio.run(tool.execute({"skill_id": item["id"], "revision": item["revision"], "offset": first.data["next_offset"]}, ToolContext(platform_name="test")))
    assert "末尾标记" in tail.message and tail.data["next_offset"] is None


def test_checkpoint_restores_original_optional_skill_catalog_after_disable(scope):
    item = imported(scope, "original", "ORIGINAL_CATALOG_BODY")
    catalog = SkillService().list(scope, enabled_only=True)
    waiting_model = ScriptedModel([ModelResponse(tool_calls=[ToolCall(id="ask", name="ask_user", arguments={"question": "继续？", "options": [{"label": "继续", "send": "继续"}, {"label": "停止", "send": "停止"}]})])])
    waiting = asyncio.run(runtime_for(waiting_model, AskUserTool(), LoadSkillTool(catalog, scope)).run("你好"))
    assert waiting.snapshot is not None and waiting.snapshot.skill_catalog[0]["id"] == item["id"]
    ExtensionRepository().set_enabled(item["id"], False, scope)
    later = imported(scope, "later", "LATER_CATALOG_BODY")
    model = ScriptedModel([ModelResponse(tool_calls=[ToolCall(id="load-original", name="load_skill", arguments={"skill_id": item["id"], "revision": item["revision"]})]), ModelResponse(content="完成")])
    runtime = runtime_for(model, LoadSkillTool(SkillService().list(scope, enabled_only=True), scope))
    snapshot = AgentRunSnapshot.model_validate_json(waiting.snapshot.model_dump_json()).model_copy(update={"resume_mode": "checkpoint"})
    result = asyncio.run(runtime.run("你好", resume=snapshot))
    assert result.content == "完成", result
    assert "ORIGINAL_CATALOG_BODY" in "\n".join(message.content for message in model.requests[-1].messages)
    description = model.requests[0].tools[0].description
    assert item["id"] in description and later["id"] not in description
