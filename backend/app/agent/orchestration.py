from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from ..domain import AgentPlan, AgentPlanStep, ModelResponse
from ..tooling import TOOL_SPECS, ToolSpec
from .capability_resolver import (
    WEB_SEARCH_CAPABILITY,
    CapabilityRequest,
    TaskRoute,
    capability_request_for_content,
    requests_private_library,
    requests_public_web,
    resolve_capabilities,
)
from .plan_builder import fallback_plan
from .progress import requests_writing_output


# Compatibility name for callers while route policy migrates to capabilities.
TOOL_POLICIES: dict[str, ToolSpec] = TOOL_SPECS


# Always visible to the model, never part of a lane plan, and never blocked as
# tool_not_planned. Must not be added to allowed_tools.
INTERRUPT_TOOLS = frozenset({"ask_user", "load_skill"})


ROUTE_LABELS = {
    "conversation": "日常问答",
    "library_search": "知识库问答",
    "library_update": "补充知识",
    "content_creation": "内容创作",
    "web_search": "联网搜索",
}

SIMPLE_CONVERSATION_MESSAGES = frozenset(
    {
        "hi",
        "hello",
        "hey",
        "你好",
        "您好",
        "在吗",
        "谢谢",
        "感谢",
        "测试",
        "test",
    }
)


def detect_kind(content: str) -> str:
    text = (content or "").strip().lower()
    if any(word in text for word in ("记住", "加入知识库", "记录知识", "保存这条知识")):
        return "library_update"
    if any(word in text for word in ("联网", "网上查", "搜索一下", "查一下最新", "新闻")):
        return "web_search"
    if any(word in text for word in ("写文章", "改写", "总结", "大纲", "创作", "写一篇")):
        return "content_creation"
    if any(word in text for word in ("知识库", "我的资料", "我的笔记", "已保存", "这份材料", "查找资料")):
        return "library_search"
    return "conversation"


def build_task_route(
    kind: str,
    content: str,
    available_tools: set[str],
    *,
    tool_specs: dict[str, ToolSpec] | None = None,
) -> TaskRoute:
    """Resolve authorized capabilities into an explicit least-privilege route."""
    resolved = kind if kind in ROUTE_LABELS else "conversation"
    specs = tool_specs or TOOL_SPECS
    surface = {name: spec for name, spec in specs.items() if name in available_tools}
    request = capability_request_for_content(content, resolved)
    return resolve_capabilities(
        request,
        registered_specs=surface,
        web_search_allowed=any(
            WEB_SEARCH_CAPABILITY in spec.capabilities for spec in surface.values()
        ),
    )


def route_task(
    content: str,
    available_tools: set[str],
    *,
    tool_specs: dict[str, ToolSpec] | None = None,
) -> TaskRoute:
    """Keyword fast path. Public web access is checked against the trusted surface."""
    return build_task_route(
        detect_kind(content),
        content,
        available_tools,
        tool_specs=tool_specs,
    )


def should_classify_kind(route: TaskRoute, content: str) -> bool:
    """Understand open tasks and creation requests with unspecified sources."""
    if route.kind == "web_search" and requests_writing_output(content):
        # Search is a source for the deliverable, not necessarily the objective.
        return True
    if any(phrase in content for phrase in ("不要", "不需要", "不用", "无需", "不围绕")):
        return True
    if route.kind not in {"conversation", "content_creation"}:
        return False
    if route.kind == "content_creation" and (requests_private_library(content) or requests_public_web(content)):
        return False
    normalized = (content or "").strip().lower().rstrip("!！?？。,. ")
    if not normalized or normalized in SIMPLE_CONVERSATION_MESSAGES:
        return False
    return True


def classifier_prompt(content: str) -> str:
    """Separate the user's objective from the sources needed to achieve it."""
    lanes = "\n".join(f"- {kind}: {label}" for kind, label in ROUTE_LABELS.items())
    today = datetime.now(timezone.utc).date().isoformat()
    return f"""分析用户当前要完成的任务及所需的信息来源。当前 UTC 日期：{today}。
只返回 JSON：{{"kind":"车道名","goal":"结合上下文还原的当前完整目标","sources":["private_library","public_web"],"needs_planning":false,"expects_draft":false}}
允许的车道：
{lanes}
规则：kind 描述任务类型，sources 独立描述必要的信息来源，可以为空数组。
goal 应保留用户要求的主题、范围和交付物；“继续”“第二个”等短回复须结合最近用户请求还原，不得把历史助手的推测当作用户目标。
private_library 仅用于用户要求基于已保存的私人资料；总结、写作、研究本身不意味着要读取私人资料。
public_web 用于需要核实的近期情况、市场行情、公众讨论或用户要求的公开检索。一般知识问答、改写用户已提供文本不需要搜索。
“大家的讨论”可能指公开平台，也可能指用户已有聊天记录；来源不明确时不要自行认定为私人知识库，可先澄清。
澄清后的最新答复优先于旧任务中的推测；不围绕个人简历、改看公开情况时应重新选择来源。
library_search 仅用于检索私人资料。不要因为历史中出现简历就选私人来源。
只选一个车道；不确定则 kind 为 conversation；不要输出工具名；不要解释。来源需求不等于联网授权，程序会另行检查许可。
研究、比较、综合行情与多来源讨论需要 needs_planning=true；单个事实查询、一般问答和简单改写为 false。
用户要求实际起草、修改、提炼成简历条目、文案、文章等成果时，expects_draft=true；仅询问写法、提供材料的方式、一般知识或调研时为 false。已有写作目标后补充材料仍为 true，除非用户明确改了目标。
用户消息：
{content}"""


class TaskUnderstanding(BaseModel):
    kind: Literal["conversation", "library_search", "library_update", "content_creation", "web_search"]
    goal: str = Field(default="", max_length=300)
    # None supports kind-only output from older configured classifiers.
    sources: list[Literal["private_library", "public_web"]] | None = Field(default=None, max_length=2)
    needs_planning: bool = Field(default=False, strict=True)
    expects_draft: bool | None = Field(default=None, strict=True)


def parse_task_understanding(response: ModelResponse) -> TaskUnderstanding | None:
    if response.tool_calls or not response.content.strip():
        return None
    raw = response.content.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, re.DOTALL)
    if fenced:
        raw = fenced.group(1)
    try:
        return TaskUnderstanding.model_validate_json(raw)
    except (ValidationError, ValueError):
        return None


def parse_classified_kind(response: ModelResponse) -> str | None:
    """Accept only a ROUTE_LABELS kind. Tool names and unknown keys are ignored."""
    understanding = parse_task_understanding(response)
    return understanding.kind if understanding is not None else None


def refine_route_from_classifier(
    route: TaskRoute,
    content: str,
    available_tools: set[str],
    response: ModelResponse,
    *,
    tool_specs: dict[str, ToolSpec] | None = None,
    force: bool = False,
) -> TaskRoute:
    """Resolve semantic source needs against the caller's trusted tool surface."""
    if not force and not should_classify_kind(route, content):
        return route
    understanding = parse_task_understanding(response)
    if understanding is None:
        return route
    classified = understanding.kind
    if understanding.sources is not None:
        sources = set(understanding.sources)
        if classified == "library_search" and "private_library" not in sources:
            classified = "conversation"
        specs = tool_specs or TOOL_SPECS
        surface = {name: spec for name, spec in specs.items() if name in available_tools}
        return resolve_capabilities(
            CapabilityRequest(
                intent_kind=classified,
                use_private_library="private_library" in sources,
                need_public_web="public_web" in sources,
                need_knowledge_proposal=classified == "library_update",
                user_explicitly_requested_web="public_web" in sources,
                needs_synthesis=understanding.needs_planning,
            ),
            registered_specs=surface,
            web_search_allowed=any(WEB_SEARCH_CAPABILITY in spec.capabilities for spec in surface.values()),
        )
    return build_task_route(
        classified,
        content,
        available_tools,
        tool_specs=tool_specs,
    )


def route_summary(route: TaskRoute) -> str:
    label = ROUTE_LABELS.get(route.kind, route.kind)
    if route.allowed_tools:
        return f"已识别为{label}，需要先规划并限制可用工具"
    return f"已识别为{label}，无需调用工具"


def tool_progress_message(tool_name: str, arguments: dict | None = None) -> str:
    """User-visible line for a running tool, using the model's actual arguments."""
    args = arguments or {}
    query = str(args.get("query") or "").strip()
    url = str(args.get("url") or args.get("official_website") or "").strip()
    question = str(args.get("question") or "").strip()
    if tool_name == "ask_user":
        return f"需要你确认：{question}" if question else "需要你确认后才能继续"
    if query:
        return f"正在检索：{query}"
    if url:
        host = re.sub(r"^https?://", "", url, flags=re.IGNORECASE).split("/")[0]
        host = host.removeprefix("www.")
        if host:
            return f"正在阅读 {host}"
    policy = TOOL_POLICIES.get(tool_name)
    if policy:
        return f"正在执行：{policy.title}"
    return "正在执行"


def visible_tools_prompt(
    tool_names: list[str],
    tool_specs: dict[str, ToolSpec] | None = None,
) -> str:
    """Tell the model the exact tool surface for this turn. Names only come from the runtime."""
    if not tool_names:
        return "本轮没有可调用的工具。直接说明当前能力缺失，不要点名或调用未提供的工具。"
    specs = tool_specs or TOOL_SPECS
    lines = []
    for name in tool_names:
        policy = specs.get(name)
        title = policy.title if policy else name
        lines.append(f"- {name}: {title}")
    return (
        "本轮实际可用工具：\n"
        + "\n".join(lines)
        + "\n只允许调用以上工具。缺少对应能力时直接说明，不要点名未提供的工具。"
    )


def required_tools_for_route(
    route: TaskRoute,
    tool_specs: dict[str, ToolSpec] | None = None,
) -> list[str]:
    """Completion obligations are explicit on the route; empty means none."""
    del tool_specs
    return list(route.required_tools)


def replan_prompt(
    goal: str,
    route: TaskRoute,
    failed_tool: str,
    error_message: str,
    tool_specs: dict[str, ToolSpec] | None = None,
) -> str:
    """Ask for one same-lane replacement plan after a tool failure."""
    specs = tool_specs or TOOL_SPECS
    tool_lines = "\n".join(
        f"- {name}: {specs[name].title}，风险={specs[name].risk}"
        for name in route.allowed_tools
    )
    return f"""当前工作任务的一个工具失败了，请在同一车道重新生成 JSON 计划。
任务：{goal}
路由：{route.kind}
失败工具：{failed_tool}
失败原因：{error_message[:300]}
只允许使用以下工具：
{tool_lines}

返回且只返回 JSON：
{{"goal":"一句话目标","expected_output":"要交付的具体结果","success_criteria":["可检查的完成条件"],"steps":[{{"tool_name":"工具名","title":"用户可理解的步骤"}}]}}
规则：不得换车道；不得添加未列出的工具；不得把未检索到的信息写成事实；
优先选择尚未失败的工具；只有没有替代工具时才重试失败工具；不要输出思维过程。
保持用户原始范围，不要因一次检索失败扩大候选数量、分类或时间核验要求；优先使用已获得的有效证据。"""


def planner_prompt(
    goal: str,
    route: TaskRoute,
    tool_specs: dict[str, ToolSpec] | None = None,
) -> str:
    specs = tool_specs or TOOL_SPECS
    tool_lines = "\n".join(
        f"- {name}: {specs[name].title}，风险={specs[name].risk}"
        for name in route.allowed_tools
    )
    return f"""为下面的工作任务生成简短、可执行、可审计的 JSON 计划。当前 UTC 日期：{datetime.now(timezone.utc).date().isoformat()}。
任务：{goal}
路由：{route.kind}
只允许使用以下工具：
{tool_lines}

返回且只返回 JSON：
{{"goal":"一句话目标","expected_output":"要交付的具体结果","success_criteria":["可检查的完成条件"],"steps":[{{"tool_name":"工具名","title":"要取得什么证据及用途"}}]}}
规则：先明确范围、信息来源与交付物；按依赖顺序排列；不必使用所有工具；不得添加未列出的工具；不要输出思维过程。
公开研究应区分事实数据与社区个体讨论，核对来源；涉及用户要求的时效性时核对时间；私人资料仅在用户要求时使用。
交付物和完成条件不得超出用户原始目标。普通推荐先筛选少量相关候选，不自行要求覆盖所有分类、逐项核实更新时间或星标数量；缺失的次要信息可标注未核实。
每次补查应对应一个会影响结论的具体证据缺口；已有证据足以回答时立即汇总，不为增加来源数量持续搜索。
检索无结果或不相关时应调整查询或使用其他已授权来源，不能把工具调用成功当作目标已完成。"""


def parse_plan(
    response: ModelResponse,
    goal: str,
    route: TaskRoute,
    tool_specs: dict[str, ToolSpec] | None = None,
) -> AgentPlan:
    specs = tool_specs or TOOL_SPECS
    if response.tool_calls or not response.content.strip():
        return fallback_plan(goal, route, specs)
    raw = response.content.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", raw, re.DOTALL)
    if fenced:
        raw = fenced.group(1)
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return fallback_plan(goal, route, specs)
    if not isinstance(payload, dict):
        return fallback_plan(goal, route, specs)

    allowed = set(route.allowed_tools)
    steps: list[AgentPlanStep] = []
    raw_steps = payload.get("steps")
    if not isinstance(raw_steps, list):
        raw_steps = []
    for item in raw_steps:
        if not isinstance(item, dict):
            continue
        tool_name = str(item.get("tool_name") or "").strip()
        if tool_name not in allowed or tool_name in {step.tool_name for step in steps}:
            continue
        policy = specs.get(tool_name)
        if policy is None:
            continue
        try:
            step = AgentPlanStep(
                id=f"step-{len(steps) + 1}",
                title=str(item.get("title") or policy.title)[:100],
                tool_name=tool_name,
                risk=policy.risk,
            )
        except ValidationError:
            continue
        steps.append(step)
    for tool_name in required_tools_for_route(route):
        if tool_name not in allowed or tool_name in {step.tool_name for step in steps}:
            continue
        policy = specs.get(tool_name)
        if policy is None:
            continue
        steps.append(
            AgentPlanStep(
                id=f"step-{len(steps) + 1}",
                title=policy.title,
                tool_name=tool_name,
                risk=policy.risk,
            )
        )
    if not steps:
        return fallback_plan(goal, route, specs)
    parsed_goal = str(payload.get("goal") or goal).strip()[:300]
    return AgentPlan(
        goal=parsed_goal or "完成当前工作任务",
        route=route.kind,
        steps=steps,
        expected_output=str(payload.get("expected_output") or "")[:500],
        success_criteria=[item[:200] for item in payload.get("success_criteria", []) if isinstance(item, str)][:6]
        if isinstance(payload.get("success_criteria"), list) else [],
        requires_confirmation=any(step.risk == "confirmed_local_write" for step in steps),
    )
