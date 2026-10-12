"""Provider contract for OpenAI-compatible model services."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class LLMCompletion:
    """Minimal provider result; no prompt or page content is retained."""

    content: str
    finish_reason: str | None
    usage: dict[str, int] | None = None


class LLMProvider(Protocol):
    """Async JSON completion contract that can be replaced by a Fake Provider."""

    model: str

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        max_output_tokens: int,
    ) -> LLMCompletion:
        """Return one JSON-mode completion without exposing provider details."""
