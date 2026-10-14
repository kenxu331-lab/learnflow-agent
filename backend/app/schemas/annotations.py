"""Read-only S3-01 Annotation Planner contracts."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr

from app.knowledge.schemas import PublishCandidateResponse

ConflictStatus = Literal[
    "clear",
    "needs_review",
    "target_missing",
    "target_mismatch",
    "source_changed",
    "annotation_conflict",
    "candidate_invalid",
]
AnnotationAction = Literal["insert", "update", "noop", "needs_review"]


class AnnotationPlanRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    candidate: PublishCandidateResponse


class AnnotationPlannedEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: AnnotationAction
    targetRelativePath: StrictStr
    anchorLine: StrictInt | None = None
    annotation: StrictStr


class AnnotationPlanResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    planId: StrictStr
    knowledgeId: StrictStr
    knowledgeVersion: StrictInt = Field(ge=1)
    targetNoteId: StrictStr
    targetVaultScope: StrictStr
    targetRelativePath: StrictStr
    sourceUrl: StrictStr
    sourceSnapshotId: StrictStr
    sourceBlockId: StrictStr | None = None
    anchorStableKey: StrictStr | None = None
    headingPath: list[StrictStr]
    expectedFileRevision: StrictStr | None = None
    plannedEdit: AnnotationPlannedEdit | None = None
    before: StrictStr = ""
    after: StrictStr = ""
    diff: StrictStr = ""
    conflictStatus: ConflictStatus
    conflictReason: StrictStr | None = None


class AnnotationConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool
    policyVersion: StrictStr = Field(default="s3-02-v1", min_length=1, max_length=100)


class AnnotationConsentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scopeId: StrictStr
    state: Literal["active", "revoked", "unavailable"]
    policyVersion: StrictStr | None = None


class AnnotationCommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    knowledgeId: StrictStr = Field(min_length=1, max_length=200)
    knowledgeVersion: StrictInt = Field(ge=1)
    planId: StrictStr | None = Field(default=None, max_length=200)
    manualConfirmation: bool = False


class AnnotationCommitResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["published", "noop", "needs_review", "failed"]
    intentId: StrictStr | None = None
    plan: AnnotationPlanResponse
    failureCode: StrictStr | None = None


class AnnotationIntentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intentId: StrictStr
    knowledgeId: StrictStr
    knowledgeVersion: StrictInt = Field(ge=1)
    targetNoteId: StrictStr
    operation: Literal["insert", "update", "noop"]
    status: Literal[
        "pending", "applying", "published", "noop", "needs_review", "failed"
    ]
    attempts: StrictInt = Field(ge=0)
    failureCode: StrictStr | None = None
    createdAt: StrictStr
    updatedAt: StrictStr
