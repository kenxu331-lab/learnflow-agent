# ruff: noqa: E501
"""S3-02 Safe Write Engine for approved annotation plans."""

from __future__ import annotations

import hashlib
import os
import threading
from typing import Any

from app.annotation_planner import AnnotationPlanner
from app.archive.locking import archive_mutex
from app.archive.planning import build_batch, candidate_fingerprint
from app.core.config import Settings
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.schemas import PublishCandidateResponse
from app.knowledge.store import KnowledgeStore
from app.notes.errors import NoteServiceError
from app.notes.resolver import NoteResolver
from app.notes.service import MarkdownNoteService
from app.schemas.annotations import AnnotationCommitResponse


def _content_hash(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


class AnnotationWriteService:
    """Re-plan on every commit and write only through MarkdownNoteService."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.store = KnowledgeStore(settings)
        self.planner = AnnotationPlanner(settings)
        self.notes = MarkdownNoteService(settings)
        self.resolver = NoteResolver()
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self.recover_applying_intents()

    def _lock_for(self, path: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(path, threading.Lock())

    def consent_status(self) -> dict[str, Any]:
        return self.store.annotation_consent_status()

    def should_retry_review_intent(self, intent: Any) -> bool:
        """Retry a paused intent only after the target file actually changed."""

        if intent["status"] != "needs_review":
            return False
        try:
            _, _, current_revision = self.planner.vault.read_text(
                intent["target_relative_path"]
            )
        except NoteServiceError:
            return False
        return current_revision != intent["expected_file_revision"]

    def set_consent(self, enabled: bool, policy_version: str) -> dict[str, Any]:
        return self.store.set_annotation_consent(enabled, policy_version)

    def recover_applying_intents(self) -> None:
        for intent in self.store.applying_annotation_intents():
            try:
                _, content, revision = self.planner.vault.read_text(
                    intent["target_relative_path"]
                )
            except NoteServiceError:
                self.store.update_annotation_intent(
                    intent["intent_id"],
                    status="needs_review",
                    failure_code="target_unreadable",
                )
                continue
            if revision == intent["planned_content_hash"]:
                self.store.update_annotation_intent(
                    intent["intent_id"],
                    status="published",
                    applied_content_hash=revision,
                )
            elif revision == intent["expected_file_revision"]:
                self.store.update_annotation_intent(
                    intent["intent_id"], status="pending"
                )
            else:
                self.store.update_annotation_intent(
                    intent["intent_id"],
                    status="needs_review",
                    failure_code="external_file_change",
                )

    def commit(
        self,
        knowledge_id: str,
        knowledge_version: int,
        *,
        manual_confirmation: bool = False,
    ) -> AnnotationCommitResponse:
        self.recover_applying_intents()
        consent = self.store.annotation_consent_status()
        if consent["state"] != "active" and not manual_confirmation:
            raise KnowledgeServiceError(
                "annotation_write_consent_required",
                "请先启用当前 Profile + Vault 的自动归档授权。",
                403,
            )
        candidate = self.planner.authoritative_candidate(
            knowledge_id, knowledge_version
        )
        if candidate is None:
            raise KnowledgeServiceError(
                "publish_candidate_not_found",
                "未找到当前作用域内具备发布资格的 PublishCandidate。",
                409,
            )
        plan, updated = self.planner.plan_document(candidate)
        if plan.conflictStatus != "clear" or plan.plannedEdit is None:
            intent = self.store.create_annotation_intent(
                scope_id=plan.targetVaultScope,
                knowledge_id=knowledge_id,
                knowledge_version=knowledge_version,
                target_note_id=candidate.targetNoteId,
                target_relative_path=plan.targetRelativePath,
                expected_file_revision=plan.expectedFileRevision,
                operation="update",
                planned_content_hash=None,
            )
            self.store.update_annotation_intent(
                intent["intent_id"],
                status="needs_review",
                failure_code="planner_conflict",
            )
            return AnnotationCommitResponse(
                status="needs_review", intentId=intent["intent_id"], plan=plan
            )

        lock = self._lock_for(plan.targetRelativePath)
        with lock:
            if plan.plannedEdit.action == "noop":
                intent = self.store.create_annotation_intent(
                    scope_id=plan.targetVaultScope,
                    knowledge_id=knowledge_id,
                    knowledge_version=knowledge_version,
                    target_note_id=candidate.targetNoteId,
                    target_relative_path=plan.targetRelativePath,
                    expected_file_revision=plan.expectedFileRevision,
                    operation="noop",
                    planned_content_hash=plan.expectedFileRevision,
                )
                self.store.update_annotation_intent(intent["intent_id"], status="noop")
                return AnnotationCommitResponse(
                    status="noop", intentId=intent["intent_id"], plan=plan
                )
            if updated is None or plan.expectedFileRevision is None:
                raise KnowledgeServiceError(
                    "annotation_plan_invalid",
                    "安全写入计划缺少当前文件版本或正文。",
                    409,
                )
            _, current_document, current_revision = self.planner.vault.read_text(
                plan.targetRelativePath
            )
            if (
                current_document is None
                or current_revision != plan.expectedFileRevision
                or not self.planner.source_anchor_matches_document(
                    candidate, current_document
                )
            ):
                intent = self.store.create_annotation_intent(
                    scope_id=plan.targetVaultScope,
                    knowledge_id=knowledge_id,
                    knowledge_version=knowledge_version,
                    target_note_id=candidate.targetNoteId,
                    target_relative_path=plan.targetRelativePath,
                    expected_file_revision=plan.expectedFileRevision,
                    operation=plan.plannedEdit.action,
                    planned_content_hash=None,
                )
                self.store.update_annotation_intent(
                    intent["intent_id"],
                    status="needs_review",
                    failure_code="source_changed",
                )
                review_plan = plan.model_copy(
                    update={
                        "conflictStatus": "needs_review",
                        "conflictReason": "source_changed: 当前原文块与来源快照不一致。",
                        "plannedEdit": None,
                    }
                )
                return AnnotationCommitResponse(
                    status="needs_review",
                    intentId=intent["intent_id"],
                    plan=review_plan,
                    failureCode="source_changed",
                )
            planned_hash = _content_hash(updated)
            intent = self.store.create_annotation_intent(
                scope_id=plan.targetVaultScope,
                knowledge_id=knowledge_id,
                knowledge_version=knowledge_version,
                target_note_id=candidate.targetNoteId,
                target_relative_path=plan.targetRelativePath,
                expected_file_revision=plan.expectedFileRevision,
                operation=plan.plannedEdit.action,
                planned_content_hash=planned_hash,
            )
            if intent["status"] in {"published", "noop"}:
                return AnnotationCommitResponse(
                    status=intent["status"], intentId=intent["intent_id"], plan=plan
                )
            attempts = intent["attempts"] + 1
            self.store.update_annotation_intent(
                intent["intent_id"], status="applying", attempts=attempts
            )
            try:
                identity = self.resolver.resolve(candidate.sourceUrl)
                revision = self.notes.replace_managed_note(
                    identity=identity,
                    relative_path=plan.targetRelativePath,
                    expected_revision=plan.expectedFileRevision,
                    content=updated,
                )
            except NoteServiceError as error:
                self.store.update_annotation_intent(
                    intent["intent_id"],
                    status="needs_review",
                    failure_code=error.code,
                )
                review_plan = plan.model_copy(
                    update={
                        "conflictStatus": "needs_review",
                        "conflictReason": f"{error.code}: {error.message}",
                        "plannedEdit": None,
                    }
                )
                return AnnotationCommitResponse(
                    status="needs_review",
                    intentId=intent["intent_id"],
                    plan=review_plan,
                    failureCode=error.code,
                )
            self.store.update_annotation_intent(
                intent["intent_id"],
                status="published",
                applied_content_hash=revision,
            )
            return AnnotationCommitResponse(
                status="published", intentId=intent["intent_id"], plan=plan
            )

    def commit_approved_batch(
        self,
        candidates: list[PublishCandidateResponse],
        *,
        expected_revision: str,
        planned_content_hash: str,
        target_path: str,
    ) -> list[AnnotationCommitResponse]:
        """Write one already-approved combined Diff, with no implicit re-approval."""
        target = os.path.normcase(str(self.planner.vault.target_path(target_path)))
        with archive_mutex(self.settings, "file:" + target):
            for candidate in candidates:
                current = self.planner.authoritative_candidate(
                    candidate.knowledgeId, candidate.knowledgeVersion
                )
                if current is None or candidate_fingerprint(
                    current
                ) != candidate_fingerprint(candidate):
                    raise KnowledgeServiceError(
                        "archive_version_changed",
                        "知识版本、资格或来源已变化，请重新预览。",
                        409,
                    )
            batch = build_batch(self.planner, candidates)
            if (
                batch.path != target_path
                or batch.revision != expected_revision
                or _content_hash(batch.after) != planned_content_hash
            ):
                raise KnowledgeServiceError(
                    "archive_plan_changed",
                    "当前文件或 Diff 与已确认计划不同，未写入。",
                    409,
                )
            intents = []
            for candidate, plan in zip(candidates, batch.plans, strict=True):
                intent = self.store.create_annotation_intent(
                    scope_id=plan.targetVaultScope,
                    knowledge_id=candidate.knowledgeId,
                    knowledge_version=candidate.knowledgeVersion,
                    target_note_id=candidate.targetNoteId,
                    target_relative_path=batch.path,
                    expected_file_revision=batch.revision,
                    operation=plan.plannedEdit.action,
                    planned_content_hash=planned_content_hash,
                )
                intents.append(intent)
                self.store.update_annotation_intent(
                    intent["intent_id"],
                    status="applying",
                    attempts=intent["attempts"] + 1,
                )
            if planned_content_hash != batch.revision:
                identity = self.resolver.resolve(candidates[0].sourceUrl)
                try:
                    revision = self.notes.replace_managed_note(
                        identity=identity,
                        relative_path=batch.path,
                        expected_revision=batch.revision,
                        content=batch.after,
                    )
                except NoteServiceError as error:
                    for intent in intents:
                        self.store.update_annotation_intent(
                            intent["intent_id"],
                            status="needs_review",
                            failure_code=error.code,
                        )
                    raise
                if revision != planned_content_hash:
                    raise KnowledgeServiceError(
                        "archive_hash_mismatch", "文件写入结果校验失败，请检查。", 409
                    )
            results = []
            for intent, plan in zip(intents, batch.plans, strict=True):
                status = "noop" if plan.plannedEdit.action == "noop" else "published"
                self.store.update_annotation_intent(
                    intent["intent_id"],
                    status=status,
                    applied_content_hash=planned_content_hash,
                )
                candidate = next(
                    c for c in candidates if c.knowledgeId == plan.knowledgeId
                )
                actual = self.planner.plan(candidate)
                if actual.plannedEdit:
                    plan = plan.model_copy(
                        update={
                            "plannedEdit": plan.plannedEdit.model_copy(
                                update={"anchorLine": actual.plannedEdit.anchorLine}
                            )
                        }
                    )
                results.append(
                    AnnotationCommitResponse(
                        status=status, intentId=intent["intent_id"], plan=plan
                    )
                )
            return results
