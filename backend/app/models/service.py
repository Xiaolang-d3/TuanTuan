"""Public model-service boundary over existing providers, selection and usage.

The provider factory retains native/LiteLLM protocol adapters and paid-image
safety. Usage comes from the existing ledger; this module owns no counters.
"""
from .factory import build_model_provider
from .selection import model_output_types, supported_purposes, purpose_exclusion, select_model_for_purpose


def get_model_monitor_snapshot(hours=24, db_path=None, connection=None):
    # Lazy because the existing monitor supports the legacy settings entry.
    from ..observability.model_monitor import get_model_monitor_snapshot as snapshot
    return snapshot(hours=hours, db_path=db_path, connection=connection)


__all__ = [
    "build_model_provider", "model_output_types", "supported_purposes",
    "purpose_exclusion", "select_model_for_purpose", "get_model_monitor_snapshot",
]
