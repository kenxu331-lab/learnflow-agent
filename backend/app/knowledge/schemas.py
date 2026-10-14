"""Strict S2-A contracts for drafts, jobs and local APIs."""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    model_validator,
)

KnowledgeKind = Literal[
    "concept",
    "pitfall",
    "explanation",
    "example",
    "user_insight",
]
ClaimKind = Literal[
    "tutorial_fact",
    "technical_explanation",
    "user_interpretation",
]
ClaimVerificationStatus = Literal[
    "evidence_registered",
    "supported",
    "partially_supported",
    "insufficient_evidence",
    "not_supported",
    "verification_unavailable",
    "user_attributed",
    "needs_review",
]
SemanticVerdict = Literal[
    "supported",
    "partially_supported",
    "insufficient_evidence",
    "not_supported",
]
PublishStatus = Literal[
    "not_eligible",
    "eligible",
    "eligible_user_insight",
    "needs_review",
]
EvidenceRelation = Literal["supports", "context_only", "contradicts"]
JobState = Literal[
    "planned",
    "blocked_consent",
    "queued",
    "running",
    "completed",
    "skipped",
    "retryable_failed",
    "needs_review",
]


class EvidenceRefDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidenceIds: list[StrictStr] = Field(min_length=1, max_length=16)
    relation: EvidenceRelation


class AtomicClaimDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    localClaimId: StrictStr = Field(min_length=1, max_length=100)
    text: StrictStr = Field(min_length=1, max_length=2_000)
    kind: ClaimKind
    evidence: list[EvidenceRefDraft] = Field(min_length=1, max_length=16)


class KnowledgeCandidateDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    localKnowledgeId: StrictStr = Field(min_length=1, max_length=100)
    topic: StrictStr | None = Field(default=None, max_length=300)
    kind: KnowledgeKind | None = None
    body: StrictStr | None = Field(default=None, max_length=8_000)
    anchorEvidenceId: StrictStr | None = Field(default=None, max_length=200)
    claims: list[AtomicClaimDraft] = Field(default_factory=list, max_length=8)
    worthExtracting: StrictBool
    skipReason: StrictStr | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def validate_worth_extracting(self) -> KnowledgeCandidateDraft:
        if self.worthExtracting:
            if not self.topic or not self.kind or not self.body or not self.claims:
                raise ValueError(
                    "extractable candidates require topic, kind, body and claims"
                )
            if self.skipReason is not None:
                raise ValueError("extractable candidates must not include skipReason")
        elif self.claims or not self.skipReason:
            raise ValueError("skipped candidates require skipReason and empty claims")
        return self


class ExtractionOutputDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    candidates: list[KnowledgeCandidateDraft] = Field(max_length=12)

    @model_validator(mode="after")
    def validate_unique_local_ids(self) -> ExtractionOutputDraft:
        ids = [candidate.localKnowledgeId for candidate in self.candidates]
        if len(ids) != len(set(ids)):
            raise ValueError("candidate localKnowledgeId values must be unique")
        return self


class VerificationEvidenceInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidenceId: StrictStr
    sourceKind: StrictStr
    relation: EvidenceRelation
    resolvable: StrictBool
    excerpt: StrictStr = Field(min_length=1, max_length=8_000)


class ClaimVerificationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claimId: StrictStr
    claimText: StrictStr = Field(min_length=1, max_length=2_000)
    claimKind: ClaimKind
    evidence: list[VerificationEvidenceInput] = Field(max_length=16)


class ClaimVerificationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claimId: StrictStr
    verdict: SemanticVerdict
    reason: StrictStr = Field(min_length=1, max_length=1_000)


class ClaimVerificationOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    results: list[ClaimVerificationResult] = Field(max_length=8)


class KnowledgeConsentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool
    policyVersion: StrictStr = Field(default="s2-a-v1", min_length=1, max_length=100)


class KnowledgeConsentResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    scopeId: StrictStr
    state: Literal["active", "revoked", "unavailable"]
    policyVersion: StrictStr | None = None


class KnowledgeTriggerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    chapterId: StrictStr = Field(min_length=1, max_length=200)
    conversationId: StrictStr = Field(min_length=1, max_length=200)


class KnowledgeVerifyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    knowledgeId: StrictStr = Field(min_length=1, max_length=200)
    version: StrictInt | None = Field(default=None, ge=1)


class EvidenceRecordResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidenceId: StrictStr
    sourceKind: StrictStr
    sourceBlockId: StrictStr | None = None
    messageId: StrictStr | None = None
    excerpt: StrictStr
    resolvable: StrictBool


class KnowledgeDraftResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    knowledgeId: StrictStr
    version: StrictInt = Field(ge=1)
    chapterId: StrictStr
    topic: StrictStr
    kind: KnowledgeKind
    body: StrictStr
    verificationStatus: ClaimVerificationStatus
    publishStatus: PublishStatus
    evidenceGapReason: StrictStr | None = None
    evidence: list[EvidenceRecordResponse]
    claims: list[KnowledgeClaimResponse] = Field(default_factory=list)


class KnowledgeClaimResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    claimId: StrictStr
    text: StrictStr
    kind: ClaimKind
    verificationStatus: ClaimVerificationStatus
    verificationReason: StrictStr | None = None
    evidenceIds: list[StrictStr]


KnowledgeDraftResponse.model_rebuild()


class PublishCandidateResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    knowledgeId: StrictStr
    knowledgeVersion: StrictInt = Field(ge=1)
    documentId: StrictStr
    chapterId: StrictStr
    sourceUrl: StrictStr
    targetNoteId: StrictStr
    targetRelativePath: StrictStr | None = None
    sourceSnapshotId: StrictStr
    sourceBlockId: StrictStr | None = None
    anchorStableKey: StrictStr | None = None
    headingPath: list[StrictStr]
    anchorFingerprint: StrictStr | None = None
    body: StrictStr
    bodyHash: StrictStr
    kind: KnowledgeKind | None = None
    verificationStatus: Literal["supported", "user_attributed"]
    evidenceIds: list[StrictStr]
    publishStatus: Literal["eligible", "eligible_user_insight"]


class KnowledgeVerificationResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    knowledgeId: StrictStr
    knowledgeVersion: StrictInt = Field(ge=1)
    verificationStatus: ClaimVerificationStatus
    publishStatus: PublishStatus
    claims: list[KnowledgeClaimResponse]
    publishCandidate: PublishCandidateResponse | None = None


class ExtractionJobResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    jobId: StrictStr
    chapterId: StrictStr
    conversationId: StrictStr
    state: JobState
    attemptCount: StrictInt = Field(ge=0)
    lastErrorCode: StrictStr | None = None
    lastErrorMessage: StrictStr | None = None
    updatedAt: datetime


class KnowledgeDebugOutputResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    available: StrictBool
    jobId: StrictStr | None = None
    model: StrictStr
    capturedAt: StrictStr | None = None
    content: StrictStr | None = None
    usage: dict[str, StrictInt] | None = None
    finishReason: StrictStr | None = None
    validationError: StrictStr | None = None


class KnowledgeStatusResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    consent: KnowledgeConsentResponse
    queuedJobCount: StrictInt = Field(ge=0)
    runningJobCount: StrictInt = Field(ge=0)
