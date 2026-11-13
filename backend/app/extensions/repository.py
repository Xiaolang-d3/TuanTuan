from __future__ import annotations

import hashlib
import json
import uuid

from ..db import connect
from .contracts import ExtensionContext


class ExtensionNotFound(ValueError):
    pass


class ExtensionUnavailable(ValueError):
    pass


def _decode(row, *, detail: bool = False) -> dict:
    item = json.loads(row["metadata_json"])
    item.update(id=row["id"], kind=row["kind"], revision=row["revision"], enabled=bool(row["enabled"]), status=row["status"])
    if detail:
        item["content"] = row["content"]
    return item


class ExtensionRepository:
    def list(self, context: ExtensionContext) -> list[dict]:
        context.check_workspace()
        with connect() as conn:
            rows = conn.execute("SELECT * FROM extension_catalog WHERE deleted=0 ORDER BY json_extract(metadata_json, '$.source') = 'builtin', created_at, id")
            return [_decode(row) for row in rows]

    def get(self, item_id: str, context: ExtensionContext, *, revision: str | None = None, include_deleted: bool = False) -> dict:
        context.check_workspace()
        with connect() as conn:
            row = conn.execute("SELECT * FROM extension_catalog WHERE id=?", (item_id,)).fetchone()
        if row is None or (row["deleted"] and not include_deleted) or (revision is not None and row["revision"] != revision):
            raise ExtensionNotFound("扩展不存在或原版本不可用")
        return _decode(row, detail=True)

    def add(self, kind: str, metadata: dict, content: str, files: dict[str, bytes], context: ExtensionContext) -> dict:
        context.check_workspace()
        item_id = uuid.uuid4().hex
        digest = hashlib.sha256(content.encode())
        for path, data in sorted(files.items()):
            digest.update(path.encode()); digest.update(hashlib.sha256(data).digest())
        revision = digest.hexdigest()
        metadata = {"source": "user", **metadata}
        status = "dependency_missing" if metadata.get("unavailable_reason") else "installed"
        with connect() as conn:
            conn.execute("INSERT INTO extension_catalog(id,kind,revision,metadata_json,content,status) VALUES(?,?,?,?,?,?)", (item_id, kind, revision, json.dumps(metadata, ensure_ascii=False), content, status))
            conn.executemany("INSERT INTO extension_files(extension_id,path,content) VALUES(?,?,?)", [(item_id, path, data) for path, data in files.items()])
        return self.get(item_id, context)

    def seed_builtin(self, kind: str, item_id: str, metadata: dict, content: str, *, db_path=None) -> None:
        """Create or refresh a packaged extension without taking ownership.

        enabled/deleted stay untouched after the first install so a user's
        choice survives application upgrades.
        """
        digest = hashlib.sha256(content.encode())
        revision = digest.hexdigest()
        payload = json.dumps({"source": "builtin", **metadata}, ensure_ascii=False)
        with connect(db_path) as conn:
            row = conn.execute("SELECT revision, deleted FROM extension_catalog WHERE id=?", (item_id,)).fetchone()
            if row is None:
                conn.execute(
                    "INSERT INTO extension_catalog(id,kind,revision,metadata_json,content,enabled,status) VALUES(?,?,?,?,?,1,'installed')",
                    (item_id, kind, revision, payload, content),
                )
            elif not row["deleted"] and row["revision"] != revision:
                conn.execute(
                    "UPDATE extension_catalog SET revision=?, metadata_json=?, content=?, status='installed' WHERE id=?",
                    (revision, payload, content, item_id),
                )

    def set_enabled(self, item_id: str, enabled: bool, context: ExtensionContext) -> dict:
        item = self.get(item_id, context)
        if enabled and item["status"] != "installed":
            raise ExtensionUnavailable(item.get("unavailable_reason") or "扩展依赖尚未就绪")
        with connect() as conn:
            conn.execute("UPDATE extension_catalog SET enabled=? WHERE id=? AND deleted=0", (int(enabled), item_id))
        return self.get(item_id, context)

    def remove(self, item_id: str, context: ExtensionContext) -> None:
        self.get(item_id, context)
        with connect() as conn:
            # Retain immutable revisions for a run that already bound them.
            conn.execute("UPDATE extension_catalog SET enabled=0, deleted=1 WHERE id=?", (item_id,))

    def resource(self, item_id: str, path: str, context: ExtensionContext) -> bytes:
        self.get(item_id, context)
        with connect() as conn:
            row = conn.execute("SELECT content FROM extension_files WHERE extension_id=? AND path=?", (item_id, path)).fetchone()
        if row is None:
            raise ExtensionNotFound("资源不存在")
        return bytes(row[0])
