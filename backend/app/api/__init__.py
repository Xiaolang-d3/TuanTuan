from fastapi import APIRouter

from . import authentication, attachments, chat, conversations, home, library, memory, model, qq_login, speech, system, weixin

router = APIRouter()
from . import extensions
router.include_router(extensions.router)
from . import artifacts, creation_records, final_works, jobs, model_selection, presentations, projects, studio_generate, studio_library
router.include_router(creation_records.router)
router.include_router(projects.router)
router.include_router(studio_generate.router)
router.include_router(studio_library.router)
router.include_router(jobs.router)
router.include_router(artifacts.router)
router.include_router(final_works.router)
router.include_router(presentations.router)
router.include_router(model_selection.router)
for module in (authentication, attachments, chat, conversations, home, library, memory, model, qq_login, speech, system, weixin):
    router.include_router(module.router)

__all__ = ["router"]
