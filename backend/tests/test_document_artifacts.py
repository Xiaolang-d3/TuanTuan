"""Saved document identity, immutable versions and account-owned resources."""
import base64
import hashlib
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from threading import Barrier

import pytest
from PIL import Image

from app import db
from app.artifacts.documents import DocumentConflict, DocumentNotFound, DocumentStore
from app.chat.artifacts import message_artifacts
from app.chat.conversations import delete_conversation
from app.chat.image_assets import asset_file, begin_generation, persist_images
from app.chat.service import save_chat_message
from app.documents.blocks import DocumentTarget, text_document
from app.domain import ModelResponse
from app.domain.agent import ModelImageOutput
from app.extensions.contracts import ExtensionContext
from app.library.evidence import evidence_for_target
from app.library.source_versions import save_source_version
from app.library.sources import create_text_source, get_source_asset, get_source_file
from app.workspace import use_workspace


@pytest.fixture
def document(tmp_path):
    root = tmp_path / "owner"
    with use_workspace(1, root):
        db.init_db()
        context = ExtensionContext.current()
        source = create_text_source(title="核对依据", content="交付日期为十一月十日。", enabled=True)
        version = save_source_version(source["id"], text_document(source["content"]))
        card = evidence_for_target(DocumentTarget(source_kind="library", source_id=source["id"], source_revision=version["revision"]), version["blocks"][0]["block_id"])
        image = BytesIO()
        Image.new("RGB", (4, 3), "blue").save(image, format="PNG")
        begin_generation("document-fixture", 1, {})
        result = persist_images("document-fixture", ModelResponse(content="旧的拼接正文不应取代分块顺序。",
            images=[ModelImageOutput(item_id="image-one", base64_data=base64.b64encode(image.getvalue()).decode())],
            output_blocks=[{"type": "text", "text": f"# 开头\n\n日期结论 [[cite:{card['citation_id']}]]"}, {"type": "image", "index": 0}, {"type": "text", "text": "收尾段落。"}]), "fixture")
        message = save_chat_message("assistant", result["content"], payload={"agent": {"status": "done", **result,
            "evidence": [card], "citations": [{"citation_id": card["citation_id"], "status": "verified"}]}}, conversation_id=1)
        with db.connect() as conn:
            conn.execute("UPDATE chat_image_assets SET message_id=? WHERE operation_id=?", (message["id"], "document-fixture"))
        store = DocumentStore()
        request = {"conversation_id": 1, "message_id": message["id"], "snapshot": message_artifacts(message["id"])["snapshot"], "idempotency_key": "create-one", "context": context}
        yield {"root": root, "context": context, "store": store, "request": request, "card": card,
               "image": image.getvalue(), "original_asset": result["assets"][0]["id"]}


def test_snapshot_keeps_text_image_order_and_document_owned_resource(document):
    doc = document["store"].create(**document["request"])
    assert doc["version"] == 1 and len(doc["document_id"]) == 32
    resource = doc["resources"][0]
    assert doc["markdown"].index("# 开头") < doc["markdown"].index(resource["uri"]) < doc["markdown"].index("收尾段落。")
    assert "旧的拼接正文" not in doc["markdown"]
    assert resource["id"] != document["original_asset"] and resource["sha256"] == hashlib.sha256(document["image"]).hexdigest()
    assert "stored_path" not in str(doc)
    assert doc["message_id"] == document["request"]["message_id"] and doc["conversation_id"] == 1


def test_versions_are_immutable_and_retry_receipts_precede_compare_and_swap(document):
    store, context = document["store"], document["context"]
    first = store.create(**document["request"])
    edited = first["markdown"].replace("收尾段落。", "修改后的收尾。")
    second = store.save(first["document_id"], base_version=1, markdown=edited, idempotency_key="save-one", context=context)
    assert second["version"] == 2 and second["parent_document_version"] == 1
    assert store.get(first["document_id"], 1, context)["markdown"] == first["markdown"]
    assert store.save(first["document_id"], base_version=1, markdown=edited, idempotency_key="save-one", context=context) == second
    with pytest.raises(DocumentConflict):
        store.save(first["document_id"], base_version=1, markdown=edited + "变更", idempotency_key="save-one", context=context)
    with pytest.raises(DocumentConflict):
        store.save(first["document_id"], base_version=1, markdown="并发旧版本", idempotency_key="save-other", context=context)


def test_two_concurrent_saves_have_one_winner(document):
    first = document["store"].create(**document["request"])
    barrier = Barrier(2)
    def save(index):
        with use_workspace(1, document["root"]):
            barrier.wait()
            try:
                return document["store"].save(first["document_id"], base_version=1, markdown=f"写入 {index}", idempotency_key=f"race-{index}", context=ExtensionContext.current())["version"]
            except DocumentConflict:
                return "conflict"
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(save, (1, 2)), key=str) == [2, "conflict"]


def test_source_chat_deletion_does_not_delete_saved_document_or_images(document):
    store, context = document["store"], document["context"]
    first = store.create(**document["request"])
    delete_conversation(1)
    assert store.get(first["document_id"], 1, context)["message_id"] == document["request"]["message_id"]
    path, _, _ = store.resource(first["document_id"], first["resources"][0]["id"], context)
    assert path.read_bytes() == document["image"]
    assert store.create(**document["request"])["document_id"] == first["document_id"], "retry must not reread a deleted source"


def test_document_and_resource_reads_and_writes_are_account_scoped(document, tmp_path):
    first = document["store"].create(**document["request"])
    with use_workspace(2, tmp_path / "other"):
        db.init_db()
        context = ExtensionContext.current()
        with pytest.raises(DocumentNotFound):
            document["store"].get(first["document_id"], 1, context)
        with pytest.raises(DocumentNotFound):
            document["store"].resource(first["document_id"], first["resources"][0]["id"], context)
        with pytest.raises(DocumentNotFound):
            document["store"].save(first["document_id"], base_version=1, markdown="越权", idempotency_key="other", context=context)


@pytest.mark.parametrize("image", ["https://example.test/private.png", "file:///C:/private.png", "../outside.png", "data:image/png;base64,AAAA", "resources/" + "f" * 32 + ".png"])
def test_save_rejects_images_outside_the_version_manifest(document, image):
    first = document["store"].create(**document["request"])
    with pytest.raises(ValueError):
        document["store"].save(first["document_id"], base_version=1, markdown=f"![伪造图片]({image})", idempotency_key="bad-image", context=document["context"])


def test_known_citations_become_unverified_after_edit_and_removed_markers_are_unused(document):
    store, context = document["store"], document["context"]
    first = store.create(**document["request"])
    unknown = "e_" + "f" * 32
    second = store.save(first["document_id"], base_version=1, markdown=first["markdown"] + f"\n\n新增 [[cite:{unknown}]]", idempotency_key="citations", context=context)
    assert {c["citation_id"]: c["status"] for c in second["citations"]} == {document["card"]["citation_id"]: "unverified", unknown: "unverified"}
    third = store.save(first["document_id"], base_version=2, markdown="不再使用引用。", idempotency_key="remove-citations", context=context)
    assert third["citations"] == [] and third["resources"] == []
    assert store.get(first["document_id"], 1, context)["resources"]


def test_creation_does_not_trust_verified_status_for_an_unmapped_marker(document):
    import json
    unknown = "e_" + "f" * 32
    with db.connect() as conn:
        row = conn.execute("SELECT payload_json FROM chat_messages WHERE id=?", (document["request"]["message_id"],)).fetchone()
        payload = json.loads(row[0])
        payload["agent"]["output_blocks"][0]["text"] += f"\n\n伪造引用 [[cite:{unknown}]]"
        payload["agent"]["citations"].append({"citation_id": unknown, "status": "verified"})
        conn.execute("UPDATE chat_messages SET payload_json=? WHERE id=?", (db.json_dump(payload), document["request"]["message_id"]))
    request = {**document["request"], "snapshot": message_artifacts(document["request"]["message_id"])["snapshot"]}
    result = document["store"].create(**request)
    assert next(item for item in result["citations"] if item["citation_id"] == unknown)["status"] == "unverified"


def test_missing_original_and_tampered_document_resources_fail_without_silent_replacement(document):
    store, context = document["store"], document["context"]
    first = store.create(**document["request"])
    path, _, _ = store.resource(first["document_id"], first["resources"][0]["id"], context)
    path.write_bytes(b"changed")
    with pytest.raises(DocumentConflict):
        store.resource(first["document_id"], first["resources"][0]["id"], context)
    asset_file(document["original_asset"])[0].unlink()
    with pytest.raises((ValueError, FileNotFoundError)):
        store.create(**{**document["request"], "idempotency_key": "missing-original"})


def test_archive_uses_edited_exact_version_and_copies_its_images_idempotently(document):
    store, context = document["store"], document["context"]
    first = store.create(**document["request"])
    second = store.save(first["document_id"], base_version=1, markdown=first["markdown"].replace("收尾段落。", "归档精确版本。"), idempotency_key="edit", context=context)
    args = {"filename": "修改后的文档.md", "folder_id": None, "enabled": False, "idempotency_key": "archive", "context": context}
    archived = store.archive(first["document_id"], 2, **args)
    path, _, _ = get_source_file(archived["source"]["id"])
    assert "归档精确版本。" in path.read_text(encoding="utf-8") and "收尾段落。" not in path.read_text(encoding="utf-8")
    assert archived["source"]["metadata"]["document_archive"]["version"] == 2
    assert get_source_asset(archived["source"]["id"], second["resources"][0]["id"])[0].read_bytes() == document["image"]
    assert store.archive(first["document_id"], 2, **args)["source"]["id"] == archived["source"]["id"]


def test_continue_attachment_binds_selected_saved_version_not_latest_or_draft(document):
    store, context = document["store"], document["context"]
    first = store.create(**document["request"])
    store.save(first["document_id"], base_version=1, markdown="最新版本文字。", idempotency_key="edit", context=context)
    attachment = store.attach(first["document_id"], 1, conversation_id=1, idempotency_key="continue", context=context)
    assert attachment["metadata"]["document"] == {"document_id": first["document_id"], "version": 1}
    assert "收尾段落。" in attachment["parsed_text"] and "最新版本文字。" not in attachment["parsed_text"]
    assert store.attach(first["document_id"], 1, conversation_id=1, idempotency_key="continue", context=context)["id"] == attachment["id"]


def test_deleting_document_releases_resources_after_all_version_references(document):
    store, context = document["store"], document["context"]
    first = store.create(**document["request"])
    path, _, _ = store.resource(first["document_id"], first["resources"][0]["id"], context)
    store.save(first["document_id"], base_version=1, markdown="只剩文字。", idempotency_key="remove-image", context=context)
    assert path.is_file(), "the historical version still owns its image"
    store.delete(first["document_id"], context)
    assert not path.exists()
    with pytest.raises(DocumentNotFound):
        store.get(first["document_id"], 1, context)
