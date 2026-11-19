"""Image studio read model and independent archives, under auth workspace middleware."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, Response

from ..chat.artifacts import ArtifactConflict
from ..chat.studio_library import archive_work, history, history_item, list_works, work_file

router = APIRouter()


@router.get('/image-studio/history')
def studio_history(limit: int = Query(24, ge=1, le=100), offset: int = Query(0, ge=0),
                   q: str = Query('', max_length=4000),
                   status: Literal['running','done','failed','uncertain'] | None = None):
    return history(limit=limit, offset=offset, q=q, status=status)


@router.get('/image-studio/tasks/{task_id}')
def studio_task(task_id: str):
    item = history_item(task_id)
    if item is None:
        raise HTTPException(404, '图片任务不存在')
    return item


@router.get('/image-studio/works')
def studio_works():
    return list_works()


@router.post('/image-studio/works/{asset_id}')
def save_work(asset_id: str):
    try:
        return archive_work(asset_id)
    except ArtifactConflict as exc:
        raise HTTPException(409, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    except OSError as exc:
        raise HTTPException(503, '作品文件未能归档，请检查存储后重试') from exc


@router.get('/image-studio/works/{work_id}/thumbnail')
def work_thumbnail(work_id: str):
    from ..chat.image_assets import image_file_thumbnail
    try:
        path, _, _ = work_file(work_id)
        data = image_file_thumbnail(path)
    except (ValueError, OSError) as exc:
        raise HTTPException(404, '作品预览不可用') from exc
    return Response(data, media_type='image/webp',
                    headers={'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'})


@router.get('/image-studio/works/{work_id}/file')
def download_work(work_id: str):
    try:
        path, filename, mime = work_file(work_id)
    except (ValueError, OSError) as exc:
        raise HTTPException(404, '作品文件不可用') from exc
    return FileResponse(path, filename=filename, media_type=mime,
                        headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'})
