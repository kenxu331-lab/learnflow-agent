"""Tests for local authenticated page snapshot ingestion."""

import json

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
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
    monkeypatch.delenv("LEARNFLOW_LOCAL_API_TOKEN", raising=False)
    get_settings.cache_clear()

    response = post_snapshot(snapshot_payload())

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
