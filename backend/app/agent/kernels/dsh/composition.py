"""DSH 组合 patch 的生成：按连接注入端点并禁用 DSH 原生工具。"""

from __future__ import annotations

from pathlib import Path


DISABLED_ROWS = (
    "tool-bash",
    "tool-pwsh",
    "tool-fs",
    "tool-fs-search",
    "tool-web",
    "tool-jobs",
    "tool-todo",
    "tool-office",
    "tool-agent-team",
    "tool-subagent-control",
    "tool-subagent",
    "tool-subagent-fork",
    "tool-goal",
    "tool-skill",
    "tool-schedule",
    "tool-workflow",
    "tool-plugin-manager",
)


def _quote(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def render_patch(base_url: str, mcp_command: str | None = None, mcp_args: list[str] | None = None) -> str:
    """Return a cordis patch: DeepSeek 端点 + 原生工具 allowlist 关闭 + 可选 MCP 挂载。"""
    lines: list[str] = ["- id: llm-deepseek", "  config:", f"    baseURL: {_quote(base_url)}"]
    for row_id in DISABLED_ROWS:
        lines.extend([f"- id: {row_id}", "  disabled: true"])
    if mcp_command:
        lines.extend([
            "- insert:",
            "    - id: mcp-tuantuan",
            "      name: '@deepseek-ai/dsh-mcp-client'",
            "      config:",
            "        serverName: tuantuan",
            "        transport: stdio",
            f"        command: {_quote(mcp_command)}",
            "        args:",
        ])
        for argument in mcp_args or []:
            lines.append(f"          - {_quote(argument)}")
        lines.append("        startupTimeoutMs: 30000")
    return "\n".join(lines) + "\n"


def write_patch(path: Path, base_url: str, mcp_command: str | None = None, mcp_args: list[str] | None = None) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_patch(base_url, mcp_command, mcp_args), encoding="utf-8")
    return path
