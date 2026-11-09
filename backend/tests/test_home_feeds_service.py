from __future__ import annotations

import copy
import os
from datetime import datetime, timedelta, timezone
from threading import Event

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import workspace
from app.api.home import router
from app.feeds import benchmarks, market, service, sources


NOW = datetime(2026, 10, 8, 12, tzinfo=timezone.utc)
ARTICLE = {"id": "article:fixture", "title": "Agent SDK", "summary": "Tools update", "url": "https://openai.com/index/agent", "source": "OpenAI", "published_at": "2026-10-07T12:00:00Z", "category": "Agent", "tags": ["Agent"], "image_url": None}


@pytest.fixture
def home_workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(market, "enabled", lambda: False)
    monkeypatch.setattr(benchmarks, "configured", lambda: False)
    monkeypatch.setattr(service, "_public_cache", service.PublicSourceCache())
    monkeypatch.setattr(service, "_now", lambda: NOW)
    monkeypatch.setattr(service, "_running", set())
    monkeypatch.setattr(service, "_last_started", {})
    monkeypatch.setattr(sources, "fetch_source", lambda source: [copy.deepcopy(ARTICLE)] if source.kind == "news" else [])
    with workspace.use_workspace(101, tmp_path / "101") as root:
        yield root


@pytest.fixture
def immediate_refresh(monkeypatch):
    monkeypatch.setattr(workspace, "spawn_thread", lambda target, *, args, name: target(*args))


def test_get_returns_cold_snapshot_without_waiting_and_merges_requests(home_workspace, monkeypatch):
    runners = []
    monkeypatch.setattr(workspace, "spawn_thread", lambda target, *, args, name: runners.append(lambda: target(*args)))
    first = service.get_feed()
    assert first["refreshing"] is True
    assert first["news"] == []
    assert all(source["status"] == "loading" for source in first["sources"])
    service.get_feed()
    service.start_refresh(force=True)
    assert len(runners) == 1
    runners[0]()
    assert service.get_feed()["news"] == [ARTICLE]
    assert service.get_feed()["refreshing"] is False
    assert len(runners) == 1


def test_source_failure_keeps_cached_content_and_reports_error(home_workspace, immediate_refresh, monkeypatch):
    service.get_feed()
    monkeypatch.setattr(service, "_now", lambda: NOW + timedelta(hours=2))
    monkeypatch.setattr(sources, "fetch_source", lambda source: (_ for _ in ()).throw(httpx.ConnectError("private proxy message")))
    snapshot = service.get_feed()
    assert snapshot["news"] == [ARTICLE]
    assert snapshot["sources"][0]["status"] == "error"
    assert "private proxy" not in snapshot["sources"][0]["error"]
    assert snapshot["sources"][0]["last_success_at"] == "2026-10-08T12:00:00Z"
    assert snapshot["last_synced_at"] == "2026-10-08T12:00:00Z"


def test_error_cooldown_does_not_retry_on_every_poll(home_workspace, immediate_refresh, monkeypatch):
    called = []

    def fail(source):
        called.append(source.id)
        raise httpx.TimeoutException("offline")

    monkeypatch.setattr(sources, "fetch_source", fail)
    service.get_feed()
    service.get_feed()
    service.get_feed()
    assert len(called) == len(sources.configured_sources([]))
    monkeypatch.setattr(service, "_now", lambda: NOW + timedelta(minutes=6))
    service.get_feed()
    assert len(called) == 2 * len(sources.configured_sources([]))


def test_rate_limited_source_keeps_snapshot_and_surfaces_retry_message(home_workspace, immediate_refresh, monkeypatch):
    service.get_feed()
    monkeypatch.setattr(service, "_now", lambda: NOW + timedelta(hours=2))
    request = httpx.Request("GET", "https://openai.com/news/rss.xml")
    response = httpx.Response(429, request=request)

    def fetch(source):
        if source.kind == "news":
            raise httpx.HTTPStatusError("rate limited", request=request, response=response)
        return []

    monkeypatch.setattr(sources, "fetch_source", fetch)
    snapshot = service.get_feed()
    assert snapshot["news"] == [ARTICLE]
    assert snapshot["sources"][0]["status"] == "error"
    assert "请求受限" in snapshot["sources"][0]["error"]


def test_manual_refresh_has_cooldown_even_after_worker_finishes(home_workspace, immediate_refresh, monkeypatch):
    times = iter([1.0, 2.0, 45.0])
    monkeypatch.setattr(service.time, "monotonic", lambda: next(times))
    assert service.start_refresh(force=True) is True
    assert service.start_refresh(force=True) is False
    assert service.start_refresh(force=True) is True


def test_user_preferences_cache_and_states_are_isolated(home_workspace, immediate_refresh, tmp_path):
    service.get_feed()
    service.save_preferences(["Agent"], ["example/agent-sdk", "EXAMPLE/agent-sdk"])
    service.set_item_state(ARTICLE["id"], {"bookmarked": True})
    first = service.get_feed(refresh_if_due=False)
    with workspace.use_workspace(202, tmp_path / "202"):
        second = service.get_feed(refresh_if_due=False)
        assert second["news"] == []
        assert second["item_states"] == {}
        assert second["preferences"]["repositories"] == []
    assert first["preferences"] == {"topics": ["Agent"], "repositories": ["example/agent-sdk"], "digest_profile_id": ""}
    assert first["item_states"][ARTICLE["id"]] == {"bookmarked": True, "hidden": False}
    if os.name != "nt":
        assert (home_workspace / "home-feed.json").stat().st_mode & 0o777 == 0o600
    assert not list(home_workspace.glob(".home-feed-*.tmp"))


def test_real_background_thread_explicitly_binds_workspace(home_workspace, monkeypatch):
    done = Event()
    roots = []
    threads = []
    spawn = workspace.spawn_thread

    def tracked_spawn(*args, **kwargs):
        thread = spawn(*args, **kwargs)
        threads.append(thread)
        return thread

    monkeypatch.setattr(workspace, "spawn_thread", tracked_spawn)

    def fetch(source):
        roots.append(workspace.current_workspace_root())
        if source.id == "anthropic-engineering":
            done.set()
        return []

    monkeypatch.setattr(sources, "fetch_source", fetch)
    assert service.start_refresh()
    assert done.wait(3)
    threads[0].join(timeout=3)
    assert not threads[0].is_alive()
    assert roots == [home_workspace] * len(sources.configured_sources([]))


def test_slow_source_does_not_block_publishing_other_sources(home_workspace, monkeypatch):
    slow_started = Event()
    release_slow = Event()
    healthy_saved = Event()
    threads = []
    spawn = workspace.spawn_thread
    save = service._save

    def tracked_spawn(*args, **kwargs):
        thread = spawn(*args, **kwargs)
        threads.append(thread)
        return thread

    def fetch(source):
        assert workspace.current_workspace_root() == home_workspace
        if source.id == "openai-news":
            slow_started.set()
            assert release_slow.wait(3)
            raise httpx.ConnectTimeout("slow source")
        return []

    def tracked_save(root, payload):
        save(root, payload)
        if "github-day" in payload["source_cache"]:
            healthy_saved.set()

    monkeypatch.setattr(workspace, "spawn_thread", tracked_spawn)
    monkeypatch.setattr(sources, "fetch_source", fetch)
    monkeypatch.setattr(service, "_save", tracked_save)
    try:
        assert service.start_refresh()
        assert slow_started.wait(2)
        assert healthy_saved.wait(2)
        snapshot = service.get_feed(refresh_if_due=False)
        assert snapshot["refreshing"] is True
        statuses = {source["id"]: source for source in snapshot["sources"]}
        assert statuses["github-day"]["last_success_at"] is not None
        assert statuses["openai-news"]["last_success_at"] is None
    finally:
        release_slow.set()
        for thread in threads:
            thread.join(timeout=3)
    assert service.get_feed(refresh_if_due=False)["refreshing"] is False


def test_state_patch_does_not_drop_other_state_or_preferences(home_workspace, immediate_refresh):
    service.get_feed()
    service.set_item_state(ARTICLE["id"], {"bookmarked": True})
    updated = service.set_item_state(ARTICLE["id"], {"hidden": True})
    assert updated["item_states"][ARTICLE["id"]] == {"bookmarked": True, "hidden": True}
    service.set_item_state(ARTICLE["id"], {"bookmarked": False})
    updated = service.set_item_state(ARTICLE["id"], {"hidden": False})
    assert updated["item_states"] == {}
    assert updated["preferences"]["topics"] == ["AI", "Agent", "MCP"]


def test_undated_item_stays_null_old_news_is_not_latest(home_workspace, immediate_refresh, monkeypatch):
    undated = {**ARTICLE, "id": "undated", "published_at": None}
    old = {**ARTICLE, "id": "old", "published_at": "2025-01-01T12:00:00Z"}
    monkeypatch.setattr(sources, "fetch_source", lambda source: [undated, old] if source.kind == "news" else [])
    assert service.get_feed()["news"] == [undated]


def test_low_frequency_publisher_retains_latest_notices_with_original_dates():
    old = [{**ARTICLE, "id": f"older-{index}", "published_at": f"2026-08-0{index + 1}T12:00:00Z"} for index in range(5)]
    retained = service._recent_news(old, NOW)
    assert [item["id"] for item in retained] == ["older-4", "older-3", "older-2"]
    assert retained[0]["published_at"] == "2026-08-05T12:00:00Z"


def test_unsubscribing_during_refresh_cannot_restore_removed_repo(home_workspace, monkeypatch):
    runners = []
    monkeypatch.setattr(workspace, "spawn_thread", lambda target, *, args, name: runners.append(lambda: target(*args)))
    service.save_preferences(["Agent"], ["example/sdk"])
    service.save_preferences(["Agent"], [])
    runners[0]()
    payload = service._load(home_workspace)
    assert "release:example/sdk" not in payload["source_cache"]
    assert service.get_feed(refresh_if_due=False)["updates"] == []


def test_preferences_and_states_reject_unsupported_values(home_workspace, immediate_refresh):
    with pytest.raises(ValueError):
        service.save_preferences(["Unlisted"], [])
    with pytest.raises(ValueError):
        service.save_preferences(["AI"], ["https://github.com/example/sdk"])
    with pytest.raises(ValueError):
        service.set_item_state("unseen", {"bookmarked": "yes"})
    with pytest.raises(LookupError):
        service.set_item_state("unseen", {"bookmarked": True})


def test_api_routes_return_same_snapshot_and_validate_patch(home_workspace, immediate_refresh):
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        fetched = client.get("/home/feed")
        assert fetched.status_code == 200
        expected_keys = {"model_benchmarks", "model_news", "news", "repositories", "updates", "practices", "sources", "preferences", "item_states", "bookmarks", "refreshing", "last_synced_at", "digest", "curation"}
        assert set(fetched.json()) == expected_keys
        refreshed = client.post("/home/feed/refresh")
        assert refreshed.status_code == 200
        assert set(refreshed.json()) == expected_keys
        saved = client.put("/home/preferences", json={"topics": ["Agent"], "repositories": []})
        assert saved.json()["preferences"]["topics"] == ["Agent"]
        patched = client.patch(f"/home/feed/items/{ARTICLE['id']}/state", json={"bookmarked": True})
        assert patched.status_code == 200
        assert patched.json()["item_states"][ARTICLE["id"]]["bookmarked"] is True
        assert client.patch("/home/feed/items/unknown/state", json={"hidden": True}).status_code == 404
        assert client.patch(f"/home/feed/items/{ARTICLE['id']}/state", json={"bookmarked": "yes"}).status_code == 422
        assert client.patch(f"/home/feed/items/{ARTICLE['id']}/state", json={"bookmarked": None}).status_code == 422
        assert client.put("/home/preferences", json={"topics": ["fake"], "repositories": []}).status_code == 422
        assert client.put("/home/preferences", json={"topics": [], "repositories": [], "url": "http://localhost"}).status_code == 422


def test_bookmark_snapshot_survives_source_replacement_and_can_be_unbookmarked(home_workspace, immediate_refresh, monkeypatch):
    service.get_feed()
    bookmarked = service.set_item_state(ARTICLE["id"], {"bookmarked": True})
    assert bookmarked["bookmarks"] == [{"kind": "news", "item": ARTICLE}]
    monkeypatch.setattr(service, "_now", lambda: NOW + timedelta(days=10))
    monkeypatch.setattr(sources, "fetch_source", lambda source: [])
    changed = service.get_feed()
    assert changed["news"] == []
    assert changed["bookmarks"] == [{"kind": "news", "item": ARTICLE}]
    hidden = service.set_item_state(ARTICLE["id"], {"hidden": True})
    assert hidden["bookmarks"] == [{"kind": "news", "item": ARTICLE}]
    assert hidden["item_states"][ARTICLE["id"]] == {"bookmarked": True, "hidden": True}
    removed = service.set_item_state(ARTICLE["id"], {"bookmarked": False})
    assert removed["bookmarks"] == []
    assert removed["item_states"][ARTICLE["id"]] == {"bookmarked": False, "hidden": True}


def test_release_bookmark_survives_unsubscribing_from_repository(home_workspace, immediate_refresh, monkeypatch):
    release = {"id": "release:fixture", "repo": "example/sdk", "name": "v2", "version": "v2", "previous_version": "v1", "published_at": None, "changes": ["Tracing"], "compatibility": "review", "url": "https://github.com/example/sdk/releases/tag/v2"}
    monkeypatch.setattr(sources, "fetch_source", lambda source: [copy.deepcopy(release)] if source.kind == "stack" else [])
    service.save_preferences(["Agent"], ["example/sdk"])
    service.set_item_state(release["id"], {"bookmarked": True})
    updated = service.save_preferences(["Agent"], [])
    assert updated["updates"] == []
    assert updated["bookmarks"] == [{"kind": "stack", "item": release}]


def test_bookmarks_are_account_isolated(home_workspace, immediate_refresh, tmp_path):
    service.get_feed()
    service.set_item_state(ARTICLE["id"], {"bookmarked": True})
    with workspace.use_workspace(202, tmp_path / "202"):
        assert service.get_feed(refresh_if_due=False)["bookmarks"] == []
    assert service.get_feed(refresh_if_due=False)["bookmarks"] == [{"kind": "news", "item": ARTICLE}]


def test_large_personal_cache_preserves_bookmarks_beyond_old_limit(home_workspace):
    payload = service._empty()
    article = {**ARTICLE, "summary": "中文收藏" * 400_000}
    payload["bookmarked_items"][ARTICLE["id"]] = {"kind": "news", "item": article}
    payload["item_states"][ARTICLE["id"]] = {"bookmarked": True, "hidden": False}
    service._save(home_workspace, payload)
    assert (home_workspace / "home-feed.json").stat().st_size > 4 * 1024 * 1024
    assert service.get_feed(refresh_if_due=False)["bookmarks"][0]["item"] == article


def test_over_capacity_write_preserves_original_file(home_workspace, monkeypatch):
    payload = service._empty()
    service._save(home_workspace, payload)
    path = home_workspace / "home-feed.json"
    original = path.read_bytes()
    monkeypatch.setattr(service, "MAX_CACHE_BYTES", len(original) + 10)
    payload["bookmarked_items"]["large"] = {"summary": "中文" * 100}
    with pytest.raises(service.FeedCacheError):
        service._save(home_workspace, payload)
    assert path.read_bytes() == original


@pytest.mark.parametrize("content", [b"broken json", b'{"version":2}', b'{"version":1}'])
def test_unreadable_cache_is_reported_without_overwriting(home_workspace, content):
    home_workspace.mkdir(parents=True, exist_ok=True)
    path = home_workspace / "home-feed.json"
    path.write_bytes(content)
    app = FastAPI()
    app.include_router(router)
    with TestClient(app) as client:
        assert client.get("/home/feed").status_code == 503
        assert client.post("/home/feed/refresh").status_code == 503
        assert client.put("/home/preferences", json={"topics": [], "repositories": []}).status_code == 503
        assert client.patch("/home/feed/items/unknown/state", json={"bookmarked": True}).status_code == 503
    assert path.read_bytes() == content


def test_oversized_existing_cache_is_not_reinitialized(home_workspace, monkeypatch):
    service._save(home_workspace, service._empty())
    path = home_workspace / "home-feed.json"
    original = path.read_bytes()
    monkeypatch.setattr(service, "MAX_CACHE_BYTES", len(original) - 1)
    with pytest.raises(service.FeedCacheError):
        service.start_refresh(force=True)
    assert path.read_bytes() == original
