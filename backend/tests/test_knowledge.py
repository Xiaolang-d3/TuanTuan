import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.db import init_db
from app.knowledge import (
    delete_document,
    index_document,
    knowledge_index_info,
    reset_embedder,
    search_knowledge,
    set_embedder,
)
from app.knowledge.embeddings import EmbeddingSpec, HashEmbedder, embed_text
from app.library.repository import save_metadata
from app.library.sources import create_text_source


class ResumeKnowledgeWiringTest(unittest.TestCase):
    """Guard the profile-save to evidence-search chain.

    The index write was once dropped from the profile save path, which left
    search_resume_evidence reading an always-empty table and reporting zero
    evidence as a success.
    """

    def test_saving_resume_makes_evidence_searchable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "profile.db"
            init_db(db_path)
            save_metadata(name="测试候选人", db_path=db_path)

            create_text_source(
                title="候选人简历",
                content="使用 Python 和 FastAPI 构建本地求职 Agent，负责检索与评估模块。",
                enabled=True,
                db_path=db_path,
            )

            results = search_knowledge("FastAPI 检索", ["library_source"], 3, db_path)
            self.assertTrue(results, "保存简历后应能检索到简历证据")
            self.assertEqual(results[0]["source_type"], "library_source")
            self.assertEqual(results[0]["source_id"], str(1))
            self.assertIn("FastAPI", results[0]["content"])

    def test_documents_are_indexed_without_career_classification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "profile.db"
            init_db(db_path)
            save_metadata(name="测试候选人", db_path=db_path)
            create_text_source(
                title="候选人简历",
                content="项目经历\n检索平台\n- 使用 FastAPI 做本地检索。",
                enabled=True,
                db_path=db_path,
            )
            results = search_knowledge("FastAPI", ["library_source"], 3, db_path)
            self.assertTrue(results)
            metadata = results[0].get("metadata") or {}
            self.assertTrue(metadata["block_id"])
            self.assertTrue(metadata["source_revision"])
            self.assertNotIn("kind", metadata)

    def test_indexed_resume_text_is_redacted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "profile.db"
            init_db(db_path)
            save_metadata(name="测试候选人", db_path=db_path)

            create_text_source(
                title="候选人简历",
                content="联系邮箱 secret.person@example.com，负责 FastAPI 服务开发。",
                enabled=True,
                db_path=db_path,
            )

            results = search_knowledge("FastAPI 服务", ["library_source"], 3, db_path)
            self.assertTrue(results)
            indexed = " ".join(result["content"] for result in results)
            self.assertNotIn("secret.person@example.com", indexed)


class KnowledgeTest(unittest.TestCase):
    def test_local_vector_knowledge_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "knowledge.db"
            init_db(db_path)
            count = index_document(
                "library_source", 1, "脱敏简历",
                "使用 Python 和 FastAPI 构建本地求职 Agent，并通过 Docker 部署。",
                db_path=db_path,
            )
            self.assertEqual(count, 1)

            results = search_knowledge("Python Agent", ["library_source"], 3, db_path)
            self.assertTrue(results)
            self.assertEqual(results[0]["source_type"], "library_source")
            self.assertIn("Python", results[0]["content"])

            self.assertEqual(delete_document("library_source", 1, db_path), 1)
            self.assertEqual(search_knowledge("Python Agent", ["library_source"], 3, db_path), [])


class PhraseEmbedder:
    def __init__(self, mapping: dict[str, list[float]], dimensions: int = 8) -> None:
        self.spec = EmbeddingSpec("test", "phrase", dimensions)
        self.mapping = mapping
        self.dimensions = dimensions

    def embed(self, text: str) -> list[float]:
        for key, vector in self.mapping.items():
            if key in text:
                return list(vector)
        vector = [0.0] * self.dimensions
        vector[-1] = 1.0
        return vector

    def embed_many(self, texts: list[str]) -> list[list[float]]:
        return [self.embed(text) for text in texts]


class SemanticKnowledgeTest(unittest.TestCase):
    def tearDown(self) -> None:
        reset_embedder()

    def test_injected_embedder_ranks_paraphrase_above_unrelated_text(self) -> None:
        service = [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        sales = [0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        query = [0.96, 0.04, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
        set_embedder(
            PhraseEmbedder(
                {
                    "微服务": service,
                    "分布式服务": query,
                    "销售管理": sales,
                }
            )
        )
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "knowledge.db"
            init_db(db_path)
            index_document("library_source", 1, "服务经历", "负责 FastAPI 与微服务接口开发。", db_path=db_path)
            index_document("library_source", 2, "销售经历", "负责线下门店销售管理与客情维护。", db_path=db_path)

            results = search_knowledge("分布式服务架构", ["library_source"], 2, db_path)
            self.assertEqual(results[0]["source_id"], "1")
            self.assertIn("微服务", results[0]["content"])
            self.assertGreater(results[0]["similarity"], results[1]["similarity"])

    def test_dimension_change_rebuilds_existing_index(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            db_path = Path(directory) / "knowledge.db"
            init_db(db_path)
            index_document("library_source", 1, "脱敏简历", "使用 Python 构建本地检索。", db_path=db_path)
            self.assertEqual(knowledge_index_info(db_path)["table_dimensions"], 256)

            set_embedder(PhraseEmbedder({"Python": [1.0, 0.0, 0.0, 0.0]}, dimensions=4))
            results = search_knowledge("Python", ["library_source"], 1, db_path)
            self.assertTrue(results)
            info = knowledge_index_info(db_path)
            self.assertEqual(info["table_dimensions"], 4)
            self.assertEqual(info["stored"]["backend"], "test")
            self.assertEqual(info["stored"]["dimensions"], 4)

    def test_fastembed_backend_requests_chinese_bge(self) -> None:
        fake_model = MagicMock()
        fake_model.embed.return_value = iter([[0.2] * 512])
        with patch.dict(
            os.environ,
            {"EMBEDDING_BACKEND": "fastembed", "EMBEDDING_MODEL": "BAAI/bge-small-zh-v1.5"},
            clear=False,
        ):
            reset_embedder()
            constructor = MagicMock(return_value=fake_model)
            with patch.dict(sys.modules, {"fastembed": SimpleNamespace(TextEmbedding=constructor)}):
                vector = embed_text("微服务接口")
        self.assertEqual(len(vector), 512)
        constructor.assert_called_once()
        self.assertEqual(constructor.call_args.kwargs["model_name"], "BAAI/bge-small-zh-v1.5")

    def test_hash_backend_stays_deterministic(self) -> None:
        reset_embedder()
        self.assertIsInstance(embed_text("FastAPI"), list)
        first = HashEmbedder().embed("FastAPI 检索")
        second = HashEmbedder().embed("FastAPI 检索")
        self.assertEqual(first, second)
        self.assertEqual(len(first), 256)
