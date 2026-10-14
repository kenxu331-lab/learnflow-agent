# ruff: noqa: E501
"""S2-A extraction, evidence, idempotency and recovery tests."""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from collections.abc import AsyncIterator
from pathlib import Path

from fastapi.testclient import TestClient

from app.api import knowledge as knowledge_api
from app.core.config import Settings, get_settings
from app.knowledge.extractor import KnowledgeExtractor
from app.knowledge.service import KnowledgeService
from app.knowledge.store import KnowledgeStore
from app.llm.errors import LLMProviderError
from app.notes.resolver import NoteResolver
from app.schemas.study import StudyChatRequest
from app.study_chat.service import StudyChatService


def snapshot_payload() -> dict[str, object]:
    blocks = [
        {"id": "heading-1", "type": "heading", "text": "Middleware", "level": 2},
        {
            "id": "block-3",
            "type": "paragraph",
            "text": "Middleware runs before each request and before each response.",
        },
        {
            "id": "code-1",
            "type": "code",
            "text": '@app.middleware("http")\nasync def timing(request, call_next):\n    return await call_next(request)',
            "language": "python",
        },
    ]
    return {
        "schemaVersion": 1,
        "url": "https://fastapi.tiangolo.com/tutorial/middleware/",
        "title": "Middleware - FastAPI",
        "capturedAt": "2026-10-13T00:00:00Z",
        "blocks": blocks,
        "extraction": {"strategy": "article", "truncated": False, "warnings": []},
        "stats": {
            "characterCount": sum(len(str(block["text"])) for block in blocks),
            "codeBlockCount": 1,
            "blockCount": len(blocks),
        },
    }


class FakeProvider:
    model = "fake-deepseek"

    def __init__(
        self,
        *,
        fake_evidence: bool = False,
        empty: bool = False,
        error: LLMProviderError | None = None,
    ) -> None:
        self.fake_evidence = fake_evidence
        self.empty = empty
        self.error = error
        self.complete_calls = 0

    async def stream_chat(
        self, *, messages: list[dict[str, str]], max_output_tokens: int
    ) -> AsyncIterator[str]:
        del messages, max_output_tokens
        yield "Middleware wraps request and response processing."

    async def complete_json(
        self, *, system_prompt: str, user_prompt: str, max_output_tokens: int
    ):
        del system_prompt, max_output_tokens
        self.complete_calls += 1
        if self.error:
            raise self.error
        if self.empty:
            content = {"schemaVersion": 1, "candidates": []}
        else:
            ids = re.findall(
                r"evidence_id=(ev-[a-f0-9]+) kind=tutorial_block",
                user_prompt,
            )
            evidence_id = "ev-fake" if self.fake_evidence else ids[0]
            content = {
                "schemaVersion": 1,
                "candidates": [
                    {
                        "localKnowledgeId": "middleware-definition",
                        "topic": "Middleware lifecycle",
                        "kind": "concept",
                        "body": "Middleware surrounds the request and response lifecycle.",
                        "anchorEvidenceId": evidence_id,
                        "claims": [
                            {
                                "localClaimId": "claim-1",
                                "text": "Middleware runs before request handling and before response return.",
                                "kind": "tutorial_fact",
                                "evidence": [
                                    {
                                        "evidenceIds": [evidence_id],
                                        "relation": "supports",
                                    }
                                ],
                            }
                        ],
                        "worthExtracting": True,
                        "skipReason": None,
                    }
                ],
            }
        from app.llm.base import LLMCompletion

        return LLMCompletion(content=json.dumps(content), finish_reason="stop")


def make_settings(tmp_path: Path) -> Settings:
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    return Settings(
        _env_file=None,
        local_api_token="test-token",
        vault_path=str(vault),
        learning_memory_db_path=str(tmp_path / "learning.sqlite3"),
        knowledge_worker_poll_seconds=0.01,
    )


async def create_event(
    settings: Settings,
    provider: FakeProvider,
    *,
    conversation_id: str = "conversation-a",
    session_id: str = "session-a",
    snapshot: dict[str, object] | None = None,
    selected_text: str = "Middleware runs before each request and before each response.",
) -> StudyChatRequest:
    snapshot_data = snapshot or snapshot_payload()
    request = StudyChatRequest.model_validate(
        {
            "schemaVersion": 1,
            "conversationId": conversation_id,
            "sessionId": session_id,
            "sourceUrl": snapshot_data["url"],
            "pageTitle": "Middleware - FastAPI",
            "headingPath": ["Middleware"],
            "selectedText": selected_text,
            "question": "What does middleware do?",
            "cloudConsent": True,
            "snapshot": snapshot_data,
        }
    )
    chat = StudyChatService(settings, provider=provider)
    stream = await chat.start_stream(request)
    async for _ in stream:
        pass
    return request


def test_s2a_extracts_traceable_draft_and_is_idempotent(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    chat_provider = FakeProvider()
    request = asyncio.run(create_event(settings, chat_provider))
    extraction_provider = FakeProvider()
    service = KnowledgeService(
        settings,
        extractor=KnowledgeExtractor(settings, provider=extraction_provider),
    )
    service.set_consent(True, "test-v1")

    assert service.trigger(
        NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id,
        request.conversationId,
    )["scheduledJobCount"] == 1
    assert asyncio.run(service.run_once()) is True

    chapter_id = NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id
    drafts = service.store.list_drafts(chapter_id)
    assert len(drafts) == 1
    assert drafts[0]["verification_status"] == "evidence_registered"
    assert drafts[0]["publish_status"] == "not_eligible"
    evidence = service.store.connection.execute(
        "SELECT * FROM evidence_records WHERE scope_id = ?",
        (service.store.resolve_scope().scope_id,),
    ).fetchall()
    assert any(row["source_kind"] == "tutorial_block" for row in evidence)

    assert service.trigger(chapter_id, request.conversationId) == {
        "scheduledJobCount": 0,
        "state": "completed",
    }
    assert asyncio.run(service.run_once()) is False
    assert len(service.store.list_drafts(chapter_id)) == 1


def test_s2a_rejects_fabricated_evidence_id(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    request = asyncio.run(create_event(settings, FakeProvider()))
    service = KnowledgeService(
        settings,
        extractor=KnowledgeExtractor(
            settings, provider=FakeProvider(fake_evidence=True)
        ),
    )
    service.set_consent(True, "test-v1")
    chapter_id = NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id
    service.trigger(chapter_id, request.conversationId)
    asyncio.run(service.run_once())

    assert service.store.list_drafts(chapter_id) == []
    assert service.store.list_jobs()[0]["state"] == "needs_review"


def test_manual_trigger_runs_without_legacy_consent(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    request = asyncio.run(create_event(settings, FakeProvider()))
    provider = FakeProvider()
    service = KnowledgeService(
        settings, extractor=KnowledgeExtractor(settings, provider=provider)
    )
    assert service.trigger("chapter-extension-local-key", request.conversationId)[
        "scheduledJobCount"
    ] == 1
    assert asyncio.run(service.run_once()) is True
    assert provider.complete_calls == 1
    assert service.store.list_jobs()[0]["state"] == "completed"


def test_manual_trigger_batches_events_before_one_extraction_call(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    chat_provider = FakeProvider()
    request = asyncio.run(create_event(settings, chat_provider))
    asyncio.run(create_event(settings, chat_provider))
    extraction_provider = FakeProvider()
    service = KnowledgeService(
        settings,
        extractor=KnowledgeExtractor(settings, provider=extraction_provider),
    )
    chapter_id = NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id
    assert service.trigger(chapter_id, request.conversationId)["scheduledJobCount"] == 1
    assert asyncio.run(service.run_once()) is True

    assert extraction_provider.complete_calls == 1
    assert len(service.store.list_drafts(chapter_id)) == 1
    assert service.store.list_jobs()[0]["state"] == "completed"


def test_background_scheduler_does_not_plan_extraction_jobs(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    settings.knowledge_extraction_idle_seconds = 0
    asyncio.run(create_event(settings, FakeProvider()))
    service = KnowledgeService(
        settings, extractor=KnowledgeExtractor(settings, provider=FakeProvider())
    )
    assert service.store.plan_jobs() == 0
    assert service.store.list_jobs() == []


def test_empty_extraction_output_skips_without_creating_knowledge(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    request = asyncio.run(create_event(settings, FakeProvider()))
    service = KnowledgeService(
        settings,
        extractor=KnowledgeExtractor(settings, provider=FakeProvider(empty=True)),
    )
    service.set_consent(True, "test-v1")
    chapter_id = NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id
    service.trigger(chapter_id, request.conversationId)

    assert asyncio.run(service.run_once()) is True
    assert service.store.list_drafts(chapter_id) == []
    assert service.store.list_jobs()[0]["state"] == "skipped"


def test_provider_error_retries_once_then_becomes_auditable_review(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    request = asyncio.run(create_event(settings, FakeProvider()))
    provider = FakeProvider(error=LLMProviderError("llm_timeout", "timeout", 504))
    service = KnowledgeService(
        settings,
        extractor=KnowledgeExtractor(settings, provider=provider),
    )
    service.set_consent(True, "test-v1")
    chapter_id = NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id
    service.trigger(chapter_id, request.conversationId)

    assert asyncio.run(service.run_once()) is True
    first = service.store.list_jobs()[0]
    assert first["state"] == "retryable_failed"
    service.store.connection.execute(
        "UPDATE extraction_jobs SET next_attempt_at = ? WHERE job_id = ?",
        ("2000-01-01T00:00:00+00:00", first["job_id"]),
    )
    service.store.connection.commit()
    assert asyncio.run(service.run_once()) is True
    second = service.store.list_jobs()[0]
    assert second["state"] == "needs_review"
    assert second["attempt_count"] == 2


def test_legacy_event_backfill_never_invents_message_or_snapshot_links(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    asyncio.run(create_event(settings, FakeProvider()))
    connection = sqlite3.connect(settings.learning_memory_db_path)
    event_id = connection.execute("SELECT event_id FROM learning_events").fetchone()[0]
    connection.execute("DELETE FROM event_contexts WHERE event_id = ?", (event_id,))
    connection.commit()
    connection.close()

    store = KnowledgeStore(settings)
    row = store.connection.execute(
        "SELECT * FROM event_contexts WHERE event_id = ?", (event_id,)
    ).fetchone()

    assert row["link_status"] == "legacy_unlinked"
    assert row["user_message_id"] is None
    assert row["assistant_message_id"] is None
    assert row["source_snapshot_id"] is None


def test_snapshot_registration_failure_does_not_interrupt_study_chat(
    tmp_path: Path, monkeypatch
) -> None:
    settings = make_settings(tmp_path)
    payload = snapshot_payload()
    request = StudyChatRequest.model_validate(
        {
            "schemaVersion": 1,
            "conversationId": "unlinked-conversation",
            "sessionId": "unlinked-session",
            "sourceUrl": payload["url"],
            "pageTitle": payload["title"],
            "headingPath": ["Middleware"],
            "question": "Explain middleware",
            "cloudConsent": True,
            "snapshot": payload,
        }
    )
    chat = StudyChatService(settings, provider=FakeProvider())

    def fail_registration(_snapshot):
        raise OSError("simulated snapshot failure")

    monkeypatch.setattr(chat.knowledge, "register_snapshot", fail_registration)
    stream = asyncio.run(chat.start_stream(request))

    async def consume() -> None:
        async for _ in stream:
            pass

    asyncio.run(consume())
    row = chat.memory._connection.execute(
        "SELECT * FROM event_contexts WHERE link_status = 'unlinked_runtime_error'"
    ).fetchone()
    assert row is not None
    assert row["user_message_id"] is not None
    assert row["assistant_message_id"] is not None
    assert row["source_snapshot_id"] is None


def test_cross_block_selection_degrades_to_a_unique_section_anchor(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    payload = snapshot_payload()
    blocks = payload["blocks"]
    assert isinstance(blocks, list)
    blocks.append(
        {
            "id": "block-4",
            "type": "paragraph",
            "text": "Shared selection text is still inside this middleware section.",
        }
    )
    blocks[1]["text"] = "Shared selection text is inside this middleware section."
    payload["stats"] = {
        "characterCount": sum(len(str(block["text"])) for block in blocks),
        "codeBlockCount": 1,
        "blockCount": len(blocks),
    }
    request = asyncio.run(
        create_event(
            settings,
            FakeProvider(),
            snapshot=payload,
            selected_text="Shared selection text",
        )
    )
    service = KnowledgeService(
        settings, extractor=KnowledgeExtractor(settings, FakeProvider())
    )
    service.set_consent(True, "test-v1")
    chapter_id = NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id
    service.trigger(chapter_id, request.conversationId)
    claimed = service.store.claim_next_job()
    assert claimed is not None
    job, _token = claimed
    evidence = service.store.build_registry(job)
    selection = next(
        row for row in evidence.values() if row["source_kind"] == "selection"
    )
    assert selection["resolvable"] == 1
    assert selection["source_block_id"] == "heading-1"
    assert selection["stable_key"] is None


def test_same_chapter_conversations_have_independent_jobs_and_expired_lease_recovers(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    provider = FakeProvider(empty=True)
    request_a = asyncio.run(
        create_event(settings, provider, conversation_id="conversation-a")
    )
    request_b = asyncio.run(
        create_event(
            settings, provider, conversation_id="conversation-b", session_id="session-b"
        )
    )
    service = KnowledgeService(
        settings, extractor=KnowledgeExtractor(settings, provider=provider)
    )
    service.set_consent(True, "test-v1")
    chapter_id = (
        NoteResolver().resolve(request_a.sourceUrl, request_a.pageTitle).chapter_id
    )
    assert service.trigger(chapter_id, request_a.conversationId)["scheduledJobCount"] == 1
    assert service.trigger(chapter_id, request_b.conversationId)["scheduledJobCount"] == 1
    claimed = service.store.claim_next_job()
    assert claimed is not None
    job, _token = claimed
    service.store.connection.execute(
        "UPDATE extraction_jobs SET lease_expires_at = ? WHERE job_id = ?",
        ("2000-01-01T00:00:00+00:00", job["job_id"]),
    )
    assert service.store.recover_expired_leases() == 1
    assert service.store.list_jobs()[0]["state"] in {"queued", "retryable_failed"}


def test_knowledge_api_exposes_independent_consent_status(
    tmp_path: Path, monkeypatch
) -> None:
    from app.main import app

    settings = make_settings(tmp_path)
    monkeypatch.setenv("LEARNFLOW_LOCAL_API_TOKEN", "test-token")
    get_settings.cache_clear()
    previous = knowledge_api.service
    knowledge_api.service = KnowledgeService(
        settings, extractor=KnowledgeExtractor(settings, FakeProvider())
    )
    headers = {"Authorization": "Bearer test-token", "Host": "127.0.0.1:8000"}
    try:
        client = TestClient(app)
        initial = client.get("/api/v1/knowledge/status", headers=headers)
        enabled = client.post(
            "/api/v1/knowledge/consent",
            json={"enabled": True, "policyVersion": "test-v1"},
            headers=headers,
        )
    finally:
        knowledge_api.service = previous
        get_settings.cache_clear()
    assert initial.status_code == 200
    assert initial.json()["consent"]["state"] == "revoked"
    assert enabled.status_code == 200
    assert enabled.json()["state"] == "active"
