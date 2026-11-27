"""Independent final-work archives; all routes require an authenticated workspace."""
import sqlite3
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Path, Response

from ..artifacts import final_works
from ..extensions.contracts import ExtensionContext

router = APIRouter(prefix="/works/final", tags=["final works"])
Version = Annotated[int, Path(gt=0, le=2**63 - 1)]


def _execute(operation, *args):
    try:
        return operation(*args, ExtensionContext.current())
    except FileNotFoundError:
        raise HTTPException(404, "定稿或原始版本不存在") from None
    except PermissionError:
        raise HTTPException(403, "无权访问定稿") from None
    except final_works.FinalWorkConflict as exc:
        raise HTTPException(409, str(exc)) from None
    except final_works.FinalWorkTooLarge as exc:
        raise HTTPException(413, str(exc)) from None
    except final_works.FinalWorksFull as exc:
        raise HTTPException(507, str(exc)) from None
    except OSError:
        raise HTTPException(503, "定稿文件暂不可用，请检查存储后重试") from None
    except sqlite3.OperationalError as exc:
        if exc.sqlite_errorcode == sqlite3.SQLITE_FULL:
            raise HTTPException(507, "定稿归档存储空间不足") from None
        raise HTTPException(503, "定稿文件暂不可用，请检查存储后重试") from None


@router.get("")
def list_final_works():
    return {"items": _execute(final_works.list_works)}


@router.post("/documents/{document_id}/versions/{version}")
def archive_final_document(document_id: str, version: Version):
    return _execute(final_works.archive_document, document_id, version)


@router.post("/artifacts/{artifact_id}/versions/{version}")
def archive_final_presentation(artifact_id: str, version: Version):
    return _execute(final_works.archive_presentation, artifact_id, version)


@router.get("/{id}/file")
def download_final_work(id: str):
    filename, media_type, payload = _execute(final_works.download_work, id)
    return Response(payload, media_type=media_type, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename, safe='')}",
        "X-Content-Type-Options": "nosniff",
    })
