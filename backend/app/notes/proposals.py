"""Short-lived in-process note proposals."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from secrets import token_urlsafe
from threading import RLock

from app.notes.errors import NoteServiceError


@dataclass
class NoteProposal:
    proposal_id: str
    action: str
    note_id: str
    target_relative_path: str
    expected_revision: str | None
    markdown: str
    diff: str
    expires_at: datetime
    assets: dict[str, str] = field(default_factory=dict)
    completed: dict[str, str] | None = None


class ProposalStore:
    def __init__(self, ttl_seconds: int = 600, max_items: int = 128) -> None:
        self.ttl = timedelta(seconds=ttl_seconds)
        self.max_items = max_items
        self._items: dict[str, NoteProposal] = {}
        self._lock = RLock()

    def _purge(self, now: datetime) -> None:
        expired = [key for key, item in self._items.items() if item.expires_at <= now]
        for key in expired:
            self._items.pop(key, None)

    def put(
        self,
        *,
        action: str,
        note_id: str,
        target_relative_path: str,
        expected_revision: str | None,
        markdown: str,
        diff: str,
        assets: dict[str, str] | None = None,
    ) -> NoteProposal:
        now = datetime.now(UTC)
        with self._lock:
            self._purge(now)
            while len(self._items) >= self.max_items:
                self._items.pop(next(iter(self._items)))
            proposal = NoteProposal(
                proposal_id=token_urlsafe(24),
                action=action,
                note_id=note_id,
                target_relative_path=target_relative_path,
                expected_revision=expected_revision,
                markdown=markdown,
                diff=diff,
                assets=dict(assets or {}),
                expires_at=now + self.ttl,
            )
            self._items[proposal.proposal_id] = proposal
            return proposal

    def get(self, proposal_id: str) -> NoteProposal:
        now = datetime.now(UTC)
        with self._lock:
            self._purge(now)
            proposal = self._items.get(proposal_id)
            if proposal is None:
                raise NoteServiceError(
                    "proposal_expired",
                    "预览提案不存在或已过期。",
                    410,
                )
            return proposal

    def complete(self, proposal: NoteProposal, result: dict[str, str]) -> None:
        with self._lock:
            proposal.completed = result
