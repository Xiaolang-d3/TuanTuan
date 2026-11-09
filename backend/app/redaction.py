"""Remove credentials from text that may reach users, logs or the database.

Upstream gateways sometimes echo the Authorization header or API key back in
error bodies; those bodies end up in ModelProviderError messages and in
``model_service_events.error_message``.
"""
from __future__ import annotations

import logging
import re
import threading
import traceback
from collections import OrderedDict
from collections.abc import Iterable

MASK = "***"
_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r'''(?i)\b(qrcode|verify_code|context_token|bot_token)(["']?\s*[:=]\s*["']?)[^\s"'&,;}\]]+'''), r"\1\2" + MASK),
    (re.compile(r"(?i)\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=\-]{4,}"), r"\1 " + MASK),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{6,}"), "sk-" + MASK),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}"), "AIza" + MASK),
    (
        re.compile(r"""(?i)\b((?:x-)?(?:goog-)?api[_-]?key|access[_-]?token|authorization|secret)(["']?\s*[:=]\s*["']?)(?!Bearer\b|Basic\b)[^\s"'&,;}\]]{4,}"""),
        r"\1\2" + MASK,
    ),
    (re.compile(r"(?i)([?&]key=)[^&\s\"']+"), r"\1" + MASK),
)
_MIN_SECRET_LENGTH = 4


_KNOWN_SECRETS: OrderedDict[str, None] = OrderedDict()
_KNOWN_LIMIT = 256
_KNOWN_LOCK = threading.Lock()


def remember_secret(secret: str | None) -> None:
    """Register an API key so log redaction masks it verbatim (most recent 256 kept)."""
    if not secret or len(secret) < _MIN_SECRET_LENGTH:
        return
    with _KNOWN_LOCK:
        _KNOWN_SECRETS[secret] = None
        _KNOWN_SECRETS.move_to_end(secret)
        while len(_KNOWN_SECRETS) > _KNOWN_LIMIT:
            _KNOWN_SECRETS.popitem(last=False)


def known_secrets() -> tuple[str, ...]:
    with _KNOWN_LOCK:
        return tuple(_KNOWN_SECRETS)


def redact_secrets(text: str, secrets: Iterable[str | None] = ()) -> str:
    """Mask the given secrets verbatim, then common credential shapes."""
    if not text:
        return text
    for secret in sorted({item for item in secrets if item and len(item) >= _MIN_SECRET_LENGTH}, key=len, reverse=True):
        text = text.replace(secret, MASK)
    for pattern, replacement in _PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class SecretRedactingFilter(logging.Filter):
    """Redact a log record's message, traceback and stack before any handler sees it.

    Exceptions keep the upstream reply in their ``__cause__`` chain (LiteLLM and
    the OpenAI SDK log it at DEBUG, our providers log tracebacks), and that text
    can echo the API key. The traceback is rendered here, redacted into
    ``exc_text`` and ``exc_info`` is dropped, so formatters cannot re-render the
    raw chain.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        redact_record(record)
        return True


_PLAIN = (int, float, bool, type(None))


def _redact_value(value, secrets):
    if isinstance(value, _PLAIN):
        return value
    if isinstance(value, str):
        return redact_secrets(value, secrets)
    try:
        text = str(value)
    except Exception:
        return value
    redacted = redact_secrets(text, secrets)
    return value if redacted == text else redacted


def redact_record(record: logging.LogRecord) -> logging.LogRecord:
    if getattr(record, "_secrets_redacted", False):
        return record
    secrets = known_secrets()
    # Redact the template and each argument in place: some formatters (uvicorn's
    # access log) unpack record.args, so its shape must stay the same.
    if isinstance(record.msg, str):
        record.msg = redact_secrets(record.msg, secrets)
    elif record.msg is not None:
        record.msg = _redact_value(record.msg, secrets)
    if isinstance(record.args, tuple):
        record.args = tuple(_redact_value(value, secrets) for value in record.args)
    elif isinstance(record.args, dict):
        record.args = {key: _redact_value(value, secrets) for key, value in record.args.items()}
    if record.exc_info and record.exc_info[1] is not None:
        rendered = "".join(traceback.format_exception(*record.exc_info)).rstrip("\n")
        record.exc_text = redact_secrets(rendered, secrets)
        record.exc_info = None
    elif record.exc_text:
        record.exc_text = redact_secrets(record.exc_text, secrets)
    if record.stack_info:
        record.stack_info = redact_secrets(record.stack_info, secrets)
    record._secrets_redacted = True
    return record


_INSTALLED = False


def install_log_redaction() -> None:
    """Redact every log record in the process, whatever logger or handler it uses.

    A filter on the root logger would miss records from child loggers with their
    own handlers (uvicorn, LiteLLM), so the record factory applies the filter at
    creation, which happens only for records whose level is enabled. Handlers
    that already exist also get the filter as a second line of defence.
    """
    global _INSTALLED
    if _INSTALLED:
        return
    _INSTALLED = True
    previous = logging.getLogRecordFactory()

    def factory(*args, **kwargs):
        return redact_record(previous(*args, **kwargs))

    logging.setLogRecordFactory(factory)
    redacting = SecretRedactingFilter()
    for logger in [logging.getLogger(), *logging.Logger.manager.loggerDict.values()]:
        for handler in getattr(logger, "handlers", []):
            handler.addFilter(redacting)
    if logging.lastResort is not None:
        logging.lastResort.addFilter(redacting)
