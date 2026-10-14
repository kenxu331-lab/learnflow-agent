"""Focused S2-B verification and publish-safety tests."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path

from app.core.config import Settings
from app.knowledge.extractor import KnowledgeExtractor
from app.knowledge.service import KnowledgeService
from app.knowledge.verifier import KnowledgeVerifier
from app.llm.base import LLMCompletion
from app.llm.errors import LLMProviderError
from app.notes.resolver import NoteResolver
from tests.test_knowledge_s2a import FakeProvider, create_event


class VerificationProvider:
    model = "fake-verifier"

    def __init__(self, verdict: str = "supported") -> None:
        self.verdict = verdict
        self.calls = 0
        self.prompts: list[str] = []

    async def complete_json(
        self, *, system_prompt: str, user_prompt: str, max_output_tokens: int
    ) -> LLMCompletion:
        del system_prompt, max_output_tokens
        self.calls += 1
        self.prompts.append(user_prompt)
        payload = json.loads(user_prompt.split("\n", 1)[1])
        content = {
            "schemaVersion": 1,
            "results": [
                {
                    "claimId": claim["claimId"],
                    "verdict": self.verdict,
                    "reason": "模拟核验：教程证据覆盖该 Claim。",
                }
                for claim in payload["claims"]
            ],
        }
        return LLMCompletion(
            content=json.dumps(content, ensure_ascii=False),
            finish_reason="stop",
            usage={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
        )

    async def stream_chat(
        self, *, messages: list[dict[str, str]], max_output_tokens: int
    ) -> AsyncIterator[str]:
        del messages, max_output_tokens
        if False:
            yield ""


class RetryVerificationProvider(VerificationProvider):
    def __init__(self) -> None:
        super().__init__()
        self.failed = False

    async def complete_json(self, **kwargs) -> LLMCompletion:
        if not self.failed:
            self.failed = True
            self.calls += 1
            raise LLMProviderError("llm_timeout", "timeout", 504)
        return await super().complete_json(**kwargs)


def make_settings(tmp_path: Path) -> Settings:
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    return Settings(
        _env_file=None,
        local_api_token="test-token",
        vault_path=str(vault),
        learning_memory_db_path=str(tmp_path / "learning.sqlite3"),
    )


def create_s2a_draft(settings: Settings) -> str:
    request = asyncio.run(create_event(settings, FakeProvider()))
    extraction = KnowledgeService(
        settings, extractor=KnowledgeExtractor(settings, FakeProvider())
    )
    extraction.set_consent(True, "test-v1")
    chapter_id = NoteResolver().resolve(request.sourceUrl, request.pageTitle).chapter_id
    assert extraction.trigger(chapter_id, request.conversationId) == 1
    assert asyncio.run(extraction.run_once()) is True
    row = extraction.store.list_drafts(chapter_id)[0]
    return row["knowledge_id"]


def test_supported_claims_produce_a_publish_candidate(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    knowledge_id = create_s2a_draft(settings)
    provider = VerificationProvider("supported")
    service = KnowledgeService(
        settings, verifier=KnowledgeVerifier(settings, provider=provider)
    )

    result = asyncio.run(service.verify_knowledge(knowledge_id))

    assert result["verificationStatus"] == "supported"
    assert result["publishStatus"] == "eligible"
    assert result["publishCandidate"]["knowledgeId"] == knowledge_id
    assert (
        result["publishCandidate"]["targetNoteId"]
        == result["publishCandidate"]["documentId"]
    )
    assert provider.calls == 1


def test_unavailable_verification_never_becomes_publishable(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    knowledge_id = create_s2a_draft(settings)

    class UnavailableProvider(VerificationProvider):
        async def complete_json(self, **kwargs) -> LLMCompletion:
            self.calls += 1
            raise LLMProviderError("llm_auth_failed", "auth failed", 502)

    provider = UnavailableProvider()
    service = KnowledgeService(
        settings, verifier=KnowledgeVerifier(settings, provider=provider)
    )

    result = asyncio.run(service.verify_knowledge(knowledge_id))

    assert result["verificationStatus"] == "verification_unavailable"
    assert result["publishStatus"] == "not_eligible"
    assert result["publishCandidate"] is None
    assert provider.calls == 1


def test_verifier_retries_one_network_error(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    knowledge_id = create_s2a_draft(settings)
    provider = RetryVerificationProvider()
    service = KnowledgeService(
        settings, verifier=KnowledgeVerifier(settings, provider=provider)
    )

    result = asyncio.run(service.verify_knowledge(knowledge_id))

    assert result["publishStatus"] == "eligible"
    assert provider.calls == 2
