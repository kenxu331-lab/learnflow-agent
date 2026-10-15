# ruff: noqa: E501
"""Small, explicit SQLite store for conversations, selections and learning events."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from app.knowledge.store import EventContextSeed, initialize_knowledge_schema
from app.schemas.activity import StudyActivity
from app.schemas.archive import ArchiveConfirmationView
from app.schemas.knowledge_view import KnowledgeTaskView
from app.schemas.study import (
    StudyChatRequest,
    StudyConversationResponse,
    StudyMessage,
    StudySource,
)


class LearningMemoryError(Exception):
    """A safe persistence or identity error exposed by the Study API."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class LearningMemoryStore:
    """Persist S1 records without adding an ORM dependency."""

    def __init__(self, database_path: str) -> None:
        self.database_path = database_path
        if database_path != ":memory:":
            Path(database_path).parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(
            database_path,
            check_same_thread=False,
        )
        self._connection.row_factory = sqlite3.Row
        self._lock = RLock()
        self._initialize()

    def _initialize(self) -> None:
        with self._lock, self._connection:
            self._connection.executescript(
                """
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS conversations (
                    conversation_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    document_id TEXT,
                    source_url TEXT NOT NULL,
                    page_title TEXT NOT NULL,
                    context_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS messages (
                    message_id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL
                        REFERENCES conversations(conversation_id),
                    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
                    content TEXT NOT NULL,
                    selected_text TEXT,
                    source_url TEXT,
                    heading_path_json TEXT NOT NULL,
                    source_node_id TEXT,
                    source_fingerprint TEXT,
                    origin TEXT NOT NULL CHECK (origin IN ('user', 'ai')),
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_messages_conversation
                    ON messages (conversation_id, created_at, message_id);
                CREATE TABLE IF NOT EXISTS study_activities (
                    event_id TEXT PRIMARY KEY,
                    message_id TEXT NOT NULL REFERENCES messages(message_id),
                    sequence INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_study_activities_message
                    ON study_activities (message_id, sequence);
                CREATE TABLE IF NOT EXISTS agent_knowledge_tasks (
                    task_id TEXT PRIMARY KEY,
                    input_key TEXT NOT NULL UNIQUE,
                    scope_id TEXT NOT NULL,
                    chapter_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    target_event_at TEXT NOT NULL,
                    target_event_id TEXT NOT NULL,
                    state TEXT NOT NULL,
                    job_id TEXT,
                    run_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    result_json TEXT
                );
                CREATE TABLE IF NOT EXISTS study_knowledge_views (
                    message_id TEXT PRIMARY KEY REFERENCES messages(message_id),
                    task_id TEXT REFERENCES agent_knowledge_tasks(task_id),
                    payload_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS study_archive_selections (
                    scope_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    chapter_id TEXT NOT NULL,
                    revision INTEGER NOT NULL,
                    references_json TEXT NOT NULL,
                    PRIMARY KEY(scope_id, conversation_id, chapter_id)
                );
                CREATE TABLE IF NOT EXISTS archive_confirmations (
                    confirmation_id TEXT PRIMARY KEY,
                    scope_id TEXT NOT NULL,
                    conversation_id TEXT NOT NULL,
                    chapter_id TEXT NOT NULL,
                    selection_revision INTEGER NOT NULL,
                    state TEXT NOT NULL,
                    digest TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    view_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS study_archive_views (
                    message_id TEXT NOT NULL REFERENCES messages(message_id),
                    confirmation_id TEXT NOT NULL REFERENCES archive_confirmations(confirmation_id),
                    PRIMARY KEY(message_id, confirmation_id)
                );
                CREATE TABLE IF NOT EXISTS selections (
                    selection_id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL
                        REFERENCES conversations(conversation_id),
                    message_id TEXT NOT NULL REFERENCES messages(message_id),
                    selected_text TEXT NOT NULL,
                    source_url TEXT NOT NULL,
                    heading_path_json TEXT NOT NULL,
                    source_node_id TEXT,
                    source_fingerprint TEXT,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS learning_events (
                    event_id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL
                        REFERENCES conversations(conversation_id),
                    session_id TEXT NOT NULL,
                    document_id TEXT,
                    source_url TEXT NOT NULL,
                    heading_path_json TEXT NOT NULL,
                    source_node_id TEXT,
                    source_fingerprint TEXT,
                    selected_text TEXT,
                    user_question TEXT NOT NULL,
                    assistant_answer TEXT NOT NULL,
                    origin TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                """
            )
            initialize_knowledge_schema(self._connection)

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    @contextmanager
    def transaction(self):
        """Serialize additive Agent metadata with message updates atomically."""
        with self._lock, self._connection:
            yield self._connection

    def start_conversation(self, request: StudyChatRequest) -> None:
        """Create or validate the chapter-bound conversation identity."""

        now = utc_now()
        context_json = json.dumps(
            [block.model_dump(mode="json") for block in request.snapshot.blocks],
            ensure_ascii=False,
        )
        with self._lock, self._connection:
            row = self._connection.execute(
                "SELECT * FROM conversations WHERE conversation_id = ?",
                (request.conversationId,),
            ).fetchone()
            if row is None:
                self._connection.execute(
                    """
                    INSERT INTO conversations (
                        conversation_id, session_id, document_id, source_url,
                        page_title, context_json, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        request.conversationId,
                        request.sessionId,
                        request.documentId,
                        request.sourceUrl,
                        request.pageTitle,
                        context_json,
                        now,
                        now,
                    ),
                )
                return

            if row["session_id"] != request.sessionId or not _same_source(
                row["source_url"], request.sourceUrl
            ):
                raise LearningMemoryError(
                    "conversation_source_conflict",
                    "会话与当前章节来源不一致，已阻止串线。",
                    409,
                )
            self._connection.execute(
                """
                UPDATE conversations
                SET page_title = ?, document_id = ?, context_json = ?, updated_at = ?
                WHERE conversation_id = ?
                """,
                (
                    request.pageTitle,
                    request.documentId,
                    context_json,
                    now,
                    request.conversationId,
                ),
            )

    def add_message(
        self,
        *,
        conversation_id: str,
        role: str,
        content: str,
        selected_text: str | None,
        source: StudySource | None,
        origin: str,
    ) -> str:
        message_id = f"message-{uuid4().hex}"
        now = utc_now()
        source_url = source.sourceUrl if source else None
        heading_path = source.headingPath if source else []
        with self._lock, self._connection:
            self._connection.execute(
                """
                INSERT INTO messages (
                    message_id, conversation_id, role, content, selected_text,
                    source_url, heading_path_json, source_node_id,
                    source_fingerprint, origin, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    conversation_id,
                    role,
                    content,
                    selected_text,
                    source_url,
                    json.dumps(heading_path, ensure_ascii=False),
                    source.sourceNodeId if source else None,
                    source.sourceFingerprint if source else None,
                    origin,
                    now,
                ),
            )
            self._connection.execute(
                "UPDATE conversations SET updated_at = ? WHERE conversation_id = ?",
                (now, conversation_id),
            )
            if selected_text and source:
                self._connection.execute(
                    """
                    INSERT INTO selections (
                        selection_id, conversation_id, message_id, selected_text,
                        source_url, heading_path_json, source_node_id,
                        source_fingerprint, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        f"selection-{uuid4().hex}",
                        conversation_id,
                        message_id,
                        selected_text,
                        source.sourceUrl,
                        json.dumps(source.headingPath, ensure_ascii=False),
                        source.sourceNodeId,
                        source.sourceFingerprint,
                        now,
                    ),
                )
        return message_id

    def update_message(self, message_id: str, content: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE messages SET content = ? WHERE message_id = ?",
                (content, message_id),
            )

    def record_learning_event(
        self,
        *,
        request: StudyChatRequest,
        selected_text: str | None,
        assistant_answer: str,
        user_message_id: str,
        assistant_message_id: str,
        context: EventContextSeed | None,
        dedupe_key: str | None = None,
    ) -> str:
        event_id = (
            "event-agent-" + hashlib.sha256(dedupe_key.encode()).hexdigest()
            if dedupe_key
            else f"event-{uuid4().hex}"
        )
        now = utc_now()
        with self._lock, self._connection:
            if (
                dedupe_key
                and self._connection.execute(
                    "SELECT 1 FROM learning_events WHERE event_id = ?", (event_id,)
                ).fetchone()
            ):
                return event_id
            self._connection.execute(
                """
                INSERT INTO learning_events (
                    event_id, conversation_id, session_id, document_id, source_url,
                    heading_path_json, source_node_id, source_fingerprint,
                    selected_text, user_question, assistant_answer, origin, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    request.conversationId,
                    request.sessionId,
                    request.documentId,
                    request.sourceUrl,
                    json.dumps(request.headingPath, ensure_ascii=False),
                    request.sourceNodeId,
                    request.sourceFingerprint,
                    selected_text,
                    request.question,
                    assistant_answer,
                    "source+user+ai",
                    now,
                ),
            )
            if context is not None:
                if context.source_snapshot_id is not None:
                    try:
                        self._connection.execute(
                            """
                            INSERT INTO event_contexts (
                                event_id, scope_id, user_message_id, assistant_message_id,
                                source_snapshot_id, document_id, chapter_id, link_status,
                                link_error_code, created_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'linked', NULL, ?)
                            """,
                            (
                                event_id,
                                context.scope_id,
                                user_message_id,
                                assistant_message_id,
                                context.source_snapshot_id,
                                context.document_id,
                                context.chapter_id,
                                now,
                            ),
                        )
                    except sqlite3.DatabaseError:
                        self._connection.execute(
                            """
                            INSERT OR REPLACE INTO event_contexts (
                                event_id, scope_id, user_message_id, assistant_message_id,
                                source_snapshot_id, document_id, chapter_id, link_status,
                                link_error_code, created_at
                            ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'unlinked_runtime_error',
                                      'snapshot_link_failed', ?)
                            """,
                            (
                                event_id,
                                context.scope_id,
                                user_message_id,
                                assistant_message_id,
                                context.document_id,
                                context.chapter_id,
                                now,
                            ),
                        )
                else:
                    self._connection.execute(
                        """
                        INSERT INTO event_contexts (
                            event_id, scope_id, user_message_id, assistant_message_id,
                            source_snapshot_id, document_id, chapter_id, link_status,
                            link_error_code, created_at
                        ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'unlinked_runtime_error',
                                  'snapshot_registration_failed', ?)
                        """,
                        (
                            event_id,
                            context.scope_id,
                            user_message_id,
                            assistant_message_id,
                            context.document_id,
                            context.chapter_id,
                            now,
                        ),
                    )
        return event_id

    def conversation(self, conversation_id: str) -> StudyConversationResponse | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT * FROM conversations WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
            if row is None:
                return None
            rows = self._connection.execute(
                """
                SELECT * FROM messages
                WHERE conversation_id = ?
                ORDER BY created_at, message_id
                """,
                (conversation_id,),
            ).fetchall()
            messages = [_message_from_row(message) for message in rows]
            for message in messages:
                activity_rows = self._connection.execute(
                    "SELECT payload_json FROM study_activities "
                    "WHERE message_id = ? ORDER BY sequence",
                    (message.messageId,),
                ).fetchall()
                message.activities = [
                    StudyActivity.model_validate_json(item[0]) for item in activity_rows
                ]
                view = self._connection.execute(
                    "SELECT payload_json FROM study_knowledge_views WHERE message_id = ?",
                    (message.messageId,),
                ).fetchone()
                if view:
                    message.knowledge = KnowledgeTaskView.model_validate_json(view[0])
                archives = self._connection.execute(
                    "SELECT ac.view_json FROM archive_confirmations ac "
                    "JOIN study_archive_views sv ON sv.confirmation_id=ac.confirmation_id "
                    "WHERE sv.message_id=? ORDER BY ac.rowid",
                    (message.messageId,),
                ).fetchall()
                message.archiveConfirmations = [
                    ArchiveConfirmationView.model_validate_json(item[0])
                    for item in archives
                ]
        return StudyConversationResponse(
            conversationId=row["conversation_id"],
            sessionId=row["session_id"],
            documentId=row["document_id"],
            sourceUrl=row["source_url"],
            pageTitle=row["page_title"],
            messages=messages,
        )

    def add_activity(self, message_id: str, activity: StudyActivity) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO study_activities VALUES (?, ?, ?, ?)",
                (
                    activity.eventId,
                    message_id,
                    activity.sequence,
                    activity.model_dump_json(),
                ),
            )

    def messages_for_prompt(
        self, conversation_id: str, limit: int
    ) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT role, content, selected_text, source_url, heading_path_json,
                       source_node_id, source_fingerprint
                FROM messages
                WHERE conversation_id = ?
                ORDER BY created_at DESC, message_id DESC
                LIMIT ?
                """,
                (conversation_id, limit),
            ).fetchall()
        return [dict(row) for row in reversed(rows)]


def _same_source(left: str, right: str) -> bool:
    left_url = urlsplit(left)
    right_url = urlsplit(right)
    return (
        left_url.scheme,
        left_url.netloc,
        left_url.path.rstrip("/") or "/",
        left_url.query,
    ) == (
        right_url.scheme,
        right_url.netloc,
        right_url.path.rstrip("/") or "/",
        right_url.query,
    )


def _message_from_row(row: sqlite3.Row) -> StudyMessage:
    source = None
    if row["source_url"]:
        source = StudySource(
            sourceUrl=row["source_url"],
            headingPath=json.loads(row["heading_path_json"]),
            sourceNodeId=row["source_node_id"],
            sourceFingerprint=row["source_fingerprint"],
        )
    return StudyMessage(
        messageId=row["message_id"],
        role=row["role"],
        content=row["content"],
        selectedText=row["selected_text"],
        source=source,
        origin=row["origin"],
        createdAt=datetime.fromisoformat(row["created_at"]),
    )
