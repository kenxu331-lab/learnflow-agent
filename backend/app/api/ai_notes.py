"""Authenticated AI key-point recommendation endpoint."""

from fastapi import APIRouter, Depends, HTTPException, Request

from app.ai_notes.recommendation import AIRecommendationService
from app.core.auth import require_local_token
from app.core.config import get_settings
from app.llm.errors import LLMProviderError
from app.notes.errors import NoteServiceError
from app.schemas.ai_notes import AIRecommendRequest, AIRecommendResponse

router = APIRouter(prefix="/api/v1/ai/notes", tags=["ai-notes"])
service = AIRecommendationService(get_settings())


def _raise(code: str, message: str, status_code: int) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


@router.post(
    "/recommend",
    response_model=AIRecommendResponse,
    dependencies=[Depends(require_local_token)],
)
async def recommend_notes(
    request: AIRecommendRequest,
    http_request: Request,
) -> AIRecommendResponse:
    try:
        return await service.recommend(
            request,
            request_id=getattr(http_request.state, "request_id", None),
        )
    except (LLMProviderError, NoteServiceError) as error:
        _raise(error.code, error.message, error.status_code)
