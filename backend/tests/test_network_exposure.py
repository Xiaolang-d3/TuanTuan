from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.testclient import TestClient

from app import auth, db
from app.config import Settings, get_settings
from app.main import FRONTEND_DIST_DIR, app, require_login, static_asset_cache_control


@pytest.fixture(autouse=True)
def isolated_database(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "exposure.db")
    db.init_db()
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_defaults_stay_on_loopback_with_docs_open(monkeypatch) -> None:
    for key in ("BIND_HOST", "PUBLIC_HOSTS", "ALLOWED_ORIGINS", "API_DOCS_ENABLED"):
        monkeypatch.delenv(key, raising=False)

    settings = get_settings()

    assert settings.bind_host == "127.0.0.1"
    assert settings.is_loopback_only is True
    assert settings.api_docs_enabled is True
    assert settings.allowed_origins == [
        "http://127.0.0.1:5173",
        "http://127.0.0.1:4173",
        "http://localhost:5173",
        "http://localhost:4173",
    ]


def test_exposed_bind_closes_docs_and_adds_named_origins(monkeypatch) -> None:
    monkeypatch.setenv("BIND_HOST", "0.0.0.0")
    monkeypatch.setenv("PUBLIC_HOSTS", "192.168.1.3")
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("API_DOCS_ENABLED", raising=False)

    settings = get_settings()

    assert settings.is_loopback_only is False
    # Docs describe every route, so exposure must not leak them by default.
    assert settings.api_docs_enabled is False
    assert "http://192.168.1.3:5173" in settings.allowed_origins
    assert "http://127.0.0.1:5173" in settings.allowed_origins


def test_unlisted_origin_is_not_allowed(monkeypatch) -> None:
    monkeypatch.setenv("BIND_HOST", "0.0.0.0")
    monkeypatch.setenv("PUBLIC_HOSTS", "192.168.1.3")

    origins = get_settings().allowed_origins

    assert "http://192.168.1.99:5173" not in origins
    assert "http://evil.example.com" not in origins


def test_explicit_allowed_origins_are_honoured(monkeypatch) -> None:
    monkeypatch.delenv("BIND_HOST", raising=False)
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://tuantuan.example.com")

    assert "https://tuantuan.example.com" in get_settings().allowed_origins


def test_login_locks_out_after_repeated_failures(monkeypatch) -> None:
    monkeypatch.setenv("LOGIN_MAX_ATTEMPTS", "3")
    auth.create_initial_user("owner@example.com", "a-long-test-password")

    for _ in range(3):
        with pytest.raises(Exception) as failure:
            auth.authenticate("owner@example.com", "wrong-password", client="192.168.1.9")
        assert getattr(failure.value, "status_code", None) == 401

    with pytest.raises(Exception) as locked:
        auth.authenticate("owner@example.com", "a-long-test-password", client="192.168.1.9")
    assert getattr(locked.value, "status_code", None) == 429

    with auth._connect_auth() as conn:
        stored = conn.execute("SELECT failure_count, locked_until FROM auth_login_attempts").fetchone()
    assert stored["failure_count"] == 3
    assert stored["locked_until"] > 0


def test_lockout_is_scoped_per_client(monkeypatch) -> None:
    monkeypatch.setenv("LOGIN_MAX_ATTEMPTS", "2")
    auth.create_initial_user("owner@example.com", "a-long-test-password")

    for _ in range(2):
        with pytest.raises(Exception):
            auth.authenticate("owner@example.com", "wrong", client="192.168.1.9")

    token = auth.authenticate(
        "owner@example.com", "a-long-test-password", client="127.0.0.1"
    )

    assert auth.current_user(f"Bearer {token}")["email"] == "owner@example.com"


def test_successful_login_clears_failure_counter(monkeypatch) -> None:
    monkeypatch.setenv("LOGIN_MAX_ATTEMPTS", "3")
    auth.create_initial_user("owner@example.com", "a-long-test-password")

    with pytest.raises(Exception):
        auth.authenticate("owner@example.com", "wrong", client="10.0.0.5")
    auth.authenticate("owner@example.com", "a-long-test-password", client="10.0.0.5")

    with auth._connect_auth() as conn:
        stored = conn.execute(
            "SELECT 1 FROM auth_login_attempts WHERE throttle_key = ?",
            (auth._throttle_key("owner@example.com", "10.0.0.5"),),
        ).fetchone()
    assert stored is None


def test_loopback_detection_covers_ipv6() -> None:
    assert Settings(bind_host="::1").is_loopback_only is True
    assert Settings(bind_host="0.0.0.0").is_loopback_only is False


def test_only_content_hashed_frontend_assets_receive_immutable_cache_policy() -> None:
    assert static_asset_cache_control("/assets/index-abc123.js") == "public, max-age=31536000, immutable"
    assert static_asset_cache_control("/") is None
    assert static_asset_cache_control("/auth/login") is None


def test_public_brand_asset_path_bypasses_login() -> None:
    client = TestClient(app)

    response = client.get("/tuantuan-legacy-mark-v2.png")
    expected_status = 200 if (FRONTEND_DIST_DIR / "tuantuan-legacy-mark-v2.png").is_file() else 404
    assert response.status_code == expected_status
    # tuantuan-mark.svg 已随品牌切换移除；白名单不应再放行不存在的文件。
    assert client.get("/tuantuan-mark.svg").status_code == 401


@pytest.mark.parametrize("filename", [
    "tuantuan-logo.png",
    "tuantuan-favicon.png",
    "tuantuan-legacy-icon-v1.png",
    "tuantuan-legacy-mark-v1.png",
    "tuantuan-legacy-favicon-v1.png",
    "intro-surface-v1.webp",
])
def test_current_public_images_load_without_authorization(tmp_path, filename: str) -> None:
    # Exercise the production middleware and a real static mount even when CI
    # has not built frontend/dist. Browsers do not attach bearer tokens to img.
    asset_content = b"public image fixture"
    (tmp_path / filename).write_bytes(asset_content)
    (tmp_path / "private.png").write_bytes(b"not a public asset")
    static_app = FastAPI()
    static_app.middleware("http")(require_login)
    static_app.mount("/", StaticFiles(directory=tmp_path), name="frontend")
    client = TestClient(static_app)

    response = client.get(f"/{filename}")

    assert response.status_code == 200
    assert response.content == asset_content
    assert response.headers["content-type"].startswith("image/")
    assert "immutable" not in response.headers.get("cache-control", "")
    assert client.get("/private.png").status_code == 401
    assert client.get("/library").status_code == 401


def test_deployment_maintenance_blocks_visitors_until_activation_finishes(tmp_path, monkeypatch):
    flag = tmp_path / "maintenance"
    flag.touch()
    monkeypatch.setenv("TUANTUAN_MAINTENANCE_FILE", str(flag))
    client = TestClient(app)

    for path in ("/", "/auth/config", "/library", "/tuantuan-legacy-icon-v1.png"):
        response = client.get(path)
        assert response.status_code == 503
        assert response.headers["retry-after"] == "30"
        assert response.headers["cache-control"] == "no-store"
    assert client.get("/health").status_code == 200
    assert client.post("/auth/register", json={"email": "new@example.com", "password": "a-long-test-password"}).status_code == 503
    flag.unlink()
    assert client.get("/auth/config").status_code == 200
