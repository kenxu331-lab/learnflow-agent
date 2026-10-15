"""Persistent human approvals. Only decision() can initiate a Vault write."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from app.annotation_writer import AnnotationWriteService
from app.archive.locking import archive_mutex
from app.archive.planning import build_batch, candidate_fingerprint, content_hash
from app.core.config import Settings
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.schemas import PublishCandidateResponse
from app.learning_memory.store import LearningMemoryStore
from app.notes.errors import NoteServiceError
from app.notes.resolver import NoteResolver
from app.schemas.activity import StudyActivity
from app.schemas.annotations import AnnotationCommitResponse
from app.schemas.archive import ArchiveConfirmationView, KnowledgeReference
from app.schemas.study import StudySource

TERMINAL = {"published", "noop", "cancelled", "expired", "needs_review", "failed"}


def now() -> str:
    return datetime.now(UTC).isoformat()


class ArchiveConfirmations:
    def __init__(self, settings: Settings, memory: LearningMemoryStore):
        self.settings = settings
        self.memory = memory
        self.writer = AnnotationWriteService(settings)

    def context(self, conversation_id: str):
        conversation = self.memory.conversation(conversation_id)
        if conversation is None:
            raise KnowledgeServiceError(
                "conversation_not_found", "请先恢复当前章节会话。", 404
            )
        identity = NoteResolver().resolve(conversation.sourceUrl)
        scope = self.writer.store.resolve_scope()
        if not scope.bound:
            raise KnowledgeServiceError("vault_required", "请先配置并验证 Vault。", 409)
        return conversation, identity, scope

    def selection(self, conversation_id: str) -> tuple[list[KnowledgeReference], int]:
        _, identity, scope = self.context(conversation_id)
        with self.memory.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM study_archive_selections WHERE scope_id=? "
                "AND conversation_id=? AND chapter_id=?",
                (scope.scope_id, conversation_id, identity.chapter_id),
            ).fetchone()
        return (
            [
                KnowledgeReference.model_validate(item)
                for item in json.loads(row["references_json"])
            ]
            if row
            else [],
            row["revision"] if row else 0,
        )

    def candidates(self, conversation_id: str, references: list[KnowledgeReference]):
        _, identity, _ = self.context(conversation_id)
        if not references or len(references) > 10:
            raise KnowledgeServiceError(
                "archive_selection_required",
                "请明确选择 1 至 10 条知识，不能猜测‘刚才那两条’。",
                422,
            )
        if len({ref.knowledgeId for ref in references}) != len(references):
            raise KnowledgeServiceError(
                "archive_duplicate_reference", "同一知识不能重复选择。", 422
            )
        result = []
        for ref in references:
            bundle = self.writer.store.verification_bundle(ref.knowledgeId)
            if bundle is None or bundle["item"]["chapter_id"] != identity.chapter_id:
                raise KnowledgeServiceError(
                    "archive_scope_mismatch", "知识不属于当前章节或 Vault。", 409
                )
            candidate = self.writer.planner.authoritative_candidate(
                ref.knowledgeId, ref.version
            )
            if candidate is None:
                raise KnowledgeServiceError(
                    "archive_version_changed",
                    "知识版本已变化或尚未通过核验，请重新查看候选。",
                    409,
                )
            result.append(candidate)
        return result

    def select(self, conversation_id: str, references: list[KnowledgeReference]):
        _, identity, scope = self.context(conversation_id)
        if references:
            self.candidates(conversation_id, references)
        serialized = json.dumps(
            [
                ref.model_dump()
                for ref in sorted(references, key=lambda r: r.knowledgeId)
            ],
            sort_keys=True,
        )
        with self.memory.transaction() as connection:
            connection.execute(
                "INSERT INTO study_archive_selections VALUES (?, ?, ?, 1, ?) "
                "ON CONFLICT(scope_id,conversation_id,chapter_id) DO UPDATE SET "
                "revision=revision+CASE WHEN references_json<>excluded.references_json "
                "THEN 1 ELSE 0 END, "
                "references_json=excluded.references_json",
                (scope.scope_id, conversation_id, identity.chapter_id, serialized),
            )
        return self.selection(conversation_id)[0]

    def prepare(
        self,
        conversation_id: str,
        references: list[KnowledgeReference],
        message_id: str | None = None,
    ) -> ArchiveConfirmationView:
        conversation, identity, scope = self.context(conversation_id)
        selected, selection_revision = self.selection(conversation_id)
        references = references or selected
        candidates = self.candidates(conversation_id, references)
        batch = build_batch(self.writer.planner, candidates)
        proof = {
            "scope": scope.scope_id,
            "conversation": conversation_id,
            "chapter": identity.chapter_id,
            "selectionRevision": selection_revision,
            "candidates": [candidate_fingerprint(c) for c in candidates],
            "path": batch.path,
            "beforeHash": batch.revision,
            "afterHash": content_hash(batch.after),
            "diff": batch.diff,
            "plans": [
                {
                    key: value
                    for key, value in plan.model_dump(mode="json").items()
                    if key != "planId"
                }
                for plan in batch.plans
            ],
        }
        digest = content_hash(json.dumps(proof, ensure_ascii=False, sort_keys=True))
        created = now()
        expires = (datetime.now(UTC) + timedelta(minutes=30)).isoformat()
        view = ArchiveConfirmationView(
            confirmationId=f"archive-{uuid4().hex}",
            conversationId=conversation_id,
            chapterId=identity.chapter_id,
            sourceUrl=conversation.sourceUrl,
            state="pending",
            planDigest=digest,
            targetRelativePath=batch.path,
            expectedFileRevision=batch.revision,
            plannedContentHash=proof["afterHash"],
            diff=batch.diff,
            plans=batch.plans,
            message="请核对文件、位置和合并 Diff；点击确认后才写入。",
            createdAt=created,
            expiresAt=expires,
        )
        self.refresh_conversation(conversation_id)
        if message_id is None:
            message_id = self.memory.add_message(
                conversation_id=conversation_id,
                role="assistant",
                content="已生成归档确认卡片，尚未写入。",
                selected_text=None,
                source=StudySource(sourceUrl=conversation.sourceUrl),
                origin="ai",
            )
        payload = {
            "proof": proof,
            "candidates": [c.model_dump(mode="json") for c in candidates],
        }
        with self.memory.transaction() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                "SELECT * FROM archive_confirmations WHERE scope_id=? "
                "AND conversation_id=? AND digest=? "
                "AND state IN ('pending','applying') ORDER BY rowid DESC LIMIT 1",
                (scope.scope_id, conversation_id, digest),
            ).fetchone()
            if existing:
                view = ArchiveConfirmationView.model_validate_json(
                    existing["view_json"]
                )
            else:
                connection.execute(
                    "INSERT INTO archive_confirmations VALUES "
                    "(?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        view.confirmationId,
                        scope.scope_id,
                        conversation_id,
                        identity.chapter_id,
                        selection_revision,
                        view.state,
                        digest,
                        json.dumps(payload, ensure_ascii=False),
                        view.model_dump_json(),
                    ),
                )
            connection.execute(
                "INSERT OR IGNORE INTO study_archive_views VALUES (?, ?)",
                (message_id, view.confirmationId),
            )
        return view

    def _row(self, confirmation_id: str, conversation_id: str):
        with self.memory.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM archive_confirmations "
                "WHERE confirmation_id=? AND conversation_id=?",
                (confirmation_id, conversation_id),
            ).fetchone()
        if row is None:
            raise KnowledgeServiceError(
                "archive_not_found", "未找到本会话的归档确认。", 404
            )
        return row

    def _validate(self, row):
        _, identity, scope = self.context(row["conversation_id"])
        if (
            scope.scope_id != row["scope_id"]
            or identity.chapter_id != row["chapter_id"]
        ):
            raise KnowledgeServiceError(
                "archive_scope_changed", "Vault 或章节范围已变化，未写入。", 409
            )
        if self.selection(row["conversation_id"])[1] != row["selection_revision"]:
            raise KnowledgeServiceError(
                "archive_selection_changed", "所选知识已变化，请重新预览。", 409
            )
        payload = self._payload(row)
        stored = [
            PublishCandidateResponse.model_validate(c) for c in payload["candidates"]
        ]
        current = self.candidates(
            row["conversation_id"],
            [
                KnowledgeReference(
                    knowledgeId=c.knowledgeId, version=c.knowledgeVersion
                )
                for c in stored
            ],
        )
        if [candidate_fingerprint(c) for c in current] != payload["proof"][
            "candidates"
        ]:
            raise KnowledgeServiceError(
                "archive_version_changed", "知识版本、核验或来源变化，请重新预览。", 409
            )
        return stored

    def _payload(self, row):
        payload = json.loads(row["payload_json"])
        proof = payload["proof"]
        view = ArchiveConfirmationView.model_validate_json(row["view_json"])
        plans = [
            {
                key: value
                for key, value in plan.model_dump(mode="json").items()
                if key != "planId"
            }
            for plan in view.plans
        ]
        if (
            content_hash(json.dumps(proof, ensure_ascii=False, sort_keys=True))
            != row["digest"]
            or view.planDigest != row["digest"]
            or proof["scope"] != row["scope_id"]
            or proof["conversation"] != view.conversationId
            or view.conversationId != row["conversation_id"]
            or proof["chapter"] != view.chapterId
            or proof["selectionRevision"] != row["selection_revision"]
            or proof["path"] != view.targetRelativePath
            or proof["beforeHash"] != view.expectedFileRevision
            or proof["afterHash"] != view.plannedContentHash
            or proof["diff"] != view.diff
            or proof["plans"] != plans
        ):
            raise KnowledgeServiceError(
                "archive_digest_mismatch", "预览内容与确认摘要不一致，未写入。", 409
            )
        return payload

    def _transition(
        self,
        row,
        view: ArchiveConfirmationView,
        state: str,
        message: str,
        results: list[AnnotationCommitResponse] | None = None,
    ):
        view = view.model_copy(update={"state": state, "message": message})
        if results is not None:
            view.results = results
        with self.memory.transaction() as connection:
            changed = connection.execute(
                "UPDATE archive_confirmations SET state=?, view_json=? "
                "WHERE confirmation_id=? AND state=? AND view_json=?",
                (
                    state,
                    view.model_dump_json(),
                    row["confirmation_id"],
                    row["state"],
                    row["view_json"],
                ),
            )
            if not changed.rowcount:
                return ArchiveConfirmationView.model_validate_json(
                    self._row(row["confirmation_id"], row["conversation_id"])[
                        "view_json"
                    ]
                )
            if state in TERMINAL:
                links = connection.execute(
                    "SELECT message_id FROM study_archive_views "
                    "WHERE confirmation_id=?",
                    (row["confirmation_id"],),
                ).fetchall()
                for link in links:
                    sequence = connection.execute(
                        "SELECT COALESCE(MAX(sequence),0)+1 FROM study_activities "
                        "WHERE message_id=?",
                        (link[0],),
                    ).fetchone()[0]
                    event = StudyActivity(
                        type="task_completed"
                        if state in {"published", "noop", "cancelled"}
                        else "task_failed",
                        eventId=f"{row['confirmation_id']}:{link[0]}:{state}",
                        runId=row["confirmation_id"],
                        conversationId=row["conversation_id"],
                        sourceUrl=view.sourceUrl,
                        sequence=sequence,
                        activityId=row["confirmation_id"],
                        createdAt=now(),
                        summary=message,
                    )
                    connection.execute(
                        "INSERT OR IGNORE INTO study_activities VALUES (?, ?, ?, ?)",
                        (event.eventId, link[0], sequence, event.model_dump_json()),
                    )
                    connection.execute(
                        "UPDATE messages SET content=content || ? WHERE message_id=?",
                        ("\n\n" + message, link[0]),
                    )
        return view

    def _recover_results(self, row, view, candidates):
        results = []
        for candidate, plan in zip(candidates, view.plans, strict=True):
            intent = self.writer.store.create_annotation_intent(
                scope_id=row["scope_id"],
                knowledge_id=candidate.knowledgeId,
                knowledge_version=candidate.knowledgeVersion,
                target_note_id=candidate.targetNoteId,
                target_relative_path=view.targetRelativePath,
                expected_file_revision=view.expectedFileRevision,
                operation=plan.plannedEdit.action,
                planned_content_hash=view.plannedContentHash,
            )
            status = "noop" if plan.plannedEdit.action == "noop" else "published"
            self.writer.store.update_annotation_intent(
                intent["intent_id"],
                status=status,
                applied_content_hash=view.plannedContentHash,
            )
            actual = self.writer.planner.plan(candidate)
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

    def _complete(self, row, view, results):
        status = (
            "noop"
            if all(result.status == "noop" for result in results)
            else "published"
        )
        locations = [
            f"{result.plan.targetRelativePath} · {' / '.join(result.plan.headingPath)}"
            f" · 第 {result.plan.plannedEdit.anchorLine} 行"
            for result in results
        ]
        message = (
            ("知识已存在，无需重复写入：" if status == "noop" else "已归档：")
            + "\n"
            + "\n".join(locations)
        )
        return self._transition(row, view, status, message, results)

    def get(self, confirmation_id: str, conversation_id: str):
        row = self._row(confirmation_id, conversation_id)
        view = ArchiveConfirmationView.model_validate_json(row["view_json"])
        if view.state in TERMINAL:
            return view
        try:
            with archive_mutex(
                self.settings, "confirmation:" + confirmation_id, timeout=0
            ):
                return self._inspect(row, view)
        except KnowledgeServiceError as error:
            if error.code == "archive_busy":
                return view
            raise

    def _inspect(self, row, view):
        try:
            self._payload(row)
            if view.state == "applying" and view.approvedAt:
                if self.writer.store.resolve_scope().scope_id != row["scope_id"]:
                    raise KnowledgeServiceError(
                        "archive_scope_changed", "Vault 已变化，停止恢复。", 409
                    )
                _, _, revision = self.writer.planner.vault.read_text(
                    view.targetRelativePath
                )
                if revision == view.plannedContentHash:
                    candidates = [
                        PublishCandidateResponse.model_validate(c)
                        for c in json.loads(row["payload_json"])["candidates"]
                    ]
                    return self._complete(
                        row, view, self._recover_results(row, view, candidates)
                    )
                if revision != view.expectedFileRevision:
                    raise KnowledgeServiceError(
                        "archive_file_changed",
                        "中断后文件已变化，不能自动恢复，请重新预览。",
                        409,
                    )
                return self._transition(
                    row,
                    view,
                    "interrupted",
                    "归档曾中断且文件未写入；可再次确认继续，不会自动写入。",
                )
            if datetime.fromisoformat(view.expiresAt) <= datetime.now(UTC):
                return self._transition(
                    row, view, "expired", "确认已过期，未写入；请重新预览。"
                )
            self._validate(row)
            return view
        except (KnowledgeServiceError, NoteServiceError) as error:
            return self._transition(row, view, "needs_review", error.message)

    def decision(
        self, confirmation_id: str, conversation_id: str, digest: str, decision: str
    ):
        with archive_mutex(self.settings, "confirmation:" + confirmation_id):
            row = self._row(confirmation_id, conversation_id)
            if digest != row["digest"]:
                raise KnowledgeServiceError(
                    "archive_digest_mismatch", "确认与预览计划不匹配。", 409
                )
            view = ArchiveConfirmationView.model_validate_json(row["view_json"])
            if view.state in TERMINAL:
                return view
            view = self._inspect(row, view)
            row = self._row(confirmation_id, conversation_id)
            if view.state in TERMINAL:
                return view
            if decision == "cancel":
                return self._transition(row, view, "cancelled", "已取消归档，未写入。")
            try:
                if datetime.fromisoformat(view.expiresAt) <= datetime.now(UTC):
                    return self._transition(
                        row, view, "expired", "确认已过期，请重新预览。"
                    )
                candidates = self._validate(row)
                view.approvedAt = view.approvedAt or now()
                view = self._transition(
                    row, view, "applying", "正在写入已确认的 Diff。"
                )
                row = self._row(confirmation_id, conversation_id)
                _, _, revision = self.writer.planner.vault.read_text(
                    view.targetRelativePath
                )
                if revision == view.plannedContentHash:
                    return self._complete(
                        row, view, self._recover_results(row, view, candidates)
                    )
                results = self.writer.commit_approved_batch(
                    candidates,
                    expected_revision=view.expectedFileRevision,
                    planned_content_hash=view.plannedContentHash,
                    target_path=view.targetRelativePath,
                )
                return self._complete(row, view, results)
            except (KnowledgeServiceError, NoteServiceError, OSError) as error:
                message = getattr(
                    error, "message", "文件写入失败，请检查 Vault；未确认保存成功。"
                )
                return self._transition(row, view, "needs_review", message)

    def refresh_conversation(self, conversation_id: str):
        with self.memory.transaction() as connection:
            rows = connection.execute(
                "SELECT confirmation_id FROM archive_confirmations "
                "WHERE conversation_id=? "
                "AND state IN ('pending','applying','interrupted')",
                (conversation_id,),
            ).fetchall()
        for row in rows:
            self.get(row[0], conversation_id)
