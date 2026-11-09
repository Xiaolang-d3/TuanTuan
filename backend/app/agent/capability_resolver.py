from __future__ import annotations

from dataclasses import dataclass

from ..tooling import ToolSpec


LIBRARY_READ_CAPABILITY = "library.read"
LIBRARY_SEARCH_CAPABILITY = "library.search"
LIBRARY_BLOCK_READ_CAPABILITY = "library.read.blocks"
WEB_SEARCH_CAPABILITY = "web.search.generic"
KNOWLEDGE_PROPOSAL_CAPABILITY = "library.propose"
LIBRARY_READ_CAPABILITIES = frozenset({LIBRARY_READ_CAPABILITY, LIBRARY_SEARCH_CAPABILITY, LIBRARY_BLOCK_READ_CAPABILITY})

# Order controls both the allowed-tool order and required-tool resolution order.
CAPABILITY_ORDER = (
    LIBRARY_READ_CAPABILITY,
    LIBRARY_SEARCH_CAPABILITY,
    LIBRARY_BLOCK_READ_CAPABILITY,
    WEB_SEARCH_CAPABILITY,
    KNOWLEDGE_PROPOSAL_CAPABILITY,
)

# Baseline capabilities per lane kind. Content signals may add more.
KIND_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "library_search": (LIBRARY_READ_CAPABILITY, LIBRARY_SEARCH_CAPABILITY),
    "content_creation": (),
    "library_update": (LIBRARY_READ_CAPABILITY, KNOWLEDGE_PROPOSAL_CAPABILITY),
    "web_search": (WEB_SEARCH_CAPABILITY,),
}

# Explicit completion obligations per lane kind, resolved on the current surface.
KIND_REQUIRED_CAPABILITIES: dict[str, tuple[str, ...]] = {
    "library_search": (LIBRARY_READ_CAPABILITY,),
    "content_creation": (),
    "library_update": (KNOWLEDGE_PROPOSAL_CAPABILITY,),
    "web_search": (WEB_SEARCH_CAPABILITY,),
}

PROPOSE_SIGNALS = ("记住", "加入知识库", "记录知识", "保存这条知识", "存入知识库", "记入知识库")
LIBRARY_SIGNALS = (
    "知识库",
    "资料库",
    "我的资料",
    "我的笔记",
    "我的文件",
    "我的文档",
    "已保存",
    "这份材料",
    "本地资料",
    "查找资料",
    "资料里",
    "笔记里",
    "文件里",
)
WEB_STRONG_SIGNALS = ("联网", "网上查", "上网查", "网上搜", "网上搜索")
WEB_ACTION_SIGNALS = ("搜索", "搜一下", "搜一搜", "帮我搜", "帮我查", "查一下", "查查")
WEB_FRESHNESS_SIGNALS = ("最新", "实时", "近期", "新闻", "进展", "动态")
# The object of the search is the user's own store, so a search verb is not a
# request to leave the device. Kept as whole phrases to avoid false positives
# on search topics that merely mention data.
LOCAL_SEARCH_PHRASES = (
    "搜索我的资料",
    "搜索我的笔记",
    "搜索我的文件",
    "搜索我的文档",
    "搜索知识库",
    "搜索资料库",
    "搜一下我的资料",
    "搜一下我的笔记",
    "搜我的资料",
    "搜我的笔记",
    "查我的资料",
    "查我的笔记",
    "查找我的资料",
    "查找我的笔记",
    "资料里",
    "笔记里",
    "文件里",
)


@dataclass(frozen=True)
class TaskRoute:
    kind: str
    needs_plan: bool
    allowed_tools: tuple[str, ...]
    required_tools: tuple[str, ...] = ()


@dataclass(frozen=True)
class CapabilityRequest:
    intent_kind: str
    use_private_library: bool = False
    need_public_web: bool = False
    need_knowledge_proposal: bool = False
    user_explicitly_requested_web: bool = False
    needs_synthesis: bool = False


def _contains(text: str, phrases: tuple[str, ...]) -> bool:
    return any(phrase in text for phrase in phrases)


def is_explicit_web_request(text: str) -> bool:
    """True only when the user's own words ask for a public web search."""
    normalized = (text or "").casefold()
    if _contains(normalized, WEB_STRONG_SIGNALS):
        return True
    if _contains(normalized, WEB_ACTION_SIGNALS):
        return not _contains(normalized, LOCAL_SEARCH_PHRASES)
    return False


def requests_public_web(text: str) -> bool:
    normalized = (text or "").casefold()
    if is_explicit_web_request(normalized):
        return True
    return _contains(normalized, WEB_FRESHNESS_SIGNALS) and not _contains(
        normalized, LOCAL_SEARCH_PHRASES
    )


def requests_private_library(text: str) -> bool:
    return _contains((text or "").casefold(), LIBRARY_SIGNALS)


def requests_knowledge_proposal(text: str) -> bool:
    return _contains((text or "").casefold(), PROPOSE_SIGNALS)


def capability_request_for_content(content: str, kind: str) -> CapabilityRequest:
    text = content or ""
    if kind == "library_update":
        # The lane already carries its helper read capability; note-taking
        # signals in the text describe the payload, not a request to read files.
        use_library = False
    else:
        use_library = kind == "library_search" or requests_private_library(text)
    explicit_web = is_explicit_web_request(text)
    return CapabilityRequest(
        intent_kind=kind,
        use_private_library=use_library,
        need_public_web=kind == "web_search" or explicit_web or requests_public_web(text),
        need_knowledge_proposal=kind == "library_update" or requests_knowledge_proposal(text),
        user_explicitly_requested_web=explicit_web,
    )


def capability_group(spec: ToolSpec) -> str:
    """Collapse concrete tools into the capability group completion cares about."""
    capabilities = spec.capabilities
    if capabilities & LIBRARY_READ_CAPABILITIES:
        return LIBRARY_READ_CAPABILITY
    if WEB_SEARCH_CAPABILITY in capabilities:
        return WEB_SEARCH_CAPABILITY
    if KNOWLEDGE_PROPOSAL_CAPABILITY in capabilities:
        return KNOWLEDGE_PROPOSAL_CAPABILITY
    return "capability:" + "|".join(sorted(capabilities))


def _pick_tool(capability: str, surface: dict[str, ToolSpec]) -> str | None:
    matches = sorted(
        (spec for spec in surface.values() if capability in spec.capabilities),
        key=lambda spec: (spec.priority, spec.name),
    )
    return matches[0].name if matches else None


def _first_allowed_in_group(
    group: str,
    allowed: list[str],
    surface: dict[str, ToolSpec],
) -> str | None:
    for name in allowed:
        spec = surface.get(name)
        if spec is not None and capability_group(spec) == group:
            return name
    return None


def resolve_capabilities(
    request: CapabilityRequest,
    *,
    registered_specs: dict[str, ToolSpec],
    web_search_allowed: bool,
) -> TaskRoute:
    """Turn a capability request into an explicit, least-privilege TaskRoute."""
    kind = request.intent_kind
    requested: set[str] = set(KIND_CAPABILITIES.get(kind, ()))
    if request.use_private_library:
        requested |= LIBRARY_READ_CAPABILITIES
    if requested & LIBRARY_READ_CAPABILITIES:
        requested.add(LIBRARY_BLOCK_READ_CAPABILITY)
    if request.need_public_web and web_search_allowed:
        requested.add(WEB_SEARCH_CAPABILITY)
    if request.need_knowledge_proposal:
        requested.add(KNOWLEDGE_PROPOSAL_CAPABILITY)
    if not web_search_allowed:
        requested.discard(WEB_SEARCH_CAPABILITY)

    allowed: list[str] = []
    for capability in CAPABILITY_ORDER:
        if capability not in requested:
            continue
        tool = _pick_tool(capability, registered_specs)
        if tool is not None and tool not in allowed:
            allowed.append(tool)

    required_capabilities = list(KIND_REQUIRED_CAPABILITIES.get(kind, ()))
    if request.use_private_library:
        required_capabilities.append(LIBRARY_READ_CAPABILITY)
    if request.user_explicitly_requested_web and web_search_allowed:
        required_capabilities.append(WEB_SEARCH_CAPABILITY)
    if request.need_knowledge_proposal:
        required_capabilities.append(KNOWLEDGE_PROPOSAL_CAPABILITY)

    required: list[str] = []
    for capability in dict.fromkeys(required_capabilities):
        tool = _pick_tool(capability, {
            name: registered_specs[name] for name in allowed if name in registered_specs
        })
        if tool is None:
            tool = _first_allowed_in_group(capability, allowed, registered_specs)
        if tool is not None and tool not in required:
            required.append(tool)

    groups = {
        capability_group(registered_specs[name])
        for name in allowed
        if name in registered_specs
    }
    return TaskRoute(
        kind=kind,
        needs_plan=request.needs_synthesis or len(groups) >= 2,
        allowed_tools=tuple(allowed),
        required_tools=tuple(required),
    )


def is_mixed_run(route: TaskRoute, registered_specs: dict[str, ToolSpec]) -> bool:
    """A run that may read private material and may publish to the web."""
    groups = {
        capability_group(registered_specs[name])
        for name in route.allowed_tools
        if name in registered_specs
    }
    return (
        WEB_SEARCH_CAPABILITY in groups
        and LIBRARY_READ_CAPABILITY in groups
    )
