import io
import stat
import zipfile

import httpx
import pytest

from app import db
from app.extensions import discovery
from app.extensions.contracts import ExtensionContext
from app.extensions.repository import ExtensionRepository
from app.workspace import use_workspace

COMMIT = "a" * 40
SKILL = "---\nname: weekly-report\ndescription: 整理工作\n---\n先读取 references/format.md 再总结。"


def archive(entries=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        output.comment = COMMIT.encode()
        for path, body in (entries or [("repo/skills/report/SKILL.md", SKILL), ("repo/skills/report/references/format.md", "保留事实")]):
            output.writestr(path, body)
    return buffer.getvalue()


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "auth.db")
    with use_workspace(1, tmp_path / "one"):
        db.init_db()
        yield ExtensionContext.current()


def mock_network(monkeypatch, package=None, status=200):
    calls = []

    def handler(request):
        calls.append(str(request.url))
        if status != 200:
            return httpx.Response(status, request=request)
        if request.url.host == "skills.sh":
            return httpx.Response(200, json={"skills": [{"id": "acme/reports/weekly-report", "name": "weekly-report", "source": "acme/reports", "installs": 42}]})
        if request.url.host == "api.github.com":
            return httpx.Response(200, json={"sha": COMMIT})
        assert request.url.host == "codeload.github.com"
        return httpx.Response(200, content=package if package is not None else archive())

    monkeypatch.setattr(discovery, "_client", lambda: httpx.Client(transport=httpx.MockTransport(handler)))
    return calls


def test_search_preview_install_preserves_snapshot_resources_and_origin(scope, monkeypatch):
    calls = mock_network(monkeypatch)
    result = discovery.search("report", scope)
    assert result["skills"][0]["installs"] == 42
    assert result["skills"][0]["installed"] is False
    preview = discovery.preview("acme/reports", "main", "weekly-report", scope)
    assert preview["commit"] == COMMIT
    candidate = preview["skills"][0]
    assert candidate["content"].endswith("再总结。")
    assert candidate["files"] == ["references/format.md"]
    before = len(calls)
    item = discovery.install(preview["preview_id"], candidate["path"], scope)
    assert len(calls) == before  # Installation cannot fetch a changed branch.
    assert item["enabled"] is False and item["source"] == "github"
    assert item["origin"] == {"repository": "acme/reports", "commit": COMMIT, "path": "skills/report", "skill_id": "weekly-report"}
    assert ExtensionRepository().resource(item["id"], "references/format.md", scope).decode() == "保留事实"
    assert discovery.install(preview["preview_id"], candidate["path"], scope)["id"] == item["id"]
    assert discovery.search("report", scope)["skills"][0]["installed"] is True


def test_preview_reads_commit_from_archive_without_github_api_quota(scope, monkeypatch):
    calls = mock_network(monkeypatch)
    result = discovery.preview("acme/reports", "feature/report", None, scope)
    assert result["commit"] == COMMIT
    assert len(calls) == 1 and calls[0] == "https://codeload.github.com/acme/reports/zip/feature%2Freport"


def test_archive_without_commit_cannot_be_previewed(scope, monkeypatch):
    buffer = io.BytesIO(archive())
    with zipfile.ZipFile(buffer, "a") as output:
        output.comment = b""
    mock_network(monkeypatch, buffer.getvalue())
    with pytest.raises(ValueError, match="版本"):
        discovery.preview("acme/reports", None, None, scope)


def test_preview_is_scoped_expires_and_rejects_unlisted_paths(scope, monkeypatch, tmp_path):
    mock_network(monkeypatch)
    result = discovery.preview("https://github.com/acme/reports", None, None, scope)
    with pytest.raises(ValueError, match="预览"):
        discovery.install(result["preview_id"], "../secret", scope)
    with use_workspace(2, tmp_path / "two"):
        db.init_db()
        with pytest.raises(ValueError, match="预览"):
            discovery.install(result["preview_id"], "skills/report", ExtensionContext.current())
    monkeypatch.setattr(discovery.time, "time", lambda: result["expires_at"] + 1)
    with pytest.raises(ValueError, match="过期"):
        discovery.install(result["preview_id"], "skills/report", scope)


@pytest.mark.parametrize("source", ["https://evil.test/acme/reports", "https://github.com@localhost/acme/reports", "file:///etc/passwd", "acme/../reports", "https://github.com/acme/reports?token=secret"])
def test_source_validation_precedes_network(scope, monkeypatch, source):
    calls = mock_network(monkeypatch)
    with pytest.raises(ValueError):
        discovery.preview(source, None, None, scope)
    assert not calls


@pytest.mark.parametrize("entries", [
    [("repo/../SKILL.md", SKILL)],
    [("repo/skills/report/SKILL.md", SKILL), ("repo/skills/report/skill.md", "bad")],
    [("repo/SKILL.md", SKILL), ("repo/C:/secret", "bad")],
])
def test_unsafe_archives_rejected(scope, monkeypatch, entries):
    mock_network(monkeypatch, archive(entries))
    with pytest.raises(ValueError):
        discovery.preview("acme/reports", None, None, scope)


def test_symlinks_and_oversized_downloads_rejected(scope, monkeypatch):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as output:
        output.comment = COMMIT.encode()
        entry = zipfile.ZipInfo("repo/SKILL.md")
        entry.create_system = 3
        entry.external_attr = (stat.S_IFLNK | 0o777) << 16
        output.writestr(entry, "target")
    mock_network(monkeypatch, buffer.getvalue())
    with pytest.raises(ValueError):
        discovery.preview("acme/reports", None, None, scope)
    mock_network(monkeypatch)
    monkeypatch.setattr(discovery, "MAX_DOWNLOAD_BYTES", 10)
    with pytest.raises(ValueError, match="大小"):
        discovery.preview("acme/reports", None, None, scope)


@pytest.mark.parametrize("status, message", [(404, "不存在"), (429, "频繁"), (503, "暂时")])
def test_upstream_errors_are_not_empty_results(scope, monkeypatch, status, message):
    mock_network(monkeypatch, status=status)
    with pytest.raises(discovery.DiscoveryUnavailable, match=message):
        discovery.search("report", scope)


def test_nested_skills_are_independent_and_invalid_metadata_is_skipped(scope, monkeypatch):
    mock_network(monkeypatch, archive([
        ("repo/SKILL.md", SKILL), ("repo/references/guide.md", "guide"),
        ("repo/child/SKILL.md", SKILL.replace("weekly-report", "child")),
        ("repo/child/assets/a.txt", "asset"), ("repo/invalid/SKILL.md", "not a skill"),
    ]))
    result = discovery.preview("acme/reports", None, None, scope)
    root = next(item for item in result["skills"] if item["path"] == "")
    assert root["files"] == ["references/guide.md"]
    assert len(result["skills"]) == 2 and result["skipped"] == 1


def test_search_schema_errors_and_empty_results(scope, monkeypatch):
    monkeypatch.setattr(discovery, "_client", lambda: httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"skills": []}))))
    assert discovery.search("report", scope) == {"skills": []}
    monkeypatch.setattr(discovery, "_client", lambda: httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={"unexpected": []}))))
    with pytest.raises(discovery.DiscoveryUnavailable):
        discovery.search("report", scope)


@pytest.mark.parametrize("payload", [[], None, "invalid"])
def test_non_object_responses_are_upstream_errors(scope, monkeypatch, payload):
    monkeypatch.setattr(discovery, "_client", lambda: httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))))
    with pytest.raises(discovery.DiscoveryUnavailable, match="格式"):
        discovery.search("report", scope)


def test_account_preview_cache_keeps_only_three_snapshots(scope, monkeypatch):
    mock_network(monkeypatch)
    for _ in range(6):
        latest = discovery.preview("acme/reports", None, None, scope)
    assert len(list(discovery._cache_root(scope).glob("*.json"))) == 3
    assert discovery.install(latest["preview_id"], "skills/report", scope)["name"] == "weekly-report"
