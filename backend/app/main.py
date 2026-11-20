from __future__ import annotations

from .branding import env
from contextlib import asynccontextmanager, suppress
import asyncio
import os
from pathlib import Path
from typing import Any
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from .config import get_settings
from .auth import current_user
from .workspace import ensure_workspace, use_workspace
from .version import APP_VERSION
from .api import router as api_router
from .api.system import startup
from .redaction import install_log_redaction

# Before anything logs: exception chains can carry upstream text that echoes keys.
install_log_redaction()


BACKEND_DIR = Path(__file__).resolve().parents[1]

FRONTEND_DIST_DIR = BACKEND_DIR.parent / "frontend" / "dist"

_settings = get_settings()

@asynccontextmanager
async def lifespan(_: FastAPI):
    startup()
    from .channels.weixin.manager import manager
    manager.restore()
    from .jobs.worker import JobWorkerManager
    from .jobs.service import job_service
    from .presentations.worker import register_preparation_handler
    register_preparation_handler(job_service)
    from .library.source_backfill import enqueue_pending_backfills, register_backfill_handler
    from .extensions.contracts import ExtensionContext
    from .workspace import list_user_ids
    register_backfill_handler(job_service)
    from .library.document_review import register_document_review_handler
    register_document_review_handler(job_service)
    from .artifacts.document_export import register_export_handler
    register_export_handler(job_service)
    for user_id in list_user_ids():
        with use_workspace(user_id, ensure_workspace(user_id)):
            enqueue_pending_backfills(ExtensionContext.current(), job_service)
    job_manager = JobWorkerManager(job_service)
    job_manager.start()
    from .api.presentations import maintain_confirmation_servers
    confirmation_maintenance = asyncio.create_task(maintain_confirmation_servers())
    from .agent.kernels.dsh.adapter import close_dsh_runtime, reap_idle_dsh_sessions

    async def maintain_dsh_runtime() -> None:
        while True:
            await asyncio.sleep(60)
            reap_idle_dsh_sessions()

    dsh_maintenance = asyncio.create_task(maintain_dsh_runtime())
    try:
        yield
    finally:
        from .api.presentations import confirmation_sessions, confirmation_servers
        confirmation_maintenance.cancel()
        dsh_maintenance.cancel()
        with suppress(asyncio.CancelledError):
            await confirmation_maintenance
        with suppress(asyncio.CancelledError):
            await dsh_maintenance
        confirmation_sessions.close_all()
        await confirmation_servers.close_all()
        await close_dsh_runtime()
        await job_manager.close()
        await manager.close()

app = FastAPI(
    title="团团 API",
    version=APP_VERSION,
    docs_url="/docs" if _settings.api_docs_enabled else None,
    redoc_url="/redoc" if _settings.api_docs_enabled else None,
    openapi_url="/openapi.json" if _settings.api_docs_enabled else None,
    lifespan=lifespan,
)

_OPEN_AUTH_PATHS = {
    "/health",
    "/auth/config",
    "/auth/bootstrap",
    "/auth/login",
    "/auth/register",
    "/auth/qq/start",
    "/auth/qq/callback",
    "/api/auth/qq/callback",
    "/auth/qq/finish",
}

_DOC_PATHS = {"/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"}

_REQUIRE_LOGIN_WHITELIST = _OPEN_AUTH_PATHS | (_DOC_PATHS if _settings.api_docs_enabled else set())

_PUBLIC_FRONTEND_FILES = {
    "/favicon.ico",
    "/vite.svg",
    "/tuantuan-legacy-mark-v2.png",
    "/tuantuan-logo.png",
    "/tuantuan-favicon.png",
    "/tuantuan-legacy-icon-v1.png",
    "/tuantuan-legacy-mark-v1.png",
    "/tuantuan-legacy-favicon-v1.png",
    "/intro-surface-v1.webp",
    "/auth-companion-cutout.webp",
    # These bundled, non-user-specific presets are loaded by <img> and fetch
    # without bearer tokens. Keep the allowlist exact rather than exposing the
    # entire avatars directory.
    "/avatars/nailong-cheer.svg",
    "/avatars/nailong-chef.svg",
    "/avatars/nailong-cool.svg",
    "/avatars/nailong-flower.svg",
    "/avatars/nailong-music.svg",
    "/avatars/nailong-sleep.svg",
    "/avatars/nailong-smile.svg",
    "/avatars/nailong-snack.svg",
    "/avatars/nailong-space.svg",
    "/avatars/nailong-study.svg",
    "/avatars/nailong-surprise.svg",
    "/avatars/nailong-wink.svg",
}

_STATIC_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"

def static_asset_cache_control(path: str) -> str | None:
    """Return the safe long-lived cache policy for Vite's content-hashed assets."""
    return _STATIC_ASSET_CACHE_CONTROL if path.startswith("/assets/") else None

# Baseline hardening for every response. The app renders model-authored Markdown
# and Mermaid in the same origin, so script execution stays local: only bundled
# chunks plus WebAssembly (pdf.js ships quickjs-eval.wasm for JBIG2/OpenJPEG).
# Google Fonts are linked from index.html; blob:/data: cover URL.createObjectURL
# previews; remote https images stay allowed because feed covers and Markdown
# images are third-party content that cannot execute script.
# Cloudflare Web Analytics injects its beacon script automatically when the site
# is proxied; allow only that exact script path (its versioned suffix is a path
# prefix match) while beacons still POST to the same-origin /cdn-cgi/rum.
_CONTENT_SECURITY_POLICY = (
    "default-src 'self'; "
    "script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com/beacon.min.js; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' data: https://fonts.gstatic.com; "
    "img-src 'self' data: blob: https:; "
    "connect-src 'self'; "
    "worker-src 'self' blob:; "
    "frame-src 'self'; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)

# Swagger UI and ReDoc load their bundles from a CDN and bootstrap with an inline
# script, so the strict policy above blanks them. They are loopback-only developer
# tooling (API_DOCS_ENABLED is off for non-loopback binds), so they get a narrower
# exception instead of weakening the policy the product UI runs under.
_DOCS_CONTENT_SECURITY_POLICY = (
    "default-src 'none'; "
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; "
    "img-src 'self' data: https://fastapi.tiangolo.com; "
    "font-src 'self' data: https://fonts.gstatic.com; "
    "connect-src 'self'; "
    "worker-src 'self' blob:; "
    "object-src 'none'; "
    "base-uri 'self'; "
    "form-action 'self'; "
    "frame-ancestors 'none'"
)

_SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": _CONTENT_SECURITY_POLICY,
}

_DOCS_SECURITY_HEADERS = {
    **_SECURITY_HEADERS,
    "Content-Security-Policy": _DOCS_CONTENT_SECURITY_POLICY,
}

@app.middleware("http")
async def require_login(request: Request, call_next: Any) -> Any:
    path = request.url.path
    maintenance_file = env("TUANTUAN_MAINTENANCE_FILE", "")
    if maintenance_file and Path(maintenance_file).is_file() and path != "/health":
        return JSONResponse(
            status_code=503,
            content={"detail": "团团正在更新，请稍后重试"},
            headers={"Cache-Control": "no-store", "Retry-After": "30"},
        )
    is_frontend_asset = path == "/" or path.startswith("/assets/") or path in _PUBLIC_FRONTEND_FILES
    if request.method == "OPTIONS" or is_frontend_asset or path in _REQUIRE_LOGIN_WHITELIST:
        response = await call_next(request)
        if path.startswith(("/auth/", "/api/auth/qq/")):
            response.headers["Cache-Control"] = "no-store"
        cache_control = static_asset_cache_control(path)
        if request.method in {"GET", "HEAD"}:
            if path == "/":
                # Never cache the entry document: CDNs can otherwise apply a
                # default TTL and keep references to a previous deployment.
                response.headers["Cache-Control"] = "no-store"
            elif cache_control:
                # A CDN can otherwise cache a transient missing chunk and make
                # it unavailable even after the deployment has completed.
                response.headers["Cache-Control"] = (
                    cache_control if response.status_code in {200, 206, 304} else "no-store"
                )
        return response
    from .api.presentations import (
        confirmation_request_scope, is_confirmation_bootstrap, is_confirmation_landing, is_confirmation_request,
    )
    if is_confirmation_landing(request):
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    if is_confirmation_bootstrap(request):
        # The endpoint consumes a body-only, one-use ticket and establishes its
        # own workspace. It cannot authenticate any other endpoint.
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response
    if is_confirmation_request(request):
        try:
            scope = confirmation_request_scope(request)
        except PermissionError as exc:
            return JSONResponse(status_code=403, content={"detail": str(exc)},
                                headers={"Cache-Control": "no-store"})
        with use_workspace(scope.user_id, ensure_workspace(scope.user_id)):
            response = await call_next(request)
            response.headers["Cache-Control"] = "no-store"
            response.headers["Referrer-Policy"] = "no-referrer"
            response.headers["X-Content-Type-Options"] = "nosniff"
            return response
    try:
        user = current_user(request.headers.get("Authorization"))
    except HTTPException as exc:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail},
                            headers={**(exc.headers or {}), "Cache-Control": "no-store"})
    root = ensure_workspace(int(user["id"]))
    with use_workspace(int(user["id"]), root):
        response = await call_next(request)
        if path.startswith("/auth/"):
            response.headers["Cache-Control"] = "no-store"
        return response

app.add_middleware(
    CORSMiddleware,
    allow_origins=_settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Retry-After"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next: Any) -> Any:
    """Attach hardening headers to every response, including rejected requests.

    Registered after CORSMiddleware, so Starlette builds it as the outermost
    user middleware: responses produced without calling a handler (maintenance
    503, login 401/403, CORS preflight) still pass through here. Handlers keep
    priority, so the PPT confirmation surface retains its narrower CSP and its
    deliberate SAMEORIGIN framing policy.
    """
    response = await call_next(request)
    headers = _DOCS_SECURITY_HEADERS if request.url.path in _DOC_PATHS else _SECURITY_HEADERS
    for name, value in headers.items():
        response.headers.setdefault(name, value)
    return response

app.include_router(api_router)

if FRONTEND_DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_DIR, html=True), name="frontend")
