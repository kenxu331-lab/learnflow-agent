"""Preview and commit endpoints for deterministic Markdown notes."""

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import require_local_token
from app.core.config import get_settings
from app.notes.errors import NoteServiceError
from app.notes.service import MarkdownNoteService
from app.schemas.notes import (
    NoteCommitRequest,
    NoteCommitResponse,
    NotePreviewRequest,
    NotePreviewResponse,
)

router = APIRouter(prefix="/api/v1/notes", tags=["notes"])
service = MarkdownNoteService(get_settings())


def _raise(error: NoteServiceError) -> None:
    raise HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


@router.post(
    "/preview",
    response_model=NotePreviewResponse,
    dependencies=[Depends(require_local_token)],
)
def preview_note(request: NotePreviewRequest) -> NotePreviewResponse:
    try:
        proposal, identity = service.preview(request)
    except NoteServiceError as error:
        _raise(error)
    return NotePreviewResponse(
        proposalId=proposal.proposal_id,
        action=proposal.action,
        noteId=identity.note_id,
        targetRelativePath=identity.target_relative_path,
        markdownPreview=proposal.markdown,
        diff=proposal.diff,
        expectedRevision=proposal.expected_revision,
        expiresAt=proposal.expires_at.isoformat(),
    )


@router.post(
    "/commit",
    response_model=NoteCommitResponse,
    dependencies=[Depends(require_local_token)],
)
def commit_note(request: NoteCommitRequest) -> NoteCommitResponse:
    try:
        result = service.commit(request.proposalId)
    except NoteServiceError as error:
        _raise(error)
    return NoteCommitResponse(**result)
