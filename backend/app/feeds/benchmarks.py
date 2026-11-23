"""Official Artificial Analysis Data API. Credentials never enter feed snapshots."""

from __future__ import annotations

import json
import math
import time
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from typing import Any
from urllib.parse import quote

import httpx

API_URL = "https://artificialanalysis.ai/api/v2/language/models/free"
SOURCE_URL = "https://artificialanalysis.ai/leaderboards/models"
DOCS_URL = "https://artificialanalysis.ai/data-api/docs/reference"
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_PAGES = 100


def configured() -> bool:
    from ..config import get_settings

    return bool(getattr(get_settings(), "artificial_analysis_api_key", None))


@contextmanager
def stream_page(
    client: httpx.Client, url: str, key: str, *, deadline: float, params: dict[str, int] | None = None,
) -> Iterator[httpx.Response]:
    with ExitStack() as stack:
        for attempt in range(2):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError("官方评测 API 请求超时，已保留上次快照")
            try:
                response = stack.enter_context(client.stream(
                    "GET", url, params=params, headers={"x-api-key": key, "Accept": "application/json"},
                    timeout=httpx.Timeout(min(25, remaining), connect=min(10, remaining)),
                ))
            except (httpx.ConnectError, httpx.ConnectTimeout):
                if attempt == 1:
                    raise ValueError("暂时无法连接官方评测 API，已保留上次快照") from None
                continue
            yield response
            return


def normalize(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or payload.get("status") not in (None, 200) or not isinstance(payload.get("data"), list):
        raise ValueError("官方评测 API 数据格式变化，已保留上次快照")

    def number(value: Any, *, nonnegative: bool = False) -> float | None:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return None
        if not math.isfinite(value) or (nonnegative and value < 0):
            return None
        return float(value)

    result = {}
    for item in payload["data"]:
        if not isinstance(item, dict):
            continue
        identifier, name = item.get("id"), item.get("name")
        if not isinstance(identifier, str) or not identifier or not isinstance(name, str) or not name.strip():
            continue
        creator = item.get("model_creator") if isinstance(item.get("model_creator"), dict) else {}
        evaluations = item.get("evaluations") if isinstance(item.get("evaluations"), dict) else {}
        pricing = item.get("pricing") if isinstance(item.get("pricing"), dict) else {}
        performance = item.get("performance") if isinstance(item.get("performance"), dict) else {}
        cost = item.get("artificial_analysis_intelligence_index_cost")
        task_cost = cost.get("cost_per_task") if isinstance(cost, dict) else None
        slug = item.get("slug")
        url = f"https://artificialanalysis.ai/models/{quote(slug, safe='')}" if isinstance(slug, str) and slug and len(slug) <= 250 else SOURCE_URL
        result.setdefault(identifier, {
            "id": identifier[:200], "name": name.strip()[:250], "url": url,
            "creator_id": str(creator.get("id") or "")[:200], "creator": str(creator.get("name") or "未标注厂商")[:120],
            "intelligence": number(evaluations.get("artificial_analysis_intelligence_index")),
            "coding": number(evaluations.get("artificial_analysis_coding_index")),
            "agentic": number(evaluations.get("artificial_analysis_agentic_index")),
            "input_price": number(pricing.get("price_1m_input_tokens"), nonnegative=True),
            "output_price": number(pricing.get("price_1m_output_tokens"), nonnegative=True),
            "task_cost": number(task_cost.get("total_cost"), nonnegative=True) if isinstance(task_cost, dict) else None,
            "tokens_per_second": number(performance.get("median_output_tokens_per_second"), nonnegative=True),
            "first_token_seconds": number(performance.get("median_time_to_first_token_seconds"), nonnegative=True),
        })
    if payload["data"] and not result:
        raise ValueError("官方评测 API 未包含可识别模型，已保留上次快照")
    # Preserve all configurations and creators returned by the official API,
    # including models with no full index or price. Missing values stay null.
    return list(result.values())


def fetch() -> list[dict[str, Any]]:
    from ..config import get_settings

    key = get_settings().artificial_analysis_api_key
    if not key:
        raise ValueError("尚未配置 Artificial Analysis 数据源")
    try:
        deadline = time.monotonic() + 45
        total_bytes = 0
        rows = {}
        context = None
        with httpx.Client(timeout=httpx.Timeout(25, connect=10), follow_redirects=False) as client:
            for page in range(1, MAX_PAGES + 1):
                with stream_page(client, API_URL, key, deadline=deadline, params={"page": page}) as response:
                    if response.status_code == 401:
                        raise ValueError("官方评测 API 密钥无效或已失效，请检查数据源配置")
                    if response.status_code == 403:
                        raise ValueError("当前数据源套餐没有此接口的访问权限，请检查官方账户")
                    if response.status_code == 429:
                        raise ValueError("官方评测 API 请求额度受限，已保留上次快照")
                    response.raise_for_status()
                    declared = response.headers.get("content-length", "")
                    if declared.isdigit() and total_bytes + int(declared) > MAX_RESPONSE_BYTES:
                        raise ValueError("官方评测 API 响应超过大小限制，已保留上次快照")
                    content = bytearray()
                    for chunk in response.iter_bytes(chunk_size=8192):
                        if time.monotonic() >= deadline:
                            raise ValueError("官方评测 API 请求超时，已保留上次快照")
                        total_bytes += len(chunk)
                        if total_bytes > MAX_RESPONSE_BYTES:
                            raise ValueError("官方评测 API 响应超过大小限制，已保留上次快照")
                        content.extend(chunk)
                payload = json.loads(content)
                pagination = payload.get("pagination") if isinstance(payload, dict) else None
                if (not isinstance(pagination, dict) or type(pagination.get("page")) is not int
                        or pagination["page"] != page or type(pagination.get("total_pages")) is not int
                        or not page <= pagination["total_pages"] <= MAX_PAGES
                        or type(pagination.get("has_more")) is not bool
                        or pagination["has_more"] != (page < pagination["total_pages"])):
                    raise ValueError("官方评测 API 分页格式变化，已保留上次快照")
                page_context = (payload.get("tier"), payload.get("intelligence_index_version"), pagination["total_pages"])
                if context is not None and page_context != context:
                    raise ValueError("官方评测 API 分页快照发生变化，已保留上次快照")
                context = page_context
                for row in normalize(payload):
                    rows.setdefault(row["id"], row)
                if not pagination["has_more"]:
                    return list(rows.values())
        raise ValueError("官方评测 API 分页超过大小限制，已保留上次快照")
    except (httpx.HTTPError, UnicodeError, json.JSONDecodeError):
        # Do not propagate upstream bodies, URLs, request headers or credentials.
        raise ValueError("官方评测 API 暂时无法更新，已保留上次快照") from None
