"""Read-only Document Engine V2 preview endpoint."""

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import require_local_token
from app.core.config import get_settings
from app.document_engine.service import DocumentPreviewService
from app.notes.errors import NoteServiceError
from app.schemas.documents import (
    DocumentCommitRequest,
    DocumentCommitResponse,
    DocumentPreviewRequest,
    DocumentPreviewResponse,
)

router = APIRouter(prefix="/api/v1/documents", tags=["documents"])
service = DocumentPreviewService(get_settings())


def _raise(error: NoteServiceError) -> None:
    raise HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message},
    )


@router.post(
    "/preview",
    response_model=DocumentPreviewResponse,
    dependencies=[Depends(require_local_token)],
)
def preview_document(request: DocumentPreviewRequest) -> DocumentPreviewResponse:
    try:
        proposal, identity, document = service.preview(request.snapshot)
    except NoteServiceError as error:
        _raise(error)
    diagnostics = document.diagnostics
    return DocumentPreviewResponse(
        status="preview",
        schemaVersion=2,
        proposalId=proposal.proposal_id,
        action=proposal.action,
        noteId=identity.note_id,
        targetRelativePath=identity.target_relative_path,
        diff=proposal.diff,
        expectedRevision=proposal.expected_revision,
        expiresAt=proposal.expires_at.isoformat(),
        title=document.document_title,
        sourceUrl=document.source_url,
        markdownPreview=proposal.markdown,
        diagnostics={
            "renderedBlockCount": diagnostics.rendered_block_count,
            "filteredBlockCount": diagnostics.filtered_block_count,
            "unsupportedBlockCount": diagnostics.unsupported_block_count,
            "truncated": diagnostics.truncated,
            "warnings": diagnostics.warnings,
            "qualityStatus": diagnostics.qualityStatus,
            "issues": diagnostics.issues,
        },
    )


@router.post(
    "/commit",
    response_model=DocumentCommitResponse,
    dependencies=[Depends(require_local_token)],
)
def commit_document(request: DocumentCommitRequest) -> DocumentCommitResponse:
    try:
        return DocumentCommitResponse(**service.commit(request.proposalId))
    except NoteServiceError as error:
        _raise(error)
