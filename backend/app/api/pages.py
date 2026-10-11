"""Page snapshot ingestion endpoint."""

from uuid import uuid4

from fastapi import APIRouter, Depends, Request

from app.core.auth import require_local_token
from app.schemas.page_snapshot import IngestResponse, PageSnapshot

router = APIRouter(prefix="/api/v1/pages", tags=["pages"])


@router.post(
    "/ingest",
    response_model=IngestResponse,
    dependencies=[Depends(require_local_token)],
    summary="Validate a page snapshot",
)
def ingest_page(snapshot: PageSnapshot, request: Request) -> IngestResponse:
    """Validate a snapshot without persisting or returning its content."""

    request_id = getattr(request.state, "request_id", str(uuid4()))
    return IngestResponse(
        status="validated",
        requestId=request_id,
        schemaVersion=1,
        stats=snapshot.stats,
    )
