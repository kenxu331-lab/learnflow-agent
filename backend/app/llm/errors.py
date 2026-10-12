"""Stable errors for model configuration and upstream failures."""


class LLMProviderError(Exception):
    """A safe, user-facing model provider error without upstream details."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
