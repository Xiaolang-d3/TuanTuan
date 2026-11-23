"""Pure model-service eligibility and deterministic purpose selection.

No workspace, credentials, providers or Agent Runtime are loaded by this core.
"""
from __future__ import annotations

import re

from ..model_protocol import is_image_generation_model, model_protocol_for_profile, protocol_requires_api_key, resolve_model_protocol, supports_image_edit


def model_output_types(profile, connection):
    name = profile["model_name"].strip().lower().rsplit("/", 1)[-1]
    caps = profile.get("capabilities") or {}
    explicit = [kind for kind, key in (("chat", "chat"), ("image", "image_generation"), ("video", "video_generation")) if caps.get(key) == "supported"]
    if re.search(r"(?:^|[-_.])(?:sora|veo|kling|seedance|cogvideo|ltx-video|hunyuan-video|grok-imagine-video)(?:$|[-_.\d])|^wan[-_.]?\d", name):
        inferred = ["video"]
    elif re.search(r"^(?:gpt-image-|chatgpt-image-|dall-e-|imagen[-_.]|flux[-_.]|stable-diffusion|sdxl|sd3[-_.]|qwen-image|z-image|nano-banana|seedream|ideogram|recraft|grok-imagine-image)|^gemini.*[-_.]image(?:$|[-_.])", name) or connection.get("protocol", connection.get("model_protocol")) == "images":
        inferred = ["image"]
    elif re.match(r"^grok-4[.-]7(?:[-.]|$)", name):
        inferred = ["chat", "image"]
    elif re.match(r"^(?:gpt-|chatgpt-|o[134](?:[-_.]|$)|claude|gemini|qwen|deepseek|grok|llama|mistral|mixtral|gemma|glm|kimi|minimax|doubao|yi-|command-r|phi[-.]|ernie)", name):
        inferred = ["chat"]
    else:
        inferred = []
    keys = {"chat": "chat", "image": "image_generation", "video": "video_generation"}
    types = [kind for kind in dict.fromkeys([*inferred, *explicit]) if caps.get(keys[kind]) != "unsupported"]
    source = "configured" if any(caps.get(key) in {"supported", "unsupported"} for key in keys.values()) else "inferred" if inferred else "unknown"
    return types, source


def supported_purposes(profile, connection):
    types, _ = model_output_types(profile, connection)
    base = connection.get("effective_base_url", connection.get("model_base_url", ""))
    protocol = model_protocol_for_profile(profile["model_name"], connection.get("protocol", connection.get("model_protocol", "auto")), profile.get("capabilities"), base)
    result = []
    if "chat" in types and resolve_model_protocol(profile["model_name"], protocol, base) != "images":
        result.append("chat")
        if (vision_status(profile) == "supported" and profile.get("context_limit") is None
                and (profile.get("capabilities") or {}).get("streaming") != "unsupported"):
            result.append("vision")
    if "image" in types and is_image_generation_model(profile["model_name"], protocol, base):
        result.append("image")
    return result


def vision_status(profile):
    return profile.get("vision_status") or (profile.get("capabilities") or {}).get("vision", "unknown")


def purpose_exclusion(profile, connection, purpose, *, strict_capabilities=False, action=None):
    """Explain the first unmet requirement without resolving a credential."""
    if purpose == "video":
        return "视频生成接口暂未接入"
    if purpose not in {"chat", "image", "vision"}:
        return "暂不支持此模型用途"
    if not profile.get("enabled", True):
        return "模型已停用"
    if not connection or not connection.get("enabled", True):
        return "连接不存在或已停用"
    types, _ = model_output_types(profile, connection)
    capability = {"chat": "chat", "image": "image_generation", "vision": "vision"}[purpose]
    status = vision_status(profile) if purpose == "vision" else (profile.get("capabilities") or {}).get(capability, "unknown")
    if status == "unsupported":
        return "模型已明确不支持此用途"
    if ("chat" if purpose == "vision" else purpose) not in types:
        return "模型输出能力未知，请先确认此用途" if not types else "模型输出类型不支持此用途"
    if purpose == "vision" and status != "supported":
        return "请先确认模型支持图片输入"
    if purpose == "vision" and profile.get("context_limit") is not None:
        return "图像理解需要使用未设置文本上下文限制的模型档案"
    if purpose == "vision" and (profile.get("capabilities") or {}).get("streaming") == "unsupported":
        return "图像理解需要使用支持流式输出的模型"
    if purpose not in supported_purposes(profile, connection):
        return "当前连接接口尚未接入此模型的执行动作"
    base = connection.get("effective_base_url", connection.get("model_base_url", ""))
    protocol = model_protocol_for_profile(profile["model_name"], connection.get("protocol", connection.get("model_protocol", "auto")), profile.get("capabilities"), base)
    resolved = resolve_model_protocol(profile["model_name"], protocol, base)
    if action == "image_edit" and not supports_image_edit(profile["model_name"], resolved, base):
        return "当前模型或接口不支持图片编辑"
    if strict_capabilities and status != "supported":
        return "严格能力模式需要先确认模型用途能力"
    if protocol_requires_api_key(resolved) and not connection.get("api_key_configured"):
        return "此连接尚未配置可用凭证"
    return None


def select_model_for_purpose(catalog, purpose, profile_id=None, *, strict_capabilities=False, action=None, preferred_profile_id=None):
    """Deterministic metadata-only choice; explicit IDs are strict purpose pins.

    Conversation selections use preferred_profile_id instead: an incompatible
    preference may switch to the purpose default without altering that choice.
    """
    sources = {item["id"]: item for item in catalog.get("connections", [])}
    candidates, excluded = [], []
    profiles = sorted(catalog.get("profiles", []), key=lambda item: (item.get("created_at", ""), item["connection_id"], item["model_name"], item["id"]))
    for profile in profiles:
        rejection = purpose_exclusion(profile, sources.get(profile["connection_id"]), purpose, strict_capabilities=strict_capabilities, action=action)
        if rejection:
            excluded.append({"profile_id": profile["id"], "reason": rejection})
        else:
            candidates.append(profile)
    result = {"purpose": purpose, "eligible": False, "profile_id": profile_id, "connection_id": None, "model_name": None, "reason": "", "excluded": excluded}
    if profile_id is not None:
        chosen = next((item for item in profiles if item["id"] == profile_id), None)
        rejection = next((item["reason"] for item in excluded if item["profile_id"] == profile_id), None)
        if chosen is None or rejection:
            result.update(reason=rejection or "模型档案不存在", error=rejection or "模型档案不存在")
            if chosen:
                result.update(connection_id=chosen["connection_id"], model_name=chosen["model_name"])
            return result
        reason = "explicit_profile"
    else:
        preferences = [(preferred_profile_id, "preferred_profile"), (catalog.get("purpose_defaults", {}).get(purpose), "purpose_default")]
        if purpose == "chat":
            preferences.extend((value, "default_profile") for value in (catalog.get("effective_execution_profile_id"), catalog.get("default_profile_id")))
        chosen, reason = None, "automatic"
        for preferred, preferred_reason in preferences:
            chosen = next((item for item in candidates if item["id"] == preferred), None)
            if chosen:
                reason = preferred_reason
                break
        if chosen is None and candidates:
            if purpose == "image":
                candidates.sort(key=lambda item: (
                    model_protocol_for_profile(item["model_name"], sources[item["connection_id"]].get("protocol", "auto"), item.get("capabilities")) != "images",
                    (item.get("capabilities") or {}).get("image_generation") != "supported",
                ))
            chosen = candidates[0]
        if chosen is None:
            error = {
                "video": "视频生成接口暂未接入",
                "image": "没有可用的生图模型，请在设置中确认模型能力、接口和凭证",
                "vision": "没有可用的图像理解模型，请在设置中确认图片输入能力和服务连接",
            }.get(purpose, "没有可用的聊天模型，请在设置中确认模型能力、接口和凭证")
            result.update(reason=error, error=error)
            return result
    result.update(eligible=True, profile_id=chosen["id"], connection_id=chosen["connection_id"], model_name=chosen["model_name"], reason=reason)
    return result
