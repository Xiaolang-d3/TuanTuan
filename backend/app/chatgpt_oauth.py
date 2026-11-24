"""Protocol for OpenAI's local, public Sign in with ChatGPT client.

Callers own the loopback listener, one-time/expiring authorization attempts,
credential storage, and serialization of refreshes for each registration.
Use a dedicated, TLS-verifying HTTP client and keep attempts and tokens local.
"""

import base64
import binascii
import hashlib
import json
import math
import re
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

ISSUER = "https://auth.openai.com"
AUTHORIZE_URL = f"{ISSUER}/api/accounts/authorize"
TOKEN_URL = f"{ISSUER}/api/accounts/oauth/token"
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"
DISCOVERY_URL = f"{ISSUER}/.well-known/openid-configuration"
RESOURCE = "https://api.openai.com/v1"
CALLBACK_PATH = "/auth/callback"
DYNAMIC_CLIENT_ID = "dynamic_agent_client"
REQUESTED_SCOPES = (
    "openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct",
)
PLAN_SCOPES = frozenset({"resource.invoke", "chatgpt.tokens.use.direct"})
TERMINAL_REFRESH_ERRORS = frozenset({
    "invalid_grant", "invalid_refresh_token", "token_expired", "refresh_token_expired",
    "refresh_token_invalidated", "refresh_token_reused",
})
_OAUTH_ERROR_CODES = TERMINAL_REFRESH_ERRORS | {
    "invalid_client", "access_denied", "temporarily_unavailable", "server_error",
}
_CLIENT_ID = re.compile(r"[a-zA-Z0-9_-]{1,200}")
_SCOPE = re.compile(r"[\x21\x23-\x5b\x5d-\x7e]+")
_BEARER = re.compile(r"[a-zA-Z0-9._~+/\-]+=*")
_BASE64URL = re.compile(r"[a-zA-Z0-9_-]+")
_CLOCK_SKEW_SECONDS = 5
_TIMEOUT_SECONDS = 15


class OAuthError(Exception):
    """Safe error: does not include raw callback data, provider text, or tokens."""

    def __init__(self, code: str, *, retryable: bool = False, status_code: int | None = None):
        super().__init__(f"ChatGPT OAuth could not complete ({code}).")
        self.code = code
        self.retryable = retryable
        self.status_code = status_code


@dataclass(frozen=True)
class AuthorizationAttempt:
    redirect_uri: str
    client_id: str
    state: str = field(repr=False)
    nonce: str = field(repr=False)
    code_verifier: str = field(repr=False)
    authorization_url: str = field(repr=False)
    expected_subject: str | None = field(repr=False)


@dataclass(frozen=True)
class AuthorizationCode:
    client_id: str
    code: str = field(repr=False)
    _state: str = field(repr=False)


@dataclass(frozen=True)
class TokenSet:
    """Backend-only token response. Absolute times use Unix seconds."""

    client_id: str
    subject: str = field(repr=False)
    email: str | None = field(repr=False)
    issuer: str
    id_token: str = field(repr=False)
    access_token: str | None = field(repr=False)
    refresh_token: str | None = field(repr=False)
    token_type: str | None
    expires_in: int | None
    scopes: tuple[str, ...]
    expires_at: float | None
    earliest_refresh_at: float | None = None

    @property
    def plan_enabled(self) -> bool:
        """The grant permits plan usage (independently of token lifetime)."""
        return bool(self.access_token) and PLAN_SCOPES.issubset(self.scopes)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _valid_client_id(value: object) -> bool:
    return isinstance(value, str) and value != DYNAMIC_CLIENT_ID and _CLIENT_ID.fullmatch(value) is not None


def _valid_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and all(ch.isprintable() for ch in value)


def begin_authorization(
    *,
    redirect_uri: str,
    host_id: str,
    agent_name: str,
    client_id: str | None = None,
    expected_subject: str | None = None,
    id_token_hint: str | None = None,
    login_hint: str | None = None,
    reconsent: bool = False,
) -> AuthorizationAttempt:
    """Prepare sign-in after binding the local listener's port.

    Persist a supported opaque host ID before calling (e.g. urn:uuid:<UUIDv4>).
    Only the callback port may change across sign-ins. An ID-token hint is
    optional; omit it if opening the browser might expose the URL to other apps.
    """
    match = re.fullmatch(r"http://127\.0\.0\.1:([1-9][0-9]{0,4})" + CALLBACK_PATH, redirect_uri)
    if not match or int(match[1]) > 65535:
        raise OAuthError("invalid_redirect_uri")
    if not _valid_text(host_id) or not (
        host_id.startswith(("urn:uuid:", "urn:ietf:params:oauth:jwk-thumbprint:", "did:key:"))
        and not any(ch.isspace() for ch in host_id)
        and not host_id.endswith(":")
    ):
        raise OAuthError("invalid_host_id")
    if client_id is None:
        if not _valid_text(agent_name) or len(agent_name) > 120:
            raise OAuthError("invalid_agent_name")
        if any(value is not None for value in (expected_subject, id_token_hint, login_hint)) or reconsent:
            raise OAuthError("invalid_registration")
    elif not _valid_client_id(client_id):
        raise OAuthError("invalid_client")
    if expected_subject is not None and not _valid_text(expected_subject):
        raise OAuthError("invalid_registration")
    for hint in (id_token_hint, login_hint):
        if hint is not None and not _valid_text(hint):
            raise OAuthError("invalid_registration")

    state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    requested_client = client_id or DYNAMIC_CLIENT_ID
    params = {
        "client_id": requested_client,
        "ext_agent_host_id": host_id,
        "response_type": "code",
        "redirect_uri": redirect_uri,
        "scope": " ".join(REQUESTED_SCOPES),
        "resource": RESOURCE,
        "state": state,
        "nonce": nonce,
        "code_challenge_method": "S256",
        "code_challenge": _b64url(hashlib.sha256(verifier.encode("ascii")).digest()),
    }
    if not client_id:
        params["agent_name_hint"] = agent_name
    if id_token_hint is not None:
        params["id_token_hint"] = id_token_hint
    if login_hint is not None:
        params["login_hint"] = login_hint
    if reconsent:
        params["prompt"] = "consent"
    return AuthorizationAttempt(
        redirect_uri, requested_client, state, nonce, verifier,
        f"{AUTHORIZE_URL}?{urlencode(params)}", expected_subject,
    )


def parse_callback(attempt: AuthorizationAttempt, callback_query: str) -> AuthorizationCode:
    """Validate the query from the expected local callback route, not a full URL."""
    if len(callback_query) > 16_384:
        raise OAuthError("invalid_callback")
    try:
        query = parse_qs(callback_query.removeprefix("?"), keep_blank_values=True, errors="strict", max_num_fields=32)
    except ValueError:
        raise OAuthError("invalid_callback") from None

    states = query.get("state", [])
    if len(states) != 1 or not states[0].isascii() or not secrets.compare_digest(states[0], attempt.state):
        raise OAuthError("invalid_state")
    errors = query.get("error", [])
    if errors:
        if len(errors) != 1:
            raise OAuthError("invalid_callback")
        raise _provider_error(errors[0], fallback="authorization_failed")
    codes = query.get("code", [])
    client_ids = query.get("client_id", [])
    if len(codes) != 1 or not _valid_text(codes[0]) or len(client_ids) > 1:
        raise OAuthError("invalid_callback")
    if attempt.client_id == DYNAMIC_CLIENT_ID:
        if not client_ids or not _valid_client_id(client_ids[0]):
            raise OAuthError("registration_incomplete")
        client_id = client_ids[0]
    else:
        client_id = attempt.client_id
        if client_ids and client_ids[0] != client_id:
            raise OAuthError("client_mismatch")
    return AuthorizationCode(client_id, codes[0], attempt.state)


def _provider_error(code: object, *, fallback: str, status: int | None = None) -> OAuthError:
    safe_code = code if isinstance(code, str) and code in _OAUTH_ERROR_CODES else fallback
    retryable = safe_code in {"temporarily_unavailable", "server_error"} or (
        status is not None and (status == 429 or 500 <= status <= 599)
    )
    return OAuthError(safe_code, retryable=retryable, status_code=status)


async def _request(
    http: httpx.AsyncClient, method: str, url: str, *, data: dict[str, str] | None = None,
) -> httpx.Response:
    try:
        # Explicitly disable redirects, even on a caller client with redirects enabled.
        return await http.request(
            method, url, data=data, headers={"Accept": "application/json"}, auth=None,
            follow_redirects=False, timeout=_TIMEOUT_SECONDS,
        )
    except httpx.RequestError:
        raise OAuthError("network_error", retryable=True) from None


def _json_payload(response: httpx.Response) -> dict[str, Any]:
    try:
        value = response.json()
    except (ValueError, RecursionError):
        return {}
    return value if isinstance(value, dict) else {}


async def _token_request(http: httpx.AsyncClient, data: dict[str, str]) -> dict[str, Any]:
    response = await _request(http, "POST", TOKEN_URL, data=data)
    payload = _json_payload(response)
    if response.status_code != 200:
        error = payload.get("error")
        if isinstance(error, dict):
            error = error.get("code")
        raise _provider_error(error, fallback="token_request_failed", status=response.status_code)
    if not payload or "error" in payload:
        raise OAuthError("invalid_token_response")
    return payload


def _decode_base64url(value: object) -> bytes:
    if not isinstance(value, str) or not _BASE64URL.fullmatch(value):
        raise ValueError("invalid base64url")
    data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if _b64url(data) != value:
        raise ValueError("invalid base64url")
    return data


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JWT member")
        result[key] = value
    return result


def _jwt_object(part: str) -> dict[str, Any]:
    value = json.loads(_decode_base64url(part).decode("utf-8"), object_pairs_hook=_unique_pairs)
    if not isinstance(value, dict):
        raise ValueError("invalid JWT object")
    return value


async def _jwks(http: httpx.AsyncClient) -> list[Any]:
    try:
        response = await _request(http, "GET", JWKS_URL)
    except OAuthError:
        raise OAuthError("identity_verification_unavailable", retryable=True) from None
    keys = _json_payload(response).get("keys")
    if response.status_code != 200 or not isinstance(keys, list) or not keys:
        raise OAuthError("identity_verification_unavailable", retryable=True)
    return keys


def _matching_key(keys: list[Any], kid: str) -> dict[str, Any] | None:
    matches = [key for key in keys if isinstance(key, dict) and key.get("kid") == kid]
    if len(matches) != 1:
        return None
    key = matches[0]
    if key.get("kty") != "RSA" or key.get("alg", "RS256") != "RS256" or key.get("use", "sig") != "sig":
        return None
    return key


async def _verify_id_token(
    http: httpx.AsyncClient, token: str, *, client_id: str, nonce: str | None,
    access_token: str | None, received_at: float, keys: list[Any] | None = None,
) -> dict[str, Any]:
    # OpenAI advertises only RS256. Verify with its pinned JWKS and the repo's
    # cryptography dependency; never read keys or algorithms from token headers.
    try:
        if len(token) > 32_768:
            raise ValueError("oversized JWT")
        header_part, claims_part, signature_part = token.split(".")
        header = _jwt_object(header_part)
        kid = header.get("kid")
        if header.get("alg") != "RS256" or not _valid_text(kid) or "crit" in header or "b64" in header:
            raise ValueError("invalid JWT header")
        signature = _decode_base64url(signature_part)
    except (ValueError, binascii.Error, RecursionError):
        raise OAuthError("invalid_id_token") from None

    if keys is None:
        key = _matching_key(await _jwks(http), kid)
    else:
        key = _matching_key(keys, kid)
        if key is None:  # May have rotated between the preflight and token exchange.
            key = _matching_key(await _jwks(http), kid)
    if key is None:
        raise OAuthError("invalid_id_token")
    try:
        n = int.from_bytes(_decode_base64url(key.get("n")), "big")
        e = int.from_bytes(_decode_base64url(key.get("e")), "big")
        if not 2048 <= n.bit_length() <= 8192 or not 3 <= e <= 2**32 - 1:
            raise ValueError("invalid RSA key")
        signing_key = rsa.RSAPublicNumbers(e, n).public_key()
    except (ValueError, binascii.Error):
        raise OAuthError("identity_verification_unavailable", retryable=True) from None

    try:
        signing_input = f"{header_part}.{claims_part}".encode("ascii")
        signing_key.verify(signature, signing_input, padding.PKCS1v15(), hashes.SHA256())
        claims = _jwt_object(claims_part)
        if claims.get("iss") != ISSUER or not _valid_text(claims.get("sub")):
            raise ValueError("invalid JWT identity")
        aud = claims.get("aud")
        audience = [aud] if isinstance(aud, str) else aud
        if (
            not isinstance(audience, list) or not all(isinstance(value, str) for value in audience)
            or client_id not in audience or (len(audience) > 1 and claims.get("azp") != client_id)
            or ("azp" in claims and claims["azp"] != client_id)
        ):
            raise ValueError("invalid JWT audience")
        exp, iat = claims.get("exp"), claims.get("iat")
        if (
            type(exp) is not int or type(iat) is not int or exp <= iat
            or exp <= received_at - _CLOCK_SKEW_SECONDS or iat > received_at + _CLOCK_SKEW_SECONDS
        ):
            raise ValueError("invalid JWT lifetime")
        if "nbf" in claims and (type(claims["nbf"]) is not int or claims["nbf"] > received_at + _CLOCK_SKEW_SECONDS):
            raise ValueError("invalid JWT not-before")
        if nonce is not None and claims.get("nonce") != nonce:
            raise ValueError("invalid JWT nonce")
        if access_token is not None and "at_hash" in claims:
            expected_hash = _b64url(hashlib.sha256(access_token.encode("ascii")).digest()[:16])
            if claims["at_hash"] != expected_hash:
                raise ValueError("invalid access token hash")
    except (InvalidSignature, ValueError, binascii.Error, RecursionError):
        raise OAuthError("invalid_id_token") from None
    return claims


def _earliest_refresh(data: dict[str, Any]) -> float | None:
    value = data.get("earliest_refresh_at")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        try:
            if math.isfinite(value) and value >= 0:
                return float(value)
        except OverflowError:
            pass
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value)
            if parsed.tzinfo is not None:
                return parsed.timestamp()
        except (ValueError, OverflowError, OSError):
            pass
    return None


async def _validated_tokens(
    http: httpx.AsyncClient, data: dict[str, Any], *, client_id: str, received_at: float,
    nonce: str | None = None, expected_subject: str | None = None,
    previous: TokenSet | None = None, keys: list[Any] | None = None,
) -> TokenSet:
    scope = data.get("scope", " ".join(previous.scopes) if previous else None)
    if not isinstance(scope, str):
        raise OAuthError("invalid_token_response")
    scopes = tuple(dict.fromkeys(scope.split()))
    if not all(_SCOPE.fullmatch(item) for item in scopes):
        raise OAuthError("invalid_token_response")

    access = data.get("access_token")
    refresh = data.get("refresh_token")
    requires_access = previous is not None or bool({"offline_access", "chatgpt.tokens.use.direct"}.intersection(scopes))
    requires_refresh = previous is not None or "offline_access" in scopes
    if (
        (access is None and requires_access)
        or (access is not None and (not isinstance(access, str) or not _BEARER.fullmatch(access)))
        or (refresh is None and requires_refresh)
        or (refresh is not None and (not _valid_text(refresh) or access is None))
        or (previous is not None and refresh == previous.refresh_token)
    ):
        raise OAuthError("invalid_token_response")
    expires_in = expires_at = token_type = None
    if access is not None:
        expires_in = data.get("expires_in")
        token_type = data.get("token_type")
        if (
            not isinstance(token_type, str) or token_type.lower() != "bearer"
            or type(expires_in) is not int or expires_in <= 0
        ):
            raise OAuthError("invalid_token_response")
        try:
            expires_at = received_at + expires_in
        except OverflowError:
            raise OAuthError("invalid_token_response") from None
        if not math.isfinite(expires_at):
            raise OAuthError("invalid_token_response")
        token_type = "Bearer"

    if previous is not None and "id_token" not in data:
        id_token, subject, email = previous.id_token, previous.subject, previous.email
    else:
        id_token = data.get("id_token")
        if not isinstance(id_token, str) or not id_token:
            raise OAuthError("invalid_id_token")
        claims = await _verify_id_token(
            http, id_token, client_id=client_id, nonce=nonce, access_token=access,
            received_at=received_at, keys=keys,
        )
        subject = claims["sub"]
        if expected_subject is not None and subject != expected_subject:
            raise OAuthError("account_mismatch")
        # Email is display/hint data only, never the account identity.
        email = claims.get("email")
        if not _valid_text(email):
            email = None
    return TokenSet(
        client_id, subject, email, ISSUER, id_token, access, refresh, token_type,
        expires_in, scopes, expires_at, _earliest_refresh(data),
    )


async def exchange_code(
    http: httpx.AsyncClient, attempt: AuthorizationAttempt, authorization_code: AuthorizationCode,
) -> TokenSet:
    """Exchange a parsed callback; consume the session attempt once in the caller."""
    if authorization_code._state != attempt.state:
        raise OAuthError("invalid_state")
    if not _valid_client_id(authorization_code.client_id) or (
        attempt.client_id != DYNAMIC_CLIENT_ID and authorization_code.client_id != attempt.client_id
    ):
        raise OAuthError("client_mismatch")
    data = await _token_request(http, {
        "grant_type": "authorization_code", "client_id": authorization_code.client_id,
        "code": authorization_code.code, "code_verifier": attempt.code_verifier,
        "redirect_uri": attempt.redirect_uri, "resource": RESOURCE,
    })
    return await _validated_tokens(
        http, data, client_id=authorization_code.client_id, received_at=time.time(),
        nonce=attempt.nonce, expected_subject=attempt.expected_subject,
    )


async def exchange_callback(
    http: httpx.AsyncClient, attempt: AuthorizationAttempt, callback_query: str,
) -> TokenSet:
    return await exchange_code(http, attempt, parse_callback(attempt, callback_query))


async def refresh_tokens(http: httpx.AsyncClient, tokens: TokenSet) -> TokenSet:
    """Renew a verified session; caller serializes and atomically persists rotation."""
    if not _valid_client_id(tokens.client_id):
        raise OAuthError("invalid_client")
    if not tokens.refresh_token:
        raise OAuthError("invalid_grant")
    if tokens.earliest_refresh_at is not None and time.time() < tokens.earliest_refresh_at:
        raise OAuthError("refresh_not_ready", retryable=True)
    # Avoid rotating a grant during a known JWKS outage. This fresh snapshot
    # is reused if the refresh response includes an optional new ID token.
    keys = await _jwks(http)
    data = await _token_request(http, {
        "grant_type": "refresh_token", "client_id": tokens.client_id,
        "refresh_token": tokens.refresh_token, "resource": RESOURCE,
    })
    try:
        return await _validated_tokens(
            http, data, client_id=tokens.client_id, received_at=time.time(),
            expected_subject=tokens.subject, previous=tokens, keys=keys,
        )
    except OAuthError as exc:
        if exc.code == "identity_verification_unavailable":
            # A rotation already succeeded. Without a secure checkpoint, the
            # caller must reauthorize rather than retrying the spent refresh token.
            raise OAuthError("refresh_identity_unverified") from None
        raise


def _is_auth_endpoint(value: object) -> bool:
    if not isinstance(value, str) or not value.startswith(f"{ISSUER}/"):
        return False
    parsed = urlsplit(value)
    return (
        parsed.scheme == "https" and parsed.netloc == "auth.openai.com" and bool(parsed.path)
        and not parsed.query and not parsed.fragment
        and all(ch.isascii() and ch.isprintable() and not ch.isspace() and ch != "\\" for ch in value)
    )


async def revoke_refresh_token(http: httpx.AsyncClient, *, client_id: str, refresh_token: str) -> None:
    """Revoke using pinned OpenAI discovery. Caller owns bounded retry/backoff."""
    if not _valid_client_id(client_id):
        raise OAuthError("invalid_client")
    if not _valid_text(refresh_token):
        raise OAuthError("invalid_grant")
    discovery = await _request(http, "GET", DISCOVERY_URL)
    config = _json_payload(discovery)
    endpoint = config.get("revocation_endpoint")
    if discovery.status_code != 200:
        raise _provider_error(None, fallback="discovery_failed", status=discovery.status_code)
    if config.get("issuer") != ISSUER or not _is_auth_endpoint(endpoint):
        raise OAuthError("discovery_failed")
    response = await _request(http, "POST", endpoint, data={
        "token": refresh_token, "token_type_hint": "refresh_token", "client_id": client_id,
    })
    if response.status_code != 200:
        raise _provider_error(None, fallback="revocation_failed", status=response.status_code)
