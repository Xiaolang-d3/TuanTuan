from __future__ import annotations

import asyncio
import time
from pathlib import Path
from uuid import uuid4

import httpx

from ...workspace import use_workspace
from ..events import SnapshotEvents
from .bridge import execute_message, record_notice
from .client import API_BASE, WeixinClient, WeixinError, validate_base_url
from .store import WeixinStore


class WeixinService:
    def __init__(self, user_id: int, root: Path, *, http=None, executor=execute_message):
        self.user_id, self.root = user_id, root
        self.store = WeixinStore(root)
        self.http = http or httpx.AsyncClient()
        self.owns_http = http is None
        self.executor = executor
        self.login_session = None
        self.tasks = []
        self.login_lock = asyncio.Lock()
        self.events = SnapshotEvents(self._status)
        self.store.on_change = self.events.refresh

    def status(self) -> dict:
        return self.events.refresh()

    def _status(self) -> dict:
        return {"connected": bool(self.store.get("account")), "enabled": self.store.get("enabled", False),
                "receiving": any(not task.done() for task in self.tasks),
                "error": self.store.get("error", ""), "conversation_id": self.store.get("conversation_id"),
                **self.store.message_state()}

    async def login(self) -> dict:
        session = {"id": uuid4().hex, "started": time.monotonic(), "base": API_BASE}
        self.login_session = session
        data = await WeixinClient(self.http).start_login()
        if self.login_session is not session:
            raise ValueError("连接请求已取消")
        if not data.get("qrcode") or not data.get("qrcode_img_content"):
            raise WeixinError(message="微信未返回二维码，请重新连接")
        session["qrcode"] = data["qrcode"]
        return {"session_id": session["id"], "qr_content": data["qrcode_img_content"], "status": "wait"}

    async def poll_login(self, session_id: str, verify_code: str = "") -> dict:
        async with self.login_lock:
            session = self.login_session
            if not session or session["id"] != session_id:
                raise ValueError("连接请求已失效，请重新生成二维码")
            if time.monotonic() - session["started"] > 300:
                return {"status": "expired"}
            data = await WeixinClient(self.http, session["base"]).poll_login(session["qrcode"], verify_code)
            if self.login_session is not session:
                raise ValueError("连接请求已取消")
            status = data.get("status", "wait")
            if status == "scaned_but_redirect" and data.get("redirect_host"):
                session["base"] = validate_base_url("https://" + data["redirect_host"])
                status = "scaned"
            if status == "confirmed":
                if not all(isinstance(data.get(key), str) and data[key] for key in ("bot_token", "ilink_bot_id", "ilink_user_id")):
                    raise WeixinError(message="微信未返回完整绑定信息，请重新连接")
                data["baseurl"] = validate_base_url(data.get("baseurl") or API_BASE)
                await self.stop()
                if self.login_session is not session:
                    raise ValueError("连接请求已取消")
                self.store.bind({key: data[key] for key in ("bot_token", "ilink_bot_id", "ilink_user_id", "baseurl")})
                self.login_session = None
            if status == "binded_redirect":
                status = "confirmed" if self.store.get("account") else "expired"
            return {"status": status}

    def accept_updates(self, data: dict) -> None:
        account = self.store.account()
        if not account:
            return
        messages = [m for m in data.get("msgs", []) if isinstance(m, dict)
                    and m.get("from_user_id") == account["ilink_user_id"]
                    and not m.get("group_id") and m.get("message_type") == 1
                    and m.get("message_state", 2) == 2 and m.get("context_token")]
        self.store.receive(messages, data.get("get_updates_buf") or "")

    async def work_once(self) -> bool:
        account, job = self.store.account(), self.store.next_job()
        if not account or not job:
            return False
        message = job["message"]
        if job["reply"] is None:
            text = "\n".join(str((item.get("text_item") or {}).get("text") or (item.get("voice_item") or {}).get("text") or "")
                             for item in message.get("item_list", []) if isinstance(item, dict)).strip()
            notice = True
            media = any(item.get('type') in (2, 4, 5) for item in message.get('item_list', []) if isinstance(item, dict))
            if not text or media:
                reply = "目前微信渠道支持文字任务和带转写文字的语音，请在团团内上传图片或文件。"
            elif len(text) > 20000:
                reply = "消息过长，请分段发送，或在团团内处理长文档。"
            else:
                self.store.started(job["id"])
                with use_workspace(self.user_id, self.root):
                    try:
                        result = await self.executor(text, self.store.get("conversation_id"), "weixin-" + job["id"])
                        self.store.set("conversation_id", result["conversation_id"])
                        reply = result["text"]
                        notice = False
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        reply = "任务执行未完成，请在团团检查模型配置或查看微信会话执行记录。"
            if notice:
                with use_workspace(self.user_id, self.root):
                    result = record_notice(text or '收到微信附件或未转写语音。', reply,
                                           self.store.get('conversation_id'), 'weixin-' + job['id'])
                self.store.set('conversation_id', result['conversation_id'])
                reply = result['text']
            self.store.save_reply(job["id"], reply)
        else:
            reply = job["reply"]
        client = WeixinClient(self.http, account.get("baseurl") or API_BASE)
        parts = [reply[i:i + 1500] for i in range(0, len(reply), 1500)] or ["任务已完成。"]
        for index in range(job["delivered_parts"], len(parts)):
            await client.send_text(account["bot_token"], account["ilink_user_id"], message["context_token"],
                                   parts[index], f"tuantuan-{job['id']}-{index}")
            self.store.sent_part(job["id"], index + 1)
        self.store.delivered(job["id"])
        return True

    def start(self) -> None:
        if self.tasks or not self.store.get("account") or not self.store.get("enabled"):
            return
        self.tasks = [asyncio.create_task(self._receive()), asyncio.create_task(self._work())]
        self.events.refresh()

    async def _receive(self):
        while True:
            try:
                account = self.store.account()
                client = WeixinClient(self.http, account.get("baseurl") or API_BASE)
                data = await client.get_updates(account["bot_token"], self.store.cursor())
                self.accept_updates(data)
                self.store.set("error", "")
                await asyncio.sleep(1)
            except WeixinError as exc:
                self.store.set("error", str(exc))
                if exc.code == -14:
                    self.store.set("enabled", False)
                    asyncio.get_running_loop().call_soon(self.events.refresh)
                    return
                await asyncio.sleep(10)
            except Exception:
                self.store.set("error", "微信接收异常，请重新连接")
                await asyncio.sleep(10)

    async def _work(self):
        while True:
            try:
                if self.store.get("enabled"):
                    await self.work_once()
                await asyncio.sleep(1)
            except Exception:
                self.store.set("error", "微信回复发送失败，稍后重试已有结果")
                await asyncio.sleep(10)

    async def stop(self):
        tasks, self.tasks = self.tasks, []
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.events.refresh()

    async def disconnect(self):
        self.login_session = None
        await self.stop()
        self.store.disconnect()

    async def close(self):
        await self.stop()
        self.events.close()
        if self.owns_http:
            await self.http.aclose()
