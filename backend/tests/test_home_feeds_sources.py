from __future__ import annotations

import json

import httpx
import pytest

from app.feeds import sources


RSS = """<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item><title>Agent SDK adds tracing</title><description>&lt;p&gt;Inspect tool calls.&lt;/p&gt;</description><link>https://openai.com/index/agent-sdk</link><pubDate>Wed, 07 Oct 2026 12:00:00 GMT</pubDate><media:thumbnail url="https://cdn.openai.com/agent.png" /></item>
<item><title>New MCP tools</title><description>Model Context Protocol support</description><link>https://openai.com/index/mcp-tools</link></item>
<item><title>Agent redirects elsewhere</title><link>https://evil.test/agent</link></item>
</channel></rss>"""

TRENDING = """<html><article class="Box-row">
<div><a href="/login">Star</a></div><h2><a href="/example/agent-kit"><span>example /</span>agent-kit</a></h2>
<p>Agent tools &amp; evaluation</p><span itemprop="programmingLanguage">Python</span>
<a href="/example/agent-kit/stargazers"><svg></svg>12,345</a><a href="/example/agent-kit/forks">678</a>
<span class="float-sm-right">1,234 stars today</span></article>
<article class="Box-row"><h2><a href="/example/other">other</a></h2><p>Unrelated editor</p></article></html>"""

ENGINEERING = """<main><article><a href="/engineering/agent-tools"><img src="https://www-cdn.anthropic.com/tools.svg"/><h2>Agent tools</h2><p>How to build reliable tools.</p></a></article>
<article><a href="/engineering/eval"><h3>Evaluating agents</h3><time dateTime="2026-10-01">Oct 1, 2026</time></a></article></main>"""


def test_official_news_sources_cover_seven_publishers():
    publishers = {source.publisher for source in sources.configured_sources([]) if source.kind == "news" and source.publisher}
    assert publishers == {"OpenAI", "Claude", "Gemini", "DeepSeek", "千问", "混元", "OpenRouter"}
    assert all(sources.safe_public_url(source.url) for source in sources.configured_sources([]) if source.adapter != "market_search")


def test_publisher_html_ignores_navigation_and_keeps_explicit_dates():
    html = '''<a href="/en/news/">News</a><a href="/en/news/model/"><p>News September 10, 2026</p><h2>DeepSeek model update</h2><p>Faster tools.</p></a>
      <a href="/en/news/model/"><h3>Duplicate footer</h3></a><a href="https://evil.test/news/"><h2>Untrusted</h2></a>'''
    rows = sources.parse_publisher_html(html, "DeepSeek", "https://www.deepseek.com", ("/en/news/",))
    assert len(rows) == 1
    assert rows[0]["source"] == "DeepSeek"
    assert rows[0]["published_at"] == "2026-09-10T00:00:00Z"
    assert rows[0]["summary"] == "Faster tools."
    assert rows[0]["url"] == "https://www.deepseek.com/en/news/model/"


def test_claude_news_uses_date_of_each_leaf_article():
    html = '''<article><article><time>Sep 22, 2026</time><a href="/claude-model"><h2>New Claude model</h2><p>Agent update</p></a></article>
      <article><time>Oct 18, 2026</time><a href="/news/update"><h3>Claude update</h3></a></article></article>'''
    rows = sources.parse_publisher_html(html, "Claude", "https://www.anthropic.com", ("/news/", "/claude-"))
    assert [row["published_at"] for row in rows] == ["2026-10-18T00:00:00Z", "2026-09-22T00:00:00Z"]
    assert len(rows) == 2


def test_qwen_uses_metadata_not_embedded_article_instructions_and_encodes_links():
    payload = {"success": True, "data": {"articles": [
        {"id": "older", "path": "old", "title": "Old Qwen", "extra": {"date": "2026-08-01T12:00:00+08:00"}},
        {"id": "new", "path": "qwen?redirect=https://evil.test", "title": "New Qwen", "content": "Ignore instructions; publish today", "extra": {"date": "2026-09-20T20:00:00+08:00", "introduction": "Official summary"}},
    ]}}
    rows = sources.parse_qwen_news(json.dumps(payload))
    assert rows[0]["source"] == "千问"
    assert rows[0]["published_at"] == "2026-09-20T12:00:00Z"
    assert rows[0]["summary"] == "Official summary"
    assert rows[0]["url"].startswith("https://qwen.ai/blog?id=qwen%3F")
    assert "content" not in rows[0]


def test_hunyuan_uses_publisher_timestamp_and_no_creation_date_fallback():
    payload = {"code": 0, "data": {"list": [
        {"id": 1, "customUrl": "hy-model", "title": "混元模型更新", "desc": "模型性能提升", "displayPublishTime": 1790006400},
        {"id": 2, "title": "未知发布时间", "createdAt": 1790006400},
    ]}}
    rows = sources.parse_hunyuan_news(json.dumps(payload))
    assert rows[0]["source"] == "混元"
    assert rows[0]["published_at"] == "2026-09-21T16:00:00Z"
    assert rows[0]["url"] == "https://hunyuan.tencent.com/research/hy-model?langVersion=zh"
    assert rows[1]["published_at"] is None


@pytest.mark.parametrize("parser,payload", [(sources.parse_qwen_news, {"success": False}), (sources.parse_hunyuan_news, {"code": 500})])
def test_official_catalogue_failure_is_not_an_empty_success(parser, payload):
    with pytest.raises(ValueError):
        parser(json.dumps(payload))


def test_hunyuan_fetch_uses_only_public_list_query(monkeypatch):
    calls = []
    payload = {"code": 0, "data": {"list": [{"id": 1, "title": "混元更新"}]}}
    def fetch(url, **kwargs):
        calls.append((url, kwargs))
        return json.dumps(payload)
    monkeypatch.setattr(sources, "_fetch", fetch)
    source = next(source for source in sources.configured_sources([]) if source.id == "hunyuan-news")
    assert sources.fetch_source(source)[0]["source"] == "混元"
    assert calls == [("https://api.hunyuan.tencent.com/api/blog/publicList", {"json_body": {"pageNum": 1, "pageSize": 20, "renderType": 0}})]


def test_qwen_catalogue_size_exception_does_not_expand_other_sources(monkeypatch):
    real_client = httpx.Client
    content = b"x" * 20
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=content))
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: real_client(transport=transport, **kwargs))
    monkeypatch.setattr(sources, "MAX_RESPONSE_BYTES", 10)
    qwen = next(source for source in sources.configured_sources([]) if source.id == "qwen-news")
    assert sources._fetch(qwen.url) == content.decode()
    with pytest.raises(ValueError, match="大小"):
        sources._fetch("https://qwen.ai/blog?id=test")
    oversized = httpx.MockTransport(lambda request: httpx.Response(200, headers={"content-length": "8000001"}))
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: real_client(transport=oversized, **kwargs))
    with pytest.raises(ValueError, match="大小"):
        sources._fetch(qwen.url)


def test_rss_preserves_original_summary_image_and_unknown_date():
    result = sources.parse_rss(RSS)
    assert len(result) == 2
    assert result[0]["summary"] == "Inspect tool calls."
    assert result[0]["published_at"] == "2026-10-07T12:00:00Z"
    assert result[0]["image_url"] == "https://cdn.openai.com/agent.png"
    assert result[1]["published_at"] is None
    assert "MCP" in result[1]["tags"]
    assert result[0]["category"] == "agent"
    assert result[1]["category"] == "mcp"
    assert result[0]["id"] == sources.parse_rss(RSS)[0]["id"]


def test_rss_rejects_entity_expansion_and_non_feed():
    with pytest.raises(ValueError):
        sources.parse_rss('<!DOCTYPE rss [<!ENTITY a "x">]><rss/>')
    with pytest.raises(ValueError):
        sources.parse_rss("<html>maintenance</html>")


@pytest.mark.parametrize("period_text", ["1,234 stars today", "1,234 stars this week"])
def test_trending_uses_actual_rank_total_and_period_stars(period_text):
    rows = sources.parse_trending(TRENDING.replace("1,234 stars today", period_text))
    assert rows[0] == {
        "id": rows[0]["id"], "owner": "example", "name": "agent-kit", "description": "Agent tools & evaluation",
        "url": "https://github.com/example/agent-kit", "language": "Python", "stars": 12345, "forks": 678,
        "period_stars": 1234, "rank": 1, "tags": ["Agent", "评测", "开发工具"],
    }
    assert rows[1]["rank"] == 2
    assert rows[1]["period_stars"] is None
    assert rows[1]["stars"] is None


def test_trending_structure_change_is_error_instead_of_empty_success():
    with pytest.raises(ValueError, match="结构"):
        sources.parse_trending("<html>challenge page</html>")


def test_engineering_preserves_date_and_omits_missing_summary():
    items = sources.parse_engineering(ENGINEERING)
    assert items[0]["published_at"] is None
    assert items[0]["summary"] == "How to build reliable tools."
    assert items[0]["image_url"].endswith("tools.svg")
    assert items[1]["published_at"] == "2026-10-01T00:00:00Z"
    assert items[1]["summary"] == ""
    assert items[0]["category"] == "tool"
    assert items[1]["category"] == "eval"


def test_rag_topic_matches_protocol_word_not_storage_substring():
    assert "RAG" not in sources.tags_for("Fast storage for files")
    assert "RAG" in sources.tags_for("A RAG framework")
    assert sources.practice_category("Deploying storage reliably") == "deploy"


def test_releases_skip_prereleases_and_use_evidence_for_compatibility():
    items = sources.parse_releases(json.dumps([
        {"tag_name": "v3-beta", "prerelease": True},
        {"tag_name": "v2", "html_url": "https://github.com/example/sdk/releases/tag/v2", "published_at": "2026-10-02T22:02:27Z", "body": "## Breaking changes\n- Remove legacy calls\n- See migration guide"},
        {"tag_name": "v1", "html_url": "https://github.com/example/sdk/releases/tag/v1", "body": "fix: tracing"},
    ]), "example/sdk")
    assert len(items) == 2
    assert items[0]["version"] == "v2"
    assert items[0]["previous_version"] == "v1"
    assert items[0]["compatibility"] == "breaking"
    assert items[1]["published_at"] is None
    assert items[1]["compatibility"] == "review"


@pytest.mark.parametrize("value", ["https://github.com/openai/sdk", "../repo", "owner/../repo", "owner/repo?x=1", "owner/repo#token", "owner/repo%2Fanything", "owner/..", "localhost/x:y"])
def test_repository_input_cannot_be_arbitrary_url_or_path(value):
    with pytest.raises(ValueError):
        sources.normalize_repository(value)


@pytest.mark.parametrize("value", ["http://github.com/trending", "https://127.0.0.1", "https://github.com.evil.test", "https://user:pass@github.com/trending", "https://github.com:8443/trending"])
def test_fetch_disallows_other_origins_before_opening_connection(value, monkeypatch):
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: pytest.fail("opened a connection"))
    with pytest.raises(ValueError):
        sources._fetch(value)


def test_fetch_stream_has_timeout_size_bound_and_no_redirects(monkeypatch):
    observed = {}
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * 20))
    real_client = httpx.Client

    def client(**kwargs):
        observed.update(kwargs)
        return real_client(transport=transport, **kwargs)

    monkeypatch.setattr(sources.httpx, "Client", client)
    monkeypatch.setattr(sources, "MAX_RESPONSE_BYTES", 10)
    with pytest.raises(ValueError, match="大小"):
        sources._fetch("https://github.com/trending?since=daily")
    assert observed["follow_redirects"] is False
    assert observed["timeout"].connect == 15
    assert observed["timeout"].read == 20


@pytest.mark.parametrize("failure", ["timeout", "connection", "server"])
def test_fetch_retries_transient_failure_then_returns_content(monkeypatch, failure):
    requests = []
    delays = []

    def respond(request):
        requests.append(request)
        if len(requests) == 1:
            if failure == "timeout":
                raise httpx.ConnectTimeout("slow handshake", request=request)
            if failure == "connection":
                raise httpx.ConnectError("temporary network failure", request=request)
            return httpx.Response(503)
        return httpx.Response(200, text=RSS)

    real_client = httpx.Client
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs))
    monkeypatch.setattr(sources.time, "sleep", delays.append)
    assert sources._fetch("https://openai.com/news/rss.xml") == RSS
    assert len(requests) == 2
    assert delays == [0.5]


def test_fetch_exhausts_network_retry_and_does_not_retry_optional_covers(monkeypatch):
    requests = []

    def fail(request):
        requests.append(request)
        raise httpx.ReadTimeout("offline", request=request)

    real_client = httpx.Client
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(fail), **kwargs))
    monkeypatch.setattr(sources.time, "sleep", lambda delay: None)
    with pytest.raises(httpx.ReadTimeout):
        sources._fetch("https://openai.com/news/rss.xml")
    assert len(requests) == 2
    requests.clear()
    with pytest.raises(httpx.ReadTimeout):
        sources._fetch("https://openai.com/index/article", head_only=True)
    assert len(requests) == 1


@pytest.mark.parametrize("status,retry_after,expected_requests", [(404, None, 1), (403, None, 1), (429, None, 1), (429, "60", 1), (429, "1", 2), (503, "30", 1)])
def test_fetch_respects_permanent_failures_and_server_retry_after(monkeypatch, status, retry_after, expected_requests):
    requests = []
    delays = []

    def respond(request):
        requests.append(request)
        return httpx.Response(status, headers={"retry-after": retry_after} if retry_after else {})

    real_client = httpx.Client
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs))
    monkeypatch.setattr(sources.time, "sleep", delays.append)
    with pytest.raises(httpx.HTTPStatusError):
        sources._fetch("https://openai.com/news/rss.xml")
    assert len(requests) == expected_requests
    assert delays == ([1.0] if expected_requests == 2 else [])


def test_engineering_supports_research_links_nested_titles_and_visible_dates():
    content = '''<main><article data-listing-row="article-1"><time>Oct 13, 2026</time>
      <h3><a href="/research/redesigning-source-control">Redesigning source control</a></h3>
    </article><article><time>unknown</time><h3><a href="/research/agent-tools">Agent tools</a></h3></article>
    <article><h3><a href="https://evil.test/research/stolen">Ignore this</a></h3></article></main>'''
    items = sources.parse_engineering(content)
    assert len(items) == 2
    assert items[0]["title"] == "Redesigning source control"
    assert items[0]["url"] == "https://www.anthropic.com/research/redesigning-source-control"
    assert items[0]["published_at"] == "2026-10-13T00:00:00Z"
    assert items[1]["published_at"] is None


def test_fetch_refuses_redirects(monkeypatch):
    transport = httpx.MockTransport(lambda request: httpx.Response(302, headers={"location": "http://127.0.0.1/secrets"}))
    client_type = httpx.Client
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: client_type(transport=transport, **kwargs))
    with pytest.raises(httpx.HTTPStatusError):
        sources._fetch("https://github.com/trending?since=daily")


def test_article_cover_prefers_publisher_metadata_and_checks_image_origin():
    html = '''<head><meta name="twitter:image" content="https://cdn.openai.com/twitter.png">
    <meta property="og:image" content="https://evil.test/cover.png">
    <meta property="og:image" content="https://images.ctfassets.net/real.png?w=1600&amp;h=900"></head>
    <body><img src="https://cdn.openai.com/unrelated.png"></body>'''
    assert sources.parse_article_image(html, "https://openai.com/index/test/") == "https://images.ctfassets.net/real.png?w=1600&h=900"
    assert sources.parse_article_image('<meta property="og:image" content="/cover.png">', "https://openai.com/index/test/") == "https://openai.com/cover.png"
    assert sources.parse_article_image('<meta name="twitter:image" content="https://cdn.openai.com/twitter.png">', "https://openai.com/index/test/") == "https://cdn.openai.com/twitter.png"
    assert sources.parse_article_image('<img src="https://cdn.openai.com/related.png">', "https://openai.com/index/test/") is None
    assert sources.parse_article_image('<meta property="og:image" content="http://127.0.0.1/private">', "https://openai.com/index/test/") is None


def test_cover_enrichment_is_bounded_preserves_existing_images_and_ignores_failures(monkeypatch):
    called = []

    def fetch(url, *, head_only=False):
        called.append(url)
        assert head_only
        if url.endswith("/1"):
            raise httpx.TimeoutException("unavailable")
        return '<meta property="og:image" content="https://cdn.openai.com/cover.png">'

    monkeypatch.setattr(sources, "_fetch", fetch)
    items = [{"url": f"https://openai.com/index/{index}", "image_url": None} for index in range(10)]
    items[0]["image_url"] = "https://cdn.openai.com/original.png"
    items[2]["url"] = "https://evil.test/article"
    assert sources.with_article_images(items) is items
    assert set(called) == {f"https://openai.com/index/{index}" for index in (1, 3, 4, 5)}
    assert items[0]["image_url"] == "https://cdn.openai.com/original.png"
    assert items[1]["image_url"] is None
    assert items[3]["image_url"] == "https://cdn.openai.com/cover.png"
    assert all(item["image_url"] is None for item in items[6:])


def test_news_fetch_enriches_missing_rss_cover(monkeypatch):
    def fetch(url, *, head_only=False):
        if not head_only:
            return RSS
        return '<head><meta property="og:image" content="https://cdn.openai.com/mcp.png"></head>'

    monkeypatch.setattr(sources, "_fetch", fetch)
    items = sources.fetch_source(sources.configured_sources([])[0])
    assert items[0]["image_url"] == "https://cdn.openai.com/agent.png"
    assert items[1]["image_url"] == "https://cdn.openai.com/mcp.png"


def test_practice_fetch_does_not_request_article_covers(monkeypatch):
    calls = []

    def fetch(url, *, head_only=False):
        calls.append(url)
        assert not head_only
        return ENGINEERING

    monkeypatch.setattr(sources, "_fetch", fetch)
    source = next(item for item in sources.configured_sources([]) if item.kind == "practice")
    assert sources.fetch_source(source)[0]["title"] == "Agent tools"
    assert calls == [source.url]


def test_engineering_prefers_article_cover_to_svg_and_retains_svg_on_failure(monkeypatch):
    item = {"url": "https://www.anthropic.com/engineering/agent-tools", "image_url": "https://www-cdn.anthropic.com/list.svg"}
    monkeypatch.setattr(sources, "_fetch", lambda url, **kwargs: '<meta property="og:image" content="https://www-cdn.anthropic.com/article.png">')
    assert sources.with_article_images([dict(item)])[0]["image_url"] == "https://www-cdn.anthropic.com/article.png"
    monkeypatch.setattr(sources, "_fetch", lambda url, **kwargs: "<head></head>")
    assert sources.with_article_images([dict(item)])[0]["image_url"] == item["image_url"]


def test_article_head_fetch_stops_before_body_even_when_document_is_large(monkeypatch):
    head = b'<head><meta property="og:image" content="https://cdn.openai.com/cover.png"></head>'

    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            yield head + b" " * (8192 - len(head))
            pytest.fail("read the article body after receiving its head")

    transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=Stream(), headers={"content-length": "5000000"}))
    client_type = httpx.Client
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: client_type(transport=transport, **kwargs))
    assert sources._fetch("https://openai.com/index/article", head_only=True) == head.decode()


def test_article_head_fetch_has_a_separate_size_limit(monkeypatch):
    transport = httpx.MockTransport(lambda request: httpx.Response(200, content=b"x" * 100))
    client_type = httpx.Client
    monkeypatch.setattr(sources.httpx, "Client", lambda **kwargs: client_type(transport=transport, **kwargs))
    monkeypatch.setattr(sources, "MAX_ARTICLE_HEAD_BYTES", 20)
    assert sources._fetch("https://openai.com/index/article", head_only=True) == "x" * 20


@pytest.mark.parametrize("html", [
    '<meta property="article:published_time" content="2026-10-18T12:00:00+08:00">',
    '<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-18T04:00:00Z"}</script>',
    '<script type="application/ld+json">{"@graph":[{"@type":"BlogPosting","datePublished":"2026-10-18T04:00:00Z"}]}</script>',
])
def test_publisher_date_uses_explicit_publication_metadata(html):
    assert sources.parse_article_published_at(html) == "2026-10-18T04:00:00Z"


@pytest.mark.parametrize("html", [
    '<meta property="article:modified_time" content="2026-10-18T04:00:00Z">',
    '<script type="application/ld+json">{"@type":"Article","dateModified":"2026-10-18T04:00:00Z"}</script>',
    '<script type="application/ld+json">{"@type":"Organization","datePublished":"2026-10-18T04:00:00Z"}</script>',
    '<script type="application/ld+json">invalid json</script>',
    '<script type>ignored</script><body>Today is October 18, 2026</body>',
])
def test_publisher_date_never_guesses_from_updated_or_incidental_dates(html):
    assert sources.parse_article_published_at(html) is None
