"""Bounded, account-scoped speech sessions using the existing HTTP transport."""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from . import speech
from .workspace import current_user_id

MAX_SESSIONS = 4
IDLE_SECONDS = 30
MAX_SESSION_SECONDS = 10 * 60
MAX_CHUNK_BYTES = 512 * 1024
_registry_lock = threading.Lock()
_sessions: dict[str, Session] = {}


class SessionGoneError(ValueError):
    pass


@dataclass
class Session:
    owner: int
    stream: Any
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    sequence: int = 0
    lock: Any = field(default_factory=threading.Lock)
    closed: Any = field(default_factory=threading.Event)
    timer: Any = None


def _owner() -> int:
    owner = current_user_id()
    if owner is None:
        raise PermissionError("请先登录后使用语音输入。")
    return owner


def _prune() -> None:
    now = time.monotonic()
    for key, session in list(_sessions.items()):
        if now - session.touched > IDLE_SECONDS or now - session.created > MAX_SESSION_SECONDS:
            session.closed.set()
            if session.timer:
                session.timer.cancel()
            del _sessions[key]


def _expire(key: str) -> None:
    with _registry_lock:
        _prune()
        session = _sessions.get(key)
        if session:
            _schedule_expiry(key, session)


def _schedule_expiry(key: str, session: Session) -> None:
    deadline = min(session.touched + IDLE_SECONDS, session.created + MAX_SESSION_SECONDS)
    session.timer = threading.Timer(max(0.01, deadline - time.monotonic()), _expire, args=(key,))
    session.timer.daemon = True
    session.timer.start()


def open_session(hotwords: list[str] | None = None) -> str:
    owner = _owner()
    from .speech_engine import DEFAULT_HOTWORDS
    if hotwords is not None and (len(hotwords) > 64 or any(len(word) > 10 or not word.strip() or any(char.isspace() for char in word) for word in hotwords)):
        raise ValueError("热词最多 64 个，每个为不含空白的 1–10 字词语。")
    words = tuple(dict.fromkeys((*DEFAULT_HOTWORDS, *(hotwords or []))))
    engine = speech.ready_model()
    with _registry_lock:
        _prune()
        for key, old in list(_sessions.items()):
            if old.owner == owner:
                old.closed.set()
                if old.timer:
                    old.timer.cancel()
                del _sessions[key]
        if len(_sessions) >= MAX_SESSIONS:
            raise speech.SpeechBusyError("当前语音服务繁忙，请稍后重试。")
        key = secrets.token_urlsafe(24)
        now = time.monotonic()
        session = Session(owner, engine.create_stream(words), created=now, touched=now)
        _sessions[key] = session
        _schedule_expiry(key, session)
        return key


def close_session(key: str) -> None:
    owner = _owner()
    with _registry_lock:
        session = _sessions.get(key)
        if session and session.owner == owner:
            session.closed.set()
            if session.timer:
                session.timer.cancel()
            del _sessions[key]


def feed(key: str, sequence: int, content: bytes | None) -> list[dict]:
    owner = _owner()
    with _registry_lock:
        _prune()
        session = _sessions.get(key)
        if not session or session.owner != owner:
            raise SessionGoneError("语音会话已结束，请重新打开语音输入。")
    if not session.lock.acquire(blocking=False):
        raise speech.SpeechBusyError("语音片段正在处理中，请重新打开语音输入。")
    try:
        if session.closed.is_set():
            raise SessionGoneError("语音会话已结束，请重新打开语音输入。")
        if sequence != session.sequence:
            raise ValueError("语音片段顺序异常，请重新打开语音输入。")
        audio = None
        if content is not None:
            if not content or len(content) > MAX_CHUNK_BYTES:
                raise ValueError("语音片段大小异常，请重新打开语音输入。")
            audio = speech._decode_audio(content, max_seconds=2)
        if not speech._inference_lock.acquire(timeout=2):
            raise speech.SpeechBusyError("当前设备处理语音较慢，请稍后重试。")
        try:
            if session.closed.is_set():
                raise SessionGoneError("语音会话已结束，请重新打开语音输入。")
            updates = session.stream.finish() if audio is None else session.stream.push(audio)
        finally:
            speech._inference_lock.release()
        if session.closed.is_set():
            raise SessionGoneError("语音会话已结束，请重新打开语音输入。")
        if content is None:
            close_session(key)
        else:
            session.sequence += 1
            session.touched = time.monotonic()
        return updates
    finally:
        session.lock.release()
