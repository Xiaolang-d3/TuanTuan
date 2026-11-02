"""Bounded, allowlisted public source adapters. No model or private data is used."""

from __future__ import annotations

import hashlib
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, urljoin, urlsplit

import httpx

from . import subscriptions
from .public_cache import NotModified, request_state

MAX_RESPONSE_BYTES = 2_000_000
MAX_ARTICLE_HEAD_BYTES = 256_000
MAX_ARTICLE_IMAGE_LOOKUPS = 6
MAX_FETCH_ATTEMPTS = 2
FETCH_DEADLINE_SECONDS = 45
REPOSITORY_PATTERN = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9_.-]{1,100}\Z")
TOPICS = ("AI", "Agent", "MCP", "RAG", "评测", "开发工具")
_ALLOWED_FETCH_HOSTS = {"openai.com", "www.anthropic.com", "github.com", "api.github.com", "blog.google", "www.deepseek.com", "deepseek.com", "qwen.ai", "hunyuan.tencent.com", "api.hunyuan.tencent.com", "huggingface.co", "openrouter.ai", "artificialanalysis.ai"}
_ALLOWED_IMAGE_HOSTS = {"openai.com", "images.ctfassets.net", "cdn.openai.com", "www-cdn.anthropic.com"}


@dataclass(frozen=True)
class Source:
    id: str
    label: str
    kind: str
    url: str
    ttl_seconds: int = 3600
    repo: str | None = None
    publisher: str | None = None
    adapter: str = ""
    article_prefixes: tuple[str, ...] = ()
    request_body: tuple[tuple[str, int], ...] = ()


def configured_sources(repositories: list[str]) -> list[Source]:
    from . import benchmarks, market, media_benchmarks

    return [
        Source("openai-news", "OpenAI 官方动态", "news", "https://openai.com/news/rss.xml", publisher="OpenAI"),
        Source("github-day", "GitHub Trending · 日榜", "github", "https://github.com/trending?since=daily"),
        Source("github-week", "GitHub Trending · 周榜", "github", "https://github.com/trending?since=weekly"),
        Source("anthropic-engineering", "Anthropic 工程实践", "practice", "https://www.anthropic.com/engineering", 43200),
        Source("anthropic-news", "Claude 官方动态", "news", "https://www.anthropic.com/news", publisher="Claude", adapter="publisher_html", article_prefixes=("/news/", "/claude-")),
        Source("gemini-news", "Gemini 官方动态", "news", "https://blog.google/products-and-platforms/products/gemini/rss/", publisher="Gemini"),
        Source("deepseek-news", "DeepSeek 官方动态", "news", "https://www.deepseek.com/en/news/", 21600, publisher="DeepSeek", adapter="publisher_html", article_prefixes=("/en/news/",)),
        Source("qwen-news", "千问官方动态", "news", "https://qwen.ai/api/v2/article/retrieval?type=qwen_ai&language=zh-CN", 21600, publisher="千问", adapter="qwen"),
        Source("hunyuan-news", "混元官方动态", "news", "https://api.hunyuan.tencent.com/api/blog/publicList", 21600, publisher="混元", adapter="hunyuan", request_body=(("pageNum", 1), ("pageSize", 20), ("renderType", 0))),
        Source("huggingface-news", "Hugging Face 模型社区", "news", "https://huggingface.co/blog/feed.xml", 21600, publisher="Hugging Face"),
        Source("openrouter-news", "OpenRouter 跨厂商动态", "news", "https://openrouter.ai/blog/feed.xml", 21600, publisher="OpenRouter"),
        *([Source("market-news-v1", "全市场模型发现", "news", "", 21600, adapter="market_search")] if market.enabled() else []),
        *([Source("aa-data-api-v2", "Artificial Analysis 官方评测", "benchmark", benchmarks.API_URL, 21600, adapter="aa_api")] if benchmarks.configured() else []),
        *([Source(board.source_id, f"官方评测 · {board.label}", "benchmark", board.api_url, 21600, adapter="aa_media") for board in media_benchmarks.BOARDS] if benchmarks.configured() else []),
        *[
            Source(f"release:{repo.lower()}", f"{repo} Releases", "stack", f"https://api.github.com/repos/{repo}/releases?per_page=4", repo=repo)
            for repo in repositories
        ],
    ]


def normalize_repository(value: str) -> str:
    repo = value.strip()
    if not REPOSITORY_PATTERN.fullmatch(repo) or repo.split("/")[1] in {".", ".."}:
        raise ValueError("仓库需填写 owner/repo，例如 modelcontextprotocol/python-sdk")
    return repo


def _fetch(url: str, *, head_only: bool = False, json_body: dict[str, Any] | None = None) -> str:
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.hostname not in _ALLOWED_FETCH_HOSTS or parsed.username or parsed.port not in (None, 443):
        raise ValueError("不允许采集该地址")
    deadline = time.monotonic() + FETCH_DEADLINE_SECONDS
    attempts = 1 if head_only else MAX_FETCH_ATTEMPTS
    for attempt in range(attempts):
        try:
            return _fetch_once(url, head_only=head_only, deadline=deadline, json_body=json_body)
        except (httpx.TransportError, httpx.HTTPStatusError) as exc:
            delay = 0.5
            if isinstance(exc, httpx.HTTPStatusError):
                if exc.response.status_code not in {408, 429, 500, 502, 503, 504}:
                    raise
                retry_after = exc.response.headers.get("retry-after")
                if retry_after:
                    try:
                        delay = max(0.5, float(retry_after))
                    except ValueError:
                        when = published_date(retry_after)
                        if when is None:
                            raise exc
                        delay = max(0.5, (datetime.fromisoformat(when.replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds())
                    # Long server cooldowns belong to the next background refresh.
                    if delay > 2:
                        raise
                elif exc.response.status_code == 429:
                    raise
            if attempt + 1 >= attempts or time.monotonic() + delay >= deadline:
                raise
            time.sleep(delay)
    raise RuntimeError("来源请求未完成")


def _fetch_once(url: str, *, head_only: bool, deadline: float, json_body: dict[str, Any] | None = None) -> str:
    remaining = max(0.1, deadline - time.monotonic())
    timeout = httpx.Timeout(min(8 if head_only else 20, remaining), connect=min(5 if head_only else 15, remaining))
    headers = {"User-Agent": "tuantuan-Developer-Home/1.0", "Accept": "application/json, application/atom+xml, application/rss+xml, application/xml, text/xml, text/html", "Accept-Language": "zh"}
    state = request_state.get()
    conditional = state if state and state.url == url and not head_only and json_body is None else None
    if conditional:
        if conditional.validators.get("etag"):
            headers["If-None-Match"] = conditional.validators["etag"]
        if conditional.validators.get("last-modified"):
            headers["If-Modified-Since"] = conditional.validators["last-modified"]
    # Redirects remain disabled even on retries; every attempt uses the validated URL.
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        with client.stream("POST" if json_body is not None else "GET", url, json=json_body, headers=headers) as response:
            if conditional:
                conditional.response_validators = {name: response.headers[name] for name in ("etag", "last-modified") if 0 < len(response.headers.get(name, "")) <= 1024}
            if response.status_code == 304:
                if conditional and conditional.validators:
                    raise NotModified()
                raise ValueError("来源返回 304 但没有条件请求缓存")
            response.raise_for_status()
            if response.is_redirect:
                raise ValueError("来源返回了不支持的重定向")
            declared = response.headers.get("content-length", "")
            # Qwen's public catalogue embeds article HTML alongside metadata.
            # Keep its larger bound tied to this exact read-only endpoint.
            limit = 8_000_000 if url == "https://qwen.ai/api/v2/article/retrieval?type=qwen_ai&language=zh-CN" else MAX_RESPONSE_BYTES
            if not head_only and declared.isdigit() and int(declared) > limit:
                raise ValueError("来源内容超过大小限制")
            content = bytearray()
            for chunk in response.iter_bytes(chunk_size=8192):
                if time.monotonic() >= deadline:
                    raise httpx.ReadTimeout("来源请求超过整体时限", request=response.request)
                content.extend(chunk)
                if head_only:
                    end = content.lower().find(b"</head>")
                    if end >= 0:
                        return content[:min(end + 7, MAX_ARTICLE_HEAD_BYTES)].decode("utf-8", errors="replace")
                    if len(content) >= MAX_ARTICLE_HEAD_BYTES:
                        return content[:MAX_ARTICLE_HEAD_BYTES].decode("utf-8", errors="replace")
                if len(content) > limit:
                    raise ValueError("来源内容超过大小限制")
            return content.decode("utf-8", errors="replace")


def safe_public_url(value: str | None, *, image: bool = False) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = urlsplit(value)
        allowed = _ALLOWED_IMAGE_HOSTS if image else _ALLOWED_FETCH_HOSTS
        if parsed.scheme != "https" or parsed.hostname not in allowed or parsed.username or parsed.port not in (None, 443):
            return None
    except ValueError:
        return None
    return value


def published_date(value: str | None) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        date = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        try:
            date = parsedate_to_datetime(value)
        except (TypeError, ValueError, OverflowError):
            return None
    if date.tzinfo is None:
        date = date.replace(tzinfo=timezone.utc)
    try:
        return date.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except (ValueError, OverflowError):
        return None


def _id(kind: str, url: str) -> str:
    return f"{kind}:{hashlib.sha256(url.encode()).hexdigest()[:20]}"


def _plain(value: str, limit: int = 320) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]*>", " ", value))).strip()[:limit]


def _contains(text: str, token: str) -> bool:
    if token.isascii() and len(token) <= 3:
        return re.search(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", text) is not None
    return token in text


def tags_for(value: str) -> list[str]:
    text = value.casefold()
    mappings = {
        "Agent": ("agent", "智能体", "claude code", "codex"),
        "MCP": ("mcp", "model context protocol"),
        "RAG": ("retrieval", "rag", "检索"),
        "评测": ("eval", "benchmark", "评测"),
        "开发工具": ("sdk", "api", "developer", "framework", "开发", "tool", "coding"),
        "AI": ("ai", "llm", "model", "gpt", "claude", "gemini", "deepseek", "qwen", "hunyuan", "千问", "混元", "人工智能", "neural"),
    }
    tags = [tag for tag, tokens in mappings.items() if any(_contains(text, token) for token in tokens)]
    return tags[:3]


def news_category(tags: list[str]) -> str:
    if "MCP" in tags:
        return "mcp"
    if "Agent" in tags:
        return "agent"
    if "开发工具" in tags:
        return "tools"
    return "model"


def practice_category(value: str) -> str:
    text = value.casefold()
    mappings = (
        ("eval", ("eval", "benchmark", "评测")),
        ("rag", ("retrieval", "rag", "检索")),
        ("memory", ("memory", "context", "long-running", "记忆", "上下文")),
        ("obs", ("observability", "tracing", "monitor", "可观测")),
        ("cost", ("cost", "latency", "efficient", "成本", "延迟")),
        ("deploy", ("deploy", "infrastructure", "scaling", "containment", "security", "部署")),
    )
    return next((category for category, tokens in mappings if any(_contains(text, token) for token in tokens)), "tool")


def parse_rss(content: str, publisher: str = "OpenAI") -> list[dict[str, Any]]:
    """Normalize standard feeds into the existing article contract (RSS/Atom)."""
    articles = []
    seen = set()
    for item in subscriptions.entries(content):
        title = _plain(item["title"], 220)
        summary = _plain(item["summary"])
        url = safe_public_url(item["url"])
        tags = tags_for(f"{title} {summary}")
        if not title or not url or not tags or url in seen:
            continue
        seen.add(url)
        image = next((value for candidate in item["images"] if (value := safe_public_url(candidate, image=True))), None)
        articles.append({
            "id": _id("article", url), "title": title, "summary": summary, "url": url,
            "source": publisher, "published_at": published_date(item["published"]),
            "category": news_category(tags), "tags": tags, "image_url": image,
        })
    return articles[:30]


@dataclass
class _Node:
    tag: str
    attrs: dict[str, str]
    children: list[Any] = field(default_factory=list)

    def all(self, tag: str | None = None) -> list[_Node]:
        result = []
        for child in self.children:
            if isinstance(child, _Node):
                if tag is None or child.tag == tag:
                    result.append(child)
                result.extend(child.all(tag))
        return result

    def text(self) -> str:
        return " ".join(child.text() if isinstance(child, _Node) else child for child in self.children)


class _TreeParser(HTMLParser):
    def __init__(self, content: str):
        super().__init__(convert_charrefs=True)
        self.root = _Node("root", {})
        self.stack = [self.root]
        self.feed(content)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = _Node(tag, {name.lower(): value or "" for name, value in attrs})
        self.stack[-1].children.append(node)
        if tag not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag: str) -> None:
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data: str) -> None:
        if self.stack[-1].tag not in {"script", "style"}:
            self.stack[-1].children.append(data)


def parse_article_image(content: str, article_url: str) -> str | None:
    """Use explicit publisher cover metadata, never a random body or related image."""
    tree = _TreeParser(content).root
    metadata = tree.all("meta")
    for key in ("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"):
        for node in metadata:
            name = (node.attrs.get("property") or node.attrs.get("name", "")).lower()
            value = node.attrs.get("content", "").strip()
            if name == key and value:
                image = safe_public_url(urljoin(article_url, value), image=True)
                if image:
                    return image
    return None


def parse_article_published_at(content: str) -> str | None:
    """Read explicit publication metadata, never modification or incidental dates."""
    tree = _TreeParser(content).root
    keys = {"article:published_time", "og:published_time", "pubdate", "datepublished", "parsely-pub-date"}
    for node in tree.all("meta"):
        name = (node.attrs.get("property") or node.attrs.get("name", "")).casefold()
        if name in keys:
            value = published_date(node.attrs.get("content"))
            if value:
                return value
    # Script text is deliberately omitted by _TreeParser. Use a dedicated
    # metadata parser to retain JSON-LD without interpreting page instructions.
    class PublicationParser(HTMLParser):
        def __init__(self):
            super().__init__()
            self.in_json = False
            self.parts = []
            self.documents = []

        def handle_starttag(self, tag, attrs):
            if tag == "script":
                self.in_json = (dict(attrs).get("type") or "").casefold() == "application/ld+json"
                self.parts = []

        def handle_data(self, data):
            if self.in_json:
                self.parts.append(data)

        def handle_endtag(self, tag):
            if tag == "script" and self.in_json:
                self.documents.append("".join(self.parts))
                self.in_json = False

    parser = PublicationParser()
    parser.feed(content)
    for document in parser.documents:
        try:
            payload = json.loads(document)
        except (ValueError, TypeError):
            continue
        nodes = payload if isinstance(payload, list) else [payload]
        for node in list(nodes):
            if isinstance(node, dict) and isinstance(node.get("@graph"), list):
                nodes.extend(node["@graph"])
        for node in nodes:
            if not isinstance(node, dict):
                continue
            kinds = node.get("@type", [])
            kinds = [kinds] if isinstance(kinds, str) else kinds
            if not isinstance(kinds, list) or not any(kind in {"Article", "NewsArticle", "BlogPosting", "TechArticle", "ScholarlyArticle"} for kind in kinds if isinstance(kind, str)):
                continue
            value = node.get("datePublished")
            if isinstance(value, str) and (date_value := published_date(value)):
                return date_value
    return None


def fetch_article_published_at(url: str) -> str | None:
    if not safe_public_url(url):
        return None
    return parse_article_published_at(_fetch(url, head_only=True))


def with_article_images(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Bound optional lookups to leading cards; failures must not lose the feed."""
    candidates = [item for item in items[:MAX_ARTICLE_IMAGE_LOOKUPS]
                  if (not item.get("image_url") or urlsplit(item["image_url"]).path.lower().endswith(".svg"))
                  and safe_public_url(item.get("url"))]

    def cover(item: dict[str, Any]) -> str | None:
        try:
            return parse_article_image(_fetch(item["url"], head_only=True), item["url"])
        except (httpx.HTTPError, ValueError):
            return None

    if candidates:
        with ThreadPoolExecutor(max_workers=3, thread_name_prefix="home-cover") as executor:
            for item, image in zip(candidates, executor.map(cover, candidates)):
                if image:
                    item["image_url"] = image
    return items


def _number(value: str) -> int | None:
    match = re.search(r"\d[\d,]*", value)
    return int(match.group().replace(",", "")) if match else None


def parse_trending(content: str) -> list[dict[str, Any]]:
    tree = _TreeParser(content).root
    rows = [node for node in tree.all("article") if "Box-row" in node.attrs.get("class", "").split()]
    if not rows:
        raise ValueError("GitHub 榜单结构已变化或暂时不可用")
    result = []
    for rank, row in enumerate(rows, 1):
        headings = row.all("h2")
        links = headings[0].all("a") if headings else []
        if not links:
            continue
        repo = links[0].attrs.get("href", "").strip("/")
        if not REPOSITORY_PATTERN.fullmatch(repo):
            continue
        owner, name = repo.split("/")
        paragraphs = row.all("p")
        description = _plain(paragraphs[0].text()) if paragraphs else ""
        anchors = row.all("a")
        stars = next((_number(node.text()) for node in anchors if node.attrs.get("href") == f"/{repo}/stargazers"), None)
        forks = next((_number(node.text()) for node in anchors if node.attrs.get("href") == f"/{repo}/forks"), None)
        period = next((_number(node.text()) for node in row.all("span") if re.search(r"stars?\s+(today|this week)", node.text())), None)
        language = next((_plain(node.text()) for node in row.all("span") if node.attrs.get("itemprop") == "programmingLanguage"), None)
        result.append({
            "id": _id("repo", f"https://github.com/{repo.lower()}"), "owner": owner, "name": name,
            "description": description, "url": f"https://github.com/{repo}", "language": language,
            "stars": stars, "period_stars": period, "forks": forks, "rank": rank,
            "tags": tags_for(f"{repo} {description}"),
        })
    if not result:
        raise ValueError("GitHub 榜单未包含可识别仓库")
    return result[:25]


def parse_engineering(content: str) -> list[dict[str, Any]]:
    tree = _TreeParser(content).root
    result = []
    seen = set()
    for row in tree.all("article"):
        links = [node for node in row.all("a") if node.attrs.get("href", "").startswith(("/engineering/", "/research/"))]
        if not links:
            continue
        link = links[0]
        url = safe_public_url(urljoin("https://www.anthropic.com", link.attrs["href"]))
        headings = row.all("h2") or row.all("h3")
        if not url or not headings or url in seen:
            continue
        seen.add(url)
        title = _plain(headings[0].text(), 220)
        paragraphs = row.all("p")
        dates = row.all("time")
        images = row.all("img")
        date = None
        if dates:
            date = published_date(dates[0].attrs.get("datetime"))
            if date is None:
                # The current listing uses a visible <time> without datetime.
                try:
                    date = datetime.strptime(_plain(dates[0].text()), "%b %d, %Y").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
                except ValueError:
                    pass
        summary = _plain(paragraphs[0].text()) if paragraphs else ""
        tags = tags_for(f"{title} {summary}") or ["开发工具"]
        result.append({
            "id": _id("article", url), "title": title,
            "summary": summary, "url": url,
            "source": "Anthropic Engineering", "published_at": date,
            "category": practice_category(f"{title} {summary}"), "tags": tags,
            "image_url": safe_public_url(images[0].attrs.get("src"), image=True) if images else None,
        })
    if not result:
        raise ValueError("工程来源结构已变化或暂时不可用")
    return result[:16]


def parse_releases(content: str, repo: str) -> list[dict[str, Any]]:
    rows = json.loads(content)
    if not isinstance(rows, list):
        raise ValueError("仓库 Release 响应不可用")
    published = [row for row in rows if isinstance(row, dict) and not row.get("draft") and not row.get("prerelease")]
    releases = []
    for index, row in enumerate(published[:3]):
        url = safe_public_url(row.get("html_url"))
        version = _plain(str(row.get("tag_name", "")), 100)
        if not url or not version:
            continue
        body = str(row.get("body") or "")
        changes = []
        for line in body.splitlines():
            text = _plain(re.sub(r"^[\s#*+\-]+", "", line), 220)
            if text and not text.startswith(("http", "![", "[Full Changelog", "Full Changelog")):
                changes.append(text)
            if len(changes) == 3:
                break
        lowered = body.casefold()
        compatibility = "breaking" if "breaking change" in lowered else "migrate" if "migration" in lowered or "migrate" in lowered else "review"
        releases.append({
            "id": _id("release", url), "repo": repo, "name": _plain(str(row.get("name") or version), 160),
            "version": version, "previous_version": str(published[index + 1].get("tag_name")) if index + 1 < len(published) and published[index + 1].get("tag_name") else None,
            "published_at": published_date(row.get("published_at")), "changes": changes,
            "compatibility": compatibility, "url": url,
        })
    return releases


def _news_item(publisher: str, title: str, summary: str, url: str, date: str | None) -> dict[str, Any]:
    tags = tags_for(f"{publisher} {title} {summary}") or ["AI"]
    return {"id": _id("article", url), "title": _plain(title, 220), "summary": _plain(summary),
            "url": url, "source": publisher, "published_at": date,
            "category": news_category(tags), "tags": tags, "image_url": None}


def _visible_news_date(text: str) -> str | None:
    # Only explicit publisher dates count; never substitute collection time.
    match = re.search(r"\b([A-Z][a-z]{2,8} \d{1,2}, \d{4})\b", text)
    if match:
        for pattern in ("%B %d, %Y", "%b %d, %Y"):
            try:
                return datetime.strptime(match[1], pattern).replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
            except ValueError:
                pass
    return None


def parse_publisher_html(content: str, publisher: str, base: str, prefixes: tuple[str, ...]) -> list[dict[str, Any]]:
    tree = _TreeParser(content).root
    articles = [row for row in tree.all("article") if not row.all("article")]
    rows = articles or tree.all("a")
    result = {}
    for row in rows:
        links = [row] if row.tag == "a" else row.all("a")
        link = next((node for node in links if node.attrs.get("href", "").startswith(prefixes) and (node.all("h2") or node.all("h3"))), None)
        if link is None:
            continue
        url = safe_public_url(urljoin(base, link.attrs["href"]))
        headings = link.all("h2") or link.all("h3")
        title = _plain(headings[0].text(), 220)
        if not url or not title or url in result:
            continue
        dates = row.all("time")
        date = (published_date(dates[0].attrs.get("datetime")) or _visible_news_date(dates[0].text())) if dates else _visible_news_date(link.text())
        paragraphs = [_plain(node.text()) for node in link.all("p")]
        summary = next((text for text in paragraphs if text and _visible_news_date(text) is None), "")
        result[url] = _news_item(publisher, title, summary, url, date)
    if not result:
        raise ValueError("官方资讯列表结构已变化或暂时不可用")
    return sorted(result.values(), key=lambda item: item["published_at"] or "", reverse=True)[:16]


def parse_qwen_news(content: str) -> list[dict[str, Any]]:
    payload = json.loads(content)
    data = payload.get("data") if isinstance(payload, dict) and payload.get("success") is True else None
    rows = data.get("articles") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not rows:
        raise ValueError("千问官方资讯列表暂时不可用")
    result = []
    for row in rows[:80]:
        if not isinstance(row, dict) or not row.get("title") or not (row.get("path") or row.get("id")):
            continue
        extra = row.get("extra") if isinstance(row.get("extra"), dict) else {}
        url = "https://qwen.ai/blog?id=" + quote(str(row.get("path") or row["id"]), safe="")
        date = published_date(extra["date"]) if isinstance(extra.get("date"), str) else None
        result.append(_news_item("千问", str(row["title"]), str(extra.get("description") or extra.get("introduction") or ""), url, date))
    if not result:
        raise ValueError("千问官方资讯未包含可识别文章")
    return sorted(result, key=lambda item: item["published_at"] or "", reverse=True)[:16]


def parse_hunyuan_news(content: str) -> list[dict[str, Any]]:
    payload = json.loads(content)
    data = payload.get("data") if isinstance(payload, dict) and payload.get("code") == 0 else None
    rows = data.get("list") if isinstance(data, dict) else None
    if not isinstance(rows, list) or not rows:
        raise ValueError("混元官方资讯列表暂时不可用")
    result = []
    for row in rows[:40]:
        if not isinstance(row, dict) or not row.get("title") or not (row.get("customUrl") or row.get("id")):
            continue
        slug = quote(str(row.get("customUrl") or row["id"]), safe="")
        url = f"https://hunyuan.tencent.com/research/{slug}?langVersion=zh"
        timestamp = row.get("displayPublishTime") or row.get("publishedAt")
        date = None
        if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool):
            try:
                date = datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")
            except (ValueError, OverflowError, OSError):
                pass
        result.append(_news_item("混元", str(row["title"]), str(row.get("desc") or ""), url, date))
    if not result:
        raise ValueError("混元官方资讯未包含可识别文章")
    return sorted(result, key=lambda item: item["published_at"] or "", reverse=True)[:16]


def fetch_source(source: Source) -> list[dict[str, Any]]:
    if source.adapter == "aa_media":
        from . import media_benchmarks

        board = next((board for board in media_benchmarks.BOARDS if board.source_id == source.id and board.api_url == source.url), None)
        if board is None:
            raise ValueError("未知官方媒体评测来源")
        return media_benchmarks.fetch(board)
    if source.adapter == "aa_api":
        from . import benchmarks

        return benchmarks.fetch()
    if source.adapter == "market_search":
        from . import market

        return market.fetch()

    adapter = source.adapter or {"news": "subscription", "github": "trending", "practice": "engineering", "stack": "releases"}.get(source.kind)
    parsers = {"trending": parse_trending, "engineering": parse_engineering, "qwen": parse_qwen_news, "hunyuan": parse_hunyuan_news}
    if adapter not in {*parsers, "subscription", "publisher_html", "releases"}:
        raise ValueError("来源类型不受支持")
    content = _fetch(source.url, json_body=dict(source.request_body)) if source.request_body else _fetch(source.url)
    if adapter == "subscription":
        items = parse_rss(content, source.publisher or "OpenAI")
        return with_article_images(items) if source.id == "openai-news" else items
    if adapter == "publisher_html":
        origin = urlsplit(source.url)
        return parse_publisher_html(content, source.publisher or source.label, f"{origin.scheme}://{origin.netloc}", source.article_prefixes)
    if adapter == "releases" and source.repo:
        return parse_releases(content, source.repo)
    if adapter in parsers:
        return parsers[adapter](content)
    raise ValueError("来源类型不受支持")
