from __future__ import annotations

from typing import Any, Callable, Literal, Protocol

from pydantic import BaseModel

from ..domain import ToolDefinition, ToolResult
from ..registry import NamedRegistry
from ..search_options import WebSearchOptions
from ..tooling import TOOL_SPECS, ToolSpec
from ..extensions.contracts import ExtensionContext, RegistrationOwner


class ToolContext(BaseModel):
    platform_name: str
    agent_run_id: str | None = None
    conversation_id: int | None = None
    library_read_allowed: bool = True
    task_id: int | None = None
    user_content: str = ""
    web_search_mode: Literal["auto", "technical", "general"] = "auto"
    web_search_options: WebSearchOptions | None = None
    require_external_query_approval: bool = False
    approved_external_queries: tuple[str, ...] = ()


class ToolHandler(Protocol):
    definition: ToolDefinition
    # Optional Pydantic model; when present the registry validates centrally.
    arguments_model: type[BaseModel] | None

    async def execute(self, arguments: dict, context: ToolContext) -> ToolResult:
        ...


class ToolRegistry(NamedRegistry[ToolHandler]):
    def __init__(self) -> None:
        super().__init__("工具")
        self._specs: dict[str, ToolSpec] = {}
        self._owners: dict[str, tuple[RegistrationOwner | None, int | None, object]] = {}
        self._frozen = False

    def register_handler(self, handler: ToolHandler, *, spec: ToolSpec | None = None, owner: RegistrationOwner | None = None, scope: int | None = None) -> Callable[[], None]:
        if self._frozen:
            raise ValueError("运行工具快照不可修改")
        spec = spec or getattr(handler, "spec", None) or TOOL_SPECS.get(handler.definition.name)
        if spec is None:
            raise ValueError(f"工具缺少 ToolSpec：{handler.definition.name}")
        if spec.name != handler.definition.name:
            raise ValueError(
                f"ToolSpec 名称与工具定义不一致：{spec.name} != {handler.definition.name}"
            )
        self.register(handler.definition.name, handler)
        name = self._normalize(handler.definition.name)
        self._specs[name] = spec
        token = object()
        self._owners[name] = (owner, scope, token)

        def dispose() -> None:
            if self._owners.get(name, (None, None, None))[2] is token:
                self._items.pop(name, None)
                self._specs.pop(name, None)
                self._owners.pop(name, None)
        return dispose

    def snapshot_for_run(self, context: ExtensionContext) -> "ToolRegistry":
        snapshot = ToolRegistry()
        for name in self.names():
            owner, scope, _ = self._owners[name]
            if scope is None or scope == context.user_id:
                snapshot.register_handler(self.get(name), spec=self._specs[name], owner=owner, scope=scope)
        snapshot._frozen = True
        return snapshot

    def definitions(self) -> list[ToolDefinition]:
        return [self.get(name).definition for name in self.names()]

    def spec(self, name: str) -> ToolSpec:
        self.get(name)
        return self._specs[name]

    def specs(self) -> list[ToolSpec]:
        return [self.spec(name) for name in self.names()]

    def names_for_capabilities(self, capabilities: set[str]) -> list[str]:
        if not capabilities:
            return self.names()
        return [
            spec.name
            for spec in self.specs()
            if capabilities & set(spec.capabilities)
        ]

    def validate_arguments(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """Validate one call before execution and return normalized arguments.

        Handlers that declare ``arguments_model`` get schema validation at the
        harness boundary; others keep the raw-dict contract and validate in
        their own error boundary.
        """
        handler = self.get(name)
        model = getattr(handler, "arguments_model", None)
        if model is None:
            return arguments
        return model.model_validate(arguments).model_dump(mode="json")
