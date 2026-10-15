"""FastAPI application entry point for LearnFlow Agent."""

import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import HTTPException, RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from app.api.ai_notes import router as ai_notes_router
from app.api.annotations import router as annotations_router
from app.api.archive import router as archive_router
from app.api.documents import router as documents_router
from app.api.health import router as health_router
from app.api.knowledge import router as knowledge_router
from app.api.knowledge import service as knowledge_service
from app.api.notes import router as notes_router
from app.api.pages import router as pages_router
from app.api.study import router as study_router
from app.api.study import service as study_service
from app.core.config import get_settings
from app.core.errors import http_exception_handler, validation_exception_handler
from app.core.middleware import (
    LocalRequestMiddleware,
    RequestIdMiddleware,
    RequestSizeLimitMiddleware,
)
from app.orchestrator import KnowledgePublishOrchestrator

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    stop = asyncio.Event()
    orchestrator = KnowledgePublishOrchestrator(settings, knowledge=knowledge_service)
    worker = asyncio.create_task(orchestrator.worker(stop))
    knowledge_tasks_worker = asyncio.create_task(
        study_service.knowledge_tasks.worker(stop)
    )
    try:
        yield
    finally:
        stop.set()
        worker.cancel()
        knowledge_tasks_worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass
        try:
            await knowledge_tasks_worker
        except asyncio.CancelledError:
            pass


app = FastAPI(
    debug=settings.debug,
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
)
app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
app.add_middleware(RequestIdMiddleware)
app.add_middleware(LocalRequestMiddleware, local_port=settings.local_port)
app.add_middleware(
    RequestSizeLimitMiddleware,
    max_bytes=settings.max_request_bytes,
)
app.include_router(health_router)
app.include_router(pages_router)
app.include_router(notes_router)
app.include_router(ai_notes_router)
app.include_router(annotations_router)
app.include_router(documents_router)
app.include_router(study_router)
app.include_router(archive_router)
app.include_router(knowledge_router)
