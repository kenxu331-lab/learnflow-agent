"""Preview and commit orchestration for the zero-token Document Engine V2."""

from __future__ import annotations

import hashlib
import threading
from dataclasses import replace
from pathlib import PurePosixPath

from app.core.config import Settings
from app.document_engine.models import (
    CalloutNode,
    DiagramNode,
    DocumentAST,
    SectionNode,
)
from app.document_engine.normalizer import SourceNormalizer
from app.document_engine.renderer import MarkdownRendererV2
from app.document_engine.svg import sanitize_svg
from app.notes.errors import NoteServiceError
from app.notes.markdown import unified_diff
from app.notes.proposals import NoteProposal, ProposalStore
from app.notes.resolver import NoteIdentity, NoteResolver
from app.notes.vault import VaultGuard
from app.schemas.page_snapshot import PageSnapshot


class DocumentPreviewService:
    def __init__(
        self,
        settings: Settings | None = None,
        normalizer: SourceNormalizer | None = None,
        renderer: MarkdownRendererV2 | None = None,
    ) -> None:
        self.vault = VaultGuard(settings or Settings(_env_file=None))
        self.resolver = NoteResolver()
        self.proposals = ProposalStore()
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self.normalizer = normalizer or SourceNormalizer()
        self.renderer = renderer or MarkdownRendererV2()

    def _lock_for(self, path: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(path, threading.Lock())

    def build(self, snapshot: PageSnapshot) -> tuple[DocumentAST, str]:
        document = self.normalizer.normalize(snapshot)
        blocks = {block.id: block for block in snapshot.blocks}
        for mapping in document.source_block_map:
            block = blocks.get(mapping.source_block_id)
            if block is not None:
                mapping.content_hash = hashlib.sha256(
                    block.text.encode("utf-8")
                ).hexdigest()
        identity = self.resolver.resolve(snapshot.url, snapshot.title)
        return document, self.renderer.render_managed(document, identity)

    @staticmethod
    def _asset_payloads(
        document: DocumentAST,
        target_relative_path: str,
    ) -> dict[str, str]:
        parent = PurePosixPath(target_relative_path).parent
        assets: dict[str, str] = {}

        def visit(nodes: list[object]) -> None:
            for node in nodes:
                if isinstance(node, DiagramNode):
                    asset_path = (parent / node.asset_relative_path).as_posix()
                    assets[asset_path] = sanitize_svg(node.svg)
                elif isinstance(node, (SectionNode, CalloutNode)):
                    visit(node.children)

        visit(document.nodes)
        return assets

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

    def preview(
        self, snapshot: PageSnapshot
    ) -> tuple[NoteProposal, NoteIdentity, DocumentAST]:
        document, markdown = self.build(snapshot)
        identity = self._select_existing_identity(
            self.resolver.resolve(snapshot.url, snapshot.title)
        )
        assets = self._asset_payloads(document, identity.target_relative_path)
        _, existing, expected_revision = self.vault.read_text(
            identity.target_relative_path
        )
        assets_changed = any(
            self.vault.read_text(path)[1] != content
            for path, content in assets.items()
        )
        if existing is None:
            action = "create"
        elif existing == markdown and not assets_changed:
            action = "noop"
        else:
            action = "replace"

        if existing and "LEARNFLOW_CONTROLLED_BEGIN" in existing:
            document.diagnostics.warnings.append(
                "目标笔记是旧版格式；确认保存后将替换为当前新版 Markdown，"
                "请先确认旧笔记中的个人内容已备份。"
            )
            document.diagnostics.warnings = list(
                dict.fromkeys(document.diagnostics.warnings)
            )
        proposal = self.proposals.put(
            action=action,
            note_id=identity.note_id,
            target_relative_path=identity.target_relative_path,
            expected_revision=expected_revision,
            markdown=markdown,
            diff=unified_diff(existing, markdown),
            assets=assets,
        )
        return proposal, identity, document

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
                for asset_path, asset_content in proposal.assets.items():
                    self.vault.write_asset(asset_path, asset_content)
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
            elif proposal.action == "replace":
                for asset_path, asset_content in proposal.assets.items():
                    self.vault.write_asset(asset_path, asset_content)
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
