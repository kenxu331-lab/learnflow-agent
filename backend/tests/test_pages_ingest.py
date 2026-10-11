"""Tests for local authenticated page snapshot ingestion."""

import asyncio
import json

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app.core.auth import require_local_token
from app.core.config import Settings, get_settings
from app.core.middleware import INGEST_PATH, RequestSizeLimitMiddleware
from app.main import app

client = TestClient(app)
TOKEN = "test-local-token"
HOST_HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "Host": "127.0.0.1:8000",
}


def snapshot_payload() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "url": "https://example.com/tutorial",
        "title": "Tutorial",
        "capturedAt": "2026-10-11T00:00:00Z",
        "blocks": [
            {"id": "heading-1", "type": "heading", "text": "Intro", "level": 1},
            {"id": "paragraph-1", "type": "paragraph", "text": "你好😀"},
            {
                "id": "code-1",
                "type": "code",
                "text": "print('x')",
                "language": "python",
            },
            {"id": "list-1", "type": "list", "text": "one"},
        ],
        "extraction": {
            "strategy": "article",
            "truncated": False,
            "warnings": [],
        },
        "stats": {
            "characterCount": 22,
            "codeBlockCount": 1,
            "blockCount": 4,
        },
    }


@pytest.fixture(autouse=True)
def configured_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LEARNFLOW_LOCAL_API_TOKEN", TOKEN)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def post_snapshot(payload: object, **headers: str):
    request_headers = dict(HOST_HEADERS)
    request_headers.update(headers)
    return client.post("/api/v1/pages/ingest", json=payload, headers=request_headers)


def test_valid_snapshot_and_token_returns_validation_summary() -> None:
    response = post_snapshot(snapshot_payload())

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "validated"
    assert body["schemaVersion"] == 1
    assert body["stats"] == snapshot_payload()["stats"]
    assert "requestId" in body
    assert "blocks" not in body


@pytest.mark.parametrize("authorization", [None, "Bearer wrong-token", "Basic abc"])
def test_missing_or_wrong_token_returns_401(authorization: str | None) -> None:
    headers = dict(HOST_HEADERS)
    if authorization is None:
        headers.pop("Authorization")
    else:
        headers["Authorization"] = authorization

    response = client.post(
        "/api/v1/pages/ingest",
        json=snapshot_payload(),
        headers=headers,
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_local_token"


def test_unconfigured_token_returns_401(monkeypatch: pytest.MonkeyPatch) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(local_api_token=None)
    try:
        response = post_snapshot(snapshot_payload())
    finally:
        app.dependency_overrides.clear()

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "local_token_not_configured"


def test_invalid_json_returns_422_without_echoing_body() -> None:
    response = client.post(
        "/api/v1/pages/ingest",
        content='{"blocks":',
        headers=HOST_HEADERS,
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_json"
    assert "blocks" not in json.dumps(response.json())


def test_invalid_content_type_returns_415() -> None:
    headers = dict(HOST_HEADERS)
    headers["Content-Type"] = "text/plain"

    response = client.post(
        "/api/v1/pages/ingest",
        content=json.dumps(snapshot_payload()),
        headers=headers,
    )

    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"


def test_body_over_limit_returns_413() -> None:
    oversized = "x" * (512 * 1024 + 1)
    response = client.post(
        "/api/v1/pages/ingest",
        content=oversized,
        headers=HOST_HEADERS,
    )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "request_too_large"


def test_stats_mismatch_returns_422() -> None:
    payload = snapshot_payload()
    payload["stats"] = {"characterCount": 1, "codeBlockCount": 1, "blockCount": 4}

    response = post_snapshot(payload)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_payload"


def test_health_is_unchanged_without_authentication() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_non_local_host_is_rejected() -> None:
    response = post_snapshot(snapshot_payload(), Host="example.com:8000")

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_host"


def test_invalid_origin_is_rejected() -> None:
    response = post_snapshot(snapshot_payload(), Origin="https://evil.example")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "invalid_origin"


def test_chrome_extension_preflight_is_allowed() -> None:
    origin = "chrome-extension://" + ("a" * 32)
    response = client.options(
        "/api/v1/pages/ingest",
        headers={
            "Host": "127.0.0.1:8000",
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )

    assert response.status_code in {200, 204}
    assert response.headers["access-control-allow-origin"] == origin


def test_non_ascii_bearer_token_returns_401_not_500() -> None:
    request = Request(
        {
            "type": "http",
            "headers": [
                (b"authorization", "Bearer 密钥😀".encode()),
            ],
        }
    )

    with pytest.raises(HTTPException) as exception:
        require_local_token(request, Settings(local_api_token=TOKEN))

    assert exception.value.status_code == 401


def test_streaming_body_limit_without_content_length() -> None:
    async def run_test() -> list[dict[str, object]]:
        events: list[dict[str, object]] = []
        downstream_called = False
        messages = iter(
            [
                {
                    "type": "http.request",
                    "body": b"12345",
                    "more_body": True,
                },
                {
                    "type": "http.request",
                    "body": b"67890X",
                    "more_body": False,
                },
            ]
        )

        async def receive() -> dict[str, object]:
            return next(messages)

        async def send(message: dict[str, object]) -> None:
            events.append(message)

        async def downstream(scope, receive, send) -> None:
            nonlocal downstream_called
            downstream_called = True

        app = RequestSizeLimitMiddleware(downstream, max_bytes=10)
        await app(
            {
                "type": "http",
                "method": "POST",
                "path": INGEST_PATH,
                "headers": [(b"content-type", b"application/json")],
            },
            receive,
            send,
        )
        assert downstream_called is False
        return events

    events = asyncio.run(run_test())
    assert events[0]["status"] == 413
