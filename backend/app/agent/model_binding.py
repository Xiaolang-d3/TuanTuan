"""Credential-free identities for immutable run bindings."""
from __future__ import annotations

from copy import deepcopy
from typing import Any


_IDENTITY_FIELDS = (
    "profile_id", "connection_id", "profile_revision", "connection_revision",
)
_SELECTION_FIELDS = frozenset({
    *_IDENTITY_FIELDS, "model_name", "model_base_url", "model_protocol",
    "resolved_model_protocol", "secret_ref", "stage", "policy_version",
    "selection_reason", "capability_status", "credential_fingerprint", "strict_capabilities", "vision_status",
})


def internal_model_selection(connection: dict[str, Any] | None) -> dict[str, Any]:
    """Persist IDs and versions; never capture a key or user-supplied parameters."""
    if not connection:
        return {"selection_reason": "legacy_unbound"}
    result = {key: deepcopy(value) for key, value in connection.items() if key in _SELECTION_FIELDS}
    stages = connection.get("stage_selections")
    if isinstance(stages, dict):
        result["stage_selections"] = {
            stage: internal_model_selection(value)
            for stage, value in stages.items() if isinstance(value, dict)
        }
    if not result:
        return {"selection_reason": "legacy_unbound"}
    return result


def selection_identity(selection: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(selection.get(field) for field in _IDENTITY_FIELDS)


def is_bound_selection(selection: dict[str, Any] | None) -> bool:
    return bool(selection and selection.get("profile_id") and selection.get("profile_revision")
                and selection.get("connection_id") and selection.get("connection_revision"))


def is_legacy_selection(selection: dict[str, Any] | None) -> bool:
    return not selection or selection == {"selection_reason": "legacy_unbound"}
