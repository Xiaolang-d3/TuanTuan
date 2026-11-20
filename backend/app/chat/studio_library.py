"""Account-local studio history (read only) and explicit, independent work archives."""
from __future__ import annotations

import json
import shutil
from hashlib import sha256
from uuid import uuid4

from ..db import connect, json_dump
from ..library.sources import _safe_filename, get_source_file
from .artifacts import ArtifactConflict, write_archive_snapshot
from .image_assets import asset_file

# A process restart loses a live connection, not evidence that the upstream
# rejected a billable operation. Reading never triggers a provider request.


# Actual assets outrank stale submission state (e.g. crash after persist_images
# committed). A done operation whose images were removed by a chat rewind is
# no longer a work to display. Status filtering happens BEFORE pagination.
_HISTORY = """SELECT t.id,t.prompt,t.size,t.profile_id,t.model_name,
  CASE WHEN EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id=t.id) THEN 'done'
       WHEN t.status='running' AND t.id IS NOT ? THEN 'uncertain'
       ELSE t.status END AS display_status,
  t.created_at,t.conversation_id,t.error,t.source_asset_id
  FROM image_studio_tasks t WHERE (t.status!='done' OR EXISTS (
      SELECT 1 FROM chat_image_assets a WHERE a.operation_id=t.id))"""


def _history_rows(*, task_id=None, limit=1, offset=0, q='', status=None):
    conditions = []
    from .studio_generate import current_task_id
    args = [current_task_id()]  # snapshot the in-flight slot before opening a read transaction
    if task_id is not None:
        conditions.append('t.id=?')
        args.append(task_id)
    if q.strip():
        conditions.append('instr(lower(t.prompt),lower(?))>0')
        args.append(q.strip())
    projection = _HISTORY + ''.join(' AND '+where for where in conditions)
    query = 'SELECT * FROM (' + projection + ')'
    if status:
        query += ' WHERE display_status=?'
        args.append(status)
    query += ' ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?'
    with connect() as conn:
        conn.execute('BEGIN')  # status and assets come from one snapshot
        tasks = [dict(row) for row in conn.execute(query, (*args,limit,offset))]
        if not tasks:
            return []
        by_id = {t['id']: t for t in tasks}
        for task in tasks:
            # Both datetime('now') and the v45 fractional default are UTC.
            task['created_at'] = task['created_at'].replace(' ', 'T') + 'Z'
            task['assets'] = []
            task['status'] = task.pop('display_status')
            if task['status'] == 'done' or not task['error']:
                task['error'] = None
            if task['status'] == 'uncertain' and not task['error']:
                task['error'] = '暂未确认生成结果；未自动重新提交。'
        placeholders = ','.join('?' for _ in tasks)
        for operation in conn.execute(f'SELECT id,selection_json FROM chat_image_operations WHERE id IN ({placeholders})', tuple(by_id)):
            selection = json.loads(operation['selection_json'])
            for field in ('service_name', 'selection_reason'):
                if field in selection:
                    by_id[operation['id']][field] = selection[field]
        for asset in conn.execute(f'SELECT operation_id,metadata_json FROM chat_image_assets '
                                  f'WHERE operation_id IN ({placeholders}) ORDER BY rowid', tuple(by_id)):
            by_id[asset['operation_id']]['assets'].append(json.loads(asset['metadata_json']))
    return tasks


def history(*, limit: int = 24, offset: int = 0, q: str = '', status: str | None = None) -> dict:
    rows = _history_rows(limit=limit+1, offset=offset, q=q, status=status)
    return {'items': rows[:limit], 'has_more': len(rows)>limit}


def history_item(task_id: str) -> dict | None:
    rows = _history_rows(task_id=task_id)
    return rows[0] if rows else None


_WORKS = """SELECT w.id,w.asset_json,strftime('%Y-%m-%dT%H:%M:%fZ',w.created_at) created_at,w.source_id,
    json_extract(s.metadata_json,'$.organization.trashed_at') AS trashed
    FROM image_studio_works w JOIN library_sources s ON s.id=w.source_id"""


def _work(row) -> dict:
    return {'id': row['id'], 'asset': json.loads(row['asset_json']), 'created_at': row['created_at']}


def list_works() -> dict:
    with connect() as conn:
        rows = conn.execute(_WORKS + ' WHERE trashed IS NULL ORDER BY w.created_at DESC,w.id DESC')
        return {'items': [_work(row) for row in rows]}


def archive_work(asset_id: str) -> dict:
    # One write transaction covers receipt lookup, independent library file
    # and unique link. It also serializes against deletion of the chat image.
    with connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        previous = conn.execute(_WORKS+' WHERE w.asset_id=?', (asset_id,)).fetchone()
        if previous:
            if previous['trashed']:
                raise ArtifactConflict('该作品已移入文件库回收站，请先恢复')
            return _work(previous)
        row = conn.execute('SELECT a.metadata_json,a.conversation_id,a.message_id FROM chat_image_assets a '
                           'JOIN image_studio_tasks t ON t.id=a.operation_id WHERE a.id=?', (asset_id,)).fetchone()
        if not row:
            raise ValueError('工作台图片不存在')
        meta = json.loads(row['metadata_json'])
        path, filename, mime = asset_file(asset_id)
        data = path.read_bytes()
        if sha256(data).hexdigest() != meta['sha256']:
            raise ArtifactConflict('图片原文件已变化，未归档')
        work_id = uuid4().hex
        archive_meta = {'size_bytes': len(data), 'file_status': 'ready', 'text_parse_status': 'not_required',
                        'organization': {'folder_id': None},
                        'image_studio': {'id': work_id, 'asset_id': asset_id, 'conversation_id': row['conversation_id'],
                                         'message_id': row['message_id']},
                        'generated_image': {k: meta[k] for k in ('model_name','sha256','width','height')}}
        source_id, directory = write_archive_snapshot(conn, filename=_safe_filename(filename), mime_type=mime,
            source_uri=f'image-studio:{work_id}', text='', data=data, metadata=archive_meta, enabled=False)
        try:
            conn.execute('INSERT INTO image_studio_works (id,asset_id,source_id,asset_json) VALUES (?,?,?,?)',
                         (work_id,asset_id,source_id,json_dump(meta)))
            result = _work(conn.execute(_WORKS+' WHERE w.id=?', (work_id,)).fetchone())
            conn.commit()
        except Exception:
            shutil.rmtree(directory, ignore_errors=True)
            raise
    return result


def work_file(work_id: str):
    with connect() as conn:
        row = conn.execute(_WORKS+' WHERE w.id=? AND trashed IS NULL', (work_id,)).fetchone()
        if not row:
            raise ValueError('作品不存在')
    return get_source_file(row['source_id'])
