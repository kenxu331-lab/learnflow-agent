"""AI recommendation orchestration without note or Vault writes."""

from __future__ import annotations

import json
import logging
import time

from pydantic import ValidationError

from app.ai_notes.context import build_recommendation_context
from app.ai_notes.prompt import build_recommendation_prompt
from app.ai_notes.validation import validate_and_order_recommendations
from app.core.config import Settings
from app.llm.base import LLMProvider
from app.llm.errors import LLMProviderError
from app.llm.openai_compatible import OpenAICompatibleProvider
from app.notes.errors import NoteServiceError
from app.schemas.ai_notes import (
    AIRecommendRequest,
    AIRecommendResponse,
    RecommendationAnalysis,
    RecommendationPayload,
)

logger = logging.getLogger(__name__)


class AIRecommendationService:
    def __init__(self, settings: Settings, provider: LLMProvider | None = None) -> None:
        self.settings = settings
        self.provider = provider or OpenAICompatibleProvider(settings)

    async def recommend(
        self,
        request: AIRecommendRequest,
        *,
        request_id: str | None = None,
    ) -> AIRecommendResponse:
        started = time.perf_counter()
        context = build_recommendation_context(request.snapshot, self.settings)
        system_prompt, user_prompt = build_recommendation_prompt(
            request.snapshot,
            context,
            request.learningGoal,
        )
        try:
            completion = await self.provider.complete_json(
                system_prompt=system_prompt,
                user_prompt=user_prompt,
                max_output_tokens=self.settings.llm_max_output_tokens,
            )
        except LLMProviderError:
            raise
        if completion.finish_reason == "length":
            raise NoteServiceError(
                "llm_output_truncated",
                "LLM 输出被截断，请减少页面内容后重试。",
                502,
            )
        try:
            parsed = json.loads(completion.content)
            payload = RecommendationPayload.model_validate(parsed)
        except (json.JSONDecodeError, TypeError, ValidationError) as error:
            raise NoteServiceError(
                "llm_invalid_response",
                "LLM 返回格式无法通过校验。",
                502,
            ) from error

        recommendations = validate_and_order_recommendations(
            payload,
            request.snapshot,
            context.analyzed_block_ids,
        )
        logger.info(
            "ai_recommendation_completed",
            extra={
                "request_id": request_id,
                "model": self.provider.model,
                "duration_ms": round((time.perf_counter() - started) * 1000),
                "analyzed_block_count": len(context.analyzed_block_ids),
                "recommendation_count": len(recommendations),
                "truncated": context.truncated,
                "usage": completion.usage,
            },
        )
        return AIRecommendResponse(
            schemaVersion=1,
            recommendations=recommendations,
            analysis=RecommendationAnalysis(
                model=self.provider.model,
                analyzedBlockCount=len(context.analyzed_block_ids),
                truncated=context.truncated,
            ),
        )
