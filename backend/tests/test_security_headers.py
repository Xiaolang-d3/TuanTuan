"""Every response carries baseline security headers, rejected requests included."""
from __future__ import annotations

import re

from fastapi import FastAPI, Response
from fastapi.testclient import TestClient

from app.main import add_security_headers, app
from app.presentations.confirmation_proxy import SECURITY_HEADERS as CONFIRMATION_SECURITY_HEADERS

_BASELINE_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
}

_CONFIRMATION_JOB_ID = "a" * 32


def _assert_baseline_headers(response) -> None:
    for name, value in _BASELINE_HEADERS.items():
        assert response.headers[name] == value
    assert response.headers["Content-Security-Policy"]


def _content_security_policy(response) -> str:
    return response.headers["Content-Security-Policy"]


def test_health_response_carries_baseline_security_headers() -> None:
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    _assert_baseline_headers(response)


def test_unauthenticated_api_request_still_carries_security_headers() -> None:
    # The login middleware returns its own 401 JSON before any handler runs, so
    # this proves the header middleware wraps the rejection branches too.
    response = TestClient(app).get("/library")

    assert response.status_code == 401
    _assert_baseline_headers(response)
    # Existing per-branch headers must survive untouched.
    assert response.headers["Cache-Control"] == "no-store"
    assert response.headers["WWW-Authenticate"] == "Bearer"


def test_maintenance_mode_response_still_carries_security_headers(tmp_path, monkeypatch) -> None:
    flag = tmp_path / "maintenance"
    flag.touch()
    monkeypatch.setenv("TUANTUAN_MAINTENANCE_FILE", str(flag))

    response = TestClient(app).get("/library")

    assert response.status_code == 503
    _assert_baseline_headers(response)
    assert response.headers["Retry-After"] == "30"


def test_content_security_policy_declares_the_required_directives() -> None:
    policy = _content_security_policy(TestClient(app).get("/health"))

    for directive in (
        "default-src 'self'",
        "script-src 'self' 'wasm-unsafe-eval'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "worker-src 'self' blob:",
    ):
        assert directive in policy


def test_content_security_policy_grants_only_the_resources_the_app_uses() -> None:
    policy = _content_security_policy(TestClient(app).get("/health"))

    # Google Fonts are linked from index.html; blob:/data: serve avatars, generated
    # images and URL.createObjectURL previews.
    assert "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com" in policy
    assert "font-src 'self' data: https://fonts.gstatic.com" in policy
    assert "img-src 'self' data: blob:" in policy
    assert "connect-src 'self'" in policy


def test_content_security_policy_has_no_wildcard_sources() -> None:
    policy = _content_security_policy(TestClient(app).get("/health"))

    assert "*" not in policy
    assert "'unsafe-eval'" not in policy


def test_product_policy_allows_only_the_cloudflare_beacon_script() -> None:
    # Cloudflare Web Analytics injects one external script when the site is
    # proxied. It must stay the sole third-party script source; beacons still
    # POST to the same-origin /cdn-cgi/rum, so connect-src remains first-party.
    policy = _content_security_policy(TestClient(app).get("/health"))

    script_sources = re.search(r"script-src ([^;]+)", policy).group(1).split()
    assert script_sources == ["'self'", "'wasm-unsafe-eval'", "https://static.cloudflareinsights.com/beacon.min.js"]
    connect_sources = re.search(r"connect-src ([^;]+)", policy).group(1).split()
    assert connect_sources == ["'self'"]


def test_docs_policy_does_not_inherit_the_product_beacon_exception() -> None:
    fixture = FastAPI()
    fixture.middleware("http")(add_security_headers)

    @fixture.get("/docs")
    def docs() -> Response:
        return Response("<html></html>", media_type="text/html")

    policy = _content_security_policy(TestClient(fixture).get("/docs"))

    assert "cloudflareinsights.com" not in policy


def test_confirmation_landing_keeps_its_own_narrower_policy() -> None:
    response = TestClient(app).get(f"/presentations/{_CONFIRMATION_JOB_ID}/confirmation-open")

    assert response.status_code == 200
    # The landing page deliberately overrides the global CSP; SAMEORIGIN and
    # nosniff come from the shared confirmation header set and must survive.
    policy = _content_security_policy(response)
    assert policy.startswith("default-src 'none'")
    assert "script-src 'none'" in policy
    assert response.headers["X-Frame-Options"] == "SAMEORIGIN"
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "no-referrer"


def test_confirmation_document_keeps_sameorigin_framing_and_strict_csp() -> None:
    # The PPT confirmation document is framed by the app itself, so the global
    # DENY / frame-ancestors 'none' defaults must not overwrite its own values.
    fixture = FastAPI()
    fixture.middleware("http")(add_security_headers)

    @fixture.get("/confirmation")
    def confirmation_document() -> Response:
        return Response("<html></html>", media_type="text/html", headers=dict(CONFIRMATION_SECURITY_HEADERS))

    response = TestClient(fixture).get("/confirmation")

    assert response.status_code == 200
    assert response.headers["X-Frame-Options"] == "SAMEORIGIN"
    assert _content_security_policy(response) == CONFIRMATION_SECURITY_HEADERS["Content-Security-Policy"]
    assert "frame-ancestors 'self'" in _content_security_policy(response)


def test_api_docs_get_the_narrow_cdn_exception_not_the_product_policy() -> None:
    # Swagger UI ships its bundle from a CDN and bootstraps with an inline script.
    # Local installs enable /docs by default, so blanking it would be a regression;
    # the exception must stay scoped to the documentation paths.
    fixture = FastAPI()
    fixture.middleware("http")(add_security_headers)

    @fixture.get("/docs")
    def docs() -> Response:
        return Response("<html></html>", media_type="text/html")

    @fixture.get("/library")
    def product() -> Response:
        return Response("{}", media_type="application/json")

    client = TestClient(fixture)
    docs_policy = _content_security_policy(client.get("/docs"))
    product_policy = _content_security_policy(client.get("/library"))

    assert "https://cdn.jsdelivr.net" in docs_policy
    assert "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net" in docs_policy
    # The product surface keeps the strict policy: no CDN, no inline script.
    assert "cdn.jsdelivr.net" not in product_policy
    assert "script-src 'self' 'wasm-unsafe-eval'" in product_policy
    # Both still refuse framing and plugins.
    for policy in (docs_policy, product_policy):
        assert "frame-ancestors 'none'" in policy
        assert "object-src 'none'" in policy
