from fastapi import APIRouter, HTTPException

from ..chat.studio_generate import GenerateIn, StudioConflict, studio_options, submit
from ..secret_store import SecretStoreUnavailable

router = APIRouter()


@router.get("/image-studio/options")
def image_studio_options() -> dict:
    return studio_options()


@router.post("/image-studio/generate", status_code=202)
async def image_studio_generate(request: GenerateIn) -> dict:
    try:
        return {"id": await submit(request)}
    except StudioConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail="模型凭证不可用，请检查图片模型设置") from exc
