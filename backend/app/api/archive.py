"""Human-only approval endpoints. No LLM tool is registered for decisions."""

from fastapi import APIRouter, Depends, HTTPException

from app.api.study import service
from app.core.auth import require_local_token
from app.knowledge.errors import KnowledgeServiceError
from app.notes.errors import NoteServiceError
from app.schemas.archive import (
    ArchiveDecisionRequest,
    ArchivePrepareRequest,
    ArchiveSelectionRequest,
)

router = APIRouter(
    prefix="/api/v1/study/archive",
    tags=["archive"],
    dependencies=[Depends(require_local_token)],
)


def invoke(operation):
    try:
        return operation()
    except (KnowledgeServiceError, NoteServiceError) as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": error.code, "message": error.message},
        ) from error


@router.post("/selection")
def select_knowledge(request: ArchiveSelectionRequest):
    return invoke(
        lambda: service.archive.select(request.conversationId, request.references)
    )


@router.post("/prepare")
def prepare_archive(request: ArchivePrepareRequest):
    return invoke(
        lambda: service.archive.prepare(request.conversationId, request.references)
    )


@router.get("/{confirmation_id}")
def get_archive(confirmation_id: str, conversationId: str):
    return invoke(lambda: service.archive.get(confirmation_id, conversationId))


@router.post("/{confirmation_id}/decision")
def decide_archive(confirmation_id: str, request: ArchiveDecisionRequest):
    return invoke(
        lambda: service.archive.decision(
            confirmation_id,
            request.conversationId,
            request.planDigest,
            request.decision,
        )
    )
