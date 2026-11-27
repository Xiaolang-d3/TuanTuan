"""Agent domain.

bootstrap/runtime 都会导入 app.tools，而 tools 的各模块又读取 agent.settings。
这里急切导入会让「先导入 tools」的一方（如单跑工具测试）撞上半初始化的包，
所以按 PEP 562 改成按需导出，打断环导入。
"""

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .bootstrap import get_agent_capabilities, get_agent_runtime, get_profile_connection, reload_agent_components
    from .runtime import AgentRuntime

__all__ = [
    "AgentRuntime",
    "get_agent_capabilities",
    "get_agent_runtime",
    "get_profile_connection",
    "reload_agent_components",
]


def __getattr__(name: str) -> Any:
    if name in __all__ and name != "AgentRuntime":
        from . import bootstrap

        return getattr(bootstrap, name)
    if name == "AgentRuntime":
        from .runtime import AgentRuntime

        return AgentRuntime
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
