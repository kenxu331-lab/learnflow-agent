"""Stable errors raised by the note service."""


class NoteServiceError(Exception):
    """An expected, user-actionable note service error."""

    def __init__(self, code: str, message: str, status_code: int) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
