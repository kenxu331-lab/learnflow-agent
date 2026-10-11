"""Stable JSON error responses for the local API."""

from uuid import uuid4

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException


def request_id(request: Request) -> str:
    return getattr(request.state, "request_id", str(uuid4()))


async def http_exception_handler(
    request: Request,
    exception: StarletteHTTPException,
) -> JSONResponse:
    detail = exception.detail
    if isinstance(detail, dict):
        code = str(detail.get("code", "http_error"))
        message = str(detail.get("message", "请求失败。"))
    else:
        code = "http_error"
        message = str(detail)
    return JSONResponse(
        status_code=exception.status_code,
        content={
            "error": {"code": code, "message": message},
            "requestId": request_id(request),
        },
        headers={"X-Request-ID": request_id(request)},
    )


async def validation_exception_handler(
    request: Request,
    exception: RequestValidationError,
) -> JSONResponse:
    error_types = [str(error.get("type", "invalid")) for error in exception.errors()]
    code = "invalid_json" if "json_invalid" in error_types else "invalid_payload"
    return JSONResponse(
        status_code=422,
        content={
            "error": {"code": code, "message": "请求 JSON 或字段结构无效。"},
            "requestId": request_id(request),
            "details": [{"type": error_type} for error_type in error_types],
        },
        headers={"X-Request-ID": request_id(request)},
    )
