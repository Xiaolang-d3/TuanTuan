"""Public-only HTTPS transport for user-configured hosted model services.

Validate DNS at the TCP boundary, then connect to the validated numeric IP.
HTTPcore still owns the original origin, Host, SNI and certificate validation.
No process-wide resolver patches or environment proxies are used.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import ssl
from urllib.parse import urlsplit

import anyio
import certifi
import httpcore
import httpx
from httpcore._backends.anyio import AnyIOBackend

from .branding import env


class ModelAddressError(httpx.RequestError):
    """A fixed, credential-free explanation of a denied model request."""


def hosted_models() -> bool:
    return env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() == "hosted"


_TRANSLATED_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "64:ff9b::/96", "64:ff9b:1::/48", "2002::/16", "2001::/32",
))
_HOSTNAME = re.compile(r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


def is_public_model_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    if "%" in value or not ip.is_global or ip.is_multicast or ip.is_reserved:
        return False
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped or ip.is_site_local or any(ip in network for network in _TRANSLATED_NETWORKS):
            return False
    return True


def validate_public_model_url(value: str) -> None:
    """Static checks only; DNS is revalidated for every new TCP connection."""
    if any(ord(char) <= 32 or ord(char) == 127 for char in value) or "\\" in value:
        raise ValueError("托管模式的 Base URL 不能包含空白、控制字符或反斜杠")
    try:
        parsed = urlsplit(value)
        host = (parsed.hostname or "").rstrip(".").lower()
        port = parsed.port
    except ValueError as exc:
        raise ValueError("托管模式的 Base URL 格式不正确") from exc
    if parsed.scheme.lower() != "https" or not host or port == 0:
        raise ValueError("托管模式仅支持公网 HTTPS 模型服务地址")
    if parsed.username is not None or parsed.password is not None or parsed.fragment:
        raise ValueError("托管模式的 Base URL 不能包含账号、密钥或片段")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        try:
            host = host.encode("idna").decode("ascii")
        except UnicodeError as exc:
            raise ValueError("托管模式的 Base URL 域名格式不正确") from exc
        if not _HOSTNAME.fullmatch(host) or host.endswith((".localhost", ".local", ".internal", ".home.arpa")):
            raise ValueError("托管模式仅支持公网域名，不能使用本机或内网地址")
    else:
        if not is_public_model_ip(host):
            raise ValueError("托管模式仅支持公网地址，不能访问本机、内网或保留 IP")


class PublicModelBackend(httpcore.AsyncNetworkBackend):
    def __init__(self) -> None:
        self._backend = AnyIOBackend()

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            # The one deadline includes DNS and all public-address attempts.
            with anyio.fail_after(timeout):
                try:
                    ipaddress.ip_address(host)
                    addresses = [host]
                except ValueError:
                    answers = await anyio.getaddrinfo(host, port, type=socket.SOCK_STREAM)
                    addresses = list(dict.fromkeys(answer[4][0] for answer in answers))
                if not addresses:
                    raise ModelAddressError("模型服务域名未解析到公网地址，请检查服务地址")
                if any(not is_public_model_ip(address) for address in addresses):
                    raise ModelAddressError("模型服务地址解析到了非公网 IP，已阻止访问本机、内网或保留地址")
                failure = None
                for index, address in enumerate(addresses):
                    try:
                        remaining = anyio.current_effective_deadline() - anyio.current_time()
                        attempt_timeout = None if timeout is None else max(0, remaining) / (len(addresses) - index)
                        return await self._backend.connect_tcp(
                            address, port, timeout=attempt_timeout, local_address=local_address,
                            socket_options=socket_options,
                        )
                    except (httpcore.ConnectError, httpcore.ConnectTimeout) as exc:
                        failure = exc
                raise failure
        except TimeoutError as exc:
            raise httpcore.ConnectTimeout("模型服务域名解析或连接超时") from exc
        except OSError as exc:
            raise httpcore.ConnectError("模型服务域名解析失败，请检查服务地址") from exc

    async def connect_unix_socket(self, *args, **kwargs):
        raise ModelAddressError("托管模式不允许访问本机套接字")

    async def sleep(self, seconds):
        await anyio.sleep(seconds)


class PublicModelTransport(httpx.AsyncHTTPTransport):
    def __init__(self) -> None:
        # Reuse HTTPX's stream/error adapters with HTTPcore's supported backend
        # injection. The _pool adapter is covered against the locked versions.
        self._pool = httpcore.AsyncConnectionPool(
            ssl_context=ssl.create_default_context(cafile=certifi.where()),
            network_backend=PublicModelBackend(), retries=0,
        )

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        try:
            validate_public_model_url(str(request.url))
        except ValueError as exc:
            raise ModelAddressError(str(exc), request=request) from exc
        response = await super().handle_async_request(request)
        if 300 <= response.status_code < 400:
            await response.aclose()
            raise ModelAddressError("模型服务返回了地址跳转；为保护密钥已停止请求，请填写最终 HTTPS API 地址", request=request)
        return response


def model_http_client(**kwargs) -> httpx.AsyncClient:
    if hosted_models():
        kwargs.update(transport=PublicModelTransport(), trust_env=False, follow_redirects=False)
    return httpx.AsyncClient(**kwargs)


def model_address_error(exc: BaseException):
    """Recover the policy reason through SDK wrappers, without upstream text."""
    pending, seen = [exc], set()
    while pending:
        item = pending.pop()
        if id(item) in seen:
            continue
        seen.add(id(item))
        if isinstance(item, ModelAddressError):
            from .models.base import ModelProviderError
            return ModelProviderError("unsafe_model_address", str(item))
        pending.extend(cause for cause in (item.__cause__, item.__context__) if cause is not None)
    return None
