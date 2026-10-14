# ruff: noqa: E501
"""SQLite persistence for S2-A snapshots, evidence, drafts and jobs."""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from app.core.config import Settings
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.schemas import ExtractionOutputDraft
from app.notes.errors import NoteServiceError
from app.notes.resolver import NoteResolver
from app.notes.vault import VaultGuard
from app.schemas.page_snapshot import PageSnapshot
from app.schemas.study import StudyChatRequest


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class KnowledgeScope:
    scope_id: str
    profile_id: str
    vault_fingerprint: str
    bound: bool


@dataclass(frozen=True)
class SnapshotRegistration:
    scope: KnowledgeScope
    source_snapshot_id: str
    document_id: str
    chapter_id: str
    source_url: str


@dataclass(frozen=True)
class EventContextSeed:
    scope_id: str
    document_id: str
    chapter_id: str
    source_snapshot_id: str | None
    link_status: str


def initialize_knowledge_schema(connection: sqlite3.Connection) -> None:
    """Create S2-A tables without migrating or rewriting S1 records."""

    connection.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS knowledge_scopes (
            scope_id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            vault_fingerprint TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (profile_id, vault_fingerprint)
        );
        CREATE TABLE IF NOT EXISTS source_snapshots (
            source_snapshot_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            document_id TEXT NOT NULL,
            chapter_id TEXT NOT NULL,
            source_url TEXT NOT NULL,
            snapshot_hash TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (scope_id, snapshot_hash)
        );
        CREATE TABLE IF NOT EXISTS source_blocks (
            source_snapshot_id TEXT NOT NULL REFERENCES source_snapshots(source_snapshot_id),
            source_block_id TEXT NOT NULL,
            stable_key TEXT,
            block_type TEXT NOT NULL,
            block_ordinal INTEGER NOT NULL,
            heading_path_json TEXT NOT NULL,
            section_anchor_block_id TEXT,
            content_hash TEXT NOT NULL,
            text TEXT NOT NULL,
            PRIMARY KEY (source_snapshot_id, source_block_id)
        );
        CREATE INDEX IF NOT EXISTS idx_source_blocks_stable_key
            ON source_blocks(source_snapshot_id, stable_key);
        CREATE TABLE IF NOT EXISTS event_contexts (
            event_id TEXT PRIMARY KEY REFERENCES learning_events(event_id),
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            user_message_id TEXT REFERENCES messages(message_id),
            assistant_message_id TEXT REFERENCES messages(message_id),
            source_snapshot_id TEXT REFERENCES source_snapshots(source_snapshot_id),
            document_id TEXT NOT NULL,
            chapter_id TEXT NOT NULL,
            link_status TEXT NOT NULL CHECK (link_status IN
                ('linked', 'legacy_unlinked', 'unlinked_runtime_error')),
            link_error_code TEXT,
            created_at TEXT NOT NULL,
            CHECK (
                (link_status = 'linked' AND user_message_id IS NOT NULL
                    AND assistant_message_id IS NOT NULL AND source_snapshot_id IS NOT NULL)
                OR (link_status = 'legacy_unlinked' AND user_message_id IS NULL
                    AND assistant_message_id IS NULL AND source_snapshot_id IS NULL)
                OR (link_status = 'unlinked_runtime_error' AND user_message_id IS NOT NULL
                    AND assistant_message_id IS NOT NULL AND source_snapshot_id IS NULL)
            )
        );
        CREATE INDEX IF NOT EXISTS idx_event_contexts_scope_chapter
            ON event_contexts(scope_id, chapter_id, created_at);
        CREATE TABLE IF NOT EXISTS evidence_records (
            evidence_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            chapter_id TEXT NOT NULL,
            source_kind TEXT NOT NULL,
            source_snapshot_id TEXT REFERENCES source_snapshots(source_snapshot_id),
            source_block_id TEXT,
            stable_key TEXT,
            selection_id TEXT REFERENCES selections(selection_id),
            message_id TEXT REFERENCES messages(message_id),
            source_url TEXT,
            heading_path_json TEXT NOT NULL,
            source_fingerprint TEXT,
            evidence_natural_key TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            excerpt TEXT NOT NULL,
            resolvable INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            UNIQUE (scope_id, evidence_natural_key),
            UNIQUE (scope_id, evidence_id)
        );
        CREATE INDEX IF NOT EXISTS idx_evidence_scope_chapter
            ON evidence_records(scope_id, chapter_id, source_kind);
        CREATE TABLE IF NOT EXISTS extraction_consents (
            consent_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            provider TEXT NOT NULL,
            purpose TEXT NOT NULL,
            policy_version TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
            granted_at TEXT NOT NULL,
            revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_consents_scope
            ON extraction_consents(scope_id, purpose, state);
        CREATE TABLE IF NOT EXISTS extraction_jobs (
            job_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            chapter_id TEXT NOT NULL,
            document_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            batch_fingerprint TEXT NOT NULL,
            trigger TEXT NOT NULL,
            state TEXT NOT NULL,
            event_high_watermark_at TEXT NOT NULL,
            event_high_watermark_id TEXT NOT NULL,
            prompt_version TEXT NOT NULL,
            consent_id TEXT,
            lease_token TEXT,
            lease_expires_at TEXT,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT,
            last_error_code TEXT,
            last_error_message TEXT,
            output_hash TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (scope_id, conversation_id, batch_fingerprint)
        );
        CREATE TABLE IF NOT EXISTS extraction_job_events (
            job_id TEXT NOT NULL REFERENCES extraction_jobs(job_id),
            event_id TEXT NOT NULL REFERENCES learning_events(event_id),
            PRIMARY KEY (job_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS chapter_extraction_cursors (
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            chapter_id TEXT NOT NULL,
            conversation_id TEXT NOT NULL,
            last_completed_event_at TEXT,
            last_completed_event_id TEXT,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (scope_id, chapter_id, conversation_id)
        );
        CREATE TABLE IF NOT EXISTS knowledge_items (
            knowledge_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            document_id TEXT NOT NULL,
            chapter_id TEXT NOT NULL,
            identity_key TEXT NOT NULL,
            anchor_kind TEXT NOT NULL,
            anchor_snapshot_id TEXT REFERENCES source_snapshots(source_snapshot_id),
            anchor_block_id TEXT,
            anchor_stable_key TEXT,
            heading_path_json TEXT NOT NULL,
            anchor_fingerprint TEXT,
            kind TEXT NOT NULL,
            topic TEXT NOT NULL,
            active_version INTEGER NOT NULL,
            verification_status TEXT NOT NULL,
            publish_status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE (scope_id, identity_key)
        );
        CREATE TABLE IF NOT EXISTS knowledge_versions (
            knowledge_id TEXT NOT NULL REFERENCES knowledge_items(knowledge_id),
            version INTEGER NOT NULL,
            body TEXT NOT NULL,
            body_hash TEXT NOT NULL,
            evidence_set_hash TEXT NOT NULL,
            version_fingerprint TEXT NOT NULL,
            origin TEXT NOT NULL,
            extraction_job_id TEXT NOT NULL REFERENCES extraction_jobs(job_id),
            verification_status TEXT NOT NULL,
            evidence_gap_reason TEXT,
            publish_status TEXT NOT NULL,
            supersedes_version INTEGER,
            created_at TEXT NOT NULL,
            PRIMARY KEY (knowledge_id, version),
            UNIQUE (knowledge_id, version_fingerprint)
        );
        CREATE TABLE IF NOT EXISTS atomic_claims (
            claim_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            knowledge_id TEXT NOT NULL,
            knowledge_version INTEGER NOT NULL,
            claim_text TEXT NOT NULL,
            claim_kind TEXT NOT NULL,
            verification_status TEXT NOT NULL,
            verification_reason TEXT,
            FOREIGN KEY (knowledge_id, knowledge_version)
                REFERENCES knowledge_versions(knowledge_id, version),
            UNIQUE (scope_id, claim_id)
        );
        CREATE TABLE IF NOT EXISTS claim_evidence (
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            claim_id TEXT NOT NULL,
            evidence_id TEXT NOT NULL,
            relation TEXT NOT NULL,
            PRIMARY KEY (scope_id, claim_id, evidence_id),
            FOREIGN KEY (scope_id, claim_id) REFERENCES atomic_claims(scope_id, claim_id),
            FOREIGN KEY (scope_id, evidence_id) REFERENCES evidence_records(scope_id, evidence_id)
        );
        CREATE TABLE IF NOT EXISTS annotation_consents (
            consent_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            purpose TEXT NOT NULL CHECK (purpose = 'annotation_write'),
            policy_version TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
            granted_at TEXT NOT NULL,
            revoked_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_annotation_consents_scope
            ON annotation_consents(scope_id, purpose, state);
        CREATE TABLE IF NOT EXISTS annotation_write_intents (
            intent_id TEXT PRIMARY KEY,
            scope_id TEXT NOT NULL REFERENCES knowledge_scopes(scope_id),
            knowledge_id TEXT NOT NULL,
            knowledge_version INTEGER NOT NULL,
            target_note_id TEXT NOT NULL,
            target_relative_path TEXT NOT NULL,
            expected_file_revision TEXT,
            operation TEXT NOT NULL CHECK (operation IN ('insert', 'update', 'noop')),
            status TEXT NOT NULL CHECK (status IN
                ('pending', 'applying', 'published', 'noop', 'needs_review', 'failed')),
            attempts INTEGER NOT NULL DEFAULT 0,
            planned_content_hash TEXT,
            applied_content_hash TEXT,
            failure_code TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(scope_id, knowledge_id, knowledge_version, expected_file_revision)
        );
        CREATE INDEX IF NOT EXISTS idx_annotation_intents_scope_status
            ON annotation_write_intents(scope_id, status, updated_at);
        CREATE TABLE IF NOT EXISTS orchestrator_runtime (
            scope_id TEXT PRIMARY KEY REFERENCES knowledge_scopes(scope_id),
            owner_pid INTEGER NOT NULL,
            owner_started_at TEXT NOT NULL,
            owner_heartbeat_at TEXT NOT NULL
        );
        """
    )

    try:
        connection.execute(
            "SELECT owner_heartbeat_at FROM orchestrator_runtime LIMIT 1"
        )
    except sqlite3.OperationalError:
        connection.execute(
            "ALTER TABLE orchestrator_runtime ADD COLUMN owner_heartbeat_at TEXT"
        )


class KnowledgeStore:
    """Program-owned S2 SQLite operations; never writes Markdown or Vault files."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        path = settings.learning_memory_db_path
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = RLock()
        with self.lock, self.connection:
            initialize_knowledge_schema(self.connection)
        self._backfill_legacy_events()

    def close(self) -> None:
        with self.lock:
            self.connection.close()

    def _backfill_legacy_events(self) -> None:
        """Represent pre-S2 events without inventing message or snapshot links."""

        scope = self.resolve_scope()
        with self.lock, self.connection:
            try:
                rows = self.connection.execute(
                    """
                    SELECT le.event_id, le.source_url
                    FROM learning_events le
                    LEFT JOIN event_contexts ec ON ec.event_id = le.event_id
                    WHERE ec.event_id IS NULL
                    """
                ).fetchall()
            except sqlite3.OperationalError as error:
                if "no such table: learning_events" in str(error):
                    return
                raise
            for row in rows:
                try:
                    identity = NoteResolver().resolve(row["source_url"])
                except NoteServiceError:
                    continue
                self.connection.execute(
                    """
                    INSERT OR IGNORE INTO event_contexts (
                        event_id, scope_id, user_message_id, assistant_message_id,
                        source_snapshot_id, document_id, chapter_id, link_status,
                        link_error_code, created_at
                    ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, 'legacy_unlinked',
                              'pre_s2_event', ?)
                    """,
                    (
                        row["event_id"],
                        scope.scope_id,
                        identity.note_id,
                        identity.chapter_id,
                        utc_now(),
                    ),
                )

    def resolve_scope(self) -> KnowledgeScope:
        fingerprint = "unbound"
        bound = False
        try:
            root = VaultGuard(self.settings).root()
            fingerprint = digest(str(root).casefold())[:32]
            bound = True
        except NoteServiceError:
            pass
        profile = self.settings.knowledge_profile_id
        scope_id = f"scope-{digest(f'{profile}\u0000{fingerprint}')[:32]}"
        with self.lock, self.connection:
            self.connection.execute(
                """
                INSERT OR IGNORE INTO knowledge_scopes (
                    scope_id, profile_id, vault_fingerprint, created_at
                ) VALUES (?, ?, ?, ?)
                """,
                (scope_id, profile, fingerprint, utc_now()),
            )
        return KnowledgeScope(scope_id, profile, fingerprint, bound)

    def register_snapshot(self, snapshot: PageSnapshot) -> SnapshotRegistration:
        scope = self.resolve_scope()
        identity = NoteResolver().resolve(snapshot.url, snapshot.title)
        payload = snapshot.model_dump(mode="json")
        canonical = json.dumps(
            payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
        )
        snapshot_hash = digest(canonical)
        snapshot_id = f"snapshot-{snapshot_hash[:32]}"
        blocks = self._source_blocks(snapshot)
        with self.lock, self.connection:
            self.connection.execute(
                """
                INSERT OR IGNORE INTO source_snapshots (
                    source_snapshot_id, scope_id, document_id, chapter_id, source_url,
                    snapshot_hash, captured_at, snapshot_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    scope.scope_id,
                    identity.note_id,
                    identity.chapter_id,
                    identity.normalized_url,
                    snapshot_hash,
                    snapshot.capturedAt.isoformat(),
                    canonical,
                    utc_now(),
                ),
            )
            for block in blocks:
                self.connection.execute(
                    """
                    INSERT OR IGNORE INTO source_blocks (
                        source_snapshot_id, source_block_id, stable_key, block_type,
                        block_ordinal, heading_path_json, section_anchor_block_id,
                        content_hash, text
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (snapshot_id, *block),
                )
        return SnapshotRegistration(
            scope=scope,
            source_snapshot_id=snapshot_id,
            document_id=identity.note_id,
            chapter_id=identity.chapter_id,
            source_url=identity.normalized_url,
        )

    def unlinked_context_seed(self, request: StudyChatRequest) -> EventContextSeed:
        """Create truthful scope/chapter metadata when snapshot registration failed."""

        scope = self.resolve_scope()
        identity = NoteResolver().resolve(request.snapshot.url, request.snapshot.title)
        return EventContextSeed(
            scope_id=scope.scope_id,
            document_id=identity.note_id,
            chapter_id=identity.chapter_id,
            source_snapshot_id=None,
            link_status="unlinked_runtime_error",
        )

    @staticmethod
    def _source_blocks(snapshot: PageSnapshot) -> list[tuple[Any, ...]]:
        blocks: list[tuple[Any, ...]] = []
        headings: list[tuple[int, str, str]] = []
        for ordinal, block in enumerate(snapshot.blocks):
            if block.type == "heading":
                level = block.level or 6
                while headings and headings[-1][0] >= level:
                    headings.pop()
                headings.append((level, block.id, block.text.strip()))
            heading_path = [heading[2] for heading in headings]
            section_anchor = headings[-1][1] if headings else None
            blocks.append(
                (
                    block.id,
                    block.stableKey,
                    block.type,
                    ordinal,
                    json.dumps(heading_path, ensure_ascii=False),
                    section_anchor,
                    digest(block.text),
                    block.text,
                )
            )
        return blocks

    def set_consent(self, enabled: bool, policy_version: str) -> dict[str, Any]:
        scope = self.resolve_scope()
        if enabled and not scope.bound:
            raise KnowledgeServiceError(
                "vault_required",
                "配置并验证 Obsidian Vault 后才能启用知识提炼。",
                409,
            )
        now = utc_now()
        with self.lock, self.connection:
            if enabled:
                self.connection.execute(
                    "UPDATE extraction_consents SET state = 'revoked', revoked_at = ? "
                    "WHERE scope_id = ? AND purpose = 'knowledge_extraction' AND state = 'active'",
                    (now, scope.scope_id),
                )
                consent_id = f"consent-{uuid4().hex}"
                self.connection.execute(
                    """
                    INSERT INTO extraction_consents (
                        consent_id, scope_id, provider, purpose, policy_version,
                        state, granted_at, revoked_at
                    ) VALUES (?, ?, ?, 'knowledge_extraction', ?, 'active', ?, NULL)
                    """,
                    (
                        consent_id,
                        scope.scope_id,
                        self.settings.llm_provider,
                        policy_version,
                        now,
                    ),
                )
                self.connection.execute(
                    """
                    UPDATE extraction_jobs
                    SET state = 'queued', consent_id = ?, updated_at = ?
                    WHERE scope_id = ? AND state = 'blocked_consent'
                    """,
                    (consent_id, now, scope.scope_id),
                )
                return {
                    "scope_id": scope.scope_id,
                    "state": "active",
                    "policy_version": policy_version,
                }
            self.connection.execute(
                "UPDATE extraction_consents SET state = 'revoked', revoked_at = ? "
                "WHERE scope_id = ? AND purpose = 'knowledge_extraction' AND state = 'active'",
                (now, scope.scope_id),
            )
            self.connection.execute(
                """
                UPDATE extraction_jobs
                SET state = 'blocked_consent', consent_id = NULL, updated_at = ?
                WHERE scope_id = ? AND state IN ('queued', 'retryable_failed')
                """,
                (now, scope.scope_id),
            )
        return {"scope_id": scope.scope_id, "state": "revoked", "policy_version": None}

    def active_consent(self, scope_id: str) -> sqlite3.Row | None:
        return self.connection.execute(
            """
            SELECT * FROM extraction_consents
            WHERE scope_id = ? AND purpose = 'knowledge_extraction' AND state = 'active'
            ORDER BY granted_at DESC LIMIT 1
            """,
            (scope_id,),
        ).fetchone()

    def consent_status(self) -> dict[str, Any]:
        scope = self.resolve_scope()
        if not scope.bound:
            return {
                "scope_id": scope.scope_id,
                "state": "unavailable",
                "policy_version": None,
            }
        row = self.active_consent(scope.scope_id)
        return {
            "scope_id": scope.scope_id,
            "state": "active" if row else "revoked",
            "policy_version": row["policy_version"] if row else None,
        }

    def status_counts(self) -> tuple[dict[str, Any], int, int]:
        consent = self.consent_status()
        with self.lock:
            rows = self.connection.execute(
                """
                SELECT state, COUNT(*) AS count FROM extraction_jobs
                WHERE scope_id = ? GROUP BY state
                """,
                (consent["scope_id"],),
            ).fetchall()
        counts = {row["state"]: row["count"] for row in rows}
        return (
            consent,
            counts.get("queued", 0) + counts.get("retryable_failed", 0),
            counts.get("running", 0),
        )

    def list_jobs(self, limit: int = 50) -> list[sqlite3.Row]:
        scope = self.resolve_scope()
        with self.lock:
            return self.connection.execute(
                """
                SELECT * FROM extraction_jobs WHERE scope_id = ?
                ORDER BY updated_at DESC LIMIT ?
                """,
                (scope.scope_id, limit),
            ).fetchall()

    def list_drafts(self, chapter_id: str) -> list[sqlite3.Row]:
        scope = self.resolve_scope()
        with self.lock:
            return self.connection.execute(
                """
                SELECT ki.*, kv.body, kv.body_hash, kv.evidence_gap_reason,
                       kv.verification_status AS version_verification_status,
                       kv.publish_status AS version_publish_status
                FROM knowledge_items ki
                JOIN knowledge_versions kv
                  ON kv.knowledge_id = ki.knowledge_id AND kv.version = ki.active_version
                WHERE ki.scope_id = ? AND ki.chapter_id = ?
                ORDER BY ki.updated_at DESC
                """,
                (scope.scope_id, chapter_id),
            ).fetchall()

    def verification_bundle(
        self, knowledge_id: str, version: int | None = None
    ) -> dict[str, Any] | None:
        """Return one version with only program-resolved Claim/Evidence data."""

        scope = self.resolve_scope()
        with self.lock:
            item = self.connection.execute(
                "SELECT * FROM knowledge_items WHERE scope_id = ? AND knowledge_id = ?",
                (scope.scope_id, knowledge_id),
            ).fetchone()
            if item is None:
                return None
            selected_version = version or item["active_version"]
            knowledge_version = self.connection.execute(
                """
                SELECT kv.*, ss.source_url AS anchor_source_url
                FROM knowledge_versions kv
                LEFT JOIN source_snapshots ss
                  ON ss.source_snapshot_id = ?
                WHERE kv.knowledge_id = ? AND kv.version = ?
                """,
                (item["anchor_snapshot_id"], knowledge_id, selected_version),
            ).fetchone()
            if knowledge_version is None:
                return None
            claims = self.connection.execute(
                """
                SELECT * FROM atomic_claims
                WHERE scope_id = ? AND knowledge_id = ? AND knowledge_version = ?
                ORDER BY claim_id
                """,
                (scope.scope_id, knowledge_id, selected_version),
            ).fetchall()
            claim_data: list[dict[str, Any]] = []
            for claim in claims:
                evidence = self.connection.execute(
                    """
                    SELECT ce.relation, er.*
                    FROM claim_evidence ce
                    JOIN evidence_records er
                      ON er.scope_id = ce.scope_id AND er.evidence_id = ce.evidence_id
                    WHERE ce.scope_id = ? AND ce.claim_id = ?
                    ORDER BY er.evidence_id
                    """,
                    (scope.scope_id, claim["claim_id"]),
                ).fetchall()
                claim_data.append({"claim": dict(claim), "evidence": [dict(row) for row in evidence]})
            return {
                "scope_id": scope.scope_id,
                "item": dict(item),
                "version": dict(knowledge_version),
                "claims": claim_data,
            }

    def persist_verification(
        self,
        *,
        knowledge_id: str,
        version: int,
        claim_updates: dict[str, tuple[str, str]],
        verification_status: str,
        publish_status: str,
        evidence_gap_reason: str | None,
    ) -> None:
        """Atomically persist Claim verdicts and the synthesized publish state."""

        scope = self.resolve_scope()
        now = utc_now()
        with self.lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            item = self.connection.execute(
                "SELECT * FROM knowledge_items WHERE scope_id = ? AND knowledge_id = ?",
                (scope.scope_id, knowledge_id),
            ).fetchone()
            if item is None or item["active_version"] != version:
                raise KnowledgeServiceError(
                    "knowledge_version_not_active",
                    "只能核验当前活动知识版本。",
                    409,
                )
            for claim_id, (status, reason) in claim_updates.items():
                updated = self.connection.execute(
                    """
                    UPDATE atomic_claims
                    SET verification_status = ?, verification_reason = ?
                    WHERE scope_id = ? AND claim_id = ?
                      AND knowledge_id = ? AND knowledge_version = ?
                    """,
                    (status, reason, scope.scope_id, claim_id, knowledge_id, version),
                )
                if updated.rowcount != 1:
                    raise KnowledgeServiceError(
                        "knowledge_claim_not_found",
                        "核验结果引用了不存在或不属于当前版本的 Claim。",
                        422,
                    )
            self.connection.execute(
                """
                UPDATE knowledge_versions
                SET verification_status = ?, publish_status = ?, evidence_gap_reason = ?
                WHERE knowledge_id = ? AND version = ?
                """,
                (
                    verification_status,
                    publish_status,
                    evidence_gap_reason,
                    knowledge_id,
                    version,
                ),
            )
            self.connection.execute(
                """
                UPDATE knowledge_items
                SET verification_status = ?, publish_status = ?, updated_at = ?
                WHERE scope_id = ? AND knowledge_id = ?
                """,
                (
                    verification_status,
                    publish_status,
                    now,
                    scope.scope_id,
                    knowledge_id,
                ),
            )

    def publish_candidate_rows(self) -> list[sqlite3.Row]:
        scope = self.resolve_scope()
        with self.lock:
            return self.connection.execute(
                """
                SELECT ki.*, kv.body, kv.body_hash, kv.verification_status AS version_verification_status,
                       kv.publish_status AS version_publish_status, ss.source_url
                FROM knowledge_items ki
                JOIN knowledge_versions kv
                  ON kv.knowledge_id = ki.knowledge_id AND kv.version = ki.active_version
                LEFT JOIN source_snapshots ss
                  ON ss.source_snapshot_id = ki.anchor_snapshot_id
                WHERE ki.scope_id = ?
                  AND kv.publish_status IN ('eligible', 'eligible_user_insight')
                ORDER BY ki.updated_at DESC
                """,
                (scope.scope_id,),
            ).fetchall()

    def evidence_ids_for_version(self, knowledge_id: str, version: int) -> list[str]:
        scope = self.resolve_scope()
        with self.lock:
            rows = self.connection.execute(
                """
                SELECT DISTINCT ce.evidence_id
                FROM claim_evidence ce
                JOIN atomic_claims ac
                  ON ac.scope_id = ce.scope_id AND ac.claim_id = ce.claim_id
                WHERE ce.scope_id = ? AND ac.knowledge_id = ? AND ac.knowledge_version = ?
                ORDER BY ce.evidence_id
                """,
                (scope.scope_id, knowledge_id, version),
            ).fetchall()
        return [row["evidence_id"] for row in rows]

    def source_block_record(
        self, source_snapshot_id: str, source_block_id: str
    ) -> sqlite3.Row | None:
        with self.lock:
            return self.connection.execute(
                """
                SELECT sb.*, ss.chapter_id, ss.source_url
                FROM source_blocks sb
                JOIN source_snapshots ss
                  ON ss.source_snapshot_id = sb.source_snapshot_id
                WHERE sb.source_snapshot_id = ? AND sb.source_block_id = ?
                """,
                (source_snapshot_id, source_block_id),
            ).fetchone()

    def annotation_consent_status(self) -> dict[str, Any]:
        scope = self.resolve_scope()
        with self.lock:
            row = self.connection.execute(
                """
                SELECT * FROM annotation_consents
                WHERE scope_id = ? AND purpose = 'annotation_write' AND state = 'active'
                ORDER BY granted_at DESC LIMIT 1
                """,
                (scope.scope_id,),
            ).fetchone()
        return {
            "scope_id": scope.scope_id,
            "state": "active" if row is not None else ("unavailable" if not scope.bound else "revoked"),
            "policy_version": row["policy_version"] if row else None,
        }

    def set_annotation_consent(self, enabled: bool, policy_version: str) -> dict[str, Any]:
        scope = self.resolve_scope()
        if enabled and not scope.bound:
            raise KnowledgeServiceError(
                "vault_required",
                "配置并验证 Obsidian Vault 后才能启用自动归档。",
                409,
            )
        now = utc_now()
        with self.lock, self.connection:
            self.connection.execute(
                """
                UPDATE annotation_consents SET state = 'revoked', revoked_at = ?
                WHERE scope_id = ? AND purpose = 'annotation_write' AND state = 'active'
                """,
                (now, scope.scope_id),
            )
            if enabled:
                self.connection.execute(
                    """
                    INSERT INTO annotation_consents (
                        consent_id, scope_id, purpose, policy_version, state,
                        granted_at, revoked_at
                    ) VALUES (?, ?, 'annotation_write', ?, 'active', ?, NULL)
                    """,
                    (f"annotation-consent-{uuid4().hex}", scope.scope_id, policy_version, now),
                )
        return self.annotation_consent_status()

    def active_annotation_consent(self, scope_id: str) -> sqlite3.Row | None:
        with self.lock:
            return self.connection.execute(
                """
                SELECT * FROM annotation_consents
                WHERE scope_id = ? AND purpose = 'annotation_write' AND state = 'active'
                ORDER BY granted_at DESC LIMIT 1
                """,
                (scope_id,),
            ).fetchone()

    def create_annotation_intent(
        self,
        *,
        scope_id: str,
        knowledge_id: str,
        knowledge_version: int,
        target_note_id: str,
        target_relative_path: str,
        expected_file_revision: str | None,
        operation: str,
        planned_content_hash: str | None,
    ) -> sqlite3.Row:
        now = utc_now()
        with self.lock, self.connection:
            existing = self.connection.execute(
                """
                SELECT * FROM annotation_write_intents
                WHERE scope_id = ? AND knowledge_id = ? AND knowledge_version = ?
                  AND expected_file_revision IS ?
                ORDER BY created_at DESC LIMIT 1
                """,
                (scope_id, knowledge_id, knowledge_version, expected_file_revision),
            ).fetchone()
            if existing is not None:
                return existing
            intent_id = f"intent-{uuid4().hex}"
            self.connection.execute(
                """
                INSERT INTO annotation_write_intents (
                    intent_id, scope_id, knowledge_id, knowledge_version,
                    target_note_id, target_relative_path, expected_file_revision,
                    operation, status, attempts, planned_content_hash,
                    applied_content_hash, failure_code, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, ?, ?)
                """,
                (
                    intent_id,
                    scope_id,
                    knowledge_id,
                    knowledge_version,
                    target_note_id,
                    target_relative_path,
                    expected_file_revision,
                    operation,
                    planned_content_hash,
                    now,
                    now,
                ),
            )
            return self.connection.execute(
                "SELECT * FROM annotation_write_intents WHERE intent_id = ?",
                (intent_id,),
            ).fetchone()

    def update_annotation_intent(
        self,
        intent_id: str,
        *,
        status: str,
        attempts: int | None = None,
        applied_content_hash: str | None = None,
        failure_code: str | None = None,
    ) -> sqlite3.Row:
        fields = ["status = ?", "updated_at = ?"]
        values: list[Any] = [status, utc_now()]
        if attempts is not None:
            fields.append("attempts = ?")
            values.append(attempts)
        if applied_content_hash is not None:
            fields.append("applied_content_hash = ?")
            values.append(applied_content_hash)
        if failure_code is not None:
            fields.append("failure_code = ?")
            values.append(failure_code)
        values.append(intent_id)
        with self.lock, self.connection:
            self.connection.execute(
                f"UPDATE annotation_write_intents SET {', '.join(fields)} WHERE intent_id = ?",
                values,
            )
            row = self.connection.execute(
                "SELECT * FROM annotation_write_intents WHERE intent_id = ?",
                (intent_id,),
            ).fetchone()
        if row is None:
            raise KnowledgeServiceError("annotation_intent_not_found", "发布 Intent 不存在。", 404)
        return row

    def applying_annotation_intents(self) -> list[sqlite3.Row]:
        with self.lock:
            return self.connection.execute(
                "SELECT * FROM annotation_write_intents WHERE status = 'applying'"
            ).fetchall()

    def unverified_knowledge(self, limit: int = 20) -> list[sqlite3.Row]:
        scope = self.resolve_scope()
        with self.lock:
            return self.connection.execute(
                """
                SELECT ki.knowledge_id, ki.active_version, ki.chapter_id,
                       kv.verification_status, kv.publish_status
                FROM knowledge_items ki
                JOIN knowledge_versions kv
                  ON kv.knowledge_id = ki.knowledge_id
                 AND kv.version = ki.active_version
                WHERE ki.scope_id = ?
                  AND kv.verification_status = 'evidence_registered'
                  AND EXISTS (
                    SELECT 1 FROM atomic_claims ac
                    WHERE ac.scope_id = ki.scope_id
                      AND ac.knowledge_id = ki.knowledge_id
                      AND ac.knowledge_version = ki.active_version
                  )
                ORDER BY ki.updated_at ASC
                LIMIT ?
                """,
                (scope.scope_id, limit),
            ).fetchall()

    def latest_annotation_intent(
        self, knowledge_id: str, knowledge_version: int
    ) -> sqlite3.Row | None:
        scope = self.resolve_scope()
        with self.lock:
            return self.connection.execute(
                """
                SELECT * FROM annotation_write_intents
                WHERE scope_id = ? AND knowledge_id = ? AND knowledge_version = ?
                ORDER BY updated_at DESC LIMIT 1
                """,
                (scope.scope_id, knowledge_id, knowledge_version),
            ).fetchone()

    def recent_annotation_intents(self, limit: int = 20) -> list[sqlite3.Row]:
        scope = self.resolve_scope()
        with self.lock:
            return self.connection.execute(
                """
                SELECT * FROM annotation_write_intents
                WHERE scope_id = ?
                ORDER BY updated_at DESC LIMIT ?
                """,
                (scope.scope_id, limit),
            ).fetchall()

    def acquire_orchestrator_process(self) -> bool:
        """Allow one live backend process per Profile + Vault scope."""

        scope = self.resolve_scope()
        pid = os.getpid()
        now = utc_now()
        with self.lock, self.connection:
            row = self.connection.execute(
                "SELECT owner_pid, owner_started_at, owner_heartbeat_at FROM orchestrator_runtime WHERE scope_id = ?",
                (scope.scope_id,),
            ).fetchone()
            if row is not None and row["owner_pid"] != pid:
                heartbeat = row["owner_heartbeat_at"] or row["owner_started_at"]
                age = (
                    datetime.now(UTC) - datetime.fromisoformat(heartbeat)
                ).total_seconds()
                if age < 60:
                    return False
            self.connection.execute(
                """
                INSERT INTO orchestrator_runtime
                    (scope_id, owner_pid, owner_started_at, owner_heartbeat_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(scope_id) DO UPDATE SET
                    owner_pid = excluded.owner_pid,
                    owner_started_at = excluded.owner_started_at,
                    owner_heartbeat_at = excluded.owner_heartbeat_at
                """,
                (scope.scope_id, pid, now, now),
            )
        return True

    def refresh_orchestrator_process(self) -> bool:
        scope = self.resolve_scope()
        with self.lock, self.connection:
            updated = self.connection.execute(
                """
                UPDATE orchestrator_runtime
                SET owner_heartbeat_at = ?
                WHERE scope_id = ? AND owner_pid = ?
                """,
                (utc_now(), scope.scope_id, os.getpid()),
            )
        return updated.rowcount == 1

    def schedule_manual(self, chapter_id: str, conversation_id: str) -> int:
        del chapter_id
        scope = self.resolve_scope()
        # The extension keeps a lightweight local chapter key for its cache;
        # the backend uses NoteResolver's canonical URL hash. Resolve the
        # authoritative chapter from the persisted event when the keys differ.
        event_identity = self.connection.execute(
            """
            SELECT ec.scope_id, ec.chapter_id
            FROM event_contexts ec
            JOIN learning_events le ON le.event_id = ec.event_id
            WHERE ec.scope_id = ? AND ec.link_status = 'linked'
              AND le.conversation_id = ?
            ORDER BY le.created_at DESC, le.event_id DESC
            LIMIT 1
            """,
            (scope.scope_id, conversation_id),
        ).fetchone()
        if event_identity is None:
            return 0
        return self._plan_group(
            event_identity["scope_id"],
            event_identity["chapter_id"],
            conversation_id,
            "manual",
            True,
        )

    def latest_job_state(self, conversation_id: str) -> str | None:
        row = self.connection.execute(
            """
            SELECT state FROM extraction_jobs
            WHERE conversation_id = ?
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            """,
            (conversation_id,),
        ).fetchone()
        return row["state"] if row is not None else None

    def recover_expired_leases(self) -> int:
        now = utc_now()
        with self.lock, self.connection:
            cursor = self.connection.execute(
                """
                UPDATE extraction_jobs
                SET state = 'retryable_failed', lease_token = NULL, lease_expires_at = NULL,
                    next_attempt_at = ?, last_error_code = 'lease_expired',
                    last_error_message = 'Worker lease expired before completion.', updated_at = ?
                WHERE state = 'running' AND lease_expires_at < ?
                """,
                (now, now, now),
            )
        return cursor.rowcount

    def plan_jobs(self) -> int:
        """Automatic planning is disabled; extraction is explicitly user-triggered."""

        return 0

    def _plan_group(
        self,
        scope_id: str,
        chapter_id: str,
        conversation_id: str,
        trigger: str,
        allow_single: bool,
    ) -> int:
        with self.lock, self.connection:
            cursor = self.connection.execute(
                """
                SELECT last_completed_event_at, last_completed_event_id
                FROM chapter_extraction_cursors
                WHERE scope_id = ? AND chapter_id = ? AND conversation_id = ?
                """,
                (scope_id, chapter_id, conversation_id),
            ).fetchone()
            params: list[Any] = [scope_id, chapter_id, conversation_id]
            predicate = ""
            if cursor and cursor["last_completed_event_at"]:
                predicate = " AND (le.created_at > ? OR (le.created_at = ? AND le.event_id > ?))"
                params.extend(
                    [
                        cursor["last_completed_event_at"],
                        cursor["last_completed_event_at"],
                        cursor["last_completed_event_id"],
                    ]
                )
            events = self.connection.execute(
                """
                SELECT le.event_id, le.created_at, ec.source_snapshot_id, ec.document_id
                FROM event_contexts ec JOIN learning_events le ON le.event_id = ec.event_id
                WHERE ec.scope_id = ? AND ec.chapter_id = ? AND le.conversation_id = ?
                  AND ec.link_status = 'linked'
                """
                + predicate
                + " ORDER BY le.created_at, le.event_id",
                params,
            ).fetchall()
            if not events or (len(events) < 2 and not allow_single):
                return 0
            fingerprint_source = {
                "version": "s2-a-v1",
                "scope": scope_id,
                "chapter": chapter_id,
                "conversation": conversation_id,
                "events": [
                    [row["event_id"], row["source_snapshot_id"]] for row in events
                ],
            }
            fingerprint = digest(json.dumps(fingerprint_source, sort_keys=True))
            consent = self.active_consent(scope_id)
            state = "queued" if consent or trigger == "manual" else "blocked_consent"
            now = utc_now()
            job_id = f"job-{uuid4().hex}"
            last = events[-1]
            inserted = self.connection.execute(
                """
                INSERT OR IGNORE INTO extraction_jobs (
                    job_id, scope_id, chapter_id, document_id, conversation_id,
                    batch_fingerprint, trigger, state, event_high_watermark_at,
                    event_high_watermark_id, prompt_version, consent_id,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 's2-a-v1', ?, ?, ?)
                """,
                (
                    job_id,
                    scope_id,
                    chapter_id,
                    last["document_id"],
                    conversation_id,
                    fingerprint,
                    trigger,
                    state,
                    last["created_at"],
                    last["event_id"],
                    consent["consent_id"] if consent else None,
                    now,
                    now,
                ),
            )
            if inserted.rowcount != 1:
                existing = self.connection.execute(
                    """
                    SELECT job_id, state FROM extraction_jobs
                    WHERE scope_id = ? AND conversation_id = ? AND batch_fingerprint = ?
                    """,
                    (scope_id, conversation_id, fingerprint),
                ).fetchone()
                if (
                    trigger == "manual"
                    and existing is not None
                    and existing["state"]
                    in {"blocked_consent", "retryable_failed", "needs_review", "skipped"}
                ):
                    self.connection.execute(
                        """
                        UPDATE extraction_jobs
                        SET state = 'queued', consent_id = ?, lease_token = NULL,
                            lease_expires_at = NULL, next_attempt_at = NULL,
                            last_error_code = NULL, last_error_message = NULL,
                            updated_at = ?
                        WHERE job_id = ?
                        """,
                        (
                            consent["consent_id"] if consent else None,
                            now,
                            existing["job_id"],
                        ),
                    )
                    return 1
                return 0
            self.connection.executemany(
                "INSERT INTO extraction_job_events (job_id, event_id) VALUES (?, ?)",
                [(job_id, row["event_id"]) for row in events],
            )
        return 1

    def claim_next_job(self) -> tuple[sqlite3.Row, str] | None:
        now = datetime.now(UTC)
        lease_expires = (now + timedelta(seconds=60)).isoformat()
        token = secrets.token_urlsafe(18)
        with self.lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            row = self.connection.execute(
                """
                SELECT j.* FROM extraction_jobs j
                LEFT JOIN extraction_consents c ON c.consent_id = j.consent_id
                WHERE j.state IN ('queued', 'retryable_failed')
                  AND (j.trigger = 'manual' OR c.state = 'active')
                  AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?)
                ORDER BY j.created_at LIMIT 1
                """,
                (now.isoformat(),),
            ).fetchone()
            if row is None:
                return None
            updated = self.connection.execute(
                """
                UPDATE extraction_jobs
                SET state = 'running', lease_token = ?, lease_expires_at = ?, updated_at = ?
                WHERE job_id = ? AND state IN ('queued', 'retryable_failed')
                """,
                (token, lease_expires, now.isoformat(), row["job_id"]),
            )
            if updated.rowcount != 1:
                return None
            claimed = self.connection.execute(
                "SELECT * FROM extraction_jobs WHERE job_id = ?", (row["job_id"],)
            ).fetchone()
        return claimed, token

    def job_rows(self, job_id: str) -> list[sqlite3.Row]:
        with self.lock:
            return self.connection.execute(
                """
                SELECT le.*, ec.scope_id, ec.chapter_id, ec.document_id,
                       ec.source_snapshot_id, ec.user_message_id, ec.assistant_message_id
                FROM extraction_job_events je
                JOIN learning_events le ON le.event_id = je.event_id
                JOIN event_contexts ec ON ec.event_id = le.event_id
                WHERE je.job_id = ? ORDER BY le.created_at, le.event_id
                """,
                (job_id,),
            ).fetchall()

    def build_registry(self, job: sqlite3.Row) -> dict[str, sqlite3.Row]:
        """Register resolver-backed evidence for a claimed job."""

        rows = self.job_rows(job["job_id"])
        with self.lock, self.connection:
            for event in rows:
                snapshot_blocks = self.connection.execute(
                    """
                    SELECT * FROM source_blocks WHERE source_snapshot_id = ?
                    ORDER BY block_ordinal
                    """,
                    (event["source_snapshot_id"],),
                ).fetchall()
                for block in snapshot_blocks:
                    self._upsert_evidence(
                        scope_id=event["scope_id"],
                        chapter_id=event["chapter_id"],
                        source_kind="tutorial_block",
                        snapshot_id=event["source_snapshot_id"],
                        block_id=block["source_block_id"],
                        stable_key=block["stable_key"],
                        selection_id=None,
                        message_id=None,
                        source_url=event["source_url"],
                        heading_path=block["heading_path_json"],
                        source_fingerprint=block["content_hash"],
                        excerpt=block["text"][:2_000],
                        resolvable=True,
                    )
                self._upsert_evidence(
                    scope_id=event["scope_id"],
                    chapter_id=event["chapter_id"],
                    source_kind="user_message",
                    snapshot_id=event["source_snapshot_id"],
                    block_id=None,
                    stable_key=None,
                    selection_id=None,
                    message_id=event["user_message_id"],
                    source_url=event["source_url"],
                    heading_path=event["heading_path_json"],
                    source_fingerprint=event["source_fingerprint"],
                    excerpt=event["user_question"][:2_000],
                    resolvable=True,
                )
                self._upsert_evidence(
                    scope_id=event["scope_id"],
                    chapter_id=event["chapter_id"],
                    source_kind="assistant_message",
                    snapshot_id=event["source_snapshot_id"],
                    block_id=None,
                    stable_key=None,
                    selection_id=None,
                    message_id=event["assistant_message_id"],
                    source_url=event["source_url"],
                    heading_path=event["heading_path_json"],
                    source_fingerprint=None,
                    excerpt=event["assistant_answer"][:2_000],
                    resolvable=True,
                )
                selections = self.connection.execute(
                    """
                    SELECT * FROM selections WHERE message_id = ?
                    """,
                    (event["user_message_id"],),
                ).fetchall()
                for selection in selections:
                    matches = [
                        block
                        for block in snapshot_blocks
                        if selection["selected_text"] in block["text"]
                    ]
                    block_id = None
                    stable_key = None
                    resolvable = False
                    if len(matches) == 1:
                        block_id = matches[0]["source_block_id"]
                        stable_key = matches[0]["stable_key"]
                        resolvable = True
                    elif matches:
                        anchors = {
                            match["section_anchor_block_id"] for match in matches
                        }
                        if len(anchors) == 1 and next(iter(anchors)) is not None:
                            block_id = next(iter(anchors))
                            resolvable = True
                    self._upsert_evidence(
                        scope_id=event["scope_id"],
                        chapter_id=event["chapter_id"],
                        source_kind="selection",
                        snapshot_id=event["source_snapshot_id"],
                        block_id=block_id,
                        stable_key=stable_key,
                        selection_id=selection["selection_id"],
                        message_id=event["user_message_id"],
                        source_url=selection["source_url"],
                        heading_path=selection["heading_path_json"],
                        source_fingerprint=selection["source_fingerprint"],
                        excerpt=selection["selected_text"][:2_000],
                        resolvable=resolvable,
                    )
            evidence = self.connection.execute(
                """
                SELECT DISTINCT er.* FROM evidence_records er
                WHERE er.scope_id = ? AND (
                    (er.source_kind = 'tutorial_block' AND er.source_snapshot_id IN (
                        SELECT ec.source_snapshot_id
                        FROM extraction_job_events je
                        JOIN event_contexts ec ON ec.event_id = je.event_id
                        WHERE je.job_id = ?
                    )) OR (er.source_kind IN ('user_message', 'assistant_message')
                    AND er.message_id IN (
                        SELECT ec.user_message_id
                        FROM extraction_job_events je
                        JOIN event_contexts ec ON ec.event_id = je.event_id
                        WHERE je.job_id = ?
                        UNION
                        SELECT ec.assistant_message_id
                        FROM extraction_job_events je
                        JOIN event_contexts ec ON ec.event_id = je.event_id
                        WHERE je.job_id = ?
                    )) OR (er.source_kind = 'selection' AND er.message_id IN (
                        SELECT ec.user_message_id
                        FROM extraction_job_events je
                        JOIN event_contexts ec ON ec.event_id = je.event_id
                        WHERE je.job_id = ?
                    ))
                )
                """,
                (
                    job["scope_id"],
                    job["job_id"],
                    job["job_id"],
                    job["job_id"],
                    job["job_id"],
                ),
            ).fetchall()
        return {row["evidence_id"]: row for row in evidence}

    def _upsert_evidence(
        self,
        *,
        scope_id: str,
        chapter_id: str,
        source_kind: str,
        snapshot_id: str | None,
        block_id: str | None,
        stable_key: str | None,
        selection_id: str | None,
        message_id: str | None,
        source_url: str | None,
        heading_path: str,
        source_fingerprint: str | None,
        excerpt: str,
        resolvable: bool,
    ) -> None:
        natural = digest(
            "\u0000".join(
                [
                    source_kind,
                    snapshot_id or "",
                    block_id or "",
                    selection_id or "",
                    message_id or "",
                    digest(excerpt),
                ]
            )
        )
        evidence_id = f"ev-{natural[:32]}"
        self.connection.execute(
            """
            INSERT OR IGNORE INTO evidence_records (
                evidence_id, scope_id, chapter_id, source_kind, source_snapshot_id,
                source_block_id, stable_key, selection_id, message_id, source_url,
                heading_path_json, source_fingerprint, evidence_natural_key,
                content_hash, excerpt, resolvable, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                evidence_id,
                scope_id,
                chapter_id,
                source_kind,
                snapshot_id,
                block_id,
                stable_key,
                selection_id,
                message_id,
                source_url,
                heading_path,
                source_fingerprint,
                natural,
                digest(excerpt),
                excerpt,
                int(resolvable),
                utc_now(),
            ),
        )

    def fail_job(
        self, job: sqlite3.Row, token: str, code: str, message: str, retryable: bool
    ) -> None:
        with self.lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            current = self.connection.execute(
                "SELECT attempt_count FROM extraction_jobs WHERE job_id = ? AND state = 'running' "
                "AND lease_token = ?",
                (job["job_id"], token),
            ).fetchone()
            if current is None:
                return
            attempts = current["attempt_count"] + (1 if retryable else 0)
            retry = (
                retryable and attempts <= self.settings.knowledge_network_retry_limit
            )
            state = "retryable_failed" if retry else "needs_review"
            next_attempt = (
                (datetime.now(UTC) + timedelta(seconds=5)).isoformat()
                if retry
                else None
            )
            self.connection.execute(
                """
                UPDATE extraction_jobs
                SET state = ?, attempt_count = ?, next_attempt_at = ?, lease_token = NULL,
                    lease_expires_at = NULL, last_error_code = ?, last_error_message = ?,
                    updated_at = ?
                WHERE job_id = ? AND lease_token = ?
                """,
                (
                    state,
                    attempts,
                    next_attempt,
                    code,
                    message[:500],
                    utc_now(),
                    job["job_id"],
                    token,
                ),
            )
            if not retry:
                self._advance_cursor_locked(job)

    def _advance_cursor_locked(self, job: sqlite3.Row) -> None:
        self.connection.execute(
            """
            INSERT INTO chapter_extraction_cursors (
                scope_id, chapter_id, conversation_id, last_completed_event_at,
                last_completed_event_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope_id, chapter_id, conversation_id) DO UPDATE SET
                last_completed_event_at = excluded.last_completed_event_at,
                last_completed_event_id = excluded.last_completed_event_id,
                updated_at = excluded.updated_at
            """,
            (
                job["scope_id"],
                job["chapter_id"],
                job["conversation_id"],
                job["event_high_watermark_at"],
                job["event_high_watermark_id"],
                utc_now(),
            ),
        )

    def persist_drafts(
        self,
        job: sqlite3.Row,
        token: str,
        output: ExtractionOutputDraft,
        evidence: dict[str, sqlite3.Row],
    ) -> str:
        """Fence, persist drafts and advance only this job's cursor atomically."""

        with self.lock, self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            current = self.connection.execute(
                "SELECT * FROM extraction_jobs WHERE job_id = ? AND state = 'running' "
                "AND lease_token = ? AND lease_expires_at > ?",
                (job["job_id"], token, utc_now()),
            ).fetchone()
            if current is None:
                return "lost_lease"
            if (
                job["trigger"] != "manual"
                and self.active_consent(job["scope_id"]) is None
            ):
                self.connection.execute(
                    """
                    UPDATE extraction_jobs SET state = 'blocked_consent', lease_token = NULL,
                        lease_expires_at = NULL, updated_at = ?
                    WHERE job_id = ? AND lease_token = ?
                    """,
                    (utc_now(), job["job_id"], token),
                )
                return "blocked_consent"

            persisted = 0
            needs_review = False
            for candidate in output.candidates:
                if not candidate.worthExtracting:
                    continue
                candidate_evidence_ids = sorted(
                    {
                        evidence_id
                        for claim in candidate.claims
                        for ref in claim.evidence
                        for evidence_id in ref.evidenceIds
                    }
                )
                anchor = evidence.get(candidate.anchorEvidenceId or "")
                anchor_kind = "unresolved"
                anchor_snapshot = None
                anchor_block = None
                anchor_stable = None
                heading_path = "[]"
                anchor_fingerprint = None
                gap_reason = None
                if anchor is not None and anchor["resolvable"]:
                    anchor_kind = (
                        "source_block"
                        if anchor["source_kind"] != "selection" or anchor["stable_key"]
                        else "section"
                    )
                    anchor_snapshot = anchor["source_snapshot_id"]
                    anchor_block = anchor["source_block_id"]
                    anchor_stable = anchor["stable_key"]
                    heading_path = anchor["heading_path_json"]
                    anchor_fingerprint = anchor["source_fingerprint"]
                else:
                    gap_reason = "anchor_unresolved"
                    needs_review = True

                topic = candidate.topic or "未命名知识"
                kind = candidate.kind or "explanation"
                identity_key = digest(
                    "\u0000".join(
                        [
                            job["chapter_id"],
                            anchor_kind,
                            anchor_block or "",
                            kind,
                            topic.casefold().strip(),
                        ]
                    )
                )
                item = self.connection.execute(
                    "SELECT * FROM knowledge_items WHERE scope_id = ? AND identity_key = ?",
                    (job["scope_id"], identity_key),
                ).fetchone()
                if item is None:
                    knowledge_id = f"ki-{uuid4().hex}"
                    active_version = 0
                    self.connection.execute(
                        """
                        INSERT INTO knowledge_items (
                            knowledge_id, scope_id, document_id, chapter_id, identity_key,
                            anchor_kind, anchor_snapshot_id, anchor_block_id, anchor_stable_key,
                            heading_path_json, anchor_fingerprint, kind, topic, active_version,
                            verification_status, publish_status, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0,
                                  'evidence_registered', 'not_eligible', ?, ?)
                        """,
                        (
                            knowledge_id,
                            job["scope_id"],
                            job["document_id"],
                            job["chapter_id"],
                            identity_key,
                            anchor_kind,
                            anchor_snapshot,
                            anchor_block,
                            anchor_stable,
                            heading_path,
                            anchor_fingerprint,
                            kind,
                            topic,
                            utc_now(),
                            utc_now(),
                        ),
                    )
                else:
                    knowledge_id = item["knowledge_id"]
                    active_version = item["active_version"]

                body = candidate.body or ""
                body_hash = digest(body)
                evidence_set_hash = digest("\u0000".join(candidate_evidence_ids))
                claims_fingerprint = digest(
                    json.dumps(
                        [
                            {
                                "text": claim.text,
                                "kind": claim.kind,
                                "evidence": [
                                    ref.model_dump() for ref in claim.evidence
                                ],
                            }
                            for claim in candidate.claims
                        ],
                        ensure_ascii=False,
                        sort_keys=True,
                    )
                )
                version_fingerprint = digest(
                    "\u0000".join(
                        [
                            body_hash,
                            evidence_set_hash,
                            claims_fingerprint,
                            gap_reason or "",
                        ]
                    )
                )
                existing = self.connection.execute(
                    "SELECT version FROM knowledge_versions WHERE knowledge_id = ? AND version_fingerprint = ?",
                    (knowledge_id, version_fingerprint),
                ).fetchone()
                if existing is not None:
                    continue
                version = active_version + 1
                self.connection.execute(
                    """
                    INSERT INTO knowledge_versions (
                        knowledge_id, version, body, body_hash, evidence_set_hash,
                        version_fingerprint, origin, extraction_job_id, verification_status,
                        evidence_gap_reason, publish_status, supersedes_version, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'evidence_registered', ?,
                              'not_eligible', ?, ?)
                    """,
                    (
                        knowledge_id,
                        version,
                        body,
                        body_hash,
                        evidence_set_hash,
                        version_fingerprint,
                        "user" if kind == "user_insight" else "ai_mixed",
                        job["job_id"],
                        gap_reason,
                        active_version or None,
                        utc_now(),
                    ),
                )
                for claim in candidate.claims:
                    claim_id = f"claim-{uuid4().hex}"
                    self.connection.execute(
                        """
                        INSERT INTO atomic_claims (
                            claim_id, scope_id, knowledge_id, knowledge_version, claim_text,
                            claim_kind, verification_status, verification_reason
                        ) VALUES (?, ?, ?, ?, ?, ?, 'evidence_registered', NULL)
                        """,
                        (
                            claim_id,
                            job["scope_id"],
                            knowledge_id,
                            version,
                            claim.text,
                            claim.kind,
                        ),
                    )
                    for ref in claim.evidence:
                        for evidence_id in ref.evidenceIds:
                            self.connection.execute(
                                """
                                INSERT INTO claim_evidence (scope_id, claim_id, evidence_id, relation)
                                VALUES (?, ?, ?, ?)
                                """,
                                (job["scope_id"], claim_id, evidence_id, ref.relation),
                            )
                self.connection.execute(
                    """
                    UPDATE knowledge_items SET active_version = ?, verification_status = 'evidence_registered',
                        publish_status = 'not_eligible', updated_at = ? WHERE knowledge_id = ?
                    """,
                    (version, utc_now(), knowledge_id),
                )
                persisted += 1

            state = (
                "needs_review"
                if needs_review
                else ("completed" if persisted else "skipped")
            )
            self.connection.execute(
                """
                UPDATE extraction_jobs SET state = ?, output_hash = ?, lease_token = NULL,
                    lease_expires_at = NULL, updated_at = ?
                WHERE job_id = ? AND lease_token = ?
                """,
                (
                    state,
                    digest(output.model_dump_json()),
                    utc_now(),
                    job["job_id"],
                    token,
                ),
            )
            self._advance_cursor_locked(job)
        return state
