"""Deterministic preview/commit orchestration for Obsidian notes."""

from __future__ import annotations

import hashlib
import threading
from dataclasses import replace
from datetime import UTC, datetime

from app.core.config import Settings
from app.notes.errors import NoteServiceError
from app.notes.markdown import (
    _validate_managed_document,
    build_new_document,
    merge_document,
    unified_diff,
)
from app.notes.proposals import NoteProposal, ProposalStore
from app.notes.resolver import NoteIdentity, NoteResolver
from app.notes.vault import VaultGuard
from app.schemas.notes import NotePreviewRequest
from app.schemas.page_snapshot import ContentBlock


class MarkdownNoteService:
    def __init__(self, settings: Settings) -> None:
        self.vault = VaultGuard(settings)
        self.resolver = NoteResolver()
        self.proposals = ProposalStore()
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()

    def _lock_for(self, path: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(path, threading.Lock())

    @staticmethod
    def _selected_blocks(request: NotePreviewRequest) -> list[ContentBlock]:
        selected = set(request.selectedBlockIds)
        return [block for block in request.snapshot.blocks if block.id in selected]

    def _identity(self, request: NotePreviewRequest) -> NoteIdentity:
        identity = self.resolver.resolve(
            request.snapshot.url,
            request.snapshot.title,
        )
        return self._select_existing_identity(identity)

    def _select_existing_identity(self, identity: NoteIdentity) -> NoteIdentity:
        _, preferred, _ = self.vault.read_text(identity.target_relative_path)
        if preferred is not None and self.resolver.content_matches_identity(
            preferred, identity
        ):
            return identity

        _, legacy, _ = self.vault.read_text(identity.legacy_target_relative_path)
        if legacy is not None and self.resolver.content_matches_identity(
            legacy, identity
        ):
            return replace(
                identity,
                target_relative_path=identity.legacy_target_relative_path,
            )

        root = self.vault.root()
        preferred_path = self.vault.target_path(identity.target_relative_path)
        if preferred_path.parent.exists():
            for path in preferred_path.parent.glob("*.md"):
                relative = path.relative_to(root).as_posix()
                _, content, _ = self.vault.read_text(relative)
                if content and self.resolver.content_matches_identity(
                    content, identity
                ):
                    return replace(identity, target_relative_path=relative)

        if preferred is not None:
            return replace(
                identity,
                target_relative_path=self.resolver.collision_target(identity),
            )
        return identity

    def resolve_existing_identity(self, identity: NoteIdentity) -> NoteIdentity:
        """Resolve the existing managed note without reading or writing content."""

        return self._select_existing_identity(identity)

    def replace_managed_note(
        self,
        *,
        identity: NoteIdentity,
        relative_path: str,
        expected_revision: str,
        content: str,
    ) -> str:
        """Replace a validated managed note with revision and path fencing."""

        lock = self._lock_for(relative_path)
        with lock:
            _, current, revision = self.vault.read_text(relative_path)
            if revision != expected_revision:
                raise NoteServiceError(
                    "note_conflict",
                    "预览后目标笔记已被修改，请重新生成计划。",
                    409,
                )
            if current is None:
                raise NoteServiceError("note_conflict", "目标笔记已不存在。", 409)
            _validate_managed_document(current, identity)
            return self.vault.replace(relative_path, content)

    def preview(self, request: NotePreviewRequest) -> tuple[NoteProposal, NoteIdentity]:
        identity = self._identity(request)
        blocks = self._selected_blocks(request)
        if not blocks:
            raise NoteServiceError("invalid_selection", "至少选择一个内容块。", 422)

        _, existing, expected_revision = self.vault.read_text(
            identity.target_relative_path
        )
        now = datetime.now(UTC)
        if existing is None:
            action = "create"
            markdown = build_new_document(
                identity,
                request.snapshot,
                blocks,
                request.personalNote,
                now,
            )
        else:
            markdown, changed = merge_document(
                existing,
                identity,
                request.snapshot,
                blocks,
                request.personalNote,
                now,
            )
            action = "append" if changed else "noop"

        proposal = self.proposals.put(
            action=action,
            note_id=identity.note_id,
            target_relative_path=identity.target_relative_path,
            expected_revision=expected_revision,
            markdown=markdown,
            diff=unified_diff(existing, markdown),
        )
        return proposal, identity

    def commit(self, proposal_id: str) -> dict[str, str]:
        proposal = self.proposals.get(proposal_id)
        lock = self._lock_for(proposal.target_relative_path)
        with lock:
            if proposal.completed is not None:
                return proposal.completed
            _, current, current_revision = self.vault.read_text(
                proposal.target_relative_path
            )
            if current_revision != proposal.expected_revision:
                raise NoteServiceError(
                    "note_conflict",
                    "预览后目标笔记已被修改，请重新生成预览。",
                    409,
                )

            if proposal.action == "noop":
                revision = current_revision or hashlib.sha256(b"").hexdigest()
                result = {
                    "status": "unchanged",
                    "noteId": proposal.note_id,
                    "targetRelativePath": proposal.target_relative_path,
                    "revision": f"sha256:{revision}",
                }
            elif proposal.action == "create":
                revision = self.vault.create(
                    proposal.target_relative_path,
                    proposal.markdown,
                )
                result = {
                    "status": "created",
                    "noteId": proposal.note_id,
                    "targetRelativePath": proposal.target_relative_path,
                    "revision": f"sha256:{revision}",
                }
            elif proposal.action == "append":
                revision = self.vault.replace(
                    proposal.target_relative_path,
                    proposal.markdown,
                )
                result = {
                    "status": "updated",
                    "noteId": proposal.note_id,
                    "targetRelativePath": proposal.target_relative_path,
                    "revision": f"sha256:{revision}",
                }
            else:
                raise NoteServiceError("invalid_proposal", "预览提案动作无效。", 409)

            self.proposals.complete(proposal, result)
            return result
