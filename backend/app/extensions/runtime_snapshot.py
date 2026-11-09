from __future__ import annotations

import hashlib
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .contracts import ExtensionContext
from .skills import SkillService


class ExtensionRunSnapshot(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    version: int = 1
    user_id: int = Field(gt=0)
    skill_binding: dict[str, Any] | None = None
    catalog: list[dict[str, Any]] = Field(default_factory=list)
    model_selection: dict[str, Any] = Field(default_factory=dict)
    grants: tuple[str, ...] = ()
    dependency_digest: str = ""
    execution: dict[str, str] | None = None

    @model_validator(mode="after")
    def execution_binding(self):
        if self.version == 1 and self.execution is not None:
            raise ValueError("v1 任务不能包含本机执行绑定")
        if self.version == 2:
            from ..execution.builtin_runtime import UPSTREAM_COMMIT
            from ..agent.model_binding import is_bound_selection
            if "builtin.ppt-master.execute" not in self.grants or not is_bound_selection(self.model_selection):
                raise ValueError("本机 PPT 任务需要内置执行授权和固定模型绑定")
            binding = self.execution or {}
            if set(binding) != {"backend", "adapter", "runtime_digest", "upstream_commit"}:
                raise ValueError("v2 任务缺少完整执行绑定")
            if binding["backend"] != "local_builtin" or binding["adapter"] != "ppt-master" or binding["upstream_commit"] != UPSTREAM_COMMIT:
                raise ValueError("未知本机执行绑定")
            if len(binding["runtime_digest"]) != 64 or any(char not in "0123456789abcdef" for char in binding["runtime_digest"]):
                raise ValueError("本机执行资源版本无效")
        if self.version not in {1, 2}:
            raise ValueError("不支持的扩展任务快照版本")
        return self


def bind_extensions(context: ExtensionContext, skill_id: str | None = None, *, model_selection: dict | None = None, grants: tuple[str, ...] = (), dependency_digest: str = "") -> ExtensionRunSnapshot:
    context.check_workspace()
    from ..agent.model_binding import internal_model_selection
    service = SkillService()
    catalog = [{key: item[key] for key in ("id", "revision", "name", "description", "model_invocable") if key in item} for item in service.list(context, enabled_only=True)]
    return ExtensionRunSnapshot(user_id=context.user_id, skill_binding=service.binding(skill_id, context) if skill_id else None, catalog=catalog, model_selection=internal_model_selection(model_selection), grants=grants, dependency_digest=dependency_digest)


def resolve_snapshot(snapshot: ExtensionRunSnapshot, context: ExtensionContext) -> ExtensionRunSnapshot:
    context.check_workspace()
    if snapshot.version not in {1, 2} or snapshot.user_id != context.user_id:
        raise PermissionError("任务快照不属于当前用户或版本不兼容")
    service = SkillService()
    if snapshot.skill_binding:
        service.resolve_binding(snapshot.skill_binding, context)
    for item in snapshot.catalog:
        service.get(item["id"], item["revision"], context, bound=True)
    return snapshot
