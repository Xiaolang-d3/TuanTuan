from __future__ import annotations

import hashlib
import io
import threading
import wave
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import speech, speech_sessions
from app.api.speech import router
from app.workspace import use_workspace


def wav(seconds: int = 1) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\0\0" * 16000 * seconds)
    return output.getvalue()


@pytest.fixture(autouse=True)
def isolated_speech(monkeypatch):
    monkeypatch.setattr(speech, "_model", None)
    monkeypatch.setattr(speech, "_state", "idle")
    monkeypatch.setattr(speech, "_error", "")
    monkeypatch.setattr(speech, "_state_lock", threading.Lock())
    monkeypatch.setattr(speech, "_inference_lock", threading.Lock())
    monkeypatch.setattr(speech_sessions, "_sessions", {})
    monkeypatch.setattr(speech_sessions.threading, "Timer", Mock())


def test_preparation_is_single_flight_and_can_retry_after_failure(monkeypatch):
    threads = []
    class FakeThread:
        def __init__(self, **kwargs):
            threads.append(kwargs["target"])
        def start(self):
            pass
    monkeypatch.setattr(speech.threading, "Thread", FakeThread)
    model = object()
    monkeypatch.setattr(speech, "_load_model", Mock(side_effect=[RuntimeError("upstream details"), model]))
    assert speech.prepare()["state"] == "preparing"
    speech.prepare()
    assert len(threads) == 1
    threads[0]()
    assert speech.status()["state"] == "error"
    assert "upstream" not in speech.status()["error"]
    speech.prepare()
    threads[1]()
    assert speech.status()["state"] == "ready"
    assert speech.ready_model() is model
    speech.prepare()
    assert len(threads) == 2


def test_cached_models_load_without_network(monkeypatch, tmp_path):
    from app import speech_engine
    spec = {"revision": "fixed", "sha256": hashlib.sha256(b"cached").hexdigest(), "size": 6}
    manifest = {name: {"repo": "iic/model", "files": {"tokens.txt": spec}} for name in ["online", "offline", "vad", "punc"]}
    for name in manifest:
        directory = tmp_path / "models/funasr-2pass" / name
        directory.mkdir(parents=True)
        (directory / "tokens.txt").write_bytes(b"cached")
    monkeypatch.setattr(speech, "data_dir", lambda: tmp_path)
    monkeypatch.setattr(speech, "MODEL_MANIFEST", manifest)
    download = Mock(side_effect=AssertionError("Network is forbidden"))
    constructor = Mock()
    monkeypatch.setattr(httpx.Client, "stream", download)
    monkeypatch.setattr(speech_engine, "SpeechEngine", constructor)
    speech._load_model()
    download.assert_not_called()
    assert constructor.call_args.args == (tmp_path / "models/funasr-2pass",)


def test_downloads_are_pinned_and_checksum_failures_never_replace_a_model(monkeypatch, tmp_path):
    files = {"model.bin": {"revision": "fixed", "sha256": hashlib.sha256(b"model").hexdigest(), "size": 5}}
    client = httpx.Client
    calls = []
    def respond(request):
        calls.append(str(request.url))
        return httpx.Response(200, content=b"model" if len(calls) == 1 else b"wrong")
    monkeypatch.setattr(speech.httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
    speech._ensure_model_files(tmp_path, repo="iic/model", files=files)
    assert (tmp_path / "model.bin").read_bytes() == b"model"
    assert "Revision=fixed" in calls[0]
    (tmp_path / "model.bin").write_bytes(b"damaged cache")
    with pytest.raises(RuntimeError, match="checksum"):
        speech._ensure_model_files(tmp_path, repo="iic/model", files=files)
    assert not (tmp_path / "model.bin.part").exists()


def test_interrupted_model_download_resumes_only_the_expected_range(monkeypatch, tmp_path):
    files = {"model.bin": {"revision": "fixed", "sha256": hashlib.sha256(b"model").hexdigest(), "size": 5}}
    (tmp_path / "model.bin.part").write_bytes(b"mo")
    client = httpx.Client
    def respond(request):
        assert request.headers["range"] == "bytes=2-"
        return httpx.Response(206, headers={"Content-Range": "bytes 2-4/5"}, content=b"del")
    monkeypatch.setattr(speech.httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(respond), **kw))
    speech._ensure_model_files(tmp_path, repo="iic/model", files=files)
    assert (tmp_path / "model.bin").read_bytes() == b"model"
    assert not (tmp_path / "model.bin.part").exists()


def test_real_audio_decode_is_bounded_and_in_memory():
    assert speech._decode_audio(wav(), max_seconds=2).shape == (16000,)
    with pytest.raises(ValueError, match="过长"):
        speech._decode_audio(wav(3), max_seconds=2)
    with pytest.raises(ValueError, match="无法读取"):
        speech._decode_audio(b"not audio", max_seconds=2)


def test_non_wave_payloads_never_reach_the_media_decoder(monkeypatch):
    import av
    decoder = Mock(side_effect=AssertionError("Unexpected format detection"))
    monkeypatch.setattr(av, "open", decoder)
    for payload in [b"#EXTM3U\nhttp://127.0.0.1/private\n", b"RIFFxxxxAVI ", b""]:
        with pytest.raises(ValueError, match="无法读取"):
            speech._decode_audio(payload, max_seconds=2)
    decoder.assert_not_called()


def test_sessions_are_account_scoped_ordered_and_cancelled_on_restart(monkeypatch):
    model = Mock()
    model.create_stream.return_value.push.return_value = [{"text": "你好"}]
    monkeypatch.setattr(speech, "_model", model)
    with use_workspace(1):
        key = speech_sessions.open_session()
        assert speech_sessions.feed(key, 0, wav()) == [{"text": "你好"}]
        with pytest.raises(ValueError, match="顺序"):
            speech_sessions.feed(key, 0, wav())
        assert speech_sessions.feed(key, 1, wav())
    with use_workspace(2):
        with pytest.raises(speech_sessions.SessionGoneError):
            speech_sessions.feed(key, 2, wav())
        speech_sessions.close_session(key)
    with use_workspace(1):
        new_key = speech_sessions.open_session()
        with pytest.raises(speech_sessions.SessionGoneError):
            speech_sessions.feed(key, 2, wav())
        speech_sessions.close_session(new_key)
        speech_sessions.close_session(new_key)
    assert not speech_sessions._sessions


def test_limits_expiry_and_lock_release(monkeypatch):
    monkeypatch.setattr(speech, "_model", Mock())
    with pytest.raises(PermissionError):
        speech_sessions.open_session()
    with use_workspace(1):
        key = speech_sessions.open_session()
        session = speech_sessions._sessions[key]
        with pytest.raises(ValueError, match="大小"):
            speech_sessions.feed(key, 0, b"x" * (speech_sessions.MAX_CHUNK_BYTES + 1))
        session.stream.push.side_effect = RuntimeError("inference failed")
        with pytest.raises(RuntimeError):
            speech_sessions.feed(key, 0, wav())
        assert speech._inference_lock.acquire(blocking=False)
        speech._inference_lock.release()
        session.touched -= 31
        speech_sessions._expire(key)
        assert session.closed.is_set()
        assert key not in speech_sessions._sessions
    for owner in range(1, 5):
        with use_workspace(owner):
            speech_sessions.open_session()
    with use_workspace(5), pytest.raises(speech.SpeechBusyError):
        speech_sessions.open_session()


def test_cancellation_during_inference_discards_its_result(monkeypatch):
    model = Mock()
    monkeypatch.setattr(speech, "_model", model)
    with use_workspace(1):
        key = speech_sessions.open_session()
        model.create_stream.return_value.push.side_effect = lambda _: speech_sessions.close_session(key) or [{"text": "迟到"}]
        with pytest.raises(speech_sessions.SessionGoneError):
            speech_sessions.feed(key, 0, wav())


def test_http_session_protocol_mime_validation_and_account_context(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    monkeypatch.setattr(speech, "_model", Mock())
    monkeypatch.setattr(speech_sessions, "current_user_id", lambda: 1)
    key = client.post("/speech/sessions").json()["id"]
    speech_sessions._sessions[key].stream.push.return_value = [{"segmentId": 0, "revision": 1, "text": "你好", "final": False}]
    response = client.post(f"/speech/sessions/{key}/audio?sequence=0", files={"file": ("a.wav", wav(), "audio/wav;codecs=pcm")})
    assert response.status_code == 200
    assert response.json()["updates"][0]["text"] == "你好"
    assert client.post(f"/speech/sessions/{key}/audio?sequence=1", files={"file": ("bad.txt", b"text", "text/plain")}).status_code == 415
    assert client.post(f"/speech/sessions/{key}/audio?sequence=-1", files={"file": ("a.wav", wav(), "audio/wav")}).status_code == 422
    assert client.delete(f"/speech/sessions/{key}").status_code == 204
    assert client.post(f"/speech/sessions/{key}/audio?sequence=1", files={"file": ("a.wav", wav(), "audio/wav")}).status_code == 410


def test_http_finish_uses_the_next_sequence_and_releases_the_session(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    monkeypatch.setattr(speech, "_model", Mock())
    monkeypatch.setattr(speech_sessions, "current_user_id", lambda: 1)
    key = client.post("/speech/sessions").json()["id"]
    updates = [{"segmentId": 0, "revision": 1, "text": "最后一句。", "final": True}]
    speech_sessions._sessions[key].stream.finish.return_value = updates
    endpoint = f"/speech/sessions/{key}/finish"
    assert client.post(f"{endpoint}?sequence=1").status_code == 422
    monkeypatch.setattr(speech_sessions, "current_user_id", lambda: 2)
    assert client.post(f"{endpoint}?sequence=0").status_code == 410
    monkeypatch.setattr(speech_sessions, "current_user_id", lambda: 1)
    assert client.post(f"{endpoint}?sequence=0").json() == {"updates": updates}
    assert client.post(f"{endpoint}?sequence=0").status_code == 410


def test_speech_routes_require_login(monkeypatch, tmp_path):
    from app import db
    from app.main import app
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "auth.db")
    client = TestClient(app)
    assert client.get("/speech/status").status_code == 401
    assert client.post("/speech/prepare").status_code == 401
    assert client.post("/speech/sessions").status_code == 401
    assert client.delete("/speech/sessions/old").status_code == 401
    assert client.post("/speech/sessions/old/audio?sequence=0", files={"file": ("a.wav", wav(), "audio/wav")}).status_code == 401
    assert client.post("/speech/sessions/old/finish?sequence=0").status_code == 401


def test_authenticated_http_audio_reaches_the_same_account_context_in_threadpool(monkeypatch, tmp_path):
    from app import db
    from app.config import get_settings
    from app.main import app
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "auth.db")
    get_settings.cache_clear()
    model = Mock()
    model.create_stream.return_value.push.return_value = []
    monkeypatch.setattr(speech, "_model", model)
    client = TestClient(app)
    headers = []
    for email in ["voice-one@example.com", "voice-two@example.com"]:
        response = client.post("/auth/register", json={"email": email, "password": "a-long-test-password"})
        assert response.status_code == 200
        headers.append({"Authorization": f"Bearer {response.json()['access_token']}"})
    key = client.post("/speech/sessions", headers=headers[0]).json()["id"]
    path = f"/speech/sessions/{key}/audio?sequence=0"
    files = {"file": ("a.wav", wav(), "audio/wav")}
    assert client.post(path, headers=headers[1], files=files).status_code == 410
    assert client.post(path, headers=headers[0], files=files).json() == {"updates": []}
    get_settings.cache_clear()


def test_hotwords_are_bounded_account_session_inputs(monkeypatch):
    from app.speech_engine import DEFAULT_HOTWORDS
    model = Mock()
    monkeypatch.setattr(speech, "_model", model)
    with use_workspace(1):
        speech_sessions.open_session(["项目甲", "团团"])
        assert model.create_stream.call_args.args == ((*DEFAULT_HOTWORDS, "项目甲"),)
        for words in [[""], ["两个 词"], ["长" * 11], ["词"] * 65]:
            with pytest.raises(ValueError, match="热词"):
                speech_sessions.open_session(words)


def test_oversized_model_response_is_rejected_before_writing(monkeypatch, tmp_path):
    files = {"model.bin": {"revision": "fixed", "sha256": hashlib.sha256(b"model").hexdigest(), "size": 5}}
    client = httpx.Client
    monkeypatch.setattr(speech.httpx, "Client", lambda **kw: client(transport=httpx.MockTransport(lambda _: httpx.Response(200, content=b"too long")), **kw))
    with pytest.raises(RuntimeError, match="size limit"):
        speech._ensure_model_files(tmp_path, repo="iic/model", files=files)
    assert not (tmp_path / "model.bin").exists()
    assert (tmp_path / "model.bin.part").stat().st_size == 0


def test_http_session_accepts_hotwords_and_rejects_invalid_words(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    model = Mock()
    monkeypatch.setattr(speech, "_model", model)
    with use_workspace(1):
        assert client.post("/speech/sessions", json={"hotwords": ["项目甲"]}).status_code == 200
        assert "项目甲" in model.create_stream.call_args.args[0]
        assert client.post("/speech/sessions", json={"hotwords": ["长" * 11]}).status_code == 422
        assert client.post("/speech/sessions", json={"hotwords": ["词"] * 65}).status_code == 422
