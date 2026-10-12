"""FastAPI application entry point for LearnFlow Agent."""

from fastapi import FastAPI
from fastapi.exceptions import HTTPException, RequestValidationError
from fastapi.middleware.cors import CORSMiddleware

from app.api.ai_notes import router as ai_notes_router
from app.api.health import router as health_router
from app.api.notes import router as notes_router
from app.api.pages import router as pages_router
from app.core.config import get_settings
from app.core.errors import http_exception_handler, validation_exception_handler
from app.core.middleware import (
    LocalRequestMiddleware,
    RequestIdMiddleware,
    RequestSizeLimitMiddleware,
)

settings = get_settings()

app = FastAPI(
    debug=settings.debug,
    title=settings.app_name,
    version=settings.app_version,
)
app.add_exception_handler(HTTPException, http_exception_handler)
app.add_exception_handler(RequestValidationError, validation_exception_handler)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS"],
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
