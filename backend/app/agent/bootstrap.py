from __future__ import annotations

from typing import Any

from .model_binding import internal_model_selection
from .model_router import ModelRouter, bind_image_model, bind_model_stages, bind_text_model, get_routing_policy
from ..observability.model_context import public_model_selection
from ..config import get_settings
from ..models import ModelProviderRegistry, build_model_provider
from ..model_protocol import protocol_requires_api_key
from ..research.search import public_search_capabilities
from ..tools import AskUserTool, SearchPublicWebTool, ToolRegistry
from ..tools.library import GetLibraryContextTool, SearchLibraryTool, ProposeLibraryKnowledgeTool
from ..tools.read_library_source import ReadLibrarySourceTool
from .runtime import AgentRuntime
from .run_store import AgentRunStore
from ..workspace import current_user_id


_components: dict[tuple[Any, ...], tuple[AgentRuntime, dict[str, Any]]] = {}

SETUP_MESSAGE = "必须先在设置中配置模型服务 API Key 后才能使用对话 Agent"


def get_profile_connection(profile_id: str | None = None, *, selection: dict[str, Any] | None = None) -> dict[str, Any]:
    from .model_catalog import get_profile_connection as resolve_profile

    return resolve_profile(profile_id, selection=selection)


def _routing_revision() -> int:
    from ..models.factory import model_backend
    from .model_routing import get_fallback_policy

    if model_backend() != "litellm":
        return -1
    try:
        return int(get_fallback_policy()["revision"])
    except Exception:
        return 0


def _runtime_cache_key(connection: dict[str, Any]) -> tuple[Any, ...]:
    from ..models.factory import model_backend

    return (
        current_user_id(), connection.get("profile_id"), connection.get("profile_revision"),
        connection.get("connection_id"), connection.get("connection_revision"),
        connection["model_name"], connection["model_base_url"], connection.get("model_protocol", "auto"),
        connection.get("credential_fingerprint"),
        connection.get("policy_version"), connection.get("strict_capabilities", False),
        tuple((stage, value.get("profile_id"), value.get("profile_revision"),
               value.get("connection_id"), value.get("connection_revision"), value.get("credential_fingerprint"), value.get("selection_reason"))
              for stage, value in sorted(connection.get("stage_connections", {}).items())),
        model_backend(), _routing_revision(), _extension_revision(),
    )


def _model_is_configured(model_connection: dict[str, Any]) -> bool:
    protocol = model_connection.get("resolved_model_protocol", "openai")
    if not protocol_requires_api_key(protocol):
        return True
    return bool(model_connection.get("api_key"))


def _build_tool_registry(settings: Any) -> ToolRegistry:
    tools = ToolRegistry()
    tools.register_handler(AskUserTool())
    tools.register_handler(SearchPublicWebTool(settings=settings))
    tools.register_handler(GetLibraryContextTool())
    tools.register_handler(SearchLibraryTool())
    tools.register_handler(ReadLibrarySourceTool())
    tools.register_handler(ProposeLibraryKnowledgeTool())
    if current_user_id() is not None:
        from ..extensions.contracts import ExtensionContext
        from ..extensions.skills import SkillService
        from ..tools.load_skill import LoadSkillTool
        context = ExtensionContext.current()
        catalog = SkillService().list(context, enabled_only=True)
        if any(item.get("model_invocable", True) for item in catalog):
            tools.register_handler(LoadSkillTool(catalog, context), scope=context.user_id)
    return tools


def _extension_revision() -> tuple:
    if current_user_id() is None:
        return ()
    from ..extensions.contracts import ExtensionContext
    from ..extensions.skills import SkillService
    return tuple((item["id"], item["revision"]) for item in SkillService().list(ExtensionContext.current(), enabled_only=True))


def _capabilities_payload(
    *,
    settings: Any,
    model_connection: dict[str, Any],
    tools: ToolRegistry,
    model_providers: list[str],
    active_model_provider: str,
    configured: bool,
    setup_message: str | None = None,
) -> dict[str, Any]:
    search_provider = settings.resolved_web_search_provider if settings.web_research_enabled else "disabled"
    payload: dict[str, Any] = {
        "configured": configured,
        "active_model_provider": active_model_provider,
        "active_model_name": model_connection["model_name"],
        "model_selection": public_model_selection(model_connection),
        "active_platform": "manual",
        "model_providers": model_providers,
        "platforms": ["manual"],
        "tools": tools.names(),
        "tool_specs": [spec.model_dump(mode="json") for spec in tools.specs()],
        "runtime": {
            "max_tool_rounds": settings.model_max_tool_rounds,
            "model_retry_attempts": settings.model_retry_attempts,
            "tool_retry_attempts": settings.tool_retry_attempts,
            "tool_timeout_seconds": settings.tool_execution_timeout_seconds,
        },
        "web_research": {
            "enabled": settings.web_research_enabled,
            "provider": search_provider,
            **public_search_capabilities(search_provider),
        },
    }
    if setup_message:
        payload["setup_message"] = setup_message
    return payload


def _build_unconfigured_capabilities(model_connection: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    tools = _build_tool_registry(settings)
    return _capabilities_payload(
        settings=settings,
        model_connection=model_connection,
        tools=tools,
        model_providers=[],
        active_model_provider="",
        configured=False,
        setup_message=SETUP_MESSAGE,
    )


def _build_components(model_connection: dict[str, Any]) -> tuple[AgentRuntime, dict[str, Any]]:
    from ..models.configured import configure_model_provider
    from .model_catalog import detected_protocol_recorder

    settings = get_settings()

    if not _model_is_configured(model_connection):
        raise ValueError("必须先配置模型服务 API Key")

    models = ModelProviderRegistry()
    model = build_model_provider(
        api_key=model_connection["api_key"],
        model=model_connection["model_name"],
        base_url=model_connection["model_base_url"] or None,
        timeout_seconds=settings.model_timeout_seconds,
        protocol=model_connection.get("model_protocol", "auto"),
        detected_protocol=model_connection.get("detected_protocol"),
        on_protocol_detected=detected_protocol_recorder(model_connection),
        price_per_million_input=model_connection.get("price_per_million_input"),
        price_per_million_output=model_connection.get("price_per_million_output"),
    )
    model = _with_fallbacks(model, model_connection, settings.model_timeout_seconds)
    model = configure_model_provider(
        model, model_connection.get("parameters", {}), model_connection.get("reasoning_effort"),
    )
    model_alias = str(model_connection.get("profile_id") or model.name)
    models.register(model_alias, model)

    stage_connections = model_connection.get("stage_connections", {})
    stage_providers = {}
    for stage, connection in stage_connections.items():
        if not _model_is_configured(connection):
            continue
        if (connection.get("profile_id"), connection.get("profile_revision"), connection.get("connection_revision"), connection.get("credential_fingerprint")) == (
            model_connection.get("profile_id"), model_connection.get("profile_revision"), model_connection.get("connection_revision"), model_connection.get("credential_fingerprint"),
        ):
            stage_providers[stage] = model
        else:
            provider = build_model_provider(
                api_key=connection["api_key"], model=connection["model_name"],
                base_url=connection["model_base_url"] or None,
                timeout_seconds=settings.model_timeout_seconds, protocol=connection.get("model_protocol", "auto"),
                detected_protocol=connection.get("detected_protocol"),
                on_protocol_detected=detected_protocol_recorder(connection),
                price_per_million_input=connection.get("price_per_million_input"),
                price_per_million_output=connection.get("price_per_million_output"),
            )
            provider = _with_fallbacks(provider, connection, settings.model_timeout_seconds)
            stage_providers[stage] = configure_model_provider(provider, connection.get("parameters", {}), connection.get("reasoning_effort"))
    model_router = ModelRouter(stage_connections, stage_providers, strict_capabilities=model_connection.get("strict_capabilities", False)) if stage_connections else None

    tools = _build_tool_registry(settings)

    runtime = AgentRuntime(
        models=models,
        tools=tools,
        model_provider=model_alias,
        model_selection=internal_model_selection(model_connection),
        model_router=model_router,
        platform_name="manual",
        max_tool_rounds=settings.model_max_tool_rounds,
        tool_timeout_seconds=settings.tool_execution_timeout_seconds,
        max_model_retries=settings.model_retry_attempts,
        max_tool_retries=settings.tool_retry_attempts,
        run_store=AgentRunStore(),
    )
    capabilities = _capabilities_payload(
        settings=settings,
        model_connection=model_connection,
        tools=tools,
        model_providers=models.names(),
        active_model_provider=model_alias,
        configured=True,
    )
    return runtime, capabilities


def _with_fallbacks(model: Any, model_connection: dict[str, Any], timeout_seconds: float) -> Any:
    """Route through litellm.Router when the user configured fallback models."""
    from ..models.factory import model_backend
    from .model_routing import get_fallback_policy, policy_has_fallbacks

    if model_backend() != "litellm" or not model_connection.get("profile_id"):
        return model
    policy = get_fallback_policy()
    if not policy_has_fallbacks(policy):
        return model
    from ..models.litellm_router import build_routed_provider

    return build_routed_provider(
        model, model_connection, policy, timeout_seconds=timeout_seconds,
        load_profile=lambda profile_id: get_profile_connection(profile_id),
    )


def _cached_components(model_connection: dict[str, Any]) -> tuple[AgentRuntime, dict[str, Any]]:
    key = _runtime_cache_key(model_connection)
    cached = _components.get(key)
    if cached is None:
        cached = _build_components(model_connection)
        _components[key] = cached
    return cached


def get_agent_runtime(profile_id: str | None = None, *, selection: dict[str, Any] | None = None,
                      user_content: str | None = None) -> AgentRuntime:
    # Resolve exactly once, before caching; restoring never consults a mutable default.
    from .settings import _settings_lock

    with _settings_lock(None):
        connection = get_profile_connection(profile_id, selection=selection)
        connection = bind_model_stages(
            connection, explicit_profile=profile_id is not None, selection=selection,
            resolve=get_profile_connection, policy=get_routing_policy() if selection is None else None,
        )
        if selection is None and user_content:
            from ..chat.image_assets import image_generation_intent
            from ..model_protocol import resolve_model_protocol
            from .model_catalog import get_model_catalog
            from ..models.selection import model_output_types

            image_only = resolve_model_protocol(connection["model_name"], connection.get("model_protocol"), connection.get("model_base_url", "")) == "images"
            output_types, _ = model_output_types(connection, {"protocol": connection.get("model_protocol", "auto")})
            if image_generation_intent(user_content, image_model_selected=image_only):
                connection = bind_image_model(connection, catalog=get_model_catalog(), resolve=get_profile_connection, explicit_profile=profile_id is not None)
            elif image_only or (output_types and "chat" not in output_types) or connection.get("capabilities", {}).get("chat") == "unsupported":
                connection = bind_text_model(connection, catalog=get_model_catalog(), resolve=get_profile_connection)
    runtime, _ = _cached_components(connection)
    return runtime


def get_agent_capabilities() -> dict[str, Any]:
    from .settings import _settings_lock
    from ..secret_store import secret_backend_name
    from .model_catalog import get_model_catalog
    if not get_model_catalog()["default_profile_id"]:
        return _build_unconfigured_capabilities({"model_name": "", "model_base_url": "", "model_protocol": "auto", "api_key": ""})

    if secret_backend_name() == "keyring":
        # Capability display is not permission to unlock every stage's key.
        from .model_catalog import get_profile_connection as resolve_profile

        def preview(profile_id=None, **kwargs):
            return resolve_profile(profile_id, resolve_credentials=False, **kwargs)

        with _settings_lock(None):
            connection = bind_model_stages(
                preview(), explicit_profile=False, selection=None,
                resolve=preview, policy=get_routing_policy(),
            )
        configured = connection["api_key_configured"] or not protocol_requires_api_key(connection["resolved_model_protocol"])
        alias = str(connection["profile_id"]) if configured else ""
        payload = _capabilities_payload(
            settings=get_settings(), model_connection=connection,
            tools=_build_tool_registry(get_settings()), model_providers=[alias] if alias else [],
            active_model_provider=alias, configured=configured,
            setup_message=None if configured else SETUP_MESSAGE,
        )
        payload["credential_status"] = connection["credential_status"]
        return payload

    with _settings_lock(None):
        model_connection = get_profile_connection()
        model_connection = bind_model_stages(
            model_connection, explicit_profile=False, selection=None,
            resolve=get_profile_connection, policy=get_routing_policy(),
        )
    if not _model_is_configured(model_connection):
        return _build_unconfigured_capabilities(model_connection)
    _, capabilities = _cached_components(model_connection)
    return capabilities


def reload_agent_components() -> None:
    user_id = current_user_id()
    if user_id is None:
        _components.clear()
        return
    for key in [item for item in _components if item[0] == user_id]:
        del _components[key]


get_agent_runtime.cache_clear = reload_agent_components
get_agent_capabilities.cache_clear = reload_agent_components
