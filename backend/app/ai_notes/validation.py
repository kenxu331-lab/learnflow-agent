"""Business validation for model-produced recommendation objects."""

from app.notes.errors import NoteServiceError
from app.schemas.ai_notes import RecommendationItem, RecommendationPayload
from app.schemas.page_snapshot import PageSnapshot


def validate_and_order_recommendations(
    payload: RecommendationPayload,
    snapshot: PageSnapshot,
    analyzed_block_ids: tuple[str, ...],
) -> list[RecommendationItem]:
    known_ids = {block.id for block in snapshot.blocks}
    analyzed_ids = set(analyzed_block_ids)
    seen: set[str] = set()
    order = {block.id: index for index, block in enumerate(snapshot.blocks)}
    validated: list[RecommendationItem] = []
    for item in payload.recommendations:
        if item.blockId not in known_ids or item.blockId not in analyzed_ids:
            raise NoteServiceError(
                "llm_invalid_response",
                "LLM 推荐结果包含未知或未分析的内容块。",
                502,
            )
        if item.blockId in seen:
            raise NoteServiceError(
                "llm_invalid_response",
                "LLM 推荐结果包含重复内容块。",
                502,
            )
        seen.add(item.blockId)
        if not item.reason.strip():
            raise NoteServiceError(
                "llm_invalid_response",
                "LLM 推荐理由不能为空。",
                502,
            )
        validated.append(item)
    return sorted(validated, key=lambda item: order[item.blockId])
