"""Single-process S2-A → S2-B → S3-02 background coordinator."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from app.core.config import Settings
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.service import KnowledgeService

if TYPE_CHECKING:
    from app.annotation_writer import AnnotationWriteService


class KnowledgePublishOrchestrator:
    """Bounded coordinator; it never writes Markdown outside Safe Write Engine."""

    def __init__(
        self,
        settings: Settings,
        knowledge: KnowledgeService | None = None,
        writer: AnnotationWriteService | None = None,
    ) -> None:
        self.settings = settings
        self.knowledge = knowledge or KnowledgeService(settings)
        # The coordinator extracts and verifies only. Vault writes are always
        # initiated by an explicit user action in the Study Agent card.
        self.writer = writer
        self.single_process_allowed = (
            self.knowledge.store.acquire_orchestrator_process()
        )

    async def run_once(self) -> bool:
        if not self.single_process_allowed:
            self.single_process_allowed = (
                self.knowledge.store.acquire_orchestrator_process()
            )
            if not self.single_process_allowed:
                return False
        if not self.knowledge.store.refresh_orchestrator_process():
            self.single_process_allowed = False
            return False
        changed = await self.knowledge.run_once()

        pending = self.knowledge.store.unverified_knowledge(limit=1)
        if pending:
            item = pending[0]
            try:
                await self.knowledge.verify_knowledge(
                    item["knowledge_id"], item["active_version"]
                )
                changed = True
            except KnowledgeServiceError:
                pass

        return changed

    async def worker(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            await self.run_once()
            try:
                await asyncio.wait_for(
                    stop.wait(), timeout=self.settings.knowledge_worker_poll_seconds
                )
            except TimeoutError:
                pass
