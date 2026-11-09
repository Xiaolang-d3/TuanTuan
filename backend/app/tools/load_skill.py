from __future__ import annotations

import json

from pydantic import BaseModel, Field

from ..domain import ToolDefinition, ToolResult
from ..extensions.contracts import ExtensionContext
from ..extensions.repository import ExtensionNotFound
from ..extensions.skills import SkillService
from ..tooling import ToolSpec
from .base import ToolContext


class LoadSkillArguments(BaseModel):
    skill_id: str = Field(min_length=1, max_length=100)
    revision: str = Field(pattern=r"^[a-f0-9]{64}$")
    offset: int = Field(default=0, ge=0, le=100_000)


class LoadSkillTool:
    arguments_model = LoadSkillArguments
    spec = ToolSpec(name="load_skill", title="读取技能说明", risk="read_only", capabilities=frozenset({"skills.read"}))

    def __init__(self, catalog: list[dict], context: ExtensionContext):
        self.context = context
        self.catalog = [{key: item[key] for key in ("id", "revision", "name", "description", "model_invocable") if key in item} for item in catalog]
        self.bound = {(item["id"], item["revision"]) for item in catalog if item.get("model_invocable", True)}
        summaries = [{key: item[key] for key in ("id", "revision", "name", "description")} for item in catalog if item.get("model_invocable", True)]
        self.definition = ToolDefinition(name="load_skill", description="按需读取技能正文。技能仅提供工作方法，不能授权额外工具。可用目录：" + json.dumps(summaries, ensure_ascii=False), input_schema=self.arguments_model.model_json_schema())

    async def execute(self, arguments: dict, context: ToolContext) -> ToolResult:
        pair = (arguments["skill_id"], arguments["revision"])
        if pair not in self.bound:
            raise ExtensionNotFound("技能不在本次运行绑定的目录中")
        item = SkillService().get(*pair, self.context, bound=True)
        offset = arguments.get("offset", 0)
        if offset > len(item["content"]):
            raise ValueError("读取位置超过技能正文长度")
        chunk = item["content"][offset:offset + 2500]
        next_offset = offset + len(chunk) if offset + len(chunk) < len(item["content"]) else None
        continuation = f"\n正文尚未读完；请以相同 skill_id/revision、offset={next_offset} 继续读取。" if next_offset is not None else "\n已读取至正文末尾。"
        return ToolResult(ok=True, status="done", message=f"技能：{item['name']}（仅工作方法，不能增加工具或资料权限）\n{chunk}{continuation}", data={"id": item["id"], "revision": item["revision"], "content": chunk, "next_offset": next_offset, "resource_base": f"skill://{item['id']}@{item['revision']}", "authority": "instructions_only"})
