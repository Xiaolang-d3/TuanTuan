"""The single entry point to the LiteLLM SDK.

Every other module obtains LiteLLM through :func:`get_litellm`; nothing else
in the application may ``import litellm``.  This keeps two guarantees in one
place:

* **Offline by default.**  LiteLLM fetches a model price map, Anthropic beta
  header config and a few other JSON files from GitHub at import time unless
  told otherwise.  The ``LITELLM_LOCAL_*`` switches below are forced *before*
  the first import so the bundled copies are used and importing never touches
  the network.  ``LITELLM_MODE=PRODUCTION`` stops LiteLLM from loading a
  ``.env`` file from the working directory on its own.
* **Lazy import.**  Importing LiteLLM costs ~1–2 s, so it happens on the first
  model call instead of at application start-up.
"""
from __future__ import annotations

import logging
import os
import threading
from contextlib import contextmanager
from time import perf_counter
from typing import Any

# Forced (not setdefault): a user shell exporting LITELLM_LOCAL_MODEL_COST_MAP=False
# must not turn on remote fetches in the desktop app.
OFFLINE_ENVIRONMENT: dict[str, str] = {
    "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    "LITELLM_LOCAL_ANTHROPIC_BETA_HEADERS": "True",
    "LITELLM_LOCAL_AUTOROUTER_PRESETS": "True",
    "LITELLM_LOCAL_BLOG_POSTS": "True",
    "LITELLM_LOCAL_POLICY_TEMPLATES": "True",
    "LITELLM_MODE": "PRODUCTION",
    "LITELLM_TELEMETRY": "False",
    # Chat Completions / Responses run in Python either way; keep the optional
    # Rust extension off so the desktop sidecar can leave it out (~40 MB).
    "LITELLM_RUST": "False",
}

_lock = threading.Lock()
_module: Any = None
_import_seconds: float | None = None


def apply_offline_environment() -> None:
    for name, value in OFFLINE_ENVIRONMENT.items():
        os.environ[name] = value


def _configure(module: Any) -> None:
    # Unsupported optional parameters are dropped instead of failing with 400.
    module.drop_params = True
    module.suppress_debug_info = True
    module.set_verbose = False
    # No global logging/observability callbacks: prompts never leave the app
    # through LiteLLM integrations.
    module.callbacks = []
    module.success_callback = []
    module.failure_callback = []
    module._async_success_callback = []
    module._async_failure_callback = []
    module.turn_off_message_logging = True
    if hasattr(module, "telemetry"):
        module.telemetry = False
    # Keep transport semantics identical to the native adapters (httpx with the
    # system proxy settings) and avoid shipping a second HTTP stack path.
    if hasattr(module, "disable_aiohttp_transport"):
        module.disable_aiohttp_transport = True
    # 团团 retries in the agent runtime; the router has its own policy.
    module.num_retries = 0


def _is_litellm_filter(candidate: Any) -> bool:
    module = getattr(type(candidate), "__module__", "") or ""
    if callable(candidate) and not isinstance(candidate, logging.Filter):
        module = getattr(candidate, "__module__", "") or module
    return module == "litellm" or module.startswith("litellm.")


@contextmanager
def _defer_litellm_log_filters():
    """Hold back the log filters LiteLLM attaches while its package is importing.

    ``litellm/_logging.py`` runs early in ``import litellm`` and adds filters to
    other libraries' loggers (``uvicorn.access``, ``uvicorn.error``, ``asyncio``,
    ``httpx`` …). Each filter lazily imports ``litellm.rust_bridge.*``. When the
    first import happens in a worker thread (a sync FastAPI endpoint), the event
    loop thread logs an access line, the filter starts importing LiteLLM
    submodules concurrently, and the two threads deadlock on the module locks:
    Python raises ``_DeadlockError`` in the importer, drops ``litellm`` from
    ``sys.modules``, but the filters stay attached, so every later log call
    raises ``KeyError: 'litellm'`` and the server stops answering, /health too.

    Filters defined in ``litellm.*`` are therefore collected instead of attached
    and only attached once the package is fully imported; on failure they are
    discarded.
    """
    pending: list[tuple[logging.Filterer, Any]] = []
    original = logging.Filterer.addFilter

    def add_filter(self: logging.Filterer, filter: Any) -> None:  # noqa: A002 - logging's name
        if _is_litellm_filter(filter):
            pending.append((self, filter))
        else:
            original(self, filter)

    logging.Filterer.addFilter = add_filter  # type: ignore[method-assign]
    try:
        yield pending
    finally:
        logging.Filterer.addFilter = original  # type: ignore[method-assign]


def get_litellm() -> Any:
    """Import and configure LiteLLM once, offline."""
    global _module, _import_seconds
    if _module is not None:
        _configure_network_policy(_module)
        return _module
    with _lock:
        if _module is None:
            apply_offline_environment()
            started = perf_counter()
            with _defer_litellm_log_filters() as pending:
                import litellm  # noqa: PLC0415 - the only sanctioned import site
            # Fully imported now: LiteLLM's filters may run (and lazily import
            # its submodules) from any thread without racing the import.
            for owner, deferred in pending:
                owner.addFilter(deferred)
            import warnings

            # LiteLLM's Responses usage object trips a harmless pydantic
            # serializer warning on every call.
            warnings.filterwarnings("ignore", message="Pydantic serializer warnings", category=UserWarning)

            _configure(litellm)
            _import_seconds = perf_counter() - started
            _module = litellm
    _configure_network_policy(_module)
    return _module


def _configure_network_policy(module: Any) -> None:
    """Use the SDK's deployment hook even for its nested Responses bridge.

    LiteLLM 1.104's async chat→Responses bridge drops the caller's client.
    A deployment hook runs again at the actual aresponses boundary, so the
    safety policy does not depend on that forwarding or on SDK cache keys.
    """
    from ..model_network import hosted_models, PublicModelTransport

    if not hosted_models():
        return
    with _lock:
        policy = getattr(module, "_tuantuan_network_policy", None)
        if policy is None:
            from litellm.integrations.custom_logger import CustomLogger
            from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler

            class HostedResponsesPolicy(CustomLogger):
                def __init__(self):
                    super().__init__(turn_off_message_logging=True)
                    self.handler = AsyncHTTPHandler(transport=PublicModelTransport(), follow_redirects=False)

                async def async_pre_call_deployment_hook(self, kwargs, call_type):
                    if hosted_models() and getattr(call_type, "value", call_type) == "aresponses":
                        kwargs["client"] = self.handler
                    return kwargs

            policy = module._tuantuan_network_policy = HostedResponsesPolicy()
        if policy not in module.callbacks:
            # This is an in-process request policy, with no logging or external
            # integrations. Prompt/response logging remains disabled.
            module.callbacks.append(policy)


def hosted_http_handler(timeout_seconds: float):
    """Keep all direct LiteLLM imports inside this SDK boundary."""
    get_litellm()
    from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler
    from ..model_network import PublicModelTransport

    return AsyncHTTPHandler(timeout=timeout_seconds, transport=PublicModelTransport(), follow_redirects=False)


def litellm_loaded() -> bool:
    return _module is not None


def litellm_import_seconds() -> float | None:
    return _import_seconds


def litellm_version() -> str:
    try:
        from importlib.metadata import version

        return version("litellm")
    except Exception:
        return ""


def litellm_available() -> bool:
    try:
        from importlib.util import find_spec

        return find_spec("litellm") is not None
    except Exception:
        return False


# --------------------------------------------------------------------------
# Protocol → LiteLLM routing
# --------------------------------------------------------------------------

_PREFIXES = {
    "openai": "openai",
    "responses": "openai",
    "anthropic": "anthropic",
    "gemini": "gemini",
    "ollama": "ollama_chat",
}


def model_string(protocol: str, model: str, *, responses_bridge: bool = False) -> str:
    """LiteLLM model id for a 团团 protocol.

    ``responses_bridge`` routes a chat-format call to the Responses API
    (LiteLLM's ``openai/responses/<model>``); the router uses it so one
    message format works across a heterogeneous fallback chain.
    """
    prefix = _PREFIXES.get(protocol, "openai")
    if protocol == "responses" and responses_bridge:
        return f"openai/responses/{model}"
    return f"{prefix}/{model}"


def api_base_for(protocol: str, base_url: str | None) -> str | None:
    """Translate 团团's "complete API root" convention into LiteLLM's api_base."""
    value = (base_url or "").strip().rstrip("/")
    if not value:
        return None
    if protocol == "anthropic" and value.endswith("/v1"):
        # 团团 accepts ".../v1" for Anthropic; LiteLLM appends /v1/messages itself.
        return value[: -len("/v1")]
    if protocol == "ollama" and value.endswith("/api"):
        return value[: -len("/api")]
    return value


# --------------------------------------------------------------------------
# Model information (bundled, offline cost map)
# --------------------------------------------------------------------------

_CAPABILITY_KEYS = {
    "vision": "supports_vision",
    "tools": "supports_function_calling",
    "reasoning": "supports_reasoning",
    "structured_output": "supports_response_schema",
    "pdf": "supports_pdf_input",
    "prompt_caching": "supports_prompt_caching",
}


def lookup_model_info(protocol: str, model: str) -> dict[str, Any] | None:
    """Return LiteLLM's bundled data for a model, or None when it is unknown.

    Gateways often expose vendor models under their bare id, so the provider
    prefixed name is tried first and the bare id second.
    """
    litellm = get_litellm()
    name = (model or "").strip()
    if not name:
        return None
    candidates = [model_string(protocol, name), name]
    if "/" in name:
        candidates.append(name.rsplit("/", 1)[-1])
    for candidate in candidates:
        try:
            info = litellm.get_model_info(candidate)
        except Exception:
            continue
        if isinstance(info, dict) and info:
            return dict(info)
    return None


def capability_defaults(protocol: str, model: str) -> dict[str, Any]:
    info = lookup_model_info(protocol, model)
    if info is None:
        return {"known": False, "capabilities": {}, "max_input_tokens": None, "max_output_tokens": None, "input_cost_per_token": None, "output_cost_per_token": None, "litellm_provider": None, "mode": None}
    capabilities = {name: bool(info.get(key)) if info.get(key) is not None else None for name, key in _CAPABILITY_KEYS.items()}
    return {
        "known": True,
        "capabilities": capabilities,
        "max_input_tokens": info.get("max_input_tokens") or info.get("max_tokens"),
        "max_output_tokens": info.get("max_output_tokens"),
        "input_cost_per_token": info.get("input_cost_per_token"),
        "output_cost_per_token": info.get("output_cost_per_token"),
        "litellm_provider": info.get("litellm_provider"),
        "mode": info.get("mode"),
    }


def estimate_cost_usd(
    response: Any,
    *,
    protocol: str,
    model: str,
    input_tokens: int,
    output_tokens: int,
    price_per_million_input: float | None = None,
    price_per_million_output: float | None = None,
) -> float | None:
    """USD estimate for one call; profile prices win over LiteLLM's price map.

    Uses token counts already reported by the provider and never calls a
    tokenizer, which could otherwise try to download one.
    """
    if protocol == "ollama":
        return 0.0  # local inference
    if price_per_million_input is not None or price_per_million_output is not None:
        return round(
            input_tokens * float(price_per_million_input or 0) / 1_000_000
            + output_tokens * float(price_per_million_output or 0) / 1_000_000,
            10,
        )
    hidden = getattr(response, "_hidden_params", None)
    if isinstance(hidden, dict):
        value = hidden.get("response_cost")
        if isinstance(value, (int, float)) and value > 0:
            return float(value)
    if not input_tokens and not output_tokens:
        return None
    litellm = get_litellm()
    for candidate in (model_string(protocol, model), model):
        try:
            prompt_cost, completion_cost = litellm.cost_per_token(
                model=candidate, prompt_tokens=input_tokens, completion_tokens=output_tokens,
            )
        except Exception:
            continue
        total = float(prompt_cost or 0) + float(completion_cost or 0)
        if total > 0:
            return total
    return None


def retry_policy_class() -> Any:
    """``litellm.router.RetryPolicy`` (imported here so this stays the only importer)."""
    get_litellm()
    from litellm.router import RetryPolicy

    return RetryPolicy
