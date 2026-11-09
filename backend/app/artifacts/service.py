from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import uuid
from contextlib import nullcontext
from pathlib import Path

from ..db import connect
from ..execution.workspace_files import WorkspaceFiles, reject_links, regular_file_stat, open_regular_file
from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobConflict, JobRepository
from ..workspace import current_workspace_root

MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
_MEDIA_TYPES = {".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8"}


_MEDIA_TYPES[".docx"] = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def public_artifact(item: dict) -> dict:
    return {key: value for key, value in item.items() if key not in {"relative_path", "user_id"}}


def digest_file(path: Path) -> tuple[str, int]:
    digest, size = hashlib.sha256(), 0
    with open_regular_file(path) as file:
        while chunk := file.read(64 * 1024):
            size += len(chunk)
            if size > MAX_ARTIFACT_BYTES:
                raise ValueError("文件成果超过 64 MB")
            digest.update(chunk)
    return digest.hexdigest(), size


class ArtifactService:
    def __init__(self, jobs: JobRepository | None = None):
        self.jobs = jobs or JobRepository()

    def root(self, context: ExtensionContext) -> Path:
        context.check_workspace()
        workspace = current_workspace_root()
        return WorkspaceFiles(workspace / "artifacts", boundary=workspace).root

    def get(self, artifact_id: str, version: int, context: ExtensionContext) -> dict:
        context.check_workspace()
        with connect() as conn:
            row = conn.execute("SELECT * FROM file_artifacts WHERE id=? AND version=?", (artifact_id, version)).fetchone()
        if row is None:
            raise FileNotFoundError("文件成果不存在")
        return dict(row)

    def list_for_job(self, job_id: str, context: ExtensionContext) -> list[dict]:
        self.jobs.get(job_id, context)
        with connect() as conn:
            return [dict(row) for row in conn.execute("SELECT * FROM file_artifacts WHERE job_id=? ORDER BY filename,version", (job_id,))]

    def resolve(self, artifact_id: str, version: int, context: ExtensionContext) -> Path:
        item = self.get(artifact_id, version, context)
        root = self.root(context)
        relative = f"{item['job_id']}/{artifact_id}/{version}/payload.bin"
        if item["relative_path"] != relative:
            raise FileNotFoundError("文件成果存储引用无效")
        path = root / relative
        reject_links(path, root)
        if not path.is_file() or digest_file(path) != (item["content_hash"], item["size"]):
            raise FileNotFoundError("文件成果缺失或校验失败")
        return path

    def _record_receipt(self, receipt: dict, context: ExtensionContext, connection=None) -> dict:
        context.check_workspace()
        if receipt["user_id"] != context.user_id:
            raise PermissionError("文件成果不属于当前用户")
        with nullcontext(connection) if connection is not None else connect() as conn:
            conn.execute("INSERT OR IGNORE INTO file_artifacts(id,version,job_id,filename,content_hash,size,media_type,relative_path) VALUES(?,?,?,?,?,?,?,?)", tuple(receipt[key] for key in ("id", "version", "job_id", "filename", "content_hash", "size", "media_type", "relative_path")))
            row = conn.execute("SELECT * FROM file_artifacts WHERE id=? AND version=?", (receipt["id"], receipt["version"])).fetchone()
            if row is None or any(row[key] != receipt[key] for key in ("job_id", "filename", "content_hash", "size", "relative_path")):
                raise JobConflict("成果收据与已保存版本冲突")
            return dict(row)

    def reconcile(self, job_id: str, token: str, context: ExtensionContext) -> list[dict]:
        self.jobs.get(job_id, context)
        root = self.root(context)
        job_root = root / job_id
        reject_links(job_root, root)
        if not job_root.is_dir():
            return []
        restored = []
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.jobs.assert_owner(conn, job_id, token)
            for path in sorted(job_root.glob("*/*/receipt.json")):
                reject_links(path, root)
                if path.stat().st_size > 16_000:
                    raise ValueError("成果收据过大")
                receipt = json.loads(path.read_text(encoding="utf-8"))
                if receipt.get("job_id") != job_id or receipt.get("user_id") != context.user_id or not re.fullmatch(r"[a-f0-9]{32}", str(receipt.get("id", ""))) or not isinstance(receipt.get("version"), int) or receipt["version"] < 1:
                    raise ValueError("成果收据身份无效")
                relative = f"{job_id}/{receipt['id']}/{receipt['version']}/payload.bin"
                if receipt.get("relative_path") != relative or path.parent != (root / relative).parent:
                    raise ValueError("成果收据路径无效")
                payload = root / relative
                reject_links(payload, root)
                if digest_file(payload) != (receipt["content_hash"], receipt["size"]):
                    raise ValueError("成果收据内容校验失败")
                restored.append(self._record_receipt(receipt, context, conn))
        return restored

    def publish(self, job_id: str, token: str, relative_path: str, filename: str, expected_hash: str, context: ExtensionContext, *, on_publish=None) -> dict:
        self.jobs.get(job_id, context)
        if not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
            raise ValueError("成果需要有效的 SHA-256 收据")
        if not filename.strip() or len(filename) > 180 or any(character in filename for character in "/\\:\r\n\x00") or filename in {".", ".."}:
            raise ValueError("成果文件名无效")
        if relative_path.endswith((".part", ".tmp")):
            raise ValueError("不能发布尚未完成的临时文件")
        self.reconcile(job_id, token, context)
        root = self.root(context)
        workspace = current_workspace_root()
        source = WorkspaceFiles(workspace / "jobs" / job_id, boundary=workspace).path(relative_path)
        staging_root = root / ".staging"
        reject_links(staging_root, root)
        staging_root.mkdir(exist_ok=True, mode=0o700)
        stage = staging_root / uuid.uuid4().hex
        stage.mkdir(mode=0o700)
        try:
            digest, size = hashlib.sha256(), 0
            before = regular_file_stat(source)
            with open_regular_file(source) as input_file, (stage / "payload.bin").open("xb") as output:
                while chunk := input_file.read(64 * 1024):
                    size += len(chunk)
                    if size > MAX_ARTIFACT_BYTES:
                        raise ValueError("文件成果超过 64 MB")
                    digest.update(chunk); output.write(chunk)
                output.flush(); os.fsync(output.fileno())
            after = regular_file_stat(source)
            if digest.hexdigest() != expected_hash or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ValueError("成果文件尚未稳定或与收据不一致")
            with connect() as conn:
                conn.execute("BEGIN IMMEDIATE")
                self.jobs.assert_owner(conn, job_id, token)
                existing = conn.execute("SELECT * FROM file_artifacts WHERE job_id=? AND filename=? AND content_hash=?", (job_id, filename, expected_hash)).fetchone()
                if existing is not None:
                    if on_publish is not None:
                        on_publish(conn, dict(existing))
                    return dict(existing)
                previous = conn.execute("SELECT id,MAX(version) AS version FROM file_artifacts WHERE job_id=? AND filename=? GROUP BY id", (job_id, filename)).fetchone()
                artifact_id, version = (previous["id"], previous["version"] + 1) if previous else (uuid.uuid4().hex, 1)
                relative = f"{job_id}/{artifact_id}/{version}/payload.bin"
                receipt = {"id": artifact_id, "version": version, "job_id": job_id, "user_id": context.user_id, "filename": filename, "content_hash": expected_hash, "size": size, "media_type": _MEDIA_TYPES.get(Path(filename).suffix.lower(), "application/octet-stream"), "relative_path": relative}
                with (stage / "receipt.json").open("x", encoding="utf-8") as file:
                    json.dump(receipt, file, ensure_ascii=False); file.flush(); os.fsync(file.fileno())
                final = root / relative
                reject_links(final, root)
                final.parent.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                # The directory rename publishes payload + receipt together. A
                # crash before the following SQLite commit is reconciled later.
                recorded = None
                if on_publish is not None:
                    recorded = self._record_receipt(receipt, context, conn)
                    on_publish(conn, recorded)
                stage.rename(final.parent)
                recorded = recorded or self._record_receipt(receipt, context, conn)
                self.jobs.event(conn, job_id, "artifact_published", {"artifact_id": artifact_id, "version": version})
                return recorded
        finally:
            # Only this call's validated staging directory may be removed.
            if stage.exists():
                reject_links(stage, root)
                if stage.resolve().parent != staging_root.resolve() or not re.fullmatch(r"[a-f0-9]{32}", stage.name):
                    raise ValueError("拒绝清理不属于本次发布的目录")
                shutil.rmtree(stage)
