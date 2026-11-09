from contextlib import closing
from pathlib import Path
import sqlite3

from app.persistence import upgrades


def test_backup_releases_sqlite_handles_before_publishing_on_windows(tmp_path, monkeypatch):
    path = tmp_path / 'tuantuan.db'
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute('CREATE TABLE history (content TEXT)')
        conn.execute("INSERT INTO history VALUES ('保留历史消息')")
    connections = []
    real_connect, real_replace = sqlite3.connect, Path.replace

    class TrackedConnection(sqlite3.Connection):
        closed = False

        def close(self):
            super().close()
            self.closed = True

    def connect(*args, **kwargs):
        conn = real_connect(*args, **kwargs, factory=TrackedConnection)
        connections.append(conn)
        return conn

    def replace(source, target):
        # Model Windows' file sharing semantics on every test platform.
        assert connections and all(conn.closed for conn in connections), 'SQLite handles must close before renaming the backup'
        return real_replace(source, target)

    monkeypatch.setattr(upgrades.sqlite3, 'connect', connect)
    monkeypatch.setattr(Path, 'replace', replace)
    try:
        upgrades._backup(path, 'before-schema-test')
    finally:
        for conn in connections:
            conn.close()
    snapshot = path.parent / '.upgrade-backups' / 'before-schema-test' / path.name
    with closing(real_connect(snapshot)) as conn:
        assert conn.execute('SELECT content FROM history').fetchone()[0] == '保留历史消息'


def test_existing_pre_upgrade_snapshot_is_not_overwritten(tmp_path):
    path = tmp_path / 'tuantuan.db'
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute('CREATE TABLE history (content TEXT)')
        conn.execute("INSERT INTO history VALUES ('first')")
    upgrades._backup(path, 'before-schema-test')
    with closing(sqlite3.connect(path)) as conn, conn:
        conn.execute("INSERT INTO history VALUES ('second')")
    upgrades._backup(path, 'before-schema-test')
    snapshot = path.parent / '.upgrade-backups' / 'before-schema-test' / path.name
    with closing(sqlite3.connect(snapshot)) as conn:
        assert conn.execute('SELECT content FROM history').fetchall() == [('first',)]
