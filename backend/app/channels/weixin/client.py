from __future__ import annotations

import base64
import secrets
from urllib.parse import urlsplit

import httpx

from ...version import APP_VERSION

API_BASE = "https://ilinkai.weixin.qq.com"
# Wire compatibility reference: Tencent/openclaw-weixin 2.4.10.
CHANNEL_VERSION = "2.4.10"


def validate_base_url(value: str) -> str:
    parts = urlsplit(value)
    host = (parts.hostname or "").lower()
    if (parts.scheme != "https" or not (host == "weixin.qq.com" or host.endswith(".weixin.qq.com"))
            or parts.username or parts.password or parts.port not in (None, 443)
            or parts.path not in ("", "/") or parts.query or parts.fragment):
        raise ValueError("微信服务地址必须是官方 HTTPS 地址")
    return f"https://{host}"


class WeixinError(RuntimeError):
    def __init__(self, code: int = 0, message: str = "微信服务暂时不可用，请稍后重试"):
        super().__init__(message)
        self.code = code


class WeixinClient:
    def __init__(self, http: httpx.AsyncClient, base_url: str = API_BASE):
        self.http = http
        self.base_url = validate_base_url(base_url)

    async def _request(self, endpoint: str, *, token: str = "", body: dict | None = None,
                       params: dict | None = None, get: bool = False, timeout: float = 20) -> dict:
        headers = {"iLink-App-Id": "bot", "iLink-App-ClientVersion": str((2 << 16) | (4 << 8) | 10)}
        if not get:
            headers.update({"Content-Type": "application/json", "AuthorizationType": "ilink_bot_token",
                            "X-WECHAT-UIN": base64.b64encode(str(secrets.randbits(32)).encode()).decode()})
        if token:
            headers["Authorization"] = f"Bearer {token}"
        payload = dict(body or {})
        if token:
            payload["base_info"] = {"channel_version": CHANNEL_VERSION, "bot_agent": f"Tuantuan/{APP_VERSION}"}
        try:
            response = await self.http.request("GET" if get else "POST", f"{self.base_url}/{endpoint}",
                                               params=params, headers=headers, json=None if get else payload,
                                               timeout=timeout, follow_redirects=False)
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise ValueError("invalid response")
        except httpx.ReadTimeout:
            # Tencent treats an idle long-poll read timeout as an empty result.
            # Keep the cursor; cancellation still propagates via CancelledError.
            if endpoint == "ilink/bot/getupdates":
                return {"ret": 0, "msgs": [], "get_updates_buf": payload.get("get_updates_buf", "")}
            raise WeixinError(message="微信请求读取超时，请稍后重试") from None
        except httpx.TimeoutException:
            raise WeixinError(message="连接微信服务超时，请检查后端网络") from None
        except httpx.ConnectError:
            raise WeixinError(message="无法连接微信服务，请检查后端网络") from None
        except httpx.HTTPStatusError as exc:
            raise WeixinError(message=f"微信接口返回 HTTP {exc.response.status_code}，请稍后重试") from None
        except ValueError:
            raise WeixinError(message="微信服务返回无效数据，请稍后重试") from None
        except httpx.HTTPError:
            # Never surface upstream URLs, bodies, credentials or QR query strings.
            raise WeixinError() from None
        for key in ("ret", "errcode"):
            code = data.get(key)
            if isinstance(code, int) and code != 0:
                raise WeixinError(code, "微信登录已失效，请重新连接" if code == -14 else "微信服务返回错误，请稍后重试")
        return data

    async def start_login(self) -> dict:
        return await self._request("ilink/bot/get_bot_qrcode", params={"bot_type": "3"}, body={"local_token_list": []})

    async def poll_login(self, qrcode: str, verify_code: str = "") -> dict:
        params = {"qrcode": qrcode}
        if verify_code:
            params["verify_code"] = verify_code
        return await self._request("ilink/bot/get_qrcode_status", params=params, get=True, timeout=40)

    async def get_updates(self, token: str, cursor: str) -> dict:
        return await self._request("ilink/bot/getupdates", token=token, body={"get_updates_buf": cursor}, timeout=40)

    async def send_text(self, token: str, peer: str, context: str, text: str, client_id: str) -> None:
        await self._request("ilink/bot/sendmessage", token=token, body={"msg": {
            "from_user_id": "", "to_user_id": peer, "client_id": client_id,
            "message_type": 2, "message_state": 2, "context_token": context,
            "item_list": [{"type": 1, "text_item": {"text": text}}],
        }})
