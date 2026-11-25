from __future__ import annotations

import hashlib
import json
from typing import Literal

from ..db import connect
from ..model_protocol import model_protocol_for_profile
from ..models.image_adapters import image_adapter
from ..models.selection import model_output_types, select_model_for_purpose
from . import settings
from .model_purposes import selection_catalog

ImageOperation = Literal["image.generate", "image.edit"]


class ImageSelectionConflict(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

    def detail(self) -> dict:
        return {"code": self.code, "message": str(self)}


class ImageSourceMissing(ValueError):
    pass


def _source_binding(asset_id: str) -> dict:
    with connect() as conn:
        row = conn.execute("""SELECT o.selection_json FROM chat_image_assets a
            JOIN chat_image_operations o ON o.id=a.operation_id WHERE a.id=?""", (asset_id,)).fetchone()
        if row is None:
            raise ImageSourceMissing("图片不存在")
        binding = json.loads(row[0])
        historical = conn.execute("""SELECT payload_json FROM model_connection_versions
            WHERE connection_id=? AND revision=?""", (binding.get("connection_id"), binding.get("connection_revision"))).fetchone()
    connection = json.loads(historical[0]) if historical else {}
    return {"profile_id": binding.get("profile_id"), "connection_id": binding.get("connection_id"),
            "revision": binding.get("connection_revision"), "data_boundary": connection.get("data_boundary"),
            "effective_base_url": connection.get("effective_base_url")}


def _preview(operation: ImageOperation, profile_id: str | None, asset_id: str | None) -> dict:
    editing = operation == "image.edit"
    if editing != bool(asset_id):
        raise ValueError("编辑选模必须指定原图，出图选模不接受原图")
    source = _source_binding(asset_id) if asset_id else None
    catalog = selection_catalog()
    action = "image_edit" if editing else None
    picked = select_model_for_purpose(catalog, "image", profile_id, action=action,
                                      preferred_profile_id=source.get("profile_id") if source else None,
                                      strict_capabilities=catalog["strict_capabilities"])
    sources = {item["id"]: item for item in catalog["connections"]}
    profiles = {item["id"]: item for item in catalog["profiles"]}
    exclusions = {item["profile_id"]: item for item in picked["excluded"]}
    candidates = []
    for profile in profiles.values():
        connection = sources[profile["connection_id"]]
        exclusion = exclusions.get(profile["id"])
        if exclusion and profile["id"] != profile_id:
            outputs, _ = model_output_types(profile, connection)
            explicitly_configured = (profile.get("capabilities") or {}).get("image_generation") in {"supported", "unsupported"}
            if "image" not in outputs and not explicitly_configured:
                continue
        candidates.append({"profile_id": profile["id"], "model_name": profile["model_name"],
                           "service_name": connection["name"], "eligible": exclusion is None,
                           "reason_code": exclusion["reason_code"] if exclusion else None,
                           "reason": exclusion["reason"] if exclusion else None})
    if not picked["eligible"]:
        if profile_id is not None:
            exclusion = exclusions.get(profile_id)
            reason_code = exclusion["reason_code"] if exclusion else "profile_missing"
        else:
            codes = {item["reason_code"] for item in candidates}
            reason_code = next(iter(codes)) if len(codes) == 1 else "blocked" if codes else "not_configured"
        return {"eligible": False, "selection": None, "comparison_key": None, "requires_confirmation": False,
                "candidates": candidates, "reason": picked["error"], "reason_code": reason_code}
    profile = profiles[picked["profile_id"]]
    connection = sources[profile["connection_id"]]
    base = connection["effective_base_url"]
    protocol = model_protocol_for_profile(profile["model_name"], connection["protocol"], profile.get("capabilities"), base)
    adapter = image_adapter(profile["model_name"], protocol, base)
    boundary = connection.get("data_boundary")
    crossing = bool(source and not (
        (source["connection_id"] == connection["id"] and source["revision"] == connection["revision"])
        or (boundary and source["data_boundary"] == boundary and source["effective_base_url"] == base)
    ))
    reason = {"preferred_profile": "沿用原图模型", "explicit_profile": "本次指定",
              "purpose_default": "图片默认", "automatic": "系统选择"}[picked["reason"]]
    selected = {"profile_id": profile["id"], "model_name": profile["model_name"], "service_name": connection["name"],
                "reason": reason, "sizes": adapter.edit_sizes if editing else adapter.generate_sizes}
    identity = [operation, asset_id, profile_id, profile["id"], profile["revision"], connection["id"],
                connection["revision"], boundary, base, protocol, source, crossing]
    key = hashlib.sha256(json.dumps(identity, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return {"eligible": True, "selection": selected, "comparison_key": key, "requires_confirmation": crossing,
            "candidates": candidates}


def preview_image_selection(operation: ImageOperation, profile_id: str | None, asset_id: str | None) -> dict:
    with settings._settings_lock(None):
        return _preview(operation, profile_id, asset_id)


def bind_image_selection(operation: ImageOperation, profile_id: str | None, *, comparison_key: str | None,
                         resolver, asset_id: str | None = None, confirmed: bool = False) -> dict:
    with settings._settings_lock(None):
        preview = _preview(operation, profile_id, asset_id)
        if comparison_key is not None and comparison_key != preview["comparison_key"]:
            raise ImageSelectionConflict("model_selection_changed", "模型配置已变化，请确认后重新提交")
        if not preview["eligible"]:
            raise ValueError(preview["reason"])
        if preview["requires_confirmation"] and not (comparison_key and confirmed):
            raise ImageSelectionConflict("image_data_boundary_confirmation_required", "发送原图前，请确认目标模型服务")
        selected = preview["selection"]
        connection = resolver("image", profile_id=selected["profile_id"],
                              action="image_edit" if operation == "image.edit" else None)
        current = _preview(operation, profile_id, asset_id)
        if current["comparison_key"] != preview["comparison_key"]:
            raise ImageSelectionConflict("model_selection_changed", "模型配置已变化，请确认后重新提交")
        return {**connection, "selection_reason": selected["reason"], "service_name": selected["service_name"]}
