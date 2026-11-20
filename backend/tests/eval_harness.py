from __future__ import annotations

import json
import asyncio
from pathlib import Path
from typing import Any

from app.agent.behavior_checks import (
    apply_classifier_output,
    apply_planner_output,
    ask_user_behavior,
    simulated_tool_names,
    unverified_experience_claims,
)
from app.agent.orchestration import TOOL_POLICIES, route_task
from app.agent.runtime import validate_web_citations


AVAILABLE_TOOLS = set(TOOL_POLICIES)
CASES_DIR = Path(__file__).with_name("eval_cases")


def load_eval_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    for path in sorted(CASES_DIR.glob("*.json")):
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, list):
            raise ValueError(f"{path} 必须是 JSON 数组")
        cases.extend(payload)
    if not cases:
        raise ValueError(f"{CASES_DIR} 没有评测用例")
    return cases


def run_eval_case(case: dict[str, Any]) -> dict[str, Any]:
    vars_ = case.get("vars") or {}
    task = vars_.get("task")
    if task == "route":
        return _run_route(vars_)
    if task == "citation":
        return _run_citation(vars_)
    if task == "classify":
        return apply_classifier_output(str(vars_.get("query") or ""), str(vars_.get("model_output") or ""))
    if task == "plan":
        return apply_planner_output(
            str(vars_.get("query") or ""),
            str(vars_.get("kind") or "conversation"),
            str(vars_.get("model_output") or ""),
        )
    if task == "invent":
        claims = unverified_experience_claims(
            str(vars_.get("content") or ""),
            str(vars_.get("evidence") or ""),
        )
        return {"claims": claims, "valid": not claims}
    if task == "ask_user":
        return ask_user_behavior(
            str(vars_.get("content") or ""),
            simulated_tool_names(vars_.get("tool_calls")),
        )
    if task == "progress_dialogue":
        return asyncio.run(_run_progress_dialogue(vars_))
    raise ValueError(f"未知评测任务: {task}")


def assert_eval_expected(result: dict[str, Any], expected: dict[str, Any]) -> None:
    if "kind" in expected and result.get("kind") != expected["kind"]:
        raise AssertionError(f"kind={result.get('kind')!r}，期望 {expected['kind']!r}")
    tools = list(result.get("allowed_tools") or [])
    if expected.get("empty_tools") and tools:
        raise AssertionError(f"工具面应为空，实际 {tools}")
    if "allowed_tools" in expected and tools != list(expected["allowed_tools"]):
        raise AssertionError(f"allowed_tools={tools!r}，期望 {expected['allowed_tools']!r}")
    missing = [name for name in expected.get("contains_tools") or [] if name not in tools]
    if missing:
        raise AssertionError(f"缺少工具 {missing}，实际 {tools}")
    forbidden = list(expected.get("forbidden_tools") or [])
    if expected.get("forbid_ask_user", True) and "ask_user" not in forbidden:
        forbidden.append("ask_user")
    leaked = [name for name in forbidden if name in tools]
    if leaked:
        raise AssertionError(f"工具面不应包含 {leaked}，实际 {tools}")
    if "valid" in expected and result.get("valid") is not expected["valid"]:
        raise AssertionError(f"valid={result.get('valid')!r}，期望 {expected['valid']!r}")
    if expected.get("error_contains") and expected["error_contains"] not in (result.get("error") or ""):
        raise AssertionError(f"error={result.get('error')!r}，应包含 {expected['error_contains']!r}")
    if "parsed_tools" in expected and list(result.get("parsed_tools") or []) != list(expected["parsed_tools"]):
        raise AssertionError(f"parsed_tools={result.get('parsed_tools')!r}，期望 {expected['parsed_tools']!r}")
    extra_dropped = [name for name in expected.get("dropped_tools") or [] if name not in (result.get("dropped_tools") or [])]
    if extra_dropped:
        raise AssertionError(f"应丢弃 {extra_dropped}，实际 {result.get('dropped_tools')}")
    if "valid" not in expected and "claims" in expected:
        if list(result.get("claims") or []) != list(expected["claims"]):
            raise AssertionError(f"claims={result.get('claims')!r}，期望 {expected['claims']!r}")
    for key in ("used_ask_user", "should_ask_user", "violation", "keyword_kind",
                "task_success", "first_artifact_turn", "waiting_turns", "clarification_rejections", "facts_preserved"):
        if key in expected and result.get(key) != expected[key]:
            raise AssertionError(f"{key}={result.get(key)!r}，期望 {expected[key]!r}")


async def _run_progress_dialogue(vars_: dict[str, Any]) -> dict[str, Any]:
    """Replay synthetic multi-turn inputs through the real runtime, offline.

    This tests orchestration contracts with scripted model decisions. It does
    not measure a live model's independent decision quality or contact services.
    """
    from app.agent.runtime import AgentRuntime
    from app.domain import AgentMessage, ModelResponse
    from app.models import ModelProviderRegistry
    from app.tools import AskUserTool, ToolRegistry

    class DialogueModel:
        name = "progress-eval"

        def __init__(self):
            self.responses = [ModelResponse.model_validate(item) for item in vars_["model_responses"]]

        async def generate(self, request):
            if not self.responses:
                raise ValueError("对话评测的模型响应已用尽")
            return self.responses.pop(0)

    model = DialogueModel()
    models = ModelProviderRegistry()
    models.register(model.name, model)
    tools = ToolRegistry()
    tools.register_handler(AskUserTool())
    runtime = AgentRuntime(models=models, tools=tools, model_provider=model.name,
                           platform_name="offline-eval", max_tool_rounds=6)
    history = []
    snapshot = None
    first_artifact_turn = None
    waiting_turns = rejections = 0
    result = None
    for index, text in enumerate(vars_["turns"], start=1):
        result = await runtime.run(text, history=history, resume=snapshot)
        waiting_turns += result.status == "waiting_user"
        rejections += sum(event.tool_name == "clarification_validator" for event in result.events)
        if first_artifact_turn is None and result.status == "done" and all(
            marker in result.content for marker in vars_.get("artifact_markers", [])
        ):
            first_artifact_turn = index
        history.extend([AgentMessage(role="user", content=text), AgentMessage(role="assistant", content=result.content)])
        snapshot = result.snapshot
    return {
        "task_success": result is not None and result.status == "done" and first_artifact_turn is not None,
        "first_artifact_turn": first_artifact_turn, "waiting_turns": waiting_turns,
        "clarification_rejections": rejections,
        "facts_preserved": result is not None and all(fact in result.content for fact in vars_.get("required_facts", [])),
    }


def _run_route(vars_: dict[str, Any]) -> dict[str, Any]:
    content = str(vars_.get("query") or "")
    available = set(AVAILABLE_TOOLS)
    if not vars_.get("web_search"):
        # Same trusted surface the runtime builds when web consent is off.
        available -= {"search_public_web"}
    route = route_task(
        content,
        available,
    )
    return {
        "kind": route.kind,
        "allowed_tools": list(route.allowed_tools),
        "needs_plan": route.needs_plan,
        "ask_user_in_lane": "ask_user" in route.allowed_tools,
    }


def _run_citation(vars_: dict[str, Any]) -> dict[str, Any]:
    allowed = _as_url_set(vars_.get("allowed_urls"))
    valid, error = validate_web_citations(str(vars_.get("content") or ""), allowed)
    return {"valid": valid, "error": error}


def _as_url_set(value: Any) -> set[str]:
    if not value:
        return set()
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("["):
            return {str(item) for item in json.loads(text)}
        return {item.strip() for item in text.split(",") if item.strip()}
    return {str(item) for item in value}
