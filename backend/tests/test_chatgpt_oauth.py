import asyncio
import base64
import hashlib
import json
from dataclasses import replace
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app import chatgpt_oauth as oauth

NOW = 1_800_000_000
HOST_ID = "urn:uuid:12345678-1234-4123-8123-123456789abc"
REDIRECT = "http://127.0.0.1:54321/auth/callback"
CLIENT_ID = "oaiapp_test-client"
SUBJECT = "test-subject"
CODE = "synthetic-authorization-code"
ACCESS = "synthetic-access-token"
REFRESH = "synthetic-refresh-token"
REVOKE = "https://auth.openai.com/api/accounts/oauth/revoke"


def b64(data):
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


@pytest.fixture(scope="module")
def signing_key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(oauth, "time", type("Clock", (), {"time": staticmethod(lambda: NOW)}))


def begin(**kwargs):
    return oauth.begin_authorization(**{
        "redirect_uri": REDIRECT, "host_id": HOST_ID, "agent_name": "团团 (TuanTuan)", **kwargs,
    })


def callback(attempt, **params):
    return urlencode({"state": attempt.state, "code": CODE, "client_id": CLIENT_ID, **params})


def jwt(key, attempt, *, claims=None, header=None, access_token=ACCESS):
    params = {
        "iss": oauth.ISSUER, "aud": [CLIENT_ID], "sub": SUBJECT,
        "nonce": attempt.nonce, "iat": NOW - 2, "exp": NOW + 3600,
        "email": "demo@example.test", "email_verified": False,
    }
    if access_token is not None:
        params["at_hash"] = b64(hashlib.sha256(access_token.encode("ascii")).digest()[:16])
    params.update(claims or {})
    segments = [b64(json.dumps(obj).encode()) for obj in (
        {"kid": "test-key", "alg": "RS256", **(header or {})}, params,
    )]
    signing_input = ".".join(segments).encode()
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return ".".join([*segments, b64(signature)])


def jwk(key, **overrides):
    public = key.public_key().public_numbers()

    def encoded_int(number):
        return b64(number.to_bytes((number.bit_length() + 7) // 8, "big"))

    return {
        "kid": "test-key", "kty": "RSA", "use": "sig", "alg": "RS256",
        "n": encoded_int(public.n), "e": encoded_int(public.e), **overrides,
    }


def token_response(issued_id_token=None, **overrides):
    result = {
        "access_token": ACCESS, "refresh_token": REFRESH, "token_type": "bearer",
        "expires_in": 3600, "scope": " ".join(oauth.REQUESTED_SCOPES), **overrides,
    }
    if issued_id_token is not None:
        result["id_token"] = issued_id_token
    return result


def form(request):
    assert request.method == "POST"
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    assert "authorization" not in request.headers
    return {name: values[0] for name, values in parse_qs(request.content.decode()).items()}


def run_http(operation, handler):
    async def run():
        # Deliberately enable redirects on the test client to assert protocol override.
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as http:
            return await operation(http)

    return asyncio.run(run())


def test_begin_dynamic_authorization_passes_official_parameters():
    first, second = begin(), begin()
    url = urlsplit(first.authorization_url)
    assert (url.scheme, url.netloc, url.path) == ("https", "auth.openai.com", "/api/accounts/authorize")
    params = parse_qs(url.query)
    assert params == {
        "client_id": ["dynamic_agent_client"], "ext_agent_host_id": [HOST_ID],
        "agent_name_hint": ["团团 (TuanTuan)"], "response_type": ["code"],
        "redirect_uri": [REDIRECT], "resource": ["https://api.openai.com/v1"],
        "scope": ["openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"],
        "state": [first.state], "nonce": [first.nonce], "code_challenge_method": ["S256"],
        "code_challenge": [b64(hashlib.sha256(first.code_verifier.encode()).digest())],
    }
    assert len({first.state, first.nonce, first.code_verifier, second.state, second.nonce, second.code_verifier}) == 6
    assert 43 <= len(first.code_verifier) <= 128
    assert first.state not in repr(first) and first.code_verifier not in repr(first)


def test_returning_sign_in_uses_same_host_and_issued_client_without_forcing_consent():
    attempt = begin(
        redirect_uri="http://127.0.0.1:1455/auth/callback", client_id=CLIENT_ID,
        expected_subject=SUBJECT, login_hint="user+work@example.test", id_token_hint="retained.id.token",
    )
    params = parse_qs(urlsplit(attempt.authorization_url).query)
    assert params["ext_agent_host_id"] == [HOST_ID]
    assert params["client_id"] == [CLIENT_ID]
    assert params["redirect_uri"] == [attempt.redirect_uri]
    assert params["login_hint"] == ["user+work@example.test"]
    assert params["id_token_hint"] == ["retained.id.token"]
    assert "agent_name_hint" not in params and "prompt" not in params
    assert "retained.id.token" not in repr(attempt)
    consent = begin(client_id=CLIENT_ID, reconsent=True)
    assert parse_qs(urlsplit(consent.authorization_url).query)["prompt"] == ["consent"]


@pytest.mark.parametrize("uri", [
    "http://localhost:1455/auth/callback", "http://127.0.0.1:1455/callback",
    "http://[::1]:1455/auth/callback", "https://127.0.0.1:1455/auth/callback",
    "http://127.0.0.1:65536/auth/callback", "http://127.0.0.1:0/auth/callback",
    "http://127.0.0.1:1455/auth/callback#fragment", "http://127.0.0.1:1455/auth/callback?x=1",
])
def test_callback_uri_rejects_wrong_endpoint(uri):
    with pytest.raises(oauth.OAuthError) as caught:
        begin(redirect_uri=uri)
    assert caught.value.code == "invalid_redirect_uri"


@pytest.mark.parametrize(("suffix", "error"), [
    ("&state=duplicate", "invalid_state"), ("&code=duplicate", "invalid_callback"),
    ("&client_id=oaiapp_other", "invalid_callback"), ("&error=access_denied", "access_denied"),
    ("&error=not_a_known_error&error_description=raw-result-must-not-escape", "authorization_failed"),
])
def test_invalid_states_errors_and_duplicate_callback_fields_prevent_token_exchange(suffix, error):
    attempt = begin()
    query = callback(attempt) + suffix
    with pytest.raises(oauth.OAuthError) as caught:
        run_http(lambda http: oauth.exchange_callback(http, attempt, query), lambda request: pytest.fail(request.url))
    assert caught.value.code == error
    assert CODE not in str(caught.value) and "raw-result-must-not-escape" not in str(caught.value)


def test_callback_checks_state_before_oauth_error_and_requires_issued_client_id():
    attempt = begin()
    for query, error in [
        ("error=access_denied&state=wrong", "invalid_state"),
        ("error=access_denied&state=%E6%B5%8B", "invalid_state"),
        (f"state={attempt.state}&code={CODE}", "registration_incomplete"),
        (callback(attempt, client_id="dynamic_agent_client"), "registration_incomplete"),
    ]:
        with pytest.raises(oauth.OAuthError) as caught:
            oauth.parse_callback(attempt, query)
        assert caught.value.code == error

    returning = begin(client_id=CLIENT_ID, expected_subject=SUBJECT)
    parsed = oauth.parse_callback(returning, f"state={returning.state}&code={CODE}")
    assert parsed.client_id == CLIENT_ID and CODE not in repr(parsed)
    with pytest.raises(oauth.OAuthError) as caught:
        oauth.parse_callback(returning, callback(returning, client_id="oaiapp_other"))
    assert caught.value.code == "client_mismatch"
    with pytest.raises(oauth.OAuthError) as caught:
        run_http(lambda http: oauth.exchange_code(http, attempt, parsed), lambda request: pytest.fail(request.url))
    assert caught.value.code == "invalid_state"


def test_code_exchange_verifies_identity_and_uses_token_scope_not_callback_scope(signing_key):
    attempt = begin()
    identity = jwt(signing_key, attempt)
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if str(request.url) == "https://auth.openai.com/api/accounts/oauth/token":
            assert form(request) == {
                "grant_type": "authorization_code", "client_id": CLIENT_ID, "code": CODE,
                "code_verifier": attempt.code_verifier, "redirect_uri": REDIRECT,
                "resource": "https://api.openai.com/v1",
            }
            return httpx.Response(200, json=token_response(identity, earliest_refresh_at="2027-01-15T09:00:00Z"))
        assert str(request.url) == "https://auth.openai.com/.well-known/jwks.json"
        return httpx.Response(200, json={"keys": [jwk(signing_key)]})

    tokens = run_http(lambda http: oauth.exchange_callback(http, attempt, callback(attempt, scope="openid")), handler)
    assert seen == [oauth.TOKEN_URL, oauth.JWKS_URL]
    assert (tokens.client_id, tokens.subject, tokens.issuer, tokens.email) == (CLIENT_ID, SUBJECT, oauth.ISSUER, "demo@example.test")
    assert tokens.plan_enabled and tokens.scopes == oauth.REQUESTED_SCOPES
    assert tokens.access_token == ACCESS and tokens.refresh_token == REFRESH and tokens.id_token == identity
    assert tokens.token_type == "Bearer" and tokens.expires_at == NOW + 3600
    assert tokens.earliest_refresh_at == NOW + 3600
    assert all(value not in repr(tokens) for value in (ACCESS, REFRESH, identity, SUBJECT, tokens.email))


@pytest.mark.parametrize(("data", "expected_plan"), [
    ({"scope": "openid profile email", "access_token": None, "refresh_token": None}, False),
    ({"scope": "openid profile email resource.invoke", "refresh_token": None}, False),
    ({"scope": "openid chatgpt.tokens.use.direct", "refresh_token": None}, False),
    ({"scope": "openid chatgpt.tokens.use.direct resource.invoke", "refresh_token": None}, True),
])
def test_identity_only_and_partial_grants_do_not_enable_plan(signing_key, data, expected_plan):
    attempt = begin()
    identity = jwt(signing_key, attempt, access_token=data.get("access_token", ACCESS))

    def handler(request):
        if str(request.url) == oauth.TOKEN_URL:
            return httpx.Response(200, json=token_response(identity, **data))
        return httpx.Response(200, json={"keys": [jwk(signing_key)]})

    tokens = run_http(lambda http: oauth.exchange_callback(http, attempt, callback(attempt, scope=" ".join(oauth.REQUESTED_SCOPES))), handler)
    assert tokens.subject == SUBJECT
    assert tokens.plan_enabled is expected_plan
    assert tokens.refresh_token is None
    if tokens.access_token is None:
        assert tokens.expires_at is None and tokens.token_type is None


@pytest.mark.parametrize(("claims", "header", "error"), [
    ({"iss": "https://elsewhere.test"}, {}, "invalid_id_token"),
    ({"aud": "oaiapp_other"}, {}, "invalid_id_token"),
    ({"aud": [CLIENT_ID, "oaiapp_other"]}, {}, "invalid_id_token"),
    ({"azp": "oaiapp_other"}, {}, "invalid_id_token"),
    ({"exp": NOW - 6, "iat": NOW - 10}, {}, "invalid_id_token"),
    ({"exp": True}, {}, "invalid_id_token"),
    ({"exp": None}, {}, "invalid_id_token"),
    ({"iat": NOW + 60}, {}, "invalid_id_token"),
    ({"nbf": NOW + 60}, {}, "invalid_id_token"),
    ({"nonce": "forged-nonce"}, {}, "invalid_id_token"),
    ({"sub": " "}, {}, "invalid_id_token"),
    ({"sub": "some-other-account"}, {}, "account_mismatch"),
    ({"at_hash": "wrong"}, {}, "invalid_id_token"),
    ({}, {"alg": "HS256"}, "invalid_id_token"),
    ({}, {"kid": "unknown-key", "jku": "https://evil.test/jwks"}, "invalid_id_token"),
    ({}, {"crit": ["b64"], "b64": False}, "invalid_id_token"),
])
def test_signed_identity_must_match_attempt_and_selected_account(signing_key, claims, header, error):
    attempt = begin(client_id=CLIENT_ID, expected_subject=SUBJECT)
    identity = jwt(signing_key, attempt, claims=claims, header=header)

    def handler(request):
        if str(request.url) == oauth.TOKEN_URL:
            return httpx.Response(200, json=token_response(identity))
        assert str(request.url) == oauth.JWKS_URL
        return httpx.Response(200, json={"keys": [jwk(signing_key)]})

    with pytest.raises(oauth.OAuthError) as caught:
        run_http(lambda http: oauth.exchange_callback(http, attempt, callback(attempt)), handler)
    assert caught.value.code == error
    assert identity not in str(caught.value)


def test_forged_signature_is_rejected(signing_key):
    attempt = begin()
    header, payload, _ = jwt(signing_key, attempt).split(".")
    forged = ".".join((header, payload, b64(b"\x01" * 256)))

    def handler(request):
        if str(request.url) == oauth.TOKEN_URL:
            return httpx.Response(200, json=token_response(forged))
        assert str(request.url) == oauth.JWKS_URL
        return httpx.Response(200, json={"keys": [jwk(signing_key)]})

    with pytest.raises(oauth.OAuthError, match="invalid_id_token"):
        run_http(lambda http: oauth.exchange_callback(http, attempt, callback(attempt)), handler)


@pytest.mark.parametrize("bad_fields", [
    {"scope": None}, {"expires_in": 0}, {"expires_in": True}, {"token_type": "Basic"},
    {"refresh_token": None}, {"access_token": None}, {"access_token": "not\na\nbearer"},
])
def test_incomplete_token_credentials_are_rejected_before_use(signing_key, bad_fields):
    attempt = begin()

    def handler(request):
        assert str(request.url) == oauth.TOKEN_URL
        return httpx.Response(200, json=token_response(jwt(signing_key, attempt), **bad_fields))

    with pytest.raises(oauth.OAuthError, match="invalid_token_response"):
        run_http(lambda http: oauth.exchange_callback(http, attempt, callback(attempt)), handler)


def tokens_before():
    return oauth.TokenSet(
        client_id=CLIENT_ID, subject=SUBJECT, email="before@example.test", issuer=oauth.ISSUER,
        id_token="verified-previous-id-token", access_token=ACCESS, refresh_token=REFRESH,
        token_type="Bearer", expires_in=3600, scopes=oauth.REQUESTED_SCOPES, expires_at=NOW + 30,
    )


def test_refresh_posts_only_public_grant_fields_and_replaces_credentials(signing_key):
    previous = tokens_before()
    new_access = "replacement-access-token"
    new_refresh = "replacement-refresh-token"
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if str(request.url) == oauth.JWKS_URL:
            return httpx.Response(200, json={"keys": [jwk(signing_key)]})
        assert str(request.url) == oauth.TOKEN_URL
        assert form(request) == {
            "grant_type": "refresh_token", "client_id": CLIENT_ID, "refresh_token": REFRESH,
            "resource": "https://api.openai.com/v1",
        }
        return httpx.Response(200, json={
            "access_token": new_access, "refresh_token": new_refresh, "token_type": "Bearer",
            "expires_in": 3600, "earliest_refresh_at": NOW + 2700,
        })

    updated = run_http(lambda http: oauth.refresh_tokens(http, previous), handler)
    assert seen == [oauth.JWKS_URL, oauth.TOKEN_URL]
    assert updated == replace(previous, access_token=new_access, refresh_token=new_refresh,
                              expires_at=NOW + 3600, earliest_refresh_at=NOW + 2700)


@pytest.mark.parametrize("subject", [SUBJECT, "other-subject"])
def test_refresh_rechecks_optional_new_identity_and_changed_scopes(signing_key, subject):
    previous = tokens_before()
    new_access = "replacement-access-token"
    new_id_token = jwt(signing_key, begin(), claims={"sub": subject}, access_token=new_access)

    def handler(request):
        if str(request.url) == oauth.JWKS_URL:
            return httpx.Response(200, json={"keys": [jwk(signing_key)]})
        assert str(request.url) == oauth.TOKEN_URL
        return httpx.Response(200, json=token_response(
            new_id_token, access_token=new_access, refresh_token="replacement-refresh-token", scope="openid",
        ))

    if subject != SUBJECT:
        with pytest.raises(oauth.OAuthError, match="account_mismatch"):
            run_http(lambda http: oauth.refresh_tokens(http, previous), handler)
    else:
        tokens = run_http(lambda http: oauth.refresh_tokens(http, previous), handler)
        assert tokens.id_token == new_id_token and not tokens.plan_enabled
        assert tokens.scopes == ("openid",)


def test_refresh_will_not_rotate_during_key_outage_or_retry_an_unverified_rotation(signing_key):
    previous = tokens_before()
    with pytest.raises(oauth.OAuthError) as caught:
        run_http(lambda http: oauth.refresh_tokens(http, previous), lambda request: httpx.Response(503))
    assert caught.value.retryable and caught.value.code == "identity_verification_unavailable"

    requests = []

    def handler(request):
        requests.append(str(request.url))
        if len(requests) == 1:
            return httpx.Response(200, json={"keys": [jwk(signing_key)]})
        if len(requests) == 2:
            return httpx.Response(200, json=token_response(
                jwt(signing_key, begin(), header={"kid": "rotated-key"}), refresh_token="replacement",
            ))
        return httpx.Response(503)

    with pytest.raises(oauth.OAuthError) as caught:
        run_http(lambda http: oauth.refresh_tokens(http, previous), handler)
    assert not caught.value.retryable and caught.value.code == "refresh_identity_unverified"
    assert requests == [oauth.JWKS_URL, oauth.TOKEN_URL, oauth.JWKS_URL]


def test_refresh_respects_vendor_earliest_refresh_time():
    tokens = replace(tokens_before(), earliest_refresh_at=NOW + 10)
    with pytest.raises(oauth.OAuthError) as caught:
        run_http(lambda http: oauth.refresh_tokens(http, tokens), lambda request: pytest.fail(request.url))
    assert caught.value.code == "refresh_not_ready" and caught.value.retryable


@pytest.mark.parametrize(("status", "payload", "code", "retryable"), [
    (400, {"error": "invalid_grant"}, "invalid_grant", False),
    (400, {"error": {"code": "refresh_token_reused", "message": "must-not-leak"}}, "refresh_token_reused", False),
    (500, {"error": "must-not-leak", "error_description": "must-not-leak"}, "token_request_failed", True),
    (307, {}, "token_request_failed", False),
])
def test_exchange_sanitizes_provider_errors_and_never_follows_redirect(status, payload, code, retryable):
    seen = []
    attempt = begin()

    def handler(request):
        seen.append(str(request.url))
        return httpx.Response(status, json=payload, headers={"location": "https://evil.test/"})

    with pytest.raises(oauth.OAuthError) as caught:
        run_http(lambda http: oauth.exchange_callback(http, attempt, callback(attempt)), handler)
    assert (caught.value.code, caught.value.retryable, caught.value.status_code) == (code, retryable, status)
    assert "must-not-leak" not in str(caught.value)
    assert seen == [oauth.TOKEN_URL]


def test_revoke_refresh_token_uses_verified_discovery_and_empty_200():
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if str(request.url) == oauth.DISCOVERY_URL:
            assert request.method == "GET"
            return httpx.Response(200, json={"issuer": oauth.ISSUER, "revocation_endpoint": REVOKE})
        assert str(request.url) == REVOKE
        assert form(request) == {"token": REFRESH, "token_type_hint": "refresh_token", "client_id": CLIENT_ID}
        return httpx.Response(200)

    run_http(lambda http: oauth.revoke_refresh_token(http, client_id=CLIENT_ID, refresh_token=REFRESH), handler)
    assert seen == [oauth.DISCOVERY_URL, REVOKE]


@pytest.mark.parametrize("endpoint", [
    "https://evil.test/oauth/revoke", "http://auth.openai.com/oauth/revoke",
    "https://auth.openai.com.evil.test/oauth/revoke", "https://auth.openai.com@evil.test/oauth/revoke",
    "https://auth.openai.com:444/oauth/revoke", "https://auth.openai.com/\\evil.test/oauth/revoke",
])
def test_revocation_rejects_noncanonical_discovery_endpoints(endpoint):
    def handler(request):
        assert str(request.url) == oauth.DISCOVERY_URL
        return httpx.Response(200, json={"issuer": oauth.ISSUER, "revocation_endpoint": endpoint})

    with pytest.raises(oauth.OAuthError, match="discovery_failed"):
        run_http(lambda http: oauth.revoke_refresh_token(http, client_id=CLIENT_ID, refresh_token=REFRESH), handler)


@pytest.mark.parametrize("timeout", [False, True])
def test_revocation_transient_failure_is_retryable_without_secret_details(timeout):
    def handler(request):
        if str(request.url) == oauth.DISCOVERY_URL:
            return httpx.Response(200, json={"issuer": oauth.ISSUER, "revocation_endpoint": REVOKE})
        assert str(request.url) == REVOKE
        if timeout:
            raise httpx.ReadTimeout("must-not-leak", request=request)
        return httpx.Response(503, text="must-not-leak")

    with pytest.raises(oauth.OAuthError) as caught:
        run_http(lambda http: oauth.revoke_refresh_token(http, client_id=CLIENT_ID, refresh_token=REFRESH), handler)
    assert caught.value.retryable
    assert caught.value.code == ("network_error" if timeout else "revocation_failed")
    assert "must-not-leak" not in str(caught.value)
