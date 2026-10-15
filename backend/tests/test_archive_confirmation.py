"""Real temporary Vault writes with immutable approvals and crash recovery."""

import asyncio
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from test_agent_knowledge import chat, make_request
from test_knowledge_s2a import (
    FakeProvider,
    create_event,
    make_settings,
    snapshot_payload,
)
from test_knowledge_s2b import VerificationProvider
from test_readonly_agent import ScriptedTools

from app.api import archive as archive_api
from app.api import study as study_api
from app.archive.confirmations import ArchiveConfirmations
from app.archive.locking import archive_mutex
from app.core.config import get_settings
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.extractor import KnowledgeExtractor
from app.knowledge.service import KnowledgeService
from app.knowledge.verifier import KnowledgeVerifier
from app.learning_memory.store import LearningMemoryStore
from app.llm.base import LLMToolCall
from app.main import app
from app.notes.errors import NoteServiceError
from app.notes.markdown import build_new_document
from app.notes.resolver import NoteResolver
from app.schemas.archive import KnowledgeReference
from app.schemas.page_snapshot import PageSnapshot
from app.study_chat.service import StudyChatService


class TwoDraftProvider(FakeProvider):
    async def complete_json(self, **kwargs):
        result = await super().complete_json(**kwargs)
        data = json.loads(result.content)
        second = json.loads(json.dumps(data["candidates"][0]))
        second["localKnowledgeId"] = "middleware-reuse"
        second["topic"] = "Middleware reuse"
        second["body"] = "Middleware provides shared request and response processing."
        data["candidates"].append(second)
        from app.llm.base import LLMCompletion

        return LLMCompletion(json.dumps(data), "stop")


@pytest.fixture(autouse=True)
def token(monkeypatch):
    monkeypatch.setenv("LEARNFLOW_LOCAL_API_TOKEN", "test-token")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def prepared(tmp_path):
    settings = make_settings(tmp_path)

    async def seed():
        request = await create_event(settings, FakeProvider())
        service = KnowledgeService(
            settings,
            extractor=KnowledgeExtractor(settings, TwoDraftProvider()),
            verifier=KnowledgeVerifier(settings, VerificationProvider()),
        )
        chapter = NoteResolver().resolve(request.sourceUrl).chapter_id
        assert (
            service.trigger(chapter, request.conversationId)["scheduledJobCount"] == 1
        )
        assert await service.run_once()
        for row in service.store.unverified_knowledge():
            await service.verify_knowledge(row["knowledge_id"])
        return request, service

    request, knowledge = asyncio.run(seed())
    snapshot = PageSnapshot.model_validate(snapshot_payload())
    identity = NoteResolver().resolve(snapshot.url, snapshot.title)
    path = Path(settings.vault_path) / identity.target_relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        build_new_document(
            identity, snapshot, snapshot.blocks, None, datetime.now(UTC)
        ),
        encoding="utf-8",
    )
    memory = LearningMemoryStore(settings.learning_memory_db_path)
    archive = ArchiveConfirmations(settings, memory)
    refs = [
        KnowledgeReference(knowledgeId=c["knowledgeId"], version=c["knowledgeVersion"])
        for c in knowledge.list_publish_candidates()
    ]
    assert len(refs) == 2
    return settings, memory, archive, request, path, refs


def make_preview(prepared):
    _, _, archive, request, _, refs = prepared
    archive.select(request.conversationId, refs)
    return archive.prepare(request.conversationId, [])


def decide(archive, view, action="confirm"):
    return archive.decision(
        view.confirmationId, view.conversationId, view.planDigest, action
    )


def test_preview_and_selection_survive_restart_without_writing(prepared):
    settings, memory, archive, request, path, refs = prepared
    before = path.read_bytes()
    view = make_preview(prepared)
    assert view.state == "pending" and len(view.plans) == 2
    assert view.diff.count("LEARNFLOW_ANNOTATION knowledge_id=") == 2
    assert path.read_bytes() == before
    restored = ArchiveConfirmations(
        settings, LearningMemoryStore(settings.learning_memory_db_path)
    )
    assert restored.selection(request.conversationId)[0] == sorted(
        refs, key=lambda r: r.knowledgeId
    )
    assert (
        restored.get(view.confirmationId, request.conversationId).planDigest
        == view.planDigest
    )
    assert (
        memory.conversation(request.conversationId)
        .messages[-1]
        .archiveConfirmations[0]
        .confirmationId
        == view.confirmationId
    )
    assert path.read_bytes() == before


def test_one_confirm_writes_combined_diff_once_and_returns_real_locations(prepared):
    _, _, archive, _, path, _ = prepared
    view = make_preview(prepared)
    with patch.object(
        archive.writer.notes,
        "replace_managed_note",
        wraps=archive.writer.notes.replace_managed_note,
    ) as write:
        result = decide(archive, view)
        assert result.state == "published" and len(result.results) == 2
        assert write.call_count == 1
        assert decide(archive, view).model_dump() == result.model_dump()
        assert write.call_count == 1
    assert (
        path.read_text(encoding="utf-8").count("LEARNFLOW_ANNOTATION knowledge_id=")
        == 2
    )
    assert all(
        r.intentId and r.plan.targetRelativePath in result.message
        for r in result.results
    )
    assert all(r.plan.plannedEdit.anchorLine for r in result.results)
    noop = archive.prepare(view.conversationId, [])
    before = path.read_bytes()
    assert decide(archive, noop).state == "noop"
    assert path.read_bytes() == before


def test_selection_change_invalidates_old_confirmation(prepared):
    _, _, archive, request, path, refs = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    archive.select(request.conversationId, refs[:1])
    result = decide(archive, view)
    assert result.state == "needs_review" and "已变化" in result.message
    assert path.read_bytes() == before


def test_external_file_change_is_not_silently_replanned(prepared):
    _, _, archive, _, path, _ = prepared
    view = make_preview(prepared)
    path.write_text(
        path.read_text(encoding="utf-8") + "\nUser personal note.\n", encoding="utf-8"
    )
    changed = path.read_bytes()
    result = decide(archive, view)
    assert result.state == "needs_review"
    assert path.read_bytes() == changed
    assert not result.results


def test_new_active_knowledge_version_rejects_old_approval(prepared):
    _, _, archive, _, path, refs = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    connection = archive.writer.store.connection
    with connection:
        row = dict(
            connection.execute(
                "SELECT * FROM knowledge_versions WHERE knowledge_id=? AND version=1",
                (refs[0].knowledgeId,),
            ).fetchone()
        )
        row["version"] = 2
        row["version_fingerprint"] = "new-version-fingerprint"
        columns = list(row)
        connection.execute(
            f"INSERT INTO knowledge_versions ({','.join(columns)}) "
            f"VALUES ({','.join('?' for _ in columns)})",
            list(row.values()),
        )
        connection.execute(
            "UPDATE knowledge_items SET active_version=2 WHERE knowledge_id=?",
            (refs[0].knowledgeId,),
        )
    assert decide(archive, view).state == "needs_review"
    assert path.read_bytes() == before


def test_changed_verification_rejects_old_approval(prepared):
    _, _, archive, _, path, refs = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    archive.writer.store.persist_verification(
        knowledge_id=refs[0].knowledgeId,
        version=1,
        claim_updates={},
        verification_status="insufficient_evidence",
        publish_status="not_eligible",
        evidence_gap_reason="missing_evidence",
    )
    assert decide(archive, view).state == "needs_review"
    assert path.read_bytes() == before


def test_expired_confirmation_and_cancel_never_write(prepared):
    _, memory, archive, _, path, _ = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    expired = view.model_copy(
        update={"expiresAt": (datetime.now(UTC) - timedelta(seconds=1)).isoformat()}
    )
    with memory.transaction() as connection:
        connection.execute(
            "UPDATE archive_confirmations SET view_json=? WHERE confirmation_id=?",
            (expired.model_dump_json(), view.confirmationId),
        )
    assert decide(archive, view).state == "expired"
    new = archive.prepare(view.conversationId, [])
    assert new.confirmationId != view.confirmationId
    assert decide(archive, new, "cancel").state == "cancelled"
    assert decide(archive, new).state == "cancelled"
    assert path.read_bytes() == before


def test_wrong_digest_and_other_conversation_are_rejected(prepared):
    _, _, archive, _, path, _ = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    from app.knowledge.errors import KnowledgeServiceError

    with pytest.raises(KnowledgeServiceError):
        archive.decision(view.confirmationId, view.conversationId, "0" * 64, "confirm")
    with pytest.raises(KnowledgeServiceError):
        archive.decision(view.confirmationId, "other", view.planDigest, "confirm")
    assert path.read_bytes() == before


def test_vault_scope_change_cannot_redirect_approved_write(prepared, tmp_path):
    settings, _, archive, _, path, _ = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    other = tmp_path / "other-vault"
    (other / ".obsidian").mkdir(parents=True)
    settings.vault_path = str(other)
    result = decide(archive, view)
    assert result.state == "needs_review"
    assert path.read_bytes() == before and not list(other.rglob("*.md"))


def test_crash_before_file_write_requires_explicit_resume(prepared):
    settings, _, archive, request, path, _ = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    with patch.object(
        archive.writer, "commit_approved_batch", side_effect=SystemExit("crash")
    ):
        with pytest.raises(SystemExit):
            decide(archive, view)
    restored = ArchiveConfirmations(
        settings, LearningMemoryStore(settings.learning_memory_db_path)
    )
    interrupted = restored.get(view.confirmationId, request.conversationId)
    assert interrupted.state == "interrupted" and interrupted.approvedAt
    assert path.read_bytes() == before
    assert decide(restored, interrupted).state == "published"


def test_crash_after_file_write_recovers_receipt_without_rewriting(prepared):
    settings, _, archive, request, path, _ = prepared
    view = make_preview(prepared)
    with patch.object(archive, "_complete", side_effect=SystemExit("crash")):
        with pytest.raises(SystemExit):
            decide(archive, view)
    written = path.read_bytes()
    restored = ArchiveConfirmations(
        settings, LearningMemoryStore(settings.learning_memory_db_path)
    )
    with patch.object(
        restored.writer.notes,
        "replace_managed_note",
        wraps=restored.writer.notes.replace_managed_note,
    ) as write:
        result = restored.get(view.confirmationId, request.conversationId)
        assert result.state == "published" and len(result.results) == 2
        assert write.call_count == 0
    assert path.read_bytes() == written


def test_write_error_is_not_success_and_keeps_reason(prepared):
    _, _, archive, _, path, _ = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    with patch.object(
        archive.writer.notes,
        "replace_managed_note",
        side_effect=NoteServiceError("vault_write_failed", "Disk denied", 500),
    ):
        result = decide(archive, view)
    assert result.state == "needs_review" and result.message == "Disk denied"
    assert not result.results and path.read_bytes() == before
    assert all(
        row["status"] == "needs_review"
        for row in archive.writer.store.recent_annotation_intents()
    )


def test_two_independent_instances_confirm_once(prepared):
    settings, _, archive, _, path, _ = prepared
    view = make_preview(prepared)
    other = ArchiveConfirmations(
        settings, LearningMemoryStore(settings.learning_memory_db_path)
    )
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(lambda service: decide(service, view), [archive, other])
        )
    assert all(result.state == "published" for result in results)
    assert [r.intentId for r in results[0].results] == [
        r.intentId for r in results[1].results
    ]
    assert (
        path.read_text(encoding="utf-8").count("LEARNFLOW_ANNOTATION knowledge_id=")
        == 2
    )


def test_agent_prepares_selected_two_but_cannot_confirm(prepared):
    settings, _, archive, request, path, refs = prepared
    archive.select(request.conversationId, refs)
    before = path.read_bytes()
    provider = ScriptedTools([LLMToolCall("p", "prepare_archive", "{}")])
    service = StudyChatService(settings, provider=provider)
    req = make_request("把刚才确认的两个知识点放到对应的 Obsidian 章节。")
    req.archiveTools = True
    events = asyncio.run(chat(service, req))
    assert events[-1][0] == "done", events
    message = events[-1][1]["message"]
    assert message["activities"][-1]["type"] == "confirmation_required"
    assert len(message["archiveConfirmations"][0]["plans"]) == 2
    assert len(provider.calls) == 1
    assert path.read_bytes() == before


def test_ambiguous_selection_and_model_confirmation_tool_fail_closed(prepared):
    settings, _, _, _, path, _ = prepared
    provider = ScriptedTools(
        [LLMToolCall("p", "prepare_archive", "{}")],
        [LLMToolCall("c", "confirm_archive", "{}")],
        ["请先明确选择知识，并在卡片确认。"],
    )
    service = StudyChatService(settings, provider=provider)
    req = make_request("把刚才两个知识归档")
    req.archiveTools = True
    before = path.read_bytes()
    events = asyncio.run(chat(service, req))
    assert events[-1][0] == "done"
    assert not events[-1][1]["message"]["archiveConfirmations"]
    assert path.read_bytes() == before


def test_archive_endpoints_require_token_and_block_untrusted_origin(
    prepared, monkeypatch
):
    settings, _, archive, request, path, refs = prepared
    service = StudyChatService(settings, provider=ScriptedTools())
    monkeypatch.setattr(archive_api, "service", service)
    monkeypatch.setattr(study_api, "service", service)
    headers = {"Host": "127.0.0.1:8000", "Authorization": "Bearer test-token"}
    client = TestClient(app)
    before = path.read_bytes()
    assert (
        client.post(
            "/api/v1/study/archive/prepare",
            json={"conversationId": request.conversationId},
            headers={"Host": "127.0.0.1:8000"},
        ).status_code
        == 401
    )
    selection = {
        "conversationId": request.conversationId,
        "references": [ref.model_dump() for ref in refs],
    }
    assert (
        client.post(
            "/api/v1/study/archive/selection", json=selection, headers=headers
        ).status_code
        == 200
    )
    preview = client.post(
        "/api/v1/study/archive/prepare",
        json={"conversationId": request.conversationId},
        headers=headers,
    )
    assert preview.status_code == 200, preview.text
    view = preview.json()
    decision = {
        "conversationId": request.conversationId,
        "planDigest": view["planDigest"],
        "decision": "confirm",
    }
    url = f"/api/v1/study/archive/{view['confirmationId']}/decision"
    assert (
        client.post(
            url, json=decision, headers={**headers, "Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    assert path.read_bytes() == before
    response = client.post(url, json=decision, headers=headers)
    assert response.status_code == 200 and response.json()["state"] == "published"


def test_repeated_same_preview_reuses_confirmation(prepared):
    _, _, archive, request, path, _ = prepared
    before = path.read_bytes()
    first = make_preview(prepared)
    second = archive.prepare(request.conversationId, [])
    assert second.confirmationId == first.confirmationId
    assert path.read_bytes() == before


def test_displayed_diff_tampering_is_rejected(prepared):
    _, memory, archive, _, path, _ = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    altered = view.model_copy(update={"diff": "+ Different approved text"})
    with memory.transaction() as connection:
        connection.execute(
            "UPDATE archive_confirmations SET view_json=? WHERE confirmation_id=?",
            (altered.model_dump_json(), view.confirmationId),
        )
    result = decide(archive, view)
    assert result.state == "needs_review" and "摘要" in result.message
    assert path.read_bytes() == before


def test_changed_source_fingerprint_invalidates_confirmation(prepared):
    _, _, archive, _, path, refs = prepared
    view = make_preview(prepared)
    before = path.read_bytes()
    with archive.writer.store.connection:
        archive.writer.store.connection.execute(
            "UPDATE knowledge_items SET anchor_fingerprint='changed' "
            "WHERE knowledge_id=?",
            (refs[0].knowledgeId,),
        )
    assert decide(archive, view).state == "needs_review"
    assert path.read_bytes() == before


def test_different_confirmations_cannot_silently_merge_into_changed_file(prepared):
    _, _, archive, request, path, refs = prepared
    first = archive.prepare(request.conversationId, refs[:1])
    second = archive.prepare(request.conversationId, refs[1:])
    assert decide(archive, first).state == "published"
    written = path.read_bytes()
    assert decide(archive, second).state == "needs_review"
    assert path.read_bytes() == written
    refreshed = archive.prepare(request.conversationId, refs[1:])
    assert decide(archive, refreshed).state == "published"
    assert (
        path.read_text(encoding="utf-8").count("LEARNFLOW_ANNOTATION knowledge_id=")
        == 2
    )


def test_archive_mutex_excludes_another_process(prepared):
    settings, _, _, _, _, _ = prepared
    script = (
        "import sys; from app.core.config import Settings; "
        "from app.archive.locking import archive_mutex; "
        "cfg=Settings(_env_file=None,learning_memory_db_path=sys.argv[1]); "
        "ctx=archive_mutex(cfg,'cross-process'); "
        "ctx.__enter__(); print('locked',flush=True); "
        "sys.stdin.readline(); ctx.__exit__(None,None,None)"
    )
    process = subprocess.Popen(
        [sys.executable, "-c", script, settings.learning_memory_db_path],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        assert process.stdout.readline().strip() == "locked"
        with pytest.raises(KnowledgeServiceError, match="正在处理"):
            with archive_mutex(settings, "cross-process", timeout=0.05):
                pass
    finally:
        process.communicate(input="\n", timeout=5)
    assert process.returncode == 0


def test_temporary_plan_id_is_not_accepted_as_human_approval(prepared, monkeypatch):
    from app.api import annotations as annotations_api

    _, _, archive, _, path, refs = prepared
    monkeypatch.setattr(annotations_api, "writer", archive.writer)
    before = path.read_bytes()
    response = TestClient(app).post(
        "/api/v1/annotations/commit",
        headers={"Host": "127.0.0.1:8000", "Authorization": "Bearer test-token"},
        json={
            "knowledgeId": refs[0].knowledgeId,
            "knowledgeVersion": 1,
            "planId": "not-approved",
            "manualConfirmation": True,
        },
    )
    assert response.status_code == 409
    assert path.read_bytes() == before
