"""Read-only S3-01 Annotation Planner API."""

from fastapi import APIRouter, Depends, HTTPException

from app.annotation_planner import AnnotationPlanner
from app.annotation_writer import AnnotationWriteService
from app.core.auth import require_local_token
from app.core.config import get_settings
from app.knowledge.errors import KnowledgeServiceError
from app.schemas.annotations import (
    AnnotationCommitRequest,
    AnnotationCommitResponse,
    AnnotationConsentRequest,
    AnnotationConsentResponse,
    AnnotationIntentResponse,
    AnnotationPlanRequest,
    AnnotationPlanResponse,
)

router = APIRouter(prefix="/api/v1/annotations", tags=["annotations"])
planner = AnnotationPlanner(get_settings())
writer = AnnotationWriteService(get_settings())


def _raise(error: KnowledgeServiceError) -> None:
    raise HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


@router.post(
    "/plan",
    response_model=AnnotationPlanResponse,
    dependencies=[Depends(require_local_token)],
)
def create_annotation_plan(request: AnnotationPlanRequest) -> AnnotationPlanResponse:
    return planner.plan(request.candidate)


@router.get(
    "/consent",
    response_model=AnnotationConsentResponse,
    dependencies=[Depends(require_local_token)],
)
def annotation_consent_status() -> AnnotationConsentResponse:
    result = writer.consent_status()
    return AnnotationConsentResponse(
        scopeId=result["scope_id"],
        state=result["state"],
        policyVersion=result["policy_version"],
    )


@router.post(
    "/consent",
    response_model=AnnotationConsentResponse,
    dependencies=[Depends(require_local_token)],
)
def update_annotation_consent(
    request: AnnotationConsentRequest,
) -> AnnotationConsentResponse:
    try:
        result = writer.set_consent(request.enabled, request.policyVersion)
    except KnowledgeServiceError as error:
        _raise(error)
    return AnnotationConsentResponse(
        scopeId=result["scope_id"],
        state=result["state"],
        policyVersion=result["policy_version"],
    )


@router.post(
    "/commit",
    response_model=AnnotationCommitResponse,
    dependencies=[Depends(require_local_token)],
)
def commit_annotation(request: AnnotationCommitRequest) -> AnnotationCommitResponse:
    try:
        return writer.commit(
            request.knowledgeId,
            request.knowledgeVersion,
            manual_confirmation=request.manualConfirmation,
        )
    except KnowledgeServiceError as error:
        _raise(error)


@router.get(
    "/intents",
    response_model=list[AnnotationIntentResponse],
    dependencies=[Depends(require_local_token)],
)
def recent_annotation_intents() -> list[AnnotationIntentResponse]:
    return [
        AnnotationIntentResponse(
            intentId=row["intent_id"],
            knowledgeId=row["knowledge_id"],
            knowledgeVersion=row["knowledge_version"],
            targetNoteId=row["target_note_id"],
            operation=row["operation"],
            status=row["status"],
            attempts=row["attempts"],
            failureCode=row["failure_code"],
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )
        for row in writer.store.recent_annotation_intents()
    ]
