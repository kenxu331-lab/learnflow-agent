"""S1 Study Chat streaming and Learning Memory tests."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.api import study as study_api
from app.core.config import Settings, get_settings
from app.learning_memory.store import LearningMemoryStore
from app.llm.openai_compatible import OpenAICompatibleProvider
from app.main import app
from app.study_chat.service import StudyChatService

TOKEN = "test-local-token"
HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "Host": "127.0.0.1:8000",
}


@pytest.fixture(autouse=True)
def configured_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LEARNFLOW_LOCAL_API_TOKEN", TOKEN)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def snapshot_payload(
    url: str = "https://fastapi.tiangolo.com/tutorial/dependencies/",
) -> dict:
    blocks = [
        {"id": "heading-1", "type": "heading", "text": "依赖注入", "level": 2},
        {
            "id": "code-1",
            "type": "code",
            "text": "Annotated[str, Form()]",
            "language": "python",
        },
    ]
    return {
        "schemaVersion": 1,
        "url": url,
        "title": "依赖注入教程",
        "capturedAt": "2026-10-13T00:00:00Z",
        "blocks": blocks,
        "extraction": {"strategy": "article", "truncated": False, "warnings": []},
        "stats": {
            "characterCount": sum(len(str(block["text"])) for block in blocks),
            "codeBlockCount": 1,
            "blockCount": 2,
        },
    }


def chat_payload(*, question: str, conversation_id: str = "conversation-test") -> dict:
    snapshot = snapshot_payload()
    return {
        "schemaVersion": 1,
        "conversationId": conversation_id,
        "sessionId": "session-test",
        "sourceUrl": snapshot["url"],
        "pageTitle": snapshot["title"],
        "headingPath": ["教程", "依赖注入"],
        "sourceNodeId": "code-1",
        "sourceFingerprint": "selection-1234",
        "selectedText": "Annotated[str, Form()]",
        "question": question,
        "cloudConsent": True,
        "snapshot": snapshot,
    }


class FakeChatProvider:
    model = "fake-deepseek-chat"

    def __init__(self, *answers: str) -> None:
        self.answers = list(answers) or ["这是答案。"]
        self.calls: list[list[dict[str, str]]] = []

    async def stream_chat(
        self,
        *,
        messages: list[dict[str, str]],
        max_output_tokens: int,
    ) -> AsyncIterator[str]:
        del max_output_tokens
        self.calls.append(messages)
        for answer in self.answers:
            yield answer


def replace_service(tmp_path, provider: FakeChatProvider) -> object:
    previous = study_api.service
    study_api.service = StudyChatService(
        Settings(
            _env_file=None,
            local_api_token=TOKEN,
            llm_model=provider.model,
            learning_memory_db_path=str(tmp_path / "learning-memory.sqlite3"),
        ),
        provider=provider,
        memory=LearningMemoryStore(str(tmp_path / "learning-memory.sqlite3")),
    )
    return previous


def parse_events(body: str) -> list[tuple[str, dict]]:
    events = []
    for raw in body.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in raw.splitlines() if ": " in line)
        if "event" in lines and "data" in lines:
            events.append((lines["event"], json.loads(lines["data"])))
    return events


def test_cloud_consent_is_required_before_provider_call(tmp_path) -> None:
    provider = FakeChatProvider()
    previous = replace_service(tmp_path, provider)
    payload = chat_payload(question="解释这段代码")
    payload["cloudConsent"] = False
    try:
        response = TestClient(app).post(
            "/api/v1/study/chat", json=payload, headers=HEADERS
        )
    finally:
        study_api.service = previous
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "cloud_consent_required"
    assert provider.calls == []


def test_streaming_chat_persists_selection_source_and_follow_up(tmp_path) -> None:
    provider = FakeChatProvider("第一段", "第二段")
    previous = replace_service(tmp_path, provider)
    client = TestClient(app)
    try:
        response = client.post(
            "/api/v1/study/chat",
            json=chat_payload(question="这段代码在做什么？"),
            headers=HEADERS,
        )
        events = parse_events(response.text)
        assert response.status_code == 200
        assert [event for event, _ in events] == ["delta", "delta", "done"]
        assert "第一段第二段" == events[-1][1]["message"]["content"]

        follow_up = client.post(
            "/api/v1/study/chat",
            json=chat_payload(question="请继续举一个例子"),
            headers=HEADERS,
        )
        assert follow_up.status_code == 200
        restored = client.get(
            "/api/v1/study/conversations/conversation-test",
            headers=HEADERS,
        )
    finally:
        study_api.service = previous
    assert restored.status_code == 200
    messages = restored.json()["messages"]
    assert len(messages) == 4
    assert messages[0]["selectedText"] == "Annotated[str, Form()]"
    assert messages[0]["source"]["headingPath"] == ["教程", "依赖注入"]
    assert "依赖注入" in provider.calls[0][1]["content"]
    assert "Annotated[str, Form()]" in provider.calls[0][-1]["content"]


def test_conversation_cannot_be_reused_for_another_chapter(tmp_path) -> None:
    provider = FakeChatProvider()
    previous = replace_service(tmp_path, provider)
    payload = chat_payload(question="第一个问题")
    try:
        created = TestClient(app).post(
            "/api/v1/study/chat", json=payload, headers=HEADERS
        )
        changed = chat_payload(question="串线问题")
        changed["sourceUrl"] = "https://fastapi.tiangolo.com/tutorial/security/"
        changed["snapshot"] = snapshot_payload(changed["sourceUrl"])
        response = TestClient(app).post(
            "/api/v1/study/chat", json=changed, headers=HEADERS
        )
    finally:
        study_api.service = previous
    assert created.status_code == 200
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "conversation_source_conflict"


def test_study_route_requires_local_token() -> None:
    response = TestClient(app).get(
        "/api/v1/study/conversations/missing",
        headers={"Host": "127.0.0.1:8000", "Authorization": "Bearer wrong"},
    )
    assert response.status_code == 401


def test_openai_compatible_provider_yields_streaming_deltas(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.llm.openai_compatible as provider_module

    closed = False

    class WorkingStream:
        def __aiter__(self):
            async def chunks():
                yield SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content="答")
                        )
                    ]
                )
                yield SimpleNamespace(
                    choices=[
                        SimpleNamespace(
                            delta=SimpleNamespace(content="案")
                        )
                    ]
                )

            return chunks()

    class WorkingClient:
        def __init__(self, **kwargs) -> None:
            del kwargs
            self.chat = SimpleNamespace(completions=self)

        async def create(self, **kwargs):
            assert kwargs["stream"] is True
            return WorkingStream()

        async def close(self) -> None:
            nonlocal closed
            closed = True

    monkeypatch.setattr(provider_module, "AsyncOpenAI", WorkingClient)
    provider = OpenAICompatibleProvider(
        Settings(_env_file=None, llm_api_key="placeholder")
    )

    async def collect() -> list[str]:
        return [
            chunk
            async for chunk in provider.stream_chat(
                messages=[{"role": "user", "content": "解释"}],
                max_output_tokens=32,
            )
        ]

    assert asyncio.run(collect()) == ["答", "案"]
    assert closed is True
