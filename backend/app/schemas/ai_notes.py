"""Strict API contracts for AI key-point recommendations."""

from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from app.schemas.page_snapshot import PageSnapshot, utf16_length

MAX_LEARNING_GOAL_CHARACTERS = 2_000
MAX_RECOMMENDATIONS = 12


class RecommendationItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    blockId: StrictStr = Field(min_length=1, max_length=200)
    category: Literal[
        "core_concept",
        "code_example",
        "important_detail",
        "pitfall",
    ]
    reason: StrictStr = Field(min_length=1, max_length=500)


class RecommendationPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    recommendations: list[RecommendationItem] = Field(max_length=MAX_RECOMMENDATIONS)


class AIRecommendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    snapshot: PageSnapshot
    learningGoal: StrictStr | None = Field(
        default=None,
        max_length=MAX_LEARNING_GOAL_CHARACTERS,
    )

    @field_validator("learningGoal")
    @classmethod
    def validate_learning_goal_length(cls, value: str | None) -> str | None:
        if value is not None and utf16_length(value) > MAX_LEARNING_GOAL_CHARACTERS:
            raise ValueError("learningGoal is too long")
        return value

    @model_validator(mode="after")
    def validate_unique_block_ids(self) -> "AIRecommendRequest":
        block_ids = [block.id for block in self.snapshot.blocks]
        if len(block_ids) != len(set(block_ids)):
            raise ValueError("snapshot blocks must have unique IDs")
        return self


class RecommendationAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    model: StrictStr
    analyzedBlockCount: StrictInt = Field(ge=0)
    truncated: StrictBool


class AIRecommendResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    recommendations: list[RecommendationItem] = Field(max_length=MAX_RECOMMENDATIONS)
    analysis: RecommendationAnalysis
