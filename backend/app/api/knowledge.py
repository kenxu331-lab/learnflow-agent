"""S2-A local APIs for consent, jobs and chapter drafts."""

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import require_local_token
from app.core.config import get_settings
from app.knowledge.errors import KnowledgeServiceError
from app.knowledge.schemas import (
    EvidenceRecordResponse,
    ExtractionJobResponse,
    KnowledgeClaimResponse,
    KnowledgeConsentRequest,
    KnowledgeConsentResponse,
    KnowledgeDebugOutputResponse,
    KnowledgeDraftResponse,
    KnowledgeStatusResponse,
    KnowledgeTriggerRequest,
    KnowledgeVerificationResponse,
    KnowledgeVerifyRequest,
    PublishCandidateResponse,
)
from app.knowledge.service import KnowledgeService

router = APIRouter(prefix="/api/v1/knowledge", tags=["knowledge"])
service = KnowledgeService(get_settings())


def _raise(error: KnowledgeServiceError) -> None:
    raise HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


@router.get("/status", dependencies=[Depends(require_local_token)])
def knowledge_status() -> KnowledgeStatusResponse:
    consent, queued, running = service.status()
    return KnowledgeStatusResponse(
        consent=KnowledgeConsentResponse(
            scopeId=consent["scope_id"],
            state=consent["state"],
            policyVersion=consent["policy_version"],
        ),
        queuedJobCount=queued,
        runningJobCount=running,
    )


@router.post("/consent", dependencies=[Depends(require_local_token)])
def update_consent(request: KnowledgeConsentRequest) -> KnowledgeConsentResponse:
    try:
        result = service.set_consent(request.enabled, request.policyVersion)
    except KnowledgeServiceError as error:
        _raise(error)
    return KnowledgeConsentResponse(
        scopeId=result["scope_id"],
        state=result["state"],
        policyVersion=result["policy_version"],
    )


@router.post("/trigger", dependencies=[Depends(require_local_token)])
def trigger_extraction(request: KnowledgeTriggerRequest) -> dict[str, int | str]:
    return service.trigger(request.chapterId, request.conversationId)


@router.get(
    "/chapters/{chapter_id}/drafts",
    dependencies=[Depends(require_local_token)],
)
def chapter_drafts(chapter_id: str) -> list[KnowledgeDraftResponse]:
    drafts = []
    for row in service.store.list_drafts(chapter_id):
        evidence_rows = service.store.connection.execute(
            """
            SELECT DISTINCT er.* FROM evidence_records er
            JOIN claim_evidence ce ON ce.scope_id = er.scope_id
                                  AND ce.evidence_id = er.evidence_id
            JOIN atomic_claims ac ON ac.scope_id = ce.scope_id
                                AND ac.claim_id = ce.claim_id
            WHERE ac.knowledge_id = ? AND ac.knowledge_version = ?
            ORDER BY er.evidence_id
            """,
            (row["knowledge_id"], row["active_version"]),
        ).fetchall()
        drafts.append(
            KnowledgeDraftResponse(
                knowledgeId=row["knowledge_id"],
                version=row["active_version"],
                chapterId=row["chapter_id"],
                topic=row["topic"],
                kind=row["kind"],
                body=row["body"],
                verificationStatus="evidence_registered",
                publishStatus=row["version_publish_status"],
                evidenceGapReason=row["evidence_gap_reason"],
                evidence=[
                    EvidenceRecordResponse(
                        evidenceId=evidence["evidence_id"],
                        sourceKind=evidence["source_kind"],
                        sourceBlockId=evidence["source_block_id"],
                        messageId=evidence["message_id"],
                        excerpt=evidence["excerpt"],
                        resolvable=bool(evidence["resolvable"]),
                    )
                    for evidence in evidence_rows
                ],
                claims=[
                    KnowledgeClaimResponse(
                        claimId=claim["claim_id"],
                        text=claim["claim_text"],
                        kind=claim["claim_kind"],
                        verificationStatus=claim["verification_status"],
                        verificationReason=claim["verification_reason"],
                        evidenceIds=[
                            row["evidence_id"]
                            for row in service.store.connection.execute(
                                """
                                SELECT evidence_id FROM claim_evidence
                                WHERE scope_id = ? AND claim_id = ?
                                ORDER BY evidence_id
                                """,
                                (claim["scope_id"], claim["claim_id"]),
                            ).fetchall()
                        ],
                    )
                    for claim in service.store.connection.execute(
                        """
                        SELECT * FROM atomic_claims
                        WHERE knowledge_id = ? AND knowledge_version = ?
                        ORDER BY claim_id
                        """,
                        (row["knowledge_id"], row["active_version"]),
                    ).fetchall()
                ],
            )
        )
    return drafts


@router.get("/jobs", dependencies=[Depends(require_local_token)])
def knowledge_jobs() -> list[ExtractionJobResponse]:
    return [
        ExtractionJobResponse(
            jobId=row["job_id"],
            chapterId=row["chapter_id"],
            conversationId=row["conversation_id"],
            state=row["state"],
            attemptCount=row["attempt_count"],
            lastErrorCode=row["last_error_code"],
            lastErrorMessage=row["last_error_message"],
            updatedAt=row["updated_at"],
        )
        for row in service.store.list_jobs()
    ]


@router.post("/verify", dependencies=[Depends(require_local_token)])
async def verify_knowledge(
    request: KnowledgeVerifyRequest,
) -> KnowledgeVerificationResponse:
    try:
        result = await service.verify_knowledge(request.knowledgeId, request.version)
    except KnowledgeServiceError as error:
        _raise(error)
    return KnowledgeVerificationResponse.model_validate(result)


@router.get(
    "/publish-candidates",
    response_model=list[PublishCandidateResponse],
    dependencies=[Depends(require_local_token)],
)
def publish_candidates() -> list[PublishCandidateResponse]:
    return [
        PublishCandidateResponse.model_validate(candidate)
        for candidate in service.list_publish_candidates()
    ]


@router.get(
    "/debug/latest-output",
    response_model=KnowledgeDebugOutputResponse,
    dependencies=[Depends(require_local_token)],
)
def latest_debug_output() -> KnowledgeDebugOutputResponse:
    result = service.debug_latest_output()
    return KnowledgeDebugOutputResponse(
        available=result["available"],
        jobId=result["job_id"],
        model=result["model"],
        capturedAt=result["captured_at"],
        content=result["content"],
        usage=result["usage"],
        finishReason=result["finish_reason"],
        validationError=result["validation_error"],
    )
