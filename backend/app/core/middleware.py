"""Request safety middleware for the local ingest endpoint."""

from __future__ import annotations

import json
import re
from urllib.parse import urlsplit
from uuid import uuid4

from starlette.types import ASGIApp, Message, Receive, Scope, Send

INGEST_PATH = "/api/v1/pages/ingest"
SECURED_POST_PATHS = {
    INGEST_PATH,
    "/api/v1/notes/preview",
    "/api/v1/notes/commit",
}


async def send_json_error(
    send: Send,
    status_code: int,
    code: str,
    message: str,
) -> None:
    body = json.dumps(
        {
            "error": {"code": code, "message": message},
            "requestId": str(uuid4()),
        },
        ensure_ascii=False,
    ).encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json; charset=utf-8"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class RequestIdMiddleware:
    """Attach a request ID without logging request content."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        state = dict(scope.get("state") or {})
        state["request_id"] = str(uuid4())
        request_scope = dict(scope)
        request_scope["state"] = state
        await self.app(request_scope, receive, send)


class LocalRequestMiddleware:
    """Apply narrow host, origin, and content-type checks to ingest requests."""

    def __init__(self, app: ASGIApp, local_port: int) -> None:
        self.app = app
        self.local_port = local_port

    @staticmethod
    def _headers(scope: Scope) -> dict[str, str]:
        return {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }

    def _allowed_host(self, host_header: str | None) -> bool:
        if not host_header:
            return False
        try:
            parsed = urlsplit(f"//{host_header}")
        except ValueError:
            return False
        if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
            return False
        return parsed.port in {None, self.local_port}

    @staticmethod
    def _allowed_origin(origin: str | None) -> bool:
        if not origin:
            return True
        try:
            parsed = urlsplit(origin)
        except ValueError:
            return False
        if parsed.scheme == "chrome-extension" and re.fullmatch(
            r"[a-p]{32}", parsed.netloc
        ):
            return True
        return (
            parsed.scheme in {"http", "https"}
            and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope.get("path") not in SECURED_POST_PATHS:
            await self.app(scope, receive, send)
            return

        headers = self._headers(scope)
        if not self._allowed_host(headers.get("host")):
            await send_json_error(
                send,
                400,
                "invalid_host",
                "请求 Host 不是允许的本地服务地址。",
            )
            return

        if not self._allowed_origin(headers.get("origin")):
            await send_json_error(
                send,
                403,
                "invalid_origin",
                "请求来源不是允许的本地扩展上下文。",
            )
            return

        if scope.get("method") == "POST":
            content_type = headers.get("content-type", "")
            if not content_type.lower().startswith("application/json"):
                await send_json_error(
                    send,
                    415,
                    "unsupported_media_type",
                    "请求必须使用 application/json。",
                )
                return

        await self.app(scope, receive, send)


class RequestSizeLimitMiddleware:
    """Limit ingest body bytes before FastAPI parses the JSON document."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (
            scope["type"] != "http"
            or scope.get("path") not in SECURED_POST_PATHS
            or scope.get("method") != "POST"
        ):
            await self.app(scope, receive, send)
            return

        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        content_length = headers.get("content-length")
        if (
            content_length
            and content_length.isdigit()
            and int(content_length) > self.max_bytes
        ):
            await send_json_error(
                send,
                413,
                "request_too_large",
                "请求体超过允许的大小限制。",
            )
            return

        body = bytearray()
        more_body = True
        while more_body:
            message = await receive()
            if message["type"] != "http.request":
                await self.app(scope, receive, send)
                return
            chunk = message.get("body", b"")
            if len(body) + len(chunk) > self.max_bytes:
                await send_json_error(
                    send,
                    413,
                    "request_too_large",
                    "请求体超过允许的大小限制。",
                )
                return
            body.extend(chunk)
            more_body = bool(message.get("more_body", False))

        sent = False

        async def replay_receive() -> Message:
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": bytes(body), "more_body": False}

        await self.app(scope, replay_receive, send)
