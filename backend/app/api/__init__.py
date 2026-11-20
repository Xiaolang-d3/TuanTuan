from fastapi import APIRouter

from . import authentication, attachments, chat, conversations, home, library, memory, model, qq_login, speech, system, weixin

router = APIRouter()
from . import extensions
router.include_router(extensions.router)
from . import artifacts, jobs, presentations, model_selection
router.include_router(jobs.router)
router.include_router(artifacts.router)
router.include_router(presentations.router)
router.include_router(model_selection.router)
for module in (authentication, attachments, chat, conversations, home, library, memory, model, qq_login, speech, system, weixin):
    router.include_router(module.router)

__all__ = ["router"]
