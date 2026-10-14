"""S3-03 orchestration tests with Fake Providers and temporary Vaults."""

from __future__ import annotations

import asyncio
from pathlib import Path

from app.annotation_writer import AnnotationWriteService
from app.knowledge.service import KnowledgeService
from app.knowledge.store import KnowledgeStore
from app.knowledge.verifier import KnowledgeVerifier
from app.orchestrator import KnowledgePublishOrchestrator
from tests.test_annotation_writer import make_settings, prepare_verified_note
from tests.test_knowledge_s2b import VerificationProvider, create_s2a_draft


def test_orchestrator_only_extracts_and_manual_commit_writes(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    writer, path, knowledge_id = prepare_verified_note(settings)
    knowledge = KnowledgeService(
        settings, verifier=KnowledgeVerifier(settings, provider=VerificationProvider())
    )
    orchestrator = KnowledgePublishOrchestrator(
        settings, knowledge=knowledge, writer=writer
    )

    assert asyncio.run(orchestrator.run_once()) is False
    assert "LEARNFLOW_ANNOTATION knowledge_id=" not in path.read_text(encoding="utf-8")
    assert writer.commit(knowledge_id, 1).status == "published"
    first_content = path.read_text(encoding="utf-8")
    assert "LEARNFLOW_ANNOTATION knowledge_id=" in first_content
    assert asyncio.run(orchestrator.run_once()) is False
    assert path.read_text(encoding="utf-8") == first_content
    assert (
        knowledge.store.latest_annotation_intent(knowledge_id, 1)["status"]
        == "published"
    )


def test_orchestrator_stops_after_user_annotation_edit(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    writer, path, knowledge_id = prepare_verified_note(settings)
    knowledge = KnowledgeService(
        settings, verifier=KnowledgeVerifier(settings, provider=VerificationProvider())
    )
    orchestrator = KnowledgePublishOrchestrator(
        settings, knowledge=knowledge, writer=writer
    )
    assert asyncio.run(orchestrator.run_once()) is False
    assert writer.commit(knowledge_id, 1).status == "published"
    changed = path.read_text(encoding="utf-8").replace(
        "> Middleware surrounds the request and response lifecycle.",
        "> User edited this annotation.",
    )
    path.write_text(changed, encoding="utf-8")

    assert asyncio.run(orchestrator.run_once()) is False

    assert "User edited this annotation." in path.read_text(encoding="utf-8")
    assert "LEARNFLOW_ANNOTATION knowledge_id=" in path.read_text(encoding="utf-8")


def test_orchestrator_retries_review_after_user_repairs_target_note(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    writer, path, knowledge_id = prepare_verified_note(settings)
    managed = path.read_text(encoding="utf-8")
    path.write_text(
        "# Legacy note\n\n来源：<https://fastapi.tiangolo.com/tutorial/middleware/>\n",
        encoding="utf-8",
    )
    knowledge = KnowledgeService(
        settings, verifier=KnowledgeVerifier(settings, provider=VerificationProvider())
    )
    orchestrator = KnowledgePublishOrchestrator(
        settings, knowledge=knowledge, writer=writer
    )

    assert asyncio.run(orchestrator.run_once()) is False
    path.write_text(managed, encoding="utf-8")
    assert asyncio.run(orchestrator.run_once()) is False
    assert "LEARNFLOW_ANNOTATION knowledge_id=" not in path.read_text(encoding="utf-8")


def test_revoked_cloud_consent_does_not_call_verifier(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    create_s2a_draft(settings)
    store = KnowledgeStore(settings)
    scope = store.resolve_scope()
    store.set_consent(False, "test-v1")
    provider = VerificationProvider()
    knowledge = KnowledgeService(
        settings, verifier=KnowledgeVerifier(settings, provider=provider)
    )
    writer = AnnotationWriteService(settings)
    writer.set_consent(False, "s3-02-test-v1")
    orchestrator = KnowledgePublishOrchestrator(
        settings, knowledge=knowledge, writer=writer
    )

    asyncio.run(orchestrator.run_once())

    assert provider.calls == 0
    assert knowledge.store.unverified_knowledge()
    assert scope.scope_id == knowledge.store.resolve_scope().scope_id
