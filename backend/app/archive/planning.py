"""Compose same-chapter annotations in memory; never write while previewing."""

import hashlib
import json
from dataclasses import dataclass

from app.annotation_planner import AnnotationPlanner
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.schemas import PublishCandidateResponse
from app.notes.markdown import unified_diff
from app.schemas.annotations import AnnotationPlanResponse


def content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def candidate_fingerprint(candidate: PublishCandidateResponse) -> str:
    return content_hash(
        json.dumps(
            candidate.model_dump(mode="json"), ensure_ascii=False, sort_keys=True
        )
    )


@dataclass
class ApprovedBatch:
    path: str
    revision: str
    after: str
    diff: str
    plans: list[AnnotationPlanResponse]


def build_batch(
    planner: AnnotationPlanner, candidates: list[PublishCandidateResponse]
) -> ApprovedBatch:
    plans = []
    original = None
    result = None
    path = ""
    revision = ""
    for candidate in candidates:
        if "<!-- LEARNFLOW_" in candidate.body or "<!-- LF_BLOCK" in candidate.body:
            raise KnowledgeServiceError(
                "archive_reserved_marker",
                "知识正文含笔记托管标记，需人工检查后再归档。",
                409,
            )
        plan = planner.plan(candidate)
        if plan.conflictStatus != "clear" or not plan.plannedEdit:
            raise KnowledgeServiceError(
                "archive_needs_review", plan.conflictReason or "归档计划需要检查。", 409
            )
        _, existing, current_revision = planner.vault.read_text(plan.targetRelativePath)
        if (
            existing is None
            or current_revision != plan.expectedFileRevision
            or not planner.source_anchor_matches_document(candidate, existing)
        ):
            raise KnowledgeServiceError(
                "archive_source_changed", "原文锚点或文件版本已变化，请重新预览。", 409
            )
        if original is None:
            original = result = existing
            path, revision = plan.targetRelativePath, current_revision
        if plan.targetRelativePath != path or current_revision != revision:
            raise KnowledgeServiceError(
                "archive_batch_mismatch",
                "一次确认仅支持当前章节同一文件；请分章节归档。",
                409,
            )
        updated = planner._apply_candidate_to_existing(result, candidate)
        if updated is None:
            raise KnowledgeServiceError(
                "archive_source_changed", "组合计划无法定位原文，请重新预览。", 409
            )
        result = updated
        plans.append(plan)
    if original is None or result is None:
        raise KnowledgeServiceError(
            "archive_selection_required", "请先选择要归档的知识。", 422
        )
    return ApprovedBatch(path, revision, result, unified_diff(original, result), plans)
