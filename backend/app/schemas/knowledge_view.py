"""Persisted knowledge results, not model-authored success claims."""

from typing import Literal

from pydantic import BaseModel, Field

from app.knowledge.schemas import KnowledgeClaimResponse, PublishCandidateResponse


class KnowledgeItemView(BaseModel):
    knowledgeId: str
    version: int
    topic: str
    kind: str
    body: str
    sourceUrl: str
    verificationStatus: str
    publishStatus: str
    evidenceGapReason: str | None = None
    archived: bool = False
    claims: list[KnowledgeClaimResponse] = Field(default_factory=list)
    duplicateIds: list[str] = Field(default_factory=list)
    similarTo: list[str] = Field(default_factory=list)
    publishCandidate: PublishCandidateResponse | None = None


class KnowledgeTaskView(BaseModel):
    taskId: str | None = None
    conversationId: str
    chapterId: str
    sourceUrl: str
    state: Literal[
        "available",
        "submitting",
        "waiting_previous",
        "queued",
        "extracting",
        "verifying",
        "completed",
        "needs_review",
        "failed",
        "no_new_events",
    ]
    message: str
    noNewContent: bool = False
    items: list[KnowledgeItemView] = Field(default_factory=list)
    duplicateCount: int = 0
    updatedAt: str
