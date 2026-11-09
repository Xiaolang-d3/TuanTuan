from __future__ import annotations

from app.agent.capability_resolver import (
    TaskRoute,
    capability_group,
    capability_request_for_content,
    is_mixed_run,
    resolve_capabilities,
)
from app.agent.orchestration import detect_kind, route_task
from app.tooling import TOOL_SPECS


SURFACE = dict(TOOL_SPECS)
WITHOUT_WEB = {name: spec for name, spec in SURFACE.items() if name != "search_public_web"}


def test_plain_question_with_web_consent_stays_conversation() -> None:
    route = route_task("分析这个岗位是否适合我", set(SURFACE))
    assert route.kind == "conversation"
    assert route.allowed_tools == ()
    assert route.required_tools == ()
    assert not is_mixed_run(route, SURFACE)


def test_news_keyword_routes_to_web_search() -> None:
    assert detect_kind("最近有什么 AI Agent 新闻？") == "web_search"


def test_search_phrase_without_consent_keeps_tools_empty() -> None:
    route = route_task("帮我搜一下，蔻蔻琪生物科技公司", set(WITHOUT_WEB))
    assert route.kind == "conversation"
    assert route.allowed_tools == ()


def test_local_search_phrase_is_not_a_public_request() -> None:
    route = route_task("搜索我的笔记", set(WITHOUT_WEB))
    assert route.kind == "library_search"
    assert route.allowed_tools == ("get_library_context", "search_library", "read_library_source")


def test_mixed_task_composes_library_and_web() -> None:
    route = route_task("根据我的笔记并搜索最新技术写报告", set(SURFACE))
    assert route.kind == "library_search"
    assert route.allowed_tools == (
        "get_library_context",
        "search_library",
        "read_library_source",
        "search_public_web",
    )
    assert route.needs_plan
    assert is_mixed_run(route, SURFACE)


def test_mixed_task_without_consent_keeps_library_only() -> None:
    route = route_task("根据我的笔记并搜索最新技术写报告", set(WITHOUT_WEB))
    assert route.kind == "library_search"
    assert route.allowed_tools == ("get_library_context", "search_library", "read_library_source")
    assert not is_mixed_run(route, WITHOUT_WEB)


def test_library_update_requires_proposal_not_read() -> None:
    route = route_task("记住：每周整理一次读书笔记", set(SURFACE))
    assert route.kind == "library_update"
    assert route.allowed_tools == ("get_library_context", "read_library_source", "propose_library_knowledge")
    assert route.required_tools == ("propose_library_knowledge",)


def test_explicit_web_request_becomes_required() -> None:
    route = route_task("帮我联网搜索今天的招聘市场新闻", set(SURFACE))
    assert route.kind == "web_search"
    assert route.allowed_tools == ("search_public_web",)
    assert route.required_tools == ("search_public_web",)


def test_group_read_and_search_share_completion_group() -> None:
    assert capability_group(SURFACE["get_library_context"]) == "library.read"
    assert capability_group(SURFACE["search_library"]) == "library.read"
    assert capability_group(SURFACE["search_public_web"]) == "web.search.generic"


def test_resolver_grants_nothing_without_registered_surface() -> None:
    request = capability_request_for_content("根据我的知识库回答", "library_search")
    route = resolve_capabilities(request, registered_specs={}, web_search_allowed=False)
    assert route.allowed_tools == ()
    assert route.required_tools == ()
    assert not route.needs_plan


def test_route_carries_required_tools_into_snapshot_shape() -> None:
    route = TaskRoute(
        "library_search", False, ("get_library_context",), ("get_library_context",)
    )
    assert route.required_tools == ("get_library_context",)
