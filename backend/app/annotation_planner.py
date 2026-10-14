# ruff: noqa: E501
"""Deterministic, read-only Markdown Annotation Planner for S3-01."""

from __future__ import annotations

import hashlib
import json
import re
from urllib.parse import quote, unquote
from uuid import uuid4

from app.core.config import Settings
from app.knowledge.schemas import PublishCandidateResponse
from app.knowledge.store import KnowledgeStore
from app.notes.errors import NoteServiceError
from app.notes.markdown import (
    BLOCK_MARKER,
    CONTROLLED_BEGIN,
    CONTROLLED_END,
    unified_diff,
)
from app.notes.resolver import NoteResolver
from app.notes.service import MarkdownNoteService
from app.notes.vault import VaultGuard
from app.schemas.annotations import AnnotationPlannedEdit, AnnotationPlanResponse

_FRONTMATTER = re.compile(r"(?m)^---\r?\n(?P<body>.*?)\r?\n---\r?\n", re.DOTALL)
_FRONTMATTER_VALUE = re.compile(r"(?m)^(?P<key>[A-Za-z0-9_]+):\s*[\"']?(?P<value>[^\"'\r\n]+)[\"']?\s*$")
_FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
_HEADING = re.compile(r"^\s*(#{1,6})\s+(.+?)\s*#*\s*$")
_ANNOTATION_START = re.compile(
    r"<!-- LEARNFLOW_ANNOTATION knowledge_id=(?P<id>[^ ]+) "
    r"version=(?P<version>[0-9]+) body_hash=(?P<body_hash>[0-9a-f]+) -->"
)
_ANNOTATION_END = "<!-- LEARNFLOW_ANNOTATION_END -->"


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _annotation_hash(value: str) -> str:
    normalized = value.replace("\r\n", "\n").replace("\r", "\n")
    return _sha256(normalized)


def _frontmatter_value(text: str, key: str) -> str | None:
    match = _FRONTMATTER.search(text)
    if not match:
        return None
    for line in match.group("body").splitlines():
        item = _FRONTMATTER_VALUE.match(line)
        if item and item.group("key") == key:
            return item.group("value")
    return None


def _heading_path_at_marker(
    text: str, marker_start: int, marker_end: int, scan_start: int
) -> list[str]:
    lines = text[scan_start:marker_start].splitlines()
    stack: list[tuple[int, str]] = []
    fence: str | None = None
    for line in lines:
        fence_match = _FENCE.match(line)
        if fence_match:
            marker = fence_match.group(1)[0]
            if fence is None:
                fence = marker
            elif fence == marker:
                fence = None
            continue
        if fence is not None:
            continue
        heading = _HEADING.match(line)
        if heading:
            level = len(heading.group(1))
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, heading.group(2).strip()))

    following = [line for line in text[marker_end:].splitlines() if line.strip()]
    if following and fence is None:
        heading = _HEADING.match(following[0])
        if heading:
            level = len(heading.group(1))
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, heading.group(2).strip()))
    return [title for _, title in stack]


def _marker_inside_fence(text: str, position: int) -> bool:
    fence: str | None = None
    for line in text[:position].splitlines():
        match = _FENCE.match(line)
        if not match:
            continue
        marker = match.group(1)[0]
        if fence is None:
            fence = marker
        elif fence == marker:
            fence = None
    return fence is not None


def _normalized_heading_path(path: list[str]) -> list[str]:
    return [re.sub(r"(?:\s*¶)+\s*$", "", value).strip() for value in path]


def _document_title_before_controlled(text: str, controlled_start: int) -> str | None:
    for line in text[:controlled_start].splitlines():
        heading = _HEADING.match(line)
        if heading and len(heading.group(1)) == 1:
            return heading.group(2).strip()
    return None


def _heading_paths_match(
    text: str,
    actual: list[str],
    expected: list[str],
    controlled_start: int,
) -> bool:
    actual = _normalized_heading_path(actual)
    expected = _normalized_heading_path(expected)
    if actual == expected:
        return True
    if len(expected) != len(actual) + 1 or expected[1:] != actual:
        return False
    return _document_title_before_controlled(text, controlled_start) == expected[0]


class AnnotationPlanner:
    """Build an in-memory plan; this class never calls Vault write methods."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.vault = VaultGuard(settings)
        self.resolver = NoteResolver()
        self.notes = MarkdownNoteService(settings)
        self.store = KnowledgeStore(settings)

    def authoritative_candidate(
        self, knowledge_id: str, knowledge_version: int
    ) -> PublishCandidateResponse | None:
        for row in self.store.publish_candidate_rows():
            if (
                row["knowledge_id"] == knowledge_id
                and row["active_version"] == knowledge_version
            ):
                return PublishCandidateResponse(
                    knowledgeId=row["knowledge_id"],
                    knowledgeVersion=row["active_version"],
                    documentId=row["document_id"],
                    chapterId=row["chapter_id"],
                    sourceUrl=row["source_url"],
                    targetNoteId=row["document_id"],
                    targetRelativePath=self.resolver.resolve(row["source_url"]).target_relative_path,
                    sourceSnapshotId=row["anchor_snapshot_id"],
                    sourceBlockId=row["anchor_block_id"],
                    anchorStableKey=row["anchor_stable_key"],
                    headingPath=json.loads(row["heading_path_json"]),
                    anchorFingerprint=row["anchor_fingerprint"],
                    body=row["body"],
                    bodyHash=row["body_hash"],
                    kind=row["kind"],
                    verificationStatus=(
                        "user_attributed"
                        if row["version_publish_status"] == "eligible_user_insight"
                        else "supported"
                    ),
                    evidenceIds=self.store.evidence_ids_for_version(
                        row["knowledge_id"], row["active_version"]
                    ),
                    publishStatus=row["version_publish_status"],
                )
        return None

    def plan_document(
        self, candidate: PublishCandidateResponse
    ) -> tuple[AnnotationPlanResponse, str | None]:
        """Return a plan plus the freshly reconstructed full document for commit."""

        plan = self.plan(candidate)
        if (
            plan.conflictStatus != "clear"
            or plan.plannedEdit is None
            or plan.plannedEdit.action == "noop"
        ):
            return plan, None
        _, existing, revision = self.vault.read_text(plan.targetRelativePath)
        if existing is None or revision != plan.expectedFileRevision:
            return plan.model_copy(
                update={
                    "conflictStatus": "needs_review",
                    "conflictReason": "source_changed: 计划生成后文件版本已变化。",
                    "plannedEdit": None,
                }
            ), None
        updated = self._apply_candidate_to_existing(existing, candidate)
        if updated is None:
            return plan.model_copy(
                update={
                    "conflictStatus": "needs_review",
                    "conflictReason": "source_changed: 最新文件无法重新定位来源锚点。",
                    "plannedEdit": None,
                }
            ), None
        return plan, updated

    def source_anchor_matches_document(
        self, candidate: PublishCandidateResponse, document: str
    ) -> bool:
        """Conservatively verify that the current rendered source block is intact."""

        if not candidate.sourceBlockId:
            return False
        source = self.store.source_block_record(
            candidate.sourceSnapshotId, candidate.sourceBlockId
        )
        marker = self._locate_source_marker(document, candidate)
        if source is None or marker is None:
            return False
        marker_match, boundary = marker
        segment = document[marker_match.end() : boundary]
        segment = re.sub(
            r"<!-- LEARNFLOW_ANNOTATION.*?<!-- LEARNFLOW_ANNOTATION_END -->",
            "",
            segment,
            flags=re.DOTALL,
        ).strip()
        source_text = source["text"].strip()
        if source["block_type"] == "heading":
            first = segment.splitlines()[0].strip() if segment else ""
            first = re.sub(r"^#{1,6}\s+", "", first)
            return first == source_text
        if source["block_type"] == "code":
            lines = segment.splitlines()
            if len(lines) < 3 or not lines[0].lstrip().startswith("```"):
                return False
            return "\n".join(lines[1:-1]).strip() == source_text
        if source["block_type"] == "list":
            segment = re.sub(r"^-\s+", "", segment, count=1)
        return segment == source_text

    def _apply_candidate_to_existing(
        self, existing: str, candidate: PublishCandidateResponse
    ) -> str | None:
        marker = self._locate_source_marker(existing, candidate)
        if marker is None:
            return None
        _, insert_at = marker
        annotation = self._annotation(candidate)
        try:
            existing_annotation = self._find_annotation(existing, candidate.knowledgeId)
        except NoteServiceError:
            return None
        if existing_annotation is not None:
            start, end, stored_hash, stored_version = existing_annotation
            current_body = existing[start.end() : end].strip("\r\n")
            if stored_hash != _annotation_hash(current_body):
                return None
            if (
                stored_version == candidate.knowledgeVersion
                and current_body.replace("\r\n", "\n").replace("\r", "\n")
                == annotation
            ):
                return existing
            edit_start, edit_end = start.start(), end + len(_ANNOTATION_END)
        else:
            edit_start, edit_end = insert_at, insert_at
        newline = "\r\n" if "\r\n" in existing else "\n"
        block = self._annotation_block(candidate, annotation, newline)
        return existing[:edit_start] + block + existing[edit_end:]

    def plan(self, candidate: PublishCandidateResponse) -> AnnotationPlanResponse:
        scope = self.store.resolve_scope()
        identity = self.resolver.resolve(candidate.sourceUrl)
        base = dict(
            planId=f"plan-{uuid4().hex}",
            knowledgeId=candidate.knowledgeId,
            knowledgeVersion=candidate.knowledgeVersion,
            targetNoteId=candidate.targetNoteId,
            targetVaultScope=scope.scope_id,
            targetRelativePath=identity.target_relative_path,
            sourceUrl=candidate.sourceUrl,
            sourceSnapshotId=candidate.sourceSnapshotId,
            sourceBlockId=candidate.sourceBlockId,
            anchorStableKey=candidate.anchorStableKey,
            headingPath=candidate.headingPath,
            expectedFileRevision=None,
            plannedEdit=None,
            before="",
            after="",
            diff="",
            conflictStatus="clear",
            conflictReason=None,
        )

        if candidate.verificationStatus not in {"supported", "user_attributed"}:
            return AnnotationPlanResponse(
                **{**base, "conflictStatus": "needs_review", "conflictReason": "candidate_invalid: 发布候选核验状态无效。"}
            )
        if candidate.publishStatus not in {"eligible", "eligible_user_insight"}:
            return AnnotationPlanResponse(
                **{**base, "conflictStatus": "needs_review", "conflictReason": "candidate_invalid: 发布候选不具备发布资格。"}
            )
        if (
            candidate.targetNoteId != identity.note_id
            or candidate.documentId != identity.note_id
            or candidate.chapterId != identity.chapter_id
        ):
            return AnnotationPlanResponse(
                **{**base, "conflictStatus": "needs_review", "conflictReason": "target_mismatch: PublishCandidate 与 NoteResolver 身份不一致。"}
            )

        try:
            resolved = self.notes.resolve_existing_identity(identity)
            path, existing, revision = self.vault.read_text(resolved.target_relative_path)
        except NoteServiceError as error:
            return AnnotationPlanResponse(
                **{
                    **base,
                    "targetRelativePath": identity.target_relative_path,
                    "conflictStatus": "needs_review",
                    "conflictReason": error.message,
                }
            )
        base["targetRelativePath"] = resolved.target_relative_path
        base["expectedFileRevision"] = revision
        if existing is None or path is None:
            return AnnotationPlanResponse(
                **{**base, "conflictStatus": "needs_review", "conflictReason": "target_missing: 目标 Markdown 不存在。"}
            )
        if (
            _frontmatter_value(existing, "learnflow_id") != identity.note_id
            or _frontmatter_value(existing, "chapter_id") != identity.chapter_id
            or _frontmatter_value(existing, "source_url") != identity.normalized_url
        ):
            return AnnotationPlanResponse(
                **{**base, "conflictStatus": "needs_review", "conflictReason": "target_mismatch: 目标 Markdown 的来源身份与 PublishCandidate 不一致。"}
            )
        if existing.count(CONTROLLED_BEGIN) != 1 or existing.count(CONTROLLED_END) != 1:
            return AnnotationPlanResponse(
                **{**base, "conflictStatus": "needs_review", "conflictReason": "target_mismatch: 目标 Markdown 缺少唯一受控区域。"}
            )

        marker = self._locate_source_marker(existing, candidate)
        if marker is None:
            return AnnotationPlanResponse(
                **{**base, "conflictStatus": "needs_review", "conflictReason": "source_changed: 无法依据 sourceBlockId/stableKey/指纹唯一定位源块。"}
            )
        marker_match, insert_at = marker
        controlled_start = existing.index(CONTROLLED_BEGIN)
        if candidate.headingPath and not _heading_paths_match(
            existing,
            _heading_path_at_marker(
                existing,
                marker_match.start(),
                marker_match.end(),
                controlled_start + len(CONTROLLED_BEGIN),
            ),
            candidate.headingPath,
            controlled_start,
        ):
            return AnnotationPlanResponse(
                **{**base, "conflictStatus": "needs_review", "conflictReason": "source_changed: 当前 Markdown 的小节路径与来源锚点不一致。"}
            )

        annotation = self._annotation(candidate)
        try:
            existing_annotation = self._find_annotation(existing, candidate.knowledgeId)
        except NoteServiceError as error:
            return AnnotationPlanResponse(
                **{
                    **base,
                    "conflictStatus": "needs_review",
                    "conflictReason": error.message,
                }
            )
        if existing_annotation is not None:
            start, end, stored_hash, stored_version = existing_annotation
            current_body = existing[start.end() : end].strip("\r\n")
            if stored_hash != _annotation_hash(current_body):
                return AnnotationPlanResponse(
                    **{**base, "conflictStatus": "needs_review", "conflictReason": "annotation_conflict: 已有托管注解已被修改，拒绝静默覆盖。"}
                )
            if (
                stored_version == candidate.knowledgeVersion
                and current_body.replace("\r\n", "\n").replace("\r", "\n")
                == annotation
            ):
                return self._plan_response(base, "noop", resolved.target_relative_path, annotation, existing, start.start(), start.end())
            edit_start, edit_end = start.start(), end + len(_ANNOTATION_END)
            action = "update"
        else:
            edit_start, edit_end = insert_at, insert_at
            action = "insert"

        newline = "\r\n" if "\r\n" in existing else "\n"
        block = self._annotation_block(candidate, annotation, newline)
        updated = existing[:edit_start] + block + existing[edit_end:]
        return self._plan_response(base, action, resolved.target_relative_path, annotation, existing, edit_start, edit_end, updated)

    @staticmethod
    def _annotation(candidate: PublishCandidateResponse) -> str:
        if candidate.publishStatus == "eligible_user_insight":
            title, style = "我的理解", "note"
        elif candidate.kind == "pitfall":
            title, style = "易错点", "warning"
        else:
            title, style = "学习理解", "note"
        lines = candidate.body.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        return "\n".join([f"> [!{style}] {title}", *[f"> {line}" for line in lines]])

    @staticmethod
    def _annotation_block(candidate: PublishCandidateResponse, annotation: str, newline: str) -> str:
        body_hash = _annotation_hash(annotation)
        start = (
            f"<!-- LEARNFLOW_ANNOTATION knowledge_id={candidate.knowledgeId} "
            f"version={candidate.knowledgeVersion} body_hash={body_hash} -->"
        )
        return newline.join([start, annotation, _ANNOTATION_END, "", ""])

    @staticmethod
    def _find_annotation(text: str, knowledge_id: str):
        matches = [
            match
            for match in _ANNOTATION_START.finditer(text)
            if match.group("id") == quote(knowledge_id, safe="-_.~")
            and text[text.rfind("\n", 0, match.start()) + 1 : match.start()].strip()
            == ""
        ]
        if len(matches) > 1:
            raise NoteServiceError("annotation_conflict", "同一 knowledgeId 存在多个注解。", 409)
        if not matches:
            return None
        start = matches[0]
        end = text.find(_ANNOTATION_END, start.end())
        if end < 0:
            raise NoteServiceError("annotation_conflict", "托管注解缺少结束标记。", 409)
        return start, end, start.group("body_hash"), int(start.group("version"))

    @staticmethod
    def _locate_source_marker(text: str, candidate: PublishCandidateResponse):
        controlled_start = text.index(CONTROLLED_BEGIN)
        controlled_end = text.index(CONTROLLED_END)
        expected_ids = {
            value
            for value in (candidate.anchorStableKey, candidate.sourceBlockId)
            if value
        }
        source_fingerprint = candidate.anchorFingerprint or ""
        markers = []
        for match in BLOCK_MARKER.finditer(text, controlled_start, controlled_end):
            if _marker_inside_fence(text, match.start()):
                continue
            marker_id = unquote(match.group("id"))
            if marker_id not in expected_ids:
                continue
            marker_fingerprint = match.group("fingerprint")
            if re.fullmatch(r"[0-9a-f]{64}", source_fingerprint) and not source_fingerprint.startswith(marker_fingerprint):
                continue
            markers.append(match)
        if len(markers) == 1:
            marker = markers[0]
        elif not markers and re.fullmatch(r"[0-9a-f]{64}", source_fingerprint):
            fingerprint_matches = [
                item
                for item in BLOCK_MARKER.finditer(
                    text, controlled_start, controlled_end
                )
                if not _marker_inside_fence(text, item.start())
                and source_fingerprint.startswith(item.group("fingerprint"))
            ]
            if len(fingerprint_matches) > 1 and candidate.headingPath:
                fingerprint_matches = [
                    item
                    for item in fingerprint_matches
                    if _heading_paths_match(
                        text,
                        _heading_path_at_marker(
                            text,
                            item.start(),
                            item.end(),
                            controlled_start + len(CONTROLLED_BEGIN),
                        ),
                        candidate.headingPath,
                        controlled_start,
                    )
                ]
            # A content fingerprint is only a safe fallback when it identifies
            # exactly one current source block after deterministic heading-path
            # disambiguation. Never guess between duplicates.
            if len(fingerprint_matches) != 1:
                return None
            marker = fingerprint_matches[0]
        else:
            return None
        next_marker = next(
            (
                item
                for item in BLOCK_MARKER.finditer(text, marker.end(), controlled_end)
                if not _marker_inside_fence(text, item.start())
            ),
            None,
        )
        return marker, next_marker.start() if next_marker else controlled_end

    @staticmethod
    def _plan_response(
        base: dict,
        action: str,
        path: str,
        annotation: str,
        existing: str,
        start: int,
        end: int,
        updated: str | None = None,
    ) -> AnnotationPlanResponse:
        if updated is None:
            updated = existing
        before = existing[max(0, start - 240) : min(len(existing), end + 240)]
        after = updated[max(0, start - 240) : min(len(updated), start + len(annotation) + 240)]
        diff = unified_diff(before, after)
        line = existing.count("\n", 0, start) + 1
        planned = AnnotationPlannedEdit(
            action=action,
            targetRelativePath=path,
            anchorLine=line,
            annotation=annotation,
        )
        return AnnotationPlanResponse(
            **{
                **base,
                "plannedEdit": planned,
                "before": before,
                "after": after,
                "diff": diff,
                "conflictStatus": "clear",
            }
        )
