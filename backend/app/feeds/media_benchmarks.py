"""Independent official media leaderboards; never combine incompatible scores."""
from __future__ import annotations

import json
import math
import time
from dataclasses import dataclass
from typing import Any

import httpx

from . import benchmarks


@dataclass(frozen=True)
class Board:
    id: str
    category: str
    label: str
    metric: str
    source_url: str

    @property
    def api_url(self) -> str:
        return f"https://artificialanalysis.ai/api/v2/media/{self.id}/models/free"

    @property
    def source_id(self) -> str:
        return f"aa-media-{self.id}-v1"


BOARDS = (
    Board("text-to-image", "image", "图像生成", "elo", "https://artificialanalysis.ai/image/arena"),
    Board("image-editing", "image", "图像编辑", "elo", "https://artificialanalysis.ai/image/arena"),
    Board("text-to-video", "video", "文生视频 · 无声", "elo", "https://artificialanalysis.ai/video/arena"),
    Board("image-to-video", "video", "图生视频 · 无声", "elo", "https://artificialanalysis.ai/video/arena"),
    Board("text-to-video-audio", "video", "文生视频 · 有声", "elo", "https://artificialanalysis.ai/video/arena"),
    Board("image-to-video-audio", "video", "图生视频 · 有声", "elo", "https://artificialanalysis.ai/video/arena"),
    Board("text-to-speech", "speech", "语音合成", "elo", "https://artificialanalysis.ai/text-to-speech"),
    Board("speech-to-speech", "speech", "语音对话", "bba_score", "https://artificialanalysis.ai/speech-to-speech"),
    Board("speech-to-text", "speech", "语音识别", "wer", "https://artificialanalysis.ai/speech-to-text"),
)


def normalize(payload: Any, board: Board) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list) or payload.get("tier") not in {"free", "pro", "commercial"}:
        raise ValueError("官方媒体评测数据格式变化，已保留上次快照")

    def number(value: Any, *, nonnegative: bool = False):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            return None
        return float(value) if not nonnegative or value >= 0 else None

    result = {}
    for item in payload["data"]:
        if not isinstance(item, dict):
            continue
        identifier, name = item.get("id"), item.get("name")
        if not isinstance(identifier, str) or not identifier.strip() or not isinstance(name, str) or not name.strip():
            continue
        creator = item.get("model_creator") if isinstance(item.get("model_creator"), dict) else {}
        result.setdefault(identifier, {
            "id": identifier[:200], "name": name.strip()[:250], "url": board.source_url,
            "creator_id": str(creator.get("id") or "")[:200], "creator": str(creator.get("name") or "未标注厂商")[:120],
            "elo": number(item.get("elo")), "ci_95": number(item.get("ci_95"), nonnegative=True),
            "bba_score": number(item.get("bba_score")), "fdb_score": number(item.get("fdb_score")),
            "tau_voice_score": number(item.get("tau_voice_score")), "wer": number(item.get("aa_wer_index"), nonnegative=True),
        })
    if payload["data"] and not result:
        raise ValueError("官方媒体评测未包含可识别模型，已保留上次快照")
    return list(result.values())


def fetch(board: Board) -> list[dict[str, Any]]:
    from ..config import get_settings

    key = get_settings().artificial_analysis_api_key
    if not key:
        raise ValueError("尚未配置 Artificial Analysis 数据源")
    try:
        deadline = time.monotonic() + 45
        with httpx.Client(timeout=httpx.Timeout(25, connect=10), follow_redirects=False) as client:
            with benchmarks.stream_page(client, board.api_url, key, deadline=deadline) as response:
                if response.status_code == 401:
                    raise ValueError("官方评测 API 密钥无效或已失效，请检查数据源配置")
                if response.status_code == 403:
                    raise ValueError("当前数据源套餐没有此榜单的访问权限")
                if response.status_code == 429:
                    raise ValueError("官方评测 API 请求额度受限，已保留上次快照")
                response.raise_for_status()
                size = response.headers.get("content-length", "")
                if size.isdigit() and int(size) > benchmarks.MAX_RESPONSE_BYTES:
                    raise ValueError("官方媒体评测响应超过大小限制，已保留上次快照")
                content = bytearray()
                for chunk in response.iter_bytes(chunk_size=8192):
                    if time.monotonic() >= deadline:
                        raise ValueError("官方媒体评测请求超时，已保留上次快照")
                    content.extend(chunk)
                    if len(content) > benchmarks.MAX_RESPONSE_BYTES:
                        raise ValueError("官方媒体评测响应超过大小限制，已保留上次快照")
        return normalize(json.loads(content), board)
    except (httpx.HTTPError, UnicodeError, json.JSONDecodeError):
        raise ValueError("官方媒体评测暂时无法更新，已保留上次快照") from None
