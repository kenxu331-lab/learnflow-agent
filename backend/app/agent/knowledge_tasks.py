"""Durable adapters around S2 services. No Vault writer or model polling."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import unicodedata
from datetime import UTC, datetime
from difflib import SequenceMatcher
from uuid import uuid4

from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.service import KnowledgeService
from app.learning_memory.store import LearningMemoryStore
from app.schemas.activity import StudyActivity
from app.schemas.knowledge_view import KnowledgeItemView, KnowledgeTaskView

PENDING = {"submitting", "waiting_previous", "queued", "extracting", "verifying"}
ACTIVE_JOBS = {"queued", "running", "retryable_failed"}
logger = logging.getLogger(__name__)


def now() -> str:
    return datetime.now(UTC).isoformat()


def normalized_body(body: str) -> str:
    # Preserve code punctuation, case and internal whitespace.
    return unicodedata.normalize(
        "NFC",
        "\n".join(line.rstrip() for line in body.replace("\r\n", "\n").split("\n")),
    ).strip()


def deduplicate(items: list[KnowledgeItemView]) -> tuple[list[KnowledgeItemView], int]:
    groups: dict[tuple[str, str], KnowledgeItemView] = {}
    count = 0
    # Prefer an already archived or eligible version, without changing records.
    items = sorted(
        items,
        key=lambda item: (
            not item.archived,
            item.publishCandidate is None,
            item.knowledgeId,
        ),
    )
    for item in items:
        key = (item.kind, normalized_body(item.body))
        previous = groups.get(key)
        if previous:
            previous.duplicateIds.append(item.knowledgeId)
            count += 1
        else:
            groups[key] = item
    result = list(groups.values())
    for index, item in enumerate(result):
        for previous in result[:index]:
            if (
                item.kind == previous.kind
                and min(len(item.body), len(previous.body)) >= 40
                and SequenceMatcher(
                    None, item.body[:1200], previous.body[:1200]
                ).ratio()
                >= 0.88
            ):
                item.similarTo.append(previous.knowledgeId)
                previous.similarTo.append(item.knowledgeId)
    return result, count


class KnowledgeTasks:
    def __init__(self, knowledge: KnowledgeService, memory: LearningMemoryStore):
        self.knowledge = knowledge
        self.memory = memory

    def query(
        self, conversation_id: str, chapter_id: str, source_url: str, query: str = ""
    ) -> KnowledgeTaskView:
        items = []
        rows = self.knowledge.store.list_drafts(chapter_id)
        if query:
            rows = [
                row
                for row in rows
                if query.casefold() in (row["topic"] + "\n" + row["body"]).casefold()
            ]
        for row in rows[:80]:
            bundle = self.knowledge.store.verification_bundle(
                row["knowledge_id"], row["active_version"]
            )
            if bundle is None:
                continue
            verified = self.knowledge._verification_response(bundle)
            intent = self.knowledge.store.latest_annotation_intent(
                row["knowledge_id"], row["active_version"]
            )
            items.append(
                KnowledgeItemView(
                    knowledgeId=row["knowledge_id"],
                    version=row["active_version"],
                    topic=row["topic"],
                    kind=row["kind"],
                    body=row["body"],
                    sourceUrl=bundle["version"].get("anchor_source_url") or source_url,
                    verificationStatus=verified["verificationStatus"],
                    publishStatus=verified["publishStatus"],
                    evidenceGapReason=row["evidence_gap_reason"],
                    archived=bool(intent and intent["status"] in {"published", "noop"}),
                    claims=verified["claims"],
                    publishCandidate=verified["publishCandidate"],
                )
            )
        items, duplicates = deduplicate(items)
        return KnowledgeTaskView(
            conversationId=conversation_id,
            chapterId=chapter_id,
            sourceUrl=source_url,
            state="available",
            message=(
                f"本次展示 {min(len(items), 30)} 条去重知识；未执行归档。"
                + (
                    "结果已限制数量，可按关键词继续查询。"
                    if len(rows) > 80 or len(items) > 30
                    else ""
                )
            ),
            items=items[:30],
            duplicateCount=duplicates,
            updatedAt=now(),
        )

    def save_view(self, message_id: str, view: KnowledgeTaskView) -> None:
        with self.memory.transaction() as connection:
            connection.execute(
                "INSERT INTO study_knowledge_views VALUES (?, ?, ?) "
                "ON CONFLICT(message_id) DO UPDATE SET "
                "task_id=excluded.task_id, payload_json=excluded.payload_json",
                (message_id, view.taskId, view.model_dump_json()),
            )

    def input_state(self, conversation_id: str, chapter_id: str) -> dict:
        scope = self.knowledge.store.resolve_scope()
        with self.knowledge.store.lock:
            event = self.knowledge.store.connection.execute(
                "SELECT le.event_id, le.created_at FROM learning_events le "
                "JOIN event_contexts ec ON ec.event_id=le.event_id "
                "WHERE ec.scope_id=? AND ec.chapter_id=? AND le.conversation_id=? "
                "AND ec.link_status='linked' "
                "ORDER BY le.created_at DESC, le.event_id DESC LIMIT 1",
                (scope.scope_id, chapter_id, conversation_id),
            ).fetchone()
            cursor = self.knowledge.store.connection.execute(
                "SELECT last_completed_event_at, last_completed_event_id "
                "FROM chapter_extraction_cursors "
                "WHERE scope_id=? AND chapter_id=? AND conversation_id=?",
                (scope.scope_id, chapter_id, conversation_id),
            ).fetchone()
        target = (event["created_at"], event["event_id"]) if event else ("", "")
        completed = (cursor[0] or "", cursor[1] or "") if cursor else ("", "")
        return {
            "scopeId": scope.scope_id,
            "bound": scope.bound,
            "target": target,
            "hasNewContent": target > completed,
        }

    def submit(
        self,
        *,
        conversation_id: str,
        chapter_id: str,
        source_url: str,
        message_id: str,
        run_id: str,
    ) -> KnowledgeTaskView:
        input_state = self.input_state(conversation_id, chapter_id)
        if not input_state["bound"]:
            raise KnowledgeServiceError(
                "vault_required", "请先配置并验证 Vault；本次未提交提炼。", 409
            )
        with self.memory.transaction() as connection:
            active = connection.execute(
                "SELECT task_id FROM agent_knowledge_tasks WHERE scope_id=? "
                "AND chapter_id=? AND conversation_id=? "
                "AND state IN "
                "('submitting','waiting_previous','queued','extracting','verifying') "
                "AND (target_event_at>? OR (target_event_at=? AND target_event_id>=?)) "
                "ORDER BY created_at LIMIT 1",
                (
                    input_state["scopeId"],
                    chapter_id,
                    conversation_id,
                    input_state["target"][0],
                    input_state["target"][0],
                    input_state["target"][1],
                ),
            ).fetchone()
        if active:
            self.refresh(active[0])
            view = self.view(active[0])
            self.save_view(message_id, view)
            return view
        if not input_state["hasNewContent"]:
            failed = self.current_failure(
                conversation_id, chapter_id, input_state["target"][1]
            )
            if failed:
                self.save_view(message_id, failed)
                return failed
            view = self.query(conversation_id, chapter_id, source_url)
            view.state = "no_new_events"
            view.noNewContent = True
            view.message = "没有新的可提炼对话。可以查看最近已有知识；未重复提炼。"
            self.save_view(message_id, view)
            return view
        target_at, target_id = input_state["target"]
        key = hashlib.sha256(
            json.dumps(
                [
                    input_state["scopeId"],
                    chapter_id,
                    conversation_id,
                    target_at,
                    target_id,
                ]
            ).encode()
        ).hexdigest()
        with self.memory.transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO agent_knowledge_tasks VALUES "
                "(?, ?, ?, ?, ?, ?, ?, ?, 'submitting', NULL, ?, ?, ?, NULL)",
                (
                    f"akt-{uuid4().hex}",
                    key,
                    input_state["scopeId"],
                    chapter_id,
                    conversation_id,
                    source_url,
                    target_at,
                    target_id,
                    run_id,
                    now(),
                    now(),
                ),
            )
            row = connection.execute(
                "SELECT * FROM agent_knowledge_tasks WHERE input_key=?", (key,)
            ).fetchone()
        # Link before queueing: a crashed submit is recoverable without a model.
        view = KnowledgeTaskView(
            taskId=row["task_id"],
            conversationId=conversation_id,
            chapterId=chapter_id,
            sourceUrl=source_url,
            state=row["state"],
            message="知识任务已登记，等待提炼与核验。",
            updatedAt=now(),
        )
        self.save_view(message_id, view)
        self.refresh(row["task_id"])
        return self.view(row["task_id"])

    def view(self, task_id: str) -> KnowledgeTaskView:
        with self.memory.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM agent_knowledge_tasks WHERE task_id=?", (task_id,)
            ).fetchone()
        if row is None:
            raise KnowledgeServiceError("task_not_found", "未找到当前知识任务。", 404)
        if row["result_json"]:
            return KnowledgeTaskView.model_validate_json(row["result_json"])
        return KnowledgeTaskView(
            taskId=task_id,
            conversationId=row["conversation_id"],
            chapterId=row["chapter_id"],
            sourceUrl=row["source_url"],
            state=row["state"],
            message="知识任务处理中。",
            updatedAt=row["updated_at"],
        )

    def current_failure(
        self, conversation_id: str, chapter_id: str, event_id: str
    ) -> KnowledgeTaskView | None:
        with self.memory.transaction() as connection:
            row = connection.execute(
                "SELECT task_id FROM agent_knowledge_tasks WHERE scope_id=? "
                "AND chapter_id=? AND conversation_id=? AND state='failed' "
                "AND target_event_id=? ORDER BY created_at DESC LIMIT 1",
                (
                    self.knowledge.store.resolve_scope().scope_id,
                    chapter_id,
                    conversation_id,
                    event_id,
                ),
            ).fetchone()
        return self.view(row[0]) if row else None

    def refresh(self, task_id: str) -> None:
        with self.memory.transaction() as connection:
            row = connection.execute(
                "SELECT * FROM agent_knowledge_tasks WHERE task_id=?", (task_id,)
            ).fetchone()
        if row is None or row["state"] not in PENDING:
            return
        if row["scope_id"] != self.knowledge.store.resolve_scope().scope_id:
            self._finish(
                row,
                "failed",
                "Vault 范围已变化，任务停止；未归档。",
                include_items=False,
            )
            return
        with self.knowledge.store.lock:
            jobs = self.knowledge.store.connection.execute(
                "SELECT * FROM extraction_jobs WHERE scope_id=? "
                "AND chapter_id=? AND conversation_id=? ORDER BY created_at",
                (row["scope_id"], row["chapter_id"], row["conversation_id"]),
            ).fetchall()
        target = (row["target_event_at"], row["target_event_id"])
        job = next((job for job in jobs if job["job_id"] == row["job_id"]), None)
        if job is None:
            job = next(
                (
                    job
                    for job in jobs
                    if (job["event_high_watermark_at"], job["event_high_watermark_id"])
                    >= target
                ),
                None,
            )
        if job is None:
            if any(job["state"] in ACTIVE_JOBS for job in jobs):
                self._progress(
                    row, "waiting_previous", "等待本会话上一批提炼完成，避免重复任务。"
                )
                return
            # The existing scheduler's batch fingerprint is the idempotency fence.
            self.knowledge.trigger(row["chapter_id"], row["conversation_id"])
            with self.knowledge.store.lock:
                job = self.knowledge.store.connection.execute(
                    "SELECT * FROM extraction_jobs WHERE scope_id=? "
                    "AND chapter_id=? AND conversation_id=? "
                    "AND (event_high_watermark_at>? OR "
                    "(event_high_watermark_at=? AND event_high_watermark_id>=?)) "
                    "ORDER BY created_at LIMIT 1",
                    (
                        row["scope_id"],
                        row["chapter_id"],
                        row["conversation_id"],
                        target[0],
                        target[0],
                        target[1],
                    ),
                ).fetchone()
            if job is None:
                self._finish(
                    row, "failed", "未能关联提炼任务，请检查对话证据是否有效。"
                )
                return
        if not row["job_id"]:
            with self.memory.transaction() as connection:
                connection.execute(
                    "UPDATE agent_knowledge_tasks SET job_id=? "
                    "WHERE task_id=? AND job_id IS NULL",
                    (job["job_id"], task_id),
                )
        state = job["state"]
        if state in ACTIVE_JOBS:
            self._progress(
                row,
                "extracting" if state == "running" else "queued",
                job["last_error_message"] or "正在提炼当前对话，完成后还需核验。",
            )
            return
        if state == "needs_review" and job["last_error_code"]:
            self._finish(
                row, "failed", job["last_error_message"] or job["last_error_code"]
            )
            return
        if state not in {"completed", "needs_review", "skipped"}:
            self._finish(
                row, "failed", job["last_error_message"] or f"提炼任务状态：{state}"
            )
            return
        with self.knowledge.store.lock:
            versions = self.knowledge.store.connection.execute(
                "SELECT kv.* FROM knowledge_versions kv JOIN knowledge_items ki "
                "ON ki.knowledge_id=kv.knowledge_id AND ki.active_version=kv.version "
                "WHERE kv.extraction_job_id=?",
                (job["job_id"],),
            ).fetchall()
        pending = sum(
            version["verification_status"] == "evidence_registered"
            for version in versions
        )
        age = (
            datetime.now(UTC) - datetime.fromisoformat(row["created_at"])
        ).total_seconds()
        if pending and age < 900:
            self._progress(
                row, "verifying", "提炼完成，正在等待 Claim 核验，尚不能视为可归档。"
            )
            return
        review = pending or any(
            version["publish_status"] in {"needs_review", "not_eligible"}
            for version in versions
        )
        self._finish(
            row,
            "needs_review" if review else "completed",
            "知识已提炼，但部分内容未通过或尚未完成核验，请查看原因；未归档。"
            if review
            else "本批没有新增知识候选，可查看已有成果；未归档。"
            if state == "skipped"
            else "知识任务已完成，以下为去重后的真实候选；未归档。",
            no_new=state == "skipped",
        )

    def _progress(self, row, state: str, message: str) -> None:
        view = KnowledgeTaskView(
            taskId=row["task_id"],
            conversationId=row["conversation_id"],
            chapterId=row["chapter_id"],
            sourceUrl=row["source_url"],
            state=state,
            message=message,
            updatedAt=now(),
        )
        self._update(row, view, terminal=False)

    def _finish(
        self, row, state: str, message: str, include_items=True, no_new=False
    ) -> None:
        view = (
            self.query(row["conversation_id"], row["chapter_id"], row["source_url"])
            if include_items
            else KnowledgeTaskView(
                conversationId=row["conversation_id"],
                chapterId=row["chapter_id"],
                sourceUrl=row["source_url"],
                state="failed",
                message=message,
                updatedAt=now(),
            )
        )
        view.taskId = row["task_id"]
        view.state = state
        view.message = message
        view.noNewContent = no_new
        self._update(row, view, terminal=True)

    def _update(self, row, view: KnowledgeTaskView, *, terminal: bool) -> None:
        with self.memory.transaction() as connection:
            # State, result and message events commit together; finish at most once.
            changed = connection.execute(
                "UPDATE agent_knowledge_tasks SET state=?, updated_at=?, result_json=? "
                "WHERE task_id=? AND state=? AND updated_at=?",
                (
                    view.state,
                    view.updatedAt,
                    view.model_dump_json(),
                    row["task_id"],
                    row["state"],
                    row["updated_at"],
                ),
            )
            if not changed.rowcount:
                return
            links = connection.execute(
                "SELECT message_id FROM study_knowledge_views WHERE task_id=?",
                (row["task_id"],),
            ).fetchall()
            connection.execute(
                "UPDATE study_knowledge_views SET payload_json=? WHERE task_id=?",
                (view.model_dump_json(), row["task_id"]),
            )
            if terminal:
                for link in links:
                    traces = connection.execute(
                        "SELECT payload_json FROM study_activities WHERE message_id=?",
                        (link[0],),
                    ).fetchall()
                    if not any(
                        json.loads(trace[0])["type"] == "task_waiting"
                        for trace in traces
                    ):
                        continue
                    sequence = connection.execute(
                        "SELECT COALESCE(MAX(sequence),0)+1 FROM study_activities "
                        "WHERE message_id=?",
                        (link[0],),
                    ).fetchone()[0]
                    event = StudyActivity(
                        type="task_failed"
                        if view.state == "failed"
                        else "task_completed",
                        eventId=f"{row['task_id']}:{row['run_id']}:{link[0]}:complete",
                        runId=row["run_id"],
                        conversationId=row["conversation_id"],
                        sourceUrl=row["source_url"],
                        sequence=sequence,
                        activityId=row["task_id"],
                        createdAt=now(),
                        summary=view.message,
                    )
                    connection.execute(
                        "INSERT OR IGNORE INTO study_activities VALUES (?, ?, ?, ?)",
                        (event.eventId, link[0], sequence, event.model_dump_json()),
                    )
                    connection.execute(
                        "UPDATE messages SET content=content || ? WHERE message_id=?",
                        ("\n\n" + view.message, link[0]),
                    )

    def refresh_pending(self, conversation_id: str | None = None) -> None:
        with self.memory.transaction() as connection:
            rows = connection.execute(
                "SELECT task_id FROM agent_knowledge_tasks WHERE state IN "
                "('submitting','waiting_previous','queued','extracting','verifying') "
                + ("AND conversation_id=? " if conversation_id else "")
                + "ORDER BY created_at LIMIT 50",
                (conversation_id,) if conversation_id else (),
            ).fetchall()
        for row in rows:
            self.refresh(row[0])

    async def worker(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            try:
                self.refresh_pending()
            except Exception:
                logger.exception("Knowledge task status refresh failed")
            try:
                await asyncio.wait_for(stop.wait(), timeout=2)
            except TimeoutError:
                pass
