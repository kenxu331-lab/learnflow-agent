"""Stable S2 error types."""


class KnowledgeServiceError(Exception):
    """Safe local errors for S2 APIs and workers."""

    def __init__(self, code: str, message: str, status_code: int = 409) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
