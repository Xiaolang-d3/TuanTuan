from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile, Query, Response
from pydantic import BaseModel, Field

from starlette.concurrency import run_in_threadpool

from .. import speech, speech_sessions

router = APIRouter(prefix="/speech", tags=["speech"])


@router.get("/status")
def speech_status() -> dict:
    return speech.status()


@router.post("/prepare")
def speech_prepare() -> dict:
    return speech.prepare()


def _speech_error(exc: Exception) -> HTTPException:
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=401, detail=str(exc))
    if isinstance(exc, speech_sessions.SessionGoneError):
        return HTTPException(status_code=410, detail=str(exc))
    if isinstance(exc, speech.SpeechBusyError):
        return HTTPException(status_code=409, detail=str(exc))
    if isinstance(exc, ValueError):
        return HTTPException(status_code=422, detail=str(exc))
    return HTTPException(status_code=503, detail="离线语音暂时不可用，请重新打开语音输入。")


class SpeechSessionOptions(BaseModel):
    hotwords: list[str] = Field(default_factory=list, max_length=64)


@router.post("/sessions")
def open_speech_session(options: SpeechSessionOptions | None = None) -> dict[str, str]:
    try:
        return {"id": speech_sessions.open_session(options.hotwords if options else None)}
    except (ValueError, RuntimeError, PermissionError) as exc:
        raise _speech_error(exc) from exc


@router.delete("/sessions/{session_id}", status_code=204)
def close_speech_session(session_id: str) -> Response:
    try:
        speech_sessions.close_session(session_id)
        return Response(status_code=204)
    except PermissionError as exc:
        raise _speech_error(exc) from exc


@router.post("/sessions/{session_id}/audio")
async def speech_audio(session_id: str, sequence: int = Query(ge=0), file: UploadFile = File(...)) -> dict:
    try:
        media_type = (file.content_type or "").split(";", 1)[0].lower()
        if media_type not in {"audio/wav", "audio/x-wav"}:
            raise HTTPException(status_code=415, detail="不支持的录音格式，请切换浏览器重试。")
        content = await file.read(speech_sessions.MAX_CHUNK_BYTES + 1)
        updates = await run_in_threadpool(speech_sessions.feed, session_id, sequence, content)
        return {"updates": updates}
    except (ValueError, RuntimeError, PermissionError) as exc:
        raise _speech_error(exc) from exc
    finally:
        await file.close()


@router.post("/sessions/{session_id}/finish")
def finish_speech_session(session_id: str, sequence: int = Query(ge=0)) -> dict:
    try:
        return {"updates": speech_sessions.feed(session_id, sequence, None)}
    except (ValueError, RuntimeError, PermissionError) as exc:
        raise _speech_error(exc) from exc
