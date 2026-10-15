"""Public, source-bound execution facts; never model chain of thought."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class StudyActivity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal[
        "tool_started",
        "tool_finished",
        "tool_failed",
        "task_completed",
        "task_failed",
        "task_waiting",
        "confirmation_required",
    ]
    eventId: str
    runId: str
    conversationId: str
    sourceUrl: str
    sequence: int
    activityId: str
    createdAt: str
    toolName: str = ""
    summary: str = ""
    error: str = ""
    action: str = ""
