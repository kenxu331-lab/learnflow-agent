"""Provider contract for OpenAI-compatible model services."""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class LLMCompletion:
    """Minimal provider result; no prompt or page content is retained."""

    content: str
    finish_reason: str | None
    usage: dict[str, int] | None = None


class LLMProvider(Protocol):
    """Async provider contract that can be replaced by a Fake Provider."""

    model: str

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_output_tokens: int,
    ) -> LLMCompletion:
        """Return one JSON-mode completion without exposing provider details."""

    async def stream_chat(
        self,
        *,
        messages: list[dict[str, str]],
        max_output_tokens: int,
    ) -> AsyncIterator[str]:
        """Yield plain-text chat deltas in provider order."""
