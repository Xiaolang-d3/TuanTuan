"""Explicitly saved documents, immutable versions and document-owned images."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from pathlib import Path

from markdown_it import MarkdownIt

from ..db import connect, json_dump
from ..workspace import resolve_document_dir

MAX_MARKDOWN = 200_000
MAX_RESOURCE_BYTES = 64 * 1024 * 1024
_parser = MarkdownIt("commonmark", {"html": True}).enable("table")
# Parse every URL into the AST so a rejected file:/javascript: image cannot
# hide as literal syntax. No HTML is rendered; our resource allowlist decides.
_parser.validateLink = lambda _url: True
_citation = re.compile(r"\[\[cite:(e_[0-9a-f]{32})\]\]")
_suffixes = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


class DocumentConflict(ValueError):
    pass


class DocumentNotFound(LookupError):
    pass


class _ExistingContinuation(Exception):
    def __init__(self, result):
        self.result = result


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _tokens(markdown):
    if not isinstance(markdown, str) or len(markdown) > MAX_MARKDOWN:
        raise ValueError("文档正文不能超过 20 万字")
    def walk(tokens):
        for token in tokens:
            yield token
            if token.children:
                yield from walk(token.children)
    return list(walk(_parser.parse(markdown)))


def _validate(markdown, resources):
    allowed = {resource["uri"]: resource["id"] for resource in resources}
    used, citations = [], []
    for token in _tokens(markdown):
        if token.type == "image":
            source = token.attrGet("src")
            if source not in allowed:
                raise ValueError("图片必须来自当前文档版本的资源清单，不能使用远程地址或任意路径")
            if allowed[source] not in used:
                used.append(allowed[source])
        if token.type in {"html_inline", "html_block"} and re.search(r"<\s*(?:img|picture|source|svg|iframe|object|embed)\b", token.content, re.I):
            raise ValueError("请使用文档资源的 Markdown 图片引用")
        if token.type == "text":
            for citation in _citation.findall(token.content):
                if citation not in citations:
                    citations.append(citation)
    return used, citations


def _index_text(markdown):
    return "\n".join(token.content for token in _tokens(markdown) if token.type in {"text", "code_inline", "fence", "code_block"}).strip()


def _directory(document_id):
    if not re.fullmatch(r"[0-9a-f]{32}", document_id):
        raise DocumentNotFound("文档不存在")
    storage = resolve_document_dir().resolve()
    root = storage / "authored-documents"
    target = root / document_id
    if root.is_symlink() or target.is_symlink() or not target.resolve().is_relative_to(storage):
        raise ValueError("文档资源目录不可用")
    return target


def _remove_directory(directory):
    storage = resolve_document_dir().resolve()
    base = storage / "authored-documents"
    root = base.resolve()
    if base.is_symlink() or not root.is_relative_to(storage) or directory.is_symlink() or directory.resolve() == root or not directory.resolve().is_relative_to(root):
        raise ValueError("文档资源目录不可用")
    shutil.rmtree(directory, ignore_errors=True)


def _read(path, expected_hash, limit=MAX_RESOURCE_BYTES):
    with path.open("rb") as stream:
        content = stream.read(limit + 1)
    if len(content) > limit or hashlib.sha256(content).hexdigest() != expected_hash:
        raise DocumentConflict("文档资源缺失或内容已变化，请核对保存版本")
    return content


class DocumentStore:
    @staticmethod
    def _receipt(conn, key, operation, request):
        if not isinstance(key, str) or not 1 <= len(key) <= 128:
            raise ValueError("请提供有效的幂等请求标识")
        row = conn.execute("SELECT * FROM authored_document_receipts WHERE idempotency_key=?", (key,)).fetchone()
        if row:
            if row["operation"] != operation or row["request_hash"] != _hash(request):
                raise DocumentConflict("相同请求标识不能用于不同的文档操作")
            return json.loads(row["result_json"])
        return None

    @staticmethod
    def _remember(conn, key, operation, request, result):
        conn.execute("INSERT INTO authored_document_receipts VALUES (?,?,?,?,CURRENT_TIMESTAMP)", (key, operation, _hash(request), json_dump(result)))

    @staticmethod
    def _version(conn, document_id, version):
        row = conn.execute("""SELECT d.id AS document_id,d.conversation_id,d.message_id,d.title,d.latest_version,d.incomplete,
            v.version,v.parent_document_version,v.markdown,v.evidence_json,v.citations_json,v.created_at
            FROM authored_documents d JOIN authored_document_versions v ON v.document_id=d.id
            WHERE d.id=? AND v.version=?""", (document_id, version)).fetchone()
        if row is None:
            raise DocumentNotFound("文档版本不存在")
        value = dict(row)
        value["incomplete"] = bool(value["incomplete"])
        value["evidence"] = json.loads(value.pop("evidence_json"))
        value["citations"] = json.loads(value.pop("citations_json"))
        value["resources"] = [dict(resource) for resource in conn.execute("""SELECT r.id,r.filename,r.mime_type,r.sha256,r.size_bytes,r.uri
            FROM authored_document_resources r JOIN authored_document_version_resources v ON v.resource_id=r.id AND v.document_id=r.document_id
            WHERE v.document_id=? AND v.version=? ORDER BY v.ordinal""", (document_id, version))]
        return value

    @staticmethod
    def _insert_version(conn, document_id, version, parent, markdown, evidence, statuses, resources):
        used, citations = _validate(markdown, resources)
        mapped = {item["citation_id"] for item in evidence if isinstance(item, dict) and item.get("citation_id")}
        relations = [{"citation_id": citation, "status": statuses.get(citation, "unverified") if citation in mapped else "unverified"} for citation in citations]
        conn.execute("INSERT INTO authored_document_versions (document_id,version,parent_document_version,markdown,evidence_json,citations_json) VALUES (?,?,?,?,?,?)",
            (document_id, version, parent, markdown, json_dump(evidence), json_dump(relations)))
        for ordinal, resource_id in enumerate(used):
            conn.execute("INSERT INTO authored_document_version_resources VALUES (?,?,?,?)", (document_id, version, resource_id, ordinal))

    def create(self, *, conversation_id, message_id, snapshot, idempotency_key, context):
        context.check_workspace()
        request = {"conversation_id": conversation_id, "message_id": message_id, "snapshot": snapshot}
        directory = None
        try:
            with connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                previous = self._receipt(conn, idempotency_key, "create", request)
                if previous:
                    return self._version(conn, previous["document_id"], previous["version"])
                message = conn.execute("SELECT role,conversation_id,payload_json FROM chat_messages WHERE id=?", (message_id,)).fetchone()
                if message is None or message["conversation_id"] != conversation_id or message["role"] != "assistant":
                    raise DocumentNotFound("回答不存在或不属于当前对话")
                from ..chat.artifacts import message_artifacts
                from ..chat.image_assets import asset_file
                manifest = message_artifacts(message_id)
                if manifest["snapshot"] != snapshot:
                    raise DocumentConflict("回答已更新，请重新打开成果后再创建文档")
                answer = next((item for item in manifest["artifacts"] if item["selector"] == "answer"), None)
                if answer is None:
                    raise ValueError("该回答没有可编辑的文档内容")
                markdown = answer["content"]
                document_id = uuid.uuid4().hex
                directory = _directory(document_id)
                directory.mkdir(parents=True, mode=0o700)
                resources, total = [], 0
                for asset in answer.get("assets", []):
                    path, _, mime_type = asset_file(asset["id"])
                    data = _read(path, asset["sha256"], MAX_RESOURCE_BYTES - total)
                    total += len(data)
                    if mime_type not in _suffixes:
                        raise ValueError("文档图片格式不受支持")
                    resource_id = uuid.uuid4().hex
                    suffix = _suffixes[mime_type]
                    uri = f"resources/{resource_id}{suffix}"
                    resource = {"id": resource_id, "uri": uri, "filename": asset["original_filename"], "mime_type": mime_type,
                        "sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}
                    target = directory / f"{resource_id}{suffix}"
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(data)
                        stream.flush()
                        os.fsync(stream.fileno())
                    markdown = markdown.replace(f"assets/{asset['id']}{Path(asset['original_filename']).suffix}", uri)
                    resources.append(resource)
                title = next((line.lstrip("# ").strip() for line in markdown.splitlines() if line.strip()), "文档")[:120]
                conn.execute("INSERT INTO authored_documents (id,conversation_id,message_id,title,incomplete) VALUES (?,?,?,?,?)",
                    (document_id, conversation_id, message_id, title, int(manifest["incomplete"])))
                for resource in resources:
                    conn.execute("INSERT INTO authored_document_resources VALUES (?,?,?,?,?,?,?)",
                        (resource["id"], document_id, resource["filename"], resource["mime_type"], resource["sha256"], resource["size_bytes"], resource["uri"]))
                statuses = {item["citation_id"]: item.get("status", "unverified") for item in (json.loads(message["payload_json"]).get("agent") or {}).get("citations", []) if isinstance(item, dict) and item.get("citation_id")}
                self._insert_version(conn, document_id, 1, None, markdown, manifest["sources"], statuses, resources)
                self._remember(conn, idempotency_key, "create", request, {"document_id": document_id, "version": 1})
                result = self._version(conn, document_id, 1)
            return result
        except Exception:
            if directory is not None:
                _remove_directory(directory)
            raise

    def get(self, document_id, version, context):
        context.check_workspace()
        with connect() as conn:
            return self._version(conn, document_id, version)

    def latest(self, document_id, context):
        context.check_workspace()
        with connect() as conn:
            row = conn.execute("SELECT latest_version FROM authored_documents WHERE id=?", (document_id,)).fetchone()
            if row is None:
                raise DocumentNotFound("文档不存在")
            return self._version(conn, document_id, row["latest_version"])

    def list(self, context):
        context.check_workspace()
        with connect() as conn:
            return [dict(row) for row in conn.execute("SELECT id AS document_id,title,latest_version,conversation_id,message_id,created_at FROM authored_documents ORDER BY created_at DESC,id")]

    def versions(self, document_id, context):
        context.check_workspace()
        with connect() as conn:
            if not conn.execute("SELECT 1 FROM authored_documents WHERE id=?", (document_id,)).fetchone():
                raise DocumentNotFound("文档不存在")
            return [dict(row) for row in conn.execute("SELECT version,parent_document_version,created_at FROM authored_document_versions WHERE document_id=? ORDER BY version DESC", (document_id,))]

    def save(self, document_id, *, base_version, markdown, idempotency_key, context):
        context.check_workspace()
        request = {"document_id": document_id, "base_version": base_version, "markdown": markdown}
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            previous = self._receipt(conn, idempotency_key, "save", request)
            if previous:
                return self._version(conn, document_id, previous["version"])
            base = self._version(conn, document_id, base_version)
            if base["latest_version"] != base_version:
                raise DocumentConflict("文档已有新版本；你的草稿已保留，请核对最新版本后再保存")
            for resource in base["resources"]:
                self.resource(document_id, resource["id"], context)
            next_version = base_version + 1
            self._insert_version(conn, document_id, next_version, base_version, markdown, base["evidence"], {}, base["resources"])
            conn.execute("UPDATE authored_documents SET latest_version=? WHERE id=? AND latest_version=?", (next_version, document_id, base_version))
            self._remember(conn, idempotency_key, "save", request, {"document_id": document_id, "version": next_version})
            return self._version(conn, document_id, next_version)

    def resource(self, document_id, resource_id, context):
        context.check_workspace()
        with connect() as conn:
            row = conn.execute("SELECT * FROM authored_document_resources WHERE document_id=? AND id=?", (document_id, resource_id)).fetchone()
        if row is None:
            raise DocumentNotFound("文档图片不存在")
        suffix = _suffixes.get(row["mime_type"])
        if suffix is None or not re.fullmatch(r"[0-9a-f]{32}", resource_id):
            raise DocumentConflict("文档图片清单无效")
        path = _directory(document_id) / f"{resource_id}{suffix}"
        if path.is_symlink() or not path.resolve().is_relative_to(_directory(document_id).resolve()):
            raise DocumentConflict("文档图片路径不可用")
        try:
            _read(path, row["sha256"])
        except FileNotFoundError:
            raise DocumentConflict("文档图片缺失，请核对保存版本") from None
        return path, row["filename"], row["mime_type"]

    def archive(self, document_id, version, *, filename, folder_id, enabled, idempotency_key, context):
        context.check_workspace()
        from ..chat.artifacts import write_archive_snapshot
        from ..library.sources import _safe_filename, get_source, _index_source
        from ..library.source_versions import save_source_version
        from ..documents.blocks import text_document
        request = {"document_id": document_id, "version": version, "filename": filename, "folder_id": folder_id, "enabled": enabled}
        directory = None
        try:
            with connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                previous = self._receipt(conn, idempotency_key, "archive", request)
                if previous:
                    source_id = previous["source_id"]
                    reused = True
                else:
                    doc = self._version(conn, document_id, version)
                    filename = _safe_filename(filename)
                    if Path(filename).suffix.lower() != ".md":
                        raise ValueError("请保留 Markdown 扩展名 .md")
                    if folder_id is not None and not conn.execute("SELECT 1 FROM library_folders WHERE id=?", (folder_id,)).fetchone():
                        raise ValueError("目标文件夹不存在")
                    markdown, copies = doc["markdown"], []
                    for resource in doc["resources"]:
                        path, _, mime_type = self.resource(document_id, resource["id"], context)
                        data = _read(path, resource["sha256"])
                        suffix = _suffixes[mime_type]
                        markdown = markdown.replace(resource["uri"], f"assets/{resource['id']}{suffix}")
                        copies.append(({"id": resource["id"], "original_filename": f"{resource['id']}{suffix}", "content_type": mime_type, "sha256": resource["sha256"]}, data))
                    text = _index_text(markdown)
                    if enabled and not text:
                        raise ValueError("该文档没有可检索文字，请只保存原文件")
                    data = markdown.encode("utf-8")
                    metadata = {"size_bytes": len(data), "file_status": "ready", "text_parse_status": "ready" if text else "not_required",
                        "organization": {"folder_id": folder_id}, "document_archive": {"document_id": document_id, "version": version,
                        "conversation_id": doc["conversation_id"], "message_id": doc["message_id"], "evidence": doc["evidence"], "citations": doc["citations"]}}
                    if copies:
                        metadata["chat_assets"] = [{**asset, "path": f"assets/{asset['original_filename']}"} for asset, _ in copies]
                    source_id, directory = write_archive_snapshot(conn, filename=filename, mime_type="text/markdown", source_uri=f"document:{document_id}/{version}",
                        text=text, data=data, metadata=metadata, enabled=enabled, copies=copies)
                    self._remember(conn, idempotency_key, "archive", request, {"source_id": source_id})
                    reused = False
        except Exception:
            if directory is not None and not directory.is_symlink() and directory.resolve().is_relative_to(resolve_document_dir().resolve()):
                shutil.rmtree(directory, ignore_errors=True)
            raise
        source = get_source(source_id)
        if source is None:
            raise DocumentNotFound("已归档文件不存在")
        if source["content"] and not source.get("source_revision"):
            save_source_version(source_id, text_document(source["content"], parser="authored_document_archive"))
            source = get_source(source_id)
        _index_source(source)
        return {"source": source, "reused": reused}

    def attach(self, document_id, version, *, conversation_id, idempotency_key, context):
        context.check_workspace()
        from ..attachments.service import create_attachment, get_attachment_metadata, parse_attachment
        document = self.get(document_id, version, context)
        request = {"document_id": document_id, "version": version, "conversation_id": conversation_id}
        with connect() as conn:
            previous = self._receipt(conn, idempotency_key, "attach", request)
        if previous is None:
            def publish(conn, attachment_id):
                self._version(conn, document_id, version)
                previous = self._receipt(conn, idempotency_key, "attach", request)
                if previous:
                    raise _ExistingContinuation(previous)
                row = conn.execute("SELECT metadata_json FROM attachments WHERE id=?", (attachment_id,)).fetchone()
                metadata = json.loads(row["metadata_json"])
                metadata["document"] = {"document_id": document_id, "version": version}
                conn.execute("UPDATE attachments SET metadata_json=? WHERE id=?", (json_dump(metadata), attachment_id))
                self._remember(conn, idempotency_key, "attach", request, {"attachment_id": attachment_id})
            try:
                created = create_attachment(conversation_id, "document", f"文档-v{version}.md", document["markdown"].encode("utf-8"), publish=publish)
                previous = {"attachment_id": created["id"]}
            except _ExistingContinuation as exc:
                previous = exc.result
        attachment = get_attachment_metadata(previous["attachment_id"])
        if attachment["conversation_id"] != conversation_id:
            raise DocumentConflict("文档附件不属于当前对话")
        if attachment["parse_status"] == "pending":
            parse_attachment(attachment["id"])
        return get_attachment_metadata(attachment["id"])

    def delete(self, document_id, context):
        context.check_workspace()
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            if not conn.execute("SELECT 1 FROM authored_documents WHERE id=?", (document_id,)).fetchone():
                raise DocumentNotFound("文档不存在")
            resources = [row[0] for row in conn.execute("SELECT id FROM authored_document_resources WHERE document_id=?", (document_id,))]
            conn.execute("DELETE FROM authored_documents WHERE id=?", (document_id,))
            remaining = any(conn.execute("SELECT 1 FROM authored_document_version_resources WHERE resource_id=?", (resource,)).fetchone() for resource in resources)
        if not remaining:
            _remove_directory(_directory(document_id))
        return {"deleted": True}
