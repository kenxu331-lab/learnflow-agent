"""S1 Study Agent chat endpoints."""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.core.auth import require_local_token
from app.core.config import get_settings
from app.learning_memory.store import LearningMemoryError
from app.llm.errors import LLMProviderError
from app.schemas.study import StudyChatRequest
from app.study_chat.service import StudyChatError, StudyChatService

router = APIRouter(prefix="/api/v1/study", tags=["study"])
service = StudyChatService(get_settings())


def _raise(code: str, message: str, status_code: int) -> None:
    raise HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message},
    )


@router.post(
    "/chat",
    dependencies=[Depends(require_local_token)],
)
async def study_chat(
    request: StudyChatRequest,
    http_request: Request,
) -> StreamingResponse:
    del http_request
    try:
        stream = await service.start_stream(request)
    except (StudyChatError, LLMProviderError, LearningMemoryError) as error:
        _raise(error.code, error.message, error.status_code)
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get(
    "/conversations/{conversation_id}",
    dependencies=[Depends(require_local_token)],
)
def get_study_conversation(conversation_id: str):
    try:
        return service.conversation(conversation_id)
    except StudyChatError as error:
        _raise(error.code, error.message, error.status_code)
