from __future__ import annotations

import base64
import asyncio
import json
import time
from io import BytesIO

from fastapi import APIRouter, HTTPException, Response, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from ..channels.weixin.client import WeixinError
from ..channels.weixin.manager import manager
from ..auth import current_user
from ..streaming import until_shutdown

router = APIRouter(prefix="/channels/weixin", tags=["weixin"])
HEARTBEAT_SECONDS = 15


@router.get('/events')
async def events(request: Request):
    # Capture the authenticated workspace now; never select it from query input.
    channel = manager.current()
    authorization = request.headers.get('Authorization')

    async def stream():
        checked_at = time.monotonic()
        async with channel.events.subscribe() as queue:
            while True:
                if time.monotonic() - checked_at >= HEARTBEAT_SECONDS:
                    try:
                        user = current_user(authorization)
                        if int(user['id']) != channel.user_id:
                            raise HTTPException(401)
                    except HTTPException:
                        yield 'event: auth-expired\ndata: {}\n\n'
                        return
                    checked_at = time.monotonic()
                try:
                    state = await asyncio.wait_for(queue.get(), HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ': heartbeat\n\n'
                    continue
                if state is None:
                    return
                yield 'event: weixin-status\ndata: ' + json.dumps(state, ensure_ascii=False) + '\n\n'

    return StreamingResponse(until_shutdown(stream(), request), media_type='text/event-stream', headers={
        'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no',
    })


class LoginPoll(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    verify_code: str = Field(default="", max_length=16, pattern=r"^[0-9]*$")


class MarkRead(BaseModel):
    through_sequence: int = Field(ge=0)
    binding_id: str = Field(min_length=1, max_length=64)


@router.post('/read')
async def mark_read(payload: MarkRead, response: Response):
    response.headers['Cache-Control'] = 'no-store'
    channel = manager.current()
    try:
        channel.store.mark_read(payload.through_sequence, payload.binding_id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None
    return channel.status()


@router.get("")
async def status(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return manager.current().status()


@router.post("/login")
async def login(response: Response):
    response.headers["Cache-Control"] = "no-store"
    try:
        import qrcode
        result = await manager.current().login()
        output = BytesIO()
        qrcode.make(result.pop("qr_content")).save(output, format="PNG")
        result["qr_image"] = "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
        return result
    except (WeixinError, ValueError):
        raise HTTPException(502, "无法生成微信连接二维码，请稍后重试") from None


@router.post("/login/poll")
async def poll(payload: LoginPoll, response: Response):
    response.headers["Cache-Control"] = "no-store"
    channel = manager.current()
    try:
        result = await channel.poll_login(payload.session_id, payload.verify_code)
        if result["status"] == "confirmed":
            channel.start()
        return result
    except WeixinError as exc:
        raise HTTPException(502, str(exc)) from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from None


@router.delete("")
async def disconnect(response: Response):
    response.headers["Cache-Control"] = "no-store"
    channel = manager.current()
    await channel.disconnect()
    return channel.status()
