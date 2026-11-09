from __future__ import annotations

from ...branding import env

import hashlib
import json
import os
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path
from uuid import uuid4

from cryptography.fernet import Fernet


class WeixinStore:
    """Per-workspace encrypted credentials and durable inbound/outbound queue."""

    def __init__(self, root: Path):
        self.root = Path(root) / ".weixin"
        self.path = self.root / "channel.sqlite3"
        self.on_change = None

    @contextmanager
    def connect(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with closing(sqlite3.connect(self.path, timeout=10)) as conn, conn:
            conn.row_factory = sqlite3.Row
            conn.execute("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            conn.execute("""CREATE TABLE IF NOT EXISTS inbox (
                id TEXT PRIMARY KEY, payload TEXT NOT NULL, reply TEXT,
                status TEXT NOT NULL DEFAULT 'pending', delivered_parts INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")
            yield conn
            changed = conn.total_changes > 0
        # Notify only after successful commit and handle release.
        if changed and self.on_change:
            self.on_change()

    def _cipher(self) -> Fernet:
        master = (env("TUANTUAN_SECRET_MASTER_KEY") or "").strip()
        if (env("TUANTUAN_DEPLOYMENT_MODE") or "local") == "hosted":
            if not master:
                raise ValueError("托管模式连接微信需配置 TUANTUAN_SECRET_MASTER_KEY")
            return Fernet(master.encode())
        path = self.root / "credential.key"
        if not path.exists():
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
                    stream.write(Fernet.generate_key())
            except FileExistsError:
                pass
        return Fernet(path.read_bytes())

    def _seal(self, value) -> str:
        return self._cipher().encrypt(json.dumps(value, ensure_ascii=False).encode()).decode()

    def _open(self, value: str):
        return json.loads(self._cipher().decrypt(value.encode()))

    def get(self, key: str, default=None):
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key: str, value) -> None:
        with self.connect() as conn:
            conn.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, json.dumps(value)))

    def account(self) -> dict | None:
        value = self.get("account")
        return self._open(value) if value else None

    def bind(self, account: dict) -> None:
        encrypted = self._seal(account)
        previous = self.account()
        if previous and all(previous.get(key) == account.get(key) for key in ("ilink_bot_id", "ilink_user_id")):
            with self.connect() as conn:
                conn.executemany("INSERT OR REPLACE INTO settings VALUES (?,?)", [
                    ("account", json.dumps(encrypted)), ("enabled", "true"), ("error", '""')])
            return
        with self.connect() as conn:
            conn.execute("DELETE FROM inbox")
            conn.execute("DELETE FROM settings")
            conn.executemany("INSERT INTO settings VALUES (?,?)", [("account", json.dumps(encrypted)), ("enabled", "true"), ("binding_id", json.dumps(uuid4().hex))])

    def disconnect(self) -> None:
        with self.connect() as conn:
            conn.execute("DELETE FROM inbox")
            conn.execute("DELETE FROM settings")

    def cursor(self) -> str:
        return self.get("cursor", "")

    def message_state(self) -> dict:
        with self.connect() as conn:
            conn.execute("BEGIN")
            settings = {row['key']: json.loads(row['value']) for row in conn.execute(
                "SELECT key,value FROM settings WHERE key IN ('read_sequence','binding_id')")}
            row = conn.execute("""SELECT COUNT(CASE WHEN rowid > ? THEN 1 END) AS unread_count,
                COALESCE(MAX(rowid),0) AS latest_sequence,
                COALESCE(MAX(CASE WHEN reply IS NOT NULL THEN rowid END),0) AS readable_sequence
                FROM inbox""", (settings.get('read_sequence', 0),)).fetchone()
        return {**dict(row), 'binding_id': settings.get('binding_id', ''), 'read_sequence': settings.get('read_sequence', 0)}

    def mark_read(self, through_sequence: int, binding_id: str | None = None) -> dict:
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            settings = {row['key']: json.loads(row['value']) for row in conn.execute(
                "SELECT key,value FROM settings WHERE key IN ('read_sequence','binding_id')")}
            if binding_id is not None and binding_id != settings.get('binding_id', ''):
                raise ValueError('微信绑定已变更，请刷新后重试')
            readable = conn.execute("SELECT COALESCE(MAX(rowid),0) FROM inbox WHERE reply IS NOT NULL").fetchone()[0]
            watermark = max(settings.get('read_sequence', 0), min(through_sequence, readable))
            conn.execute("INSERT OR REPLACE INTO settings VALUES ('read_sequence',?)", (json.dumps(watermark),))
        return self.message_state()

    def receive(self, messages: list[dict], cursor: str) -> None:
        binding_id = self.get("binding_id", "unbound")
        with self.connect() as conn:
            for message in messages:
                identity = message.get("message_id") or message.get("client_id") or message.get("seq")
                canonical = json.dumps(message, sort_keys=True, ensure_ascii=False)
                key = hashlib.sha256((binding_id + ":" + str(identity if identity is not None else canonical)).encode()).hexdigest()
                conn.execute("INSERT OR IGNORE INTO inbox(id,payload) VALUES (?,?)", (key, self._seal(message)))
            if cursor:
                conn.execute("INSERT OR REPLACE INTO settings VALUES ('cursor',?)", (json.dumps(cursor),))

    def next_job(self) -> dict | None:
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM inbox WHERE status != 'done' ORDER BY rowid LIMIT 1").fetchone()
        if row is None:
            return None
        job = dict(row)
        job["message"] = self._open(job.pop("payload"))
        return job

    def save_reply(self, job_id: str, reply: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE inbox SET reply=?,status='reply' WHERE id=?", (reply, job_id))

    def started(self, job_id: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE inbox SET status='running' WHERE id=?", (job_id,))

    def sent_part(self, job_id: str, count: int) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE inbox SET delivered_parts=? WHERE id=?", (count, job_id))

    def delivered(self, job_id: str) -> None:
        with self.connect() as conn:
            conn.execute("UPDATE inbox SET status='done' WHERE id=?", (job_id,))
