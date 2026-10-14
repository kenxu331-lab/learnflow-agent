# ruff: noqa: E501
"""S3-01 read-only Annotation Planner safety tests."""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from pathlib import Path

from app.annotation_planner import AnnotationPlanner
from app.core.config import Settings
from app.knowledge.schemas import PublishCandidateResponse
from app.notes.markdown import CONTROLLED_END, build_new_document
from app.notes.resolver import NoteResolver
from app.schemas.page_snapshot import PageSnapshot


def make_settings(tmp_path: Path) -> Settings:
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    return Settings(
        _env_file=None,
        local_api_token="test-token",
        vault_path=str(vault),
        learning_memory_db_path=str(tmp_path / "learning.sqlite3"),
    )


def make_snapshot(*, duplicate_headings: bool = False) -> PageSnapshot:
    blocks: list[dict[str, object]] = [
        {"id": "heading-1", "stableKey": "v1-heading-1-0", "type": "heading", "text": "同名小节", "level": 2},
        {"id": "code-1", "stableKey": "v1-code-1-0", "type": "code", "text": "# 代码中的标题\nprint('x')", "language": "python"},
        {"id": "paragraph-1", "stableKey": "v1-paragraph-1-0", "type": "paragraph", "text": "第一个小节正文。"},
    ]
    if duplicate_headings:
        blocks.extend(
            [
                {"id": "heading-2", "stableKey": "v1-heading-2-0", "type": "heading", "text": "同名小节", "level": 2},
                {"id": "paragraph-2", "stableKey": "v1-paragraph-2-0", "type": "paragraph", "text": "第二个小节正文。"},
            ]
        )
    return PageSnapshot.model_validate(
        {
            "schemaVersion": 1,
            "url": "https://fastapi.tiangolo.com/tutorial/background-tasks/",
            "title": "Background Tasks - FastAPI",
            "capturedAt": "2026-10-14T00:00:00Z",
            "blocks": blocks,
            "extraction": {"strategy": "article", "truncated": False, "warnings": []},
            "stats": {
                "characterCount": sum(len(str(block["text"])) for block in blocks),
                "codeBlockCount": 1,
                "blockCount": len(blocks),
            },
        }
    )


def write_note(settings: Settings, snapshot: PageSnapshot) -> tuple[NoteResolver, Path]:
    resolver = NoteResolver()
    identity = resolver.resolve(snapshot.url, snapshot.title)
    path = Path(settings.vault_path) / identity.target_relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        build_new_document(
            identity,
            snapshot,
            snapshot.blocks,
            None,
            datetime.now(UTC),
        ),
        encoding="utf-8",
    )
    return resolver, path


def candidate_for(
    snapshot: PageSnapshot,
    block_id: str,
    stable_key: str,
    heading_path: list[str],
    *,
    publish_status: str = "eligible",
    verification_status: str = "supported",
    body: str = "这是对该教程内容的学习理解。",
) -> PublishCandidateResponse:
    identity = NoteResolver().resolve(snapshot.url, snapshot.title)
    block = next((block for block in snapshot.blocks if block.id == block_id), None)
    return PublishCandidateResponse(
        knowledgeId="ki-test-1",
        knowledgeVersion=1,
        documentId=identity.note_id,
        chapterId=identity.chapter_id,
        sourceUrl=snapshot.url,
        targetNoteId=identity.note_id,
        sourceSnapshotId="snapshot-test",
        sourceBlockId=block_id,
        anchorStableKey=stable_key,
        headingPath=heading_path,
        anchorFingerprint=(
            hashlib.sha256(block.text.encode("utf-8")).hexdigest()
            if block is not None
            else None
        ),
        body=body,
        bodyHash=hashlib.sha256(body.encode("utf-8")).hexdigest(),
        kind="concept",
        verificationStatus=verification_status,
        evidenceIds=["ev-test"],
        publishStatus=publish_status,
    )


def test_unique_source_block_generates_read_only_insert_plan(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    snapshot = make_snapshot()
    _, path = write_note(settings, snapshot)
    planner = AnnotationPlanner(settings)
    candidate = candidate_for(
        snapshot, "paragraph-1", "v1-paragraph-1-0", ["同名小节"]
    )

    plan = planner.plan(candidate)

    assert plan.conflictStatus == "clear"
    assert plan.plannedEdit is not None
    assert plan.plannedEdit.action == "insert"
    assert "[!note] 学习理解" in plan.plannedEdit.annotation
    assert "LEARNFLOW_ANNOTATION" not in path.read_text(encoding="utf-8")


def test_unique_fingerprint_relocates_source_after_stable_key_changes(
    tmp_path: Path,
) -> None:
    settings = make_settings(tmp_path)
    snapshot = make_snapshot()
    write_note(settings, snapshot)
    planner = AnnotationPlanner(settings)

    candidate = candidate_for(
        snapshot, "paragraph-1", "v1-new-capture-key-0", ["同名小节"]
    )

    plan = planner.plan(candidate)

    assert plan.conflictStatus == "clear"
    assert plan.plannedEdit is not None


def test_duplicate_headings_are_disambiguated_by_source_block(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    snapshot = make_snapshot(duplicate_headings=True)
    write_note(settings, snapshot)
    planner = AnnotationPlanner(settings)

    plan = planner.plan(
        candidate_for(snapshot, "paragraph-2", "v1-paragraph-2-0", ["同名小节"])
    )

    assert plan.conflictStatus == "clear"
    assert plan.plannedEdit is not None


def test_duplicate_fingerprint_uses_heading_path_for_safe_disambiguation(
    tmp_path: Path,
) -> None:
    snapshot = make_snapshot(duplicate_headings=True)
    payload = snapshot.model_dump(mode="json")
    payload["blocks"][3]["text"] = "另一个小节"
    payload["stats"]["characterCount"] = sum(
        len(str(block["text"])) for block in payload["blocks"]
    )
    snapshot = PageSnapshot.model_validate(payload)
    settings = make_settings(tmp_path)
    write_note(settings, snapshot)
    planner = AnnotationPlanner(settings)

    plan = planner.plan(
        candidate_for(snapshot, "paragraph-2", "v1-new-capture-key-0", ["另一个小节"])
    )

    assert plan.conflictStatus == "clear"
    assert plan.plannedEdit is not None


def test_code_fence_heading_is_not_used_as_markdown_heading(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    snapshot = make_snapshot()
    write_note(settings, snapshot)
    planner = AnnotationPlanner(settings)

    plan = planner.plan(
        candidate_for(snapshot, "paragraph-1", "v1-paragraph-1-0", ["同名小节"])
    )

    assert plan.conflictStatus == "clear"


def test_unlocatable_source_refuses_executable_plan(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    snapshot = make_snapshot()
    write_note(settings, snapshot)
    planner = AnnotationPlanner(settings)

    plan = planner.plan(
        candidate_for(snapshot, "missing-block", "v1-missing-0", ["同名小节"])
    )

    assert plan.conflictStatus == "needs_review"
    assert plan.plannedEdit is None


def test_same_knowledge_is_noop_and_modified_annotation_is_conflict(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    snapshot = make_snapshot()
    _, path = write_note(settings, snapshot)
    planner = AnnotationPlanner(settings)
    candidate = candidate_for(
        snapshot, "paragraph-1", "v1-paragraph-1-0", ["同名小节"]
    )
    first = planner.plan(candidate)
    assert first.plannedEdit is not None
    existing = path.read_text(encoding="utf-8")
    insertion = existing.index(CONTROLLED_END)
    block = planner._annotation_block(candidate, first.plannedEdit.annotation, "\n")
    path.write_text(existing[:insertion] + "\n\n" + block + existing[insertion:], encoding="utf-8")

    noop = planner.plan(candidate)
    assert noop.conflictStatus == "clear"
    assert noop.plannedEdit is not None
    assert noop.plannedEdit.action == "noop"

    modified = path.read_text(encoding="utf-8").replace(
        "> 这是对该教程内容的学习理解。", "> 用户手动修改过的内容。"
    )
    path.write_text(modified, encoding="utf-8")
    conflict = planner.plan(candidate)
    assert conflict.conflictStatus == "needs_review"
    assert conflict.plannedEdit is None


def test_user_insight_uses_distinct_callout_title(tmp_path: Path) -> None:
    settings = make_settings(tmp_path)
    snapshot = make_snapshot()
    write_note(settings, snapshot)
    planner = AnnotationPlanner(settings)
    candidate = candidate_for(
        snapshot,
        "paragraph-1",
        "v1-paragraph-1-0",
        ["同名小节"],
        publish_status="eligible_user_insight",
        verification_status="user_attributed",
        body="我理解为：这里是在响应完成后执行额外任务。",
    )

    plan = planner.plan(candidate)

    assert plan.plannedEdit is not None
    assert "[!note] 我的理解" in plan.plannedEdit.annotation
