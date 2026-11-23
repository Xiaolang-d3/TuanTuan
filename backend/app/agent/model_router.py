"""Deterministic model choices, independent of TaskRoute and tool permissions."""
from __future__ import annotations

import json
from copy import deepcopy
from typing import Any, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field

from ..domain import ModelRequest
from ..model_protocol import protocol_requires_api_key
from ..models import ModelProviderError
from .model_binding import internal_model_selection, is_bound_selection, selection_identity
from . import settings


STAGES = ("classify", "plan", "execute")


class RoutingPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    roles: dict[Literal["classify", "plan", "execute"], str | None] = Field(default_factory=dict)
    strict_capabilities: bool = False


def get_routing_policy(db_path=None) -> dict[str, Any]:
    from .model_catalog import _ensure_catalog

    _ensure_catalog(db_path)
    with settings.connect(db_path) as conn:
        row = conn.execute("SELECT version, payload_json FROM model_routing_policy WHERE id=1").fetchone()
    payload = json.loads(row["payload_json"])
    payload.pop("purpose_defaults", None)
    payload.pop("service_connection_id", None)
    return {**RoutingPolicy.model_validate(payload).model_dump(), "version": row["version"]}


def save_routing_policy(values: dict[str, Any], db_path=None) -> dict[str, Any]:
    from .model_catalog import _ensure_catalog, _profile, _connection

    policy = RoutingPolicy.model_validate({key: value for key, value in values.items() if key != "expected_version"})
    if any(value is not None and not value.strip() for value in policy.roles.values()):
        raise ValueError("阶段模型档案 ID 不能为空")
    _ensure_catalog(db_path)
    with settings._settings_lock(db_path), settings.connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        version = conn.execute("SELECT version FROM model_routing_policy WHERE id=1").fetchone()[0]
        if values.get("expected_version") != version:
            raise settings.AgentSettingsConflict("模型路由已更新，请读取最新版本后保存")
        for profile_id in policy.roles.values():
            if profile_id is not None:
                profile = _profile(conn, profile_id)
                connection = _connection(conn, profile["connection_id"])
                if not profile["enabled"] or not connection["enabled"]:
                    raise ValueError("阶段模型或连接已停用，请选择其他模型")
        previous = json.loads(conn.execute("SELECT payload_json FROM model_routing_policy WHERE id=1").fetchone()[0])
        merged = {**previous, **policy.model_dump()}
        conn.execute("UPDATE model_routing_policy SET version=version+1, payload_json=? WHERE id=1", (json.dumps(merged),))
    return {**policy.model_dump(), "version": version + 1}


def bind_model_stages(
    connection: dict[str, Any], *, explicit_profile: bool, selection: dict[str, Any] | None,
    resolve: Callable, policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Bind every role before the first call; restored runs ignore current policy."""
    result = deepcopy(connection)
    stored = (selection or {}).get("stage_selections")
    if selection is not None:
        if stored is None:
            if selection.get("policy_version") is not None:
                raise ValueError("运行的阶段模型绑定缺失，无法恢复")
            # Runs created before stage routing used one provider in every stage.
            return result
        if not isinstance(stored, dict) or set(stored) != set(STAGES) or not all(isinstance(value, dict) and is_bound_selection(value) for value in stored.values()):
            raise ValueError("运行的阶段模型绑定不完整，无法恢复")
        if not isinstance(selection.get("policy_version"), int) or selection["policy_version"] < 1 or not isinstance(selection.get("strict_capabilities", False), bool):
            raise ValueError("运行的阶段策略版本不完整，无法恢复")
        stages = {stage: resolve(selection=value) for stage, value in stored.items()}
        if selection_identity(stages["execute"]) != selection_identity(connection):
            raise ValueError("运行的执行模型与阶段绑定不匹配")
        for stage, value in stages.items():
            value["selection_reason"] = stored[stage].get("selection_reason", "restored_stage")
            if stored[stage].get("vision_status") == "supported":
                value["vision_status"] = "supported"
        if stages["execute"].get("vision_status") == "supported":
            result["vision_status"] = "supported"
        result.update(policy_version=selection.get("policy_version", 1), strict_capabilities=bool(selection.get("strict_capabilities", False)))
    else:
        policy = policy or {"version": 1, "roles": {}, "strict_capabilities": False}
        roles = policy["roles"]
        default = connection if not explicit_profile else resolve()
        stages = {}
        for stage in STAGES:
            if stage == "execute" and explicit_profile:
                chosen, reason = connection, "explicit_profile"
            elif roles.get(stage):
                chosen, reason = resolve(roles[stage]), "stage_role"
            else:
                chosen, reason = default, "default_profile"
            stages[stage] = {**chosen, "selection_reason": reason}
        result = {**stages["execute"], "policy_version": policy["version"], "strict_capabilities": policy["strict_capabilities"]}
    result["stage_connections"] = stages
    for value in stages.values():
        value["policy_version"] = result["policy_version"]
    result["stage_selections"] = {stage: internal_model_selection(value) for stage, value in stages.items()}
    return result


def _replace_executor(connection: dict[str, Any], chosen: dict[str, Any], reason: str) -> dict[str, Any]:
    chosen = {**chosen, "selection_reason": reason, "policy_version": connection["policy_version"]}
    stages = deepcopy(connection["stage_connections"])
    stages["execute"] = chosen
    return {
        **connection, **chosen, "stage_connections": stages,
        "stage_selections": {stage: internal_model_selection(value) for stage, value in stages.items()},
    }


def _binding_catalog(catalog, connection):
    """Include the already resolved conversation preference in a metadata choice."""
    result = deepcopy(catalog)
    profile_id, connection_id = connection.get("profile_id"), connection.get("connection_id")
    if profile_id and connection_id:
        profile = {**connection, "id": profile_id, "enabled": True}
        source = {"id": connection_id, "enabled": True, "protocol": connection.get("model_protocol", "auto"),
                  "effective_base_url": connection.get("model_base_url", ""),
                  "api_key_configured": connection.get("api_key_configured", bool(connection.get("api_key")))}
        # Do not overwrite saved source metadata shared by other profiles.
        if not any(item["id"] == connection_id for item in result.get("connections", [])):
            result.setdefault("connections", []).append(source)
        result["profiles"] = [item for item in result.get("profiles", []) if item["id"] != profile_id] + [profile]
    return result


def _live_purpose_exclusion(connection, purpose, *, strict_capabilities=False):
    from ..models.selection import purpose_exclusion
    source = {"protocol": connection.get("model_protocol", "auto"), "effective_base_url": connection.get("model_base_url", ""),
              "api_key_configured": connection.get("api_key_configured", bool(connection.get("api_key")))}
    return purpose_exclusion(connection, source, purpose, strict_capabilities=strict_capabilities)


def bind_image_model(connection: dict[str, Any], *, catalog: dict[str, Any], resolve: Callable, explicit_profile: bool = False) -> dict[str, Any]:
    """Choose once at the model-service boundary; this never retries image calls."""
    from ..models.selection import select_model_for_purpose
    available = _binding_catalog(catalog, connection)
    preferred = connection.get("profile_id") if explicit_profile or not catalog.get("purpose_defaults", {}).get("image") else None
    selected = select_model_for_purpose(available, "image", preferred_profile_id=preferred, strict_capabilities=connection.get("strict_capabilities", False))
    if not selected["eligible"]:
        raise ValueError(selected["error"])
    if selected["profile_id"] == connection.get("profile_id"):
        if _live_purpose_exclusion(connection, "image", strict_capabilities=connection.get("strict_capabilities", False)):
            raise ValueError("生图模型配置已变化，请重新发送请求")
        return connection
    chosen = resolve(selected["profile_id"])
    if _live_purpose_exclusion(chosen, "image", strict_capabilities=connection.get("strict_capabilities", False)):
        raise ValueError("生图模型配置已变化，请重新发送请求")
    return _replace_executor(connection, chosen, "image_default" if selected["reason"] == "purpose_default" else "image_intent")


def bind_text_model(connection: dict[str, Any], *, catalog: dict[str, Any], resolve: Callable) -> dict[str, Any]:
    """A pure Images selection must not receive questions or classification."""
    from ..model_protocol import resolve_model_protocol
    from ..models.selection import model_output_types, select_model_for_purpose
    selected = select_model_for_purpose(catalog, "chat", strict_capabilities=connection.get("strict_capabilities", False))
    if not selected["eligible"]:
        raise ValueError(selected["error"])
    chosen = resolve(selected["profile_id"])
    if _live_purpose_exclusion(chosen, "chat", strict_capabilities=connection.get("strict_capabilities", False)):
        raise ValueError("聊天模型配置已变化，请重新发送请求")
    result = _replace_executor(connection, chosen, "text_intent")
    # Keep configured text stage roles; repair known non-chat defaults that
    # classify/plan inherited before purpose defaults were introduced.
    for stage, value in result["stage_connections"].items():
        types, _ = model_output_types(value, {"protocol": value.get("model_protocol", "auto")})
        if (resolve_model_protocol(value["model_name"], value.get("model_protocol"), value.get("model_base_url", "")) == "images"
                or (types and "chat" not in types) or value.get("capabilities", {}).get("chat") == "unsupported"):
            result["stage_connections"][stage] = {**result["stage_connections"]["execute"]}
    result["stage_selections"] = {stage: internal_model_selection(value) for stage, value in result["stage_connections"].items()}
    return result


def bind_vision_model(connection: dict[str, Any], *, catalog: dict[str, Any], resolve: Callable, profile_id: str | None = None) -> dict[str, Any]:
    from ..models.selection import select_model_for_purpose

    default_id = catalog.get("purpose_defaults", {}).get("vision")
    selected = select_model_for_purpose(catalog, "vision", profile_id) if profile_id else None
    if not selected or not selected["eligible"]:
        selected = select_model_for_purpose(catalog, "vision", default_id, preferred_profile_id=connection.get("profile_id"))
    if not selected["eligible"]:
        if default_id:
            raise ValueError(f"图像理解默认模型当前不可用，请在模型配置中更换或设为自动选择。{selected['error']}")
        # Preserve existing unverified-model behavior when no default is set.
        return connection
    chosen = connection if selected["profile_id"] == connection.get("profile_id") else resolve(selected["profile_id"])
    protocol = chosen.get("resolved_model_protocol", "openai")
    if protocol == "images" or (protocol_requires_api_key(protocol) and not chosen.get("api_key")):
        raise ValueError("图像理解模型配置已变化，请检查服务连接")
    reason = "vision_default" if selected["profile_id"] == default_id and profile_id != default_id else "vision_input"
    return _replace_executor(connection, {**chosen, "vision_status": "supported"}, reason)


class ModelRouter:
    def __init__(self, connections: dict[str, dict[str, Any]], providers: dict[str, Any], *, strict_capabilities: bool = False) -> None:
        self._connections = deepcopy(connections)
        self._providers = dict(providers)
        self._strict = strict_capabilities

    def select(self, stage: str, request: ModelRequest, *, streaming: bool = False) -> tuple[Any, dict[str, Any]]:
        connection = self._connections[stage]
        required = []
        if request.tools and request.tool_choice != "none":
            required.append("tools")
        if any(message.payload.get("image_urls") for message in request.messages):
            required.append("vision")
        if streaming and not request.image_generation:
            required.append("streaming")
        if request.image_generation:
            required.append("image_generation")
        capabilities = connection.get("capabilities", {})
        if connection.get("vision_status"):
            capabilities = {**capabilities, "vision": connection["vision_status"]}
        if request.image_generation and capabilities.get("image_generation") == "unsupported":
            raise ModelProviderError("image_generation_unsupported", "当前连接暂不支持生成图片。你可以继续聊天，或接入支持生图的模型后再试。")
        unknown = [capability for capability in required if capabilities.get(capability, "unknown") == "unknown"]
        unavailable = [capability for capability in required if capabilities.get(capability) == "unsupported"]
        if unavailable or (unknown and self._strict):
            labels = {"tools": "工具调用", "vision": "图片输入", "streaming": "流式输出", "image_generation": "图片生成"}
            detail = "、".join(labels[item] for item in unavailable or unknown)
            raise ModelProviderError("model_capability_unavailable", f"{stage} 阶段的模型不满足所需能力：{detail}" + ("（尚未验证）" if not unavailable else ""))
        # A conservative byte upper bound, including tool definitions, is used
        # when a configured context limit exists. No tokenizer is assumed.
        context_limit = connection.get("context_limit")
        if context_limit is not None:
            if "vision" in required:
                raise ModelProviderError("model_context_limit", f"{stage} 阶段包含图片，当前无法可靠估算图片上下文用量；请使用未设置文本上下文限制的档案")
            from ..models.openai_compatible import SYSTEM_PROMPT

            input_bound = len(request.model_dump_json(exclude={"parameters"}).encode("utf-8"))
            input_bound += len((SYSTEM_PROMPT + settings.persona_prompt(settings.get_agent_settings())).encode("utf-8"))
            profile_limit = connection.get("parameters", {}).get("max_output_tokens")
            if profile_limit is None and "max_output_tokens" not in request.parameters:
                raise ModelProviderError("model_context_limit", f"{stage} 阶段已设置上下文限制，请同时配置输出长度上限")
            output_limit = request.parameters.get("max_output_tokens", profile_limit or 0)
            if profile_limit is not None:
                output_limit = min(profile_limit, output_limit)
            if input_bound + output_limit > context_limit:
                raise ModelProviderError("model_context_limit", f"{stage} 阶段输入与输出预留超过所选模型的上下文限制")
        provider = self._providers.get(stage)
        if provider is None:
            raise ModelProviderError("model_not_configured", f"{stage} 阶段的模型尚未配置可用凭证，请检查模型设置")
        selection = internal_model_selection(connection)
        selection["stage"] = stage
        selection["capability_status"] = "unverified" if unknown else "satisfied"
        return provider, selection
