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
    try:
        yield
    finally:
        from .api.presentations import confirmation_sessions, confirmation_servers
        confirmation_maintenance.cancel()
        with suppress(asyncio.CancelledError):
            await confirmation_maintenance
        confirmation_sessions.close_all()
        await confirmation_servers.close_all()
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
}

_STATIC_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"

def static_asset_cache_control(path: str) -> str | None:
    """Return the safe long-lived cache policy for Vite's content-hashed assets."""
    return _STATIC_ASSET_CACHE_CONTROL if path.startswith("/assets/") else None

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
        if path.startswith("/auth/"):
            response.headers["Cache-Control"] = "no-store"
        cache_control = static_asset_cache_control(path)
        if cache_control and response.status_code == 200:
            response.headers["Cache-Control"] = cache_control
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

app.include_router(api_router)

if FRONTEND_DIST_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIST_DIR, html=True), name="frontend")
