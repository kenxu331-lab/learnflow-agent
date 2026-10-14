# ruff: noqa: E501
"""S3-02 Safe Write Engine tests using only temporary Vaults."""

from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from pathlib import Path

import pytest

from app.annotation_writer import AnnotationWriteService
from app.core.config import Settings
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.service import KnowledgeService
from app.knowledge.verifier import KnowledgeVerifier
from app.notes.markdown import build_new_document
from app.notes.resolver import NoteResolver
from app.schemas.page_snapshot import PageSnapshot
from tests.test_knowledge_s2a import snapshot_payload
from tests.test_knowledge_s2b import VerificationProvider, create_s2a_draft


def make_settings(tmp_path: Path) -> Settings:
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    return Settings(
        _env_file=None,
        local_api_token="test-token",
        vault_path=str(vault),
        learning_memory_db_path=str(tmp_path / "learning.sqlite3"),
    )


def prepare_verified_note(settings: Settings) -> tuple[AnnotationWriteService, Path, str]:
    knowledge_id = create_s2a_draft(settings)
    verification = KnowledgeService(
        settings,
        verifier=KnowledgeVerifier(settings, provider=VerificationProvider()),
    )
    result = asyncio.run(verification.verify_knowledge(knowledge_id))
    assert result["publishStatus"] == "eligible"

    snapshot = PageSnapshot.model_validate(snapshot_payload())
    identity = NoteResolver().resolve(snapshot.url, snapshot.title)
    path = Path(settings.vault_path) / identity.target_relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        build_new_document(identity, snapshot, snapshot.blocks, None, datetime.now(UTC)),
        encoding="utf-8",
    )
    writer = AnnotationWriteService(settings)
    writer.set_consent(True, "s3-02-test-v1")
    return writer, path, knowledge_id


def test_insert_then_repeat_is_noop(tmp_path: Path) -> None:
    writer, path, knowledge_id = prepare_verified_note(make_settings(tmp_path))

    first = writer.commit(knowledge_id, 1)
    content_after_first = path.read_text(encoding="utf-8")
    second = writer.commit(knowledge_id, 1)

    assert first.status == "published"
    assert second.status == "noop"
    assert path.read_text(encoding="utf-8") == content_after_first
    assert content_after_first.count("LEARNFLOW_ANNOTATION knowledge_id=") == 1


def test_user_modified_annotation_is_not_overwritten(tmp_path: Path) -> None:
    writer, path, knowledge_id = prepare_verified_note(make_settings(tmp_path))
    assert writer.commit(knowledge_id, 1).status == "published"
    modified = path.read_text(encoding="utf-8").replace(
        "> Middleware surrounds the request and response lifecycle.",
        "> 用户手工修改的注解。",
    )
    path.write_text(modified, encoding="utf-8")

    result = writer.commit(knowledge_id, 1)

    assert result.status == "needs_review"
    assert "用户手工修改的注解" in path.read_text(encoding="utf-8")


def test_original_change_is_not_silently_overwritten(tmp_path: Path) -> None:
    writer, path, knowledge_id = prepare_verified_note(make_settings(tmp_path))
    original = path.read_text(encoding="utf-8")
    changed = original.replace(
        "## Middleware",
        "## User changed the original tutorial heading",
    )
    path.write_text(changed, encoding="utf-8")

    result = writer.commit(knowledge_id, 1)

    assert result.status == "needs_review"
    assert path.read_text(encoding="utf-8") == changed


def test_without_annotation_consent_no_file_write(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    knowledge_id = create_s2a_draft(settings)
    verification = KnowledgeService(
        settings,
        verifier=KnowledgeVerifier(settings, provider=VerificationProvider()),
    )
    asyncio.run(verification.verify_knowledge(knowledge_id))
    snapshot = PageSnapshot.model_validate(snapshot_payload())
    identity = NoteResolver().resolve(snapshot.url, snapshot.title)
    path = Path(settings.vault_path) / identity.target_relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        build_new_document(identity, snapshot, snapshot.blocks, None, datetime.now(UTC)),
        encoding="utf-8",
    )
    before = path.read_bytes()
    writer = AnnotationWriteService(settings)

    with pytest.raises(KnowledgeServiceError) as error:
        writer.commit(knowledge_id, 1)

    assert error.value.code == "annotation_write_consent_required"
    assert path.read_bytes() == before


def test_explicit_manual_confirmation_allows_one_archive_without_auto_consent(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    knowledge_id = create_s2a_draft(settings)
    verification = KnowledgeService(
        settings,
        verifier=KnowledgeVerifier(settings, provider=VerificationProvider()),
    )
    asyncio.run(verification.verify_knowledge(knowledge_id))
    snapshot = PageSnapshot.model_validate(snapshot_payload())
    identity = NoteResolver().resolve(snapshot.url, snapshot.title)
    path = Path(settings.vault_path) / identity.target_relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        build_new_document(identity, snapshot, snapshot.blocks, None, datetime.now(UTC)),
        encoding="utf-8",
    )
    writer = AnnotationWriteService(settings)

    result = writer.commit(knowledge_id, 1, manual_confirmation=True)

    assert result.status == "published"
    assert "LEARNFLOW_ANNOTATION knowledge_id=" in path.read_text(encoding="utf-8")


def test_recovery_recognizes_file_written_before_db_update(tmp_path: Path) -> None:
    writer, path, knowledge_id = prepare_verified_note(make_settings(tmp_path))
    candidate = writer.planner.authoritative_candidate(knowledge_id, 1)
    assert candidate is not None
    plan, updated = writer.planner.plan_document(candidate)
    assert plan.plannedEdit is not None and updated is not None
    planned_hash = hashlib.sha256(updated.encode("utf-8")).hexdigest()
    intent = writer.store.create_annotation_intent(
        scope_id=plan.targetVaultScope,
        knowledge_id=knowledge_id,
        knowledge_version=1,
        target_note_id=candidate.targetNoteId,
        target_relative_path=plan.targetRelativePath,
        expected_file_revision=plan.expectedFileRevision,
        operation=plan.plannedEdit.action,
        planned_content_hash=planned_hash,
    )
    writer.store.update_annotation_intent(intent["intent_id"], status="applying", attempts=1)
    path.write_bytes(updated.encode("utf-8"))

    recovered = AnnotationWriteService(writer.settings)
    row = recovered.store.connection.execute(
        "SELECT status, applied_content_hash FROM annotation_write_intents WHERE intent_id = ?",
        (intent["intent_id"],),
    ).fetchone()

    assert row["status"] == "published"
    assert row["applied_content_hash"] == planned_hash
