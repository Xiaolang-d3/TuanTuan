from __future__ import annotations

import hashlib
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


HASH_DIMENSIONS = 256
DEFAULT_FASTEMBED_MODEL = "BAAI/bge-small-zh-v1.5"
KNOWN_DIMENSIONS = {
    "hash-blake2b": HASH_DIMENSIONS,
    "BAAI/bge-small-zh-v1.5": 512,
    "BAAI/bge-small-en-v1.5": 384,
}


@dataclass(frozen=True)
class EmbeddingSpec:
    backend: str
    model: str
    dimensions: int
    processing_version: int = 0


class Embedder(Protocol):
    spec: EmbeddingSpec

    def embed(self, text: str) -> list[float]: ...

    def embed_many(self, texts: list[str]) -> list[list[float]]: ...


class HashEmbedder:
    spec = EmbeddingSpec("hash", "hash-blake2b", HASH_DIMENSIONS)

    def embed(self, text: str) -> list[float]:
        return _hash_embed(text, self.spec.dimensions)

    def embed_many(self, texts: list[str]) -> list[list[float]]:
        return [self.embed(text) for text in texts]


class FastEmbedEmbedder:
    def __init__(self, model: str, cache_dir: str | Path | None = None) -> None:
        self.spec = EmbeddingSpec("fastembed", model, dimensions_for(model), processing_version=1)
        self.cache_dir = Path(cache_dir) if cache_dir else default_cache_dir()
        self._model = None
        self._window_tokenizer = None

    def split_for_embedding(self, text: str) -> list[tuple[int, int]]:
        if self._window_tokenizer is None:
            from tokenizers import Tokenizer
            tokenizer = self._load().model.tokenizer
            if tokenizer is None or not tokenizer.truncation:
                raise ValueError("无法确认 embedding 模型的分词窗口")
            limit = int(tokenizer.truncation["max_length"])
            unbounded = Tokenizer.from_str(tokenizer.to_str())
            unbounded.no_truncation()
            unbounded.no_padding()
            self._window_tokenizer = (unbounded, limit)
        tokenizer, limit = self._window_tokenizer
        result, start = [], 0
        while start < len(text):
            if len(tokenizer.encode(text[start:]).ids) <= limit:
                result.append((start, len(text)))
                break
            low, high = start + 1, len(text)
            end = start
            while low <= high:
                candidate = (low + high) // 2
                if len(tokenizer.encode(text[start:candidate]).ids) <= limit:
                    end, low = candidate, candidate + 1
                else:
                    high = candidate - 1
            if end == start:
                raise ValueError("单个字符已超过 embedding 分词窗口")
            result.append((start, end))
            start = end
        return result

    def embed(self, text: str) -> list[float]:
        return self.embed_many([text])[0]

    def embed_many(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        model = self._load()
        return [_normalize([float(value) for value in vector]) for vector in model.embed(texts)]

    def _load(self):
        if self._model is None:
            from fastembed import TextEmbedding

            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self._model = TextEmbedding(
                model_name=self.spec.model,
                cache_dir=str(self.cache_dir),
            )
        return self._model


_current: Embedder | None = None


def dimensions_for(model: str) -> int:
    if model in KNOWN_DIMENSIONS:
        return KNOWN_DIMENSIONS[model]
    raw = (os.getenv("EMBEDDING_DIMENSIONS") or "").strip()
    if raw.isdigit():
        return int(raw)
    raise ValueError(f"未知 embedding 模型 {model}，请设置 EMBEDDING_DIMENSIONS")


def default_cache_dir() -> Path:
    raw = (os.getenv("EMBEDDING_CACHE_DIR") or "").strip()
    if raw:
        return Path(raw)
    from ..config import BACKEND_DIR

    return BACKEND_DIR / "data" / "fastembed"


def requested_backend() -> str:
    return (os.getenv("EMBEDDING_BACKEND") or "auto").strip().lower() or "auto"


def requested_model() -> str:
    return (os.getenv("EMBEDDING_MODEL") or DEFAULT_FASTEMBED_MODEL).strip() or DEFAULT_FASTEMBED_MODEL


def get_embedder() -> Embedder:
    global _current
    if _current is None:
        _current = build_embedder()
    return _current


def set_embedder(embedder: Embedder | None) -> None:
    global _current
    _current = embedder


def reset_embedder() -> None:
    set_embedder(None)


def build_embedder() -> Embedder:
    backend = requested_backend()
    if backend == "hash":
        return HashEmbedder()
    if backend == "fastembed":
        return FastEmbedEmbedder(requested_model())
    if backend not in {"", "auto"}:
        raise ValueError(f"不支持的 EMBEDDING_BACKEND: {backend}")
    try:
        import fastembed  # noqa: F401
    except ImportError:
        return HashEmbedder()
    return FastEmbedEmbedder(requested_model())


def embed_text(text: str) -> list[float]:
    return get_embedder().embed(text)


def _hash_embed(text: str, dimensions: int) -> list[float]:
    vector = [0.0] * dimensions
    terms = re.findall(r"[a-zA-Z][a-zA-Z0-9.+#-]*|[\u4e00-\u9fff]{1,4}", text.lower())
    for term in terms:
        digest = hashlib.blake2b(term.encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "little") % dimensions
        sign = 1.0 if digest[4] % 2 == 0 else -1.0
        vector[index] += sign
    return _normalize(vector)


def _normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]
