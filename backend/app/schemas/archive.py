"""Approval is bound to immutable server plans, never model-written paths."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from app.schemas.annotations import AnnotationCommitResponse, AnnotationPlanResponse


class KnowledgeReference(BaseModel):
    model_config = ConfigDict(extra="forbid")
    knowledgeId: StrictStr = Field(min_length=1, max_length=200)
    version: StrictInt = Field(ge=1)


class ArchivePrepareRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversationId: StrictStr = Field(min_length=1, max_length=200)
    references: list[KnowledgeReference] = Field(default_factory=list, max_length=10)


class ArchiveSelectionRequest(ArchivePrepareRequest):
    pass


class ArchiveDecisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversationId: StrictStr = Field(min_length=1, max_length=200)
    planDigest: StrictStr = Field(min_length=64, max_length=64)
    decision: Literal["confirm", "cancel"]


class ArchiveConfirmationView(BaseModel):
    confirmationId: str
    conversationId: str
    chapterId: str
    sourceUrl: str
    state: Literal[
        "pending",
        "applying",
        "interrupted",
        "published",
        "noop",
        "cancelled",
        "expired",
        "needs_review",
        "failed",
    ]
    planDigest: str
    targetRelativePath: str
    expectedFileRevision: str
    plannedContentHash: str
    diff: str
    plans: list[AnnotationPlanResponse]
    message: str
    createdAt: str
    expiresAt: str
    approvedAt: str | None = None
    results: list[AnnotationCommitResponse] = Field(default_factory=list)
