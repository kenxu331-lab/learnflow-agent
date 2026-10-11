"""Request and response models for deterministic note preview and commit."""

from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictStr,
    field_validator,
    model_validator,
)

from app.schemas.page_snapshot import PageSnapshot, utf16_length


class NotePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    snapshot: PageSnapshot
    selectedBlockIds: list[StrictStr] = Field(min_length=1, max_length=300)
    personalNote: StrictStr | None = Field(default=None, max_length=20_000)

    @field_validator("personalNote")
    @classmethod
    def validate_personal_note_length(cls, value: str | None) -> str | None:
        if value is not None and utf16_length(value) > 20_000:
            raise ValueError("personalNote is too long")
        return value

    @model_validator(mode="after")
    def validate_selection(self) -> "NotePreviewRequest":
        if any(not block_id.strip() for block_id in self.selectedBlockIds):
            raise ValueError("selectedBlockIds must not contain empty IDs")
        if len(set(self.selectedBlockIds)) != len(self.selectedBlockIds):
            raise ValueError("selectedBlockIds must not contain duplicates")
        snapshot_ids = [block.id for block in self.snapshot.blocks]
        if len(set(snapshot_ids)) != len(snapshot_ids):
            raise ValueError("snapshot blocks must have unique IDs")
        missing = set(self.selectedBlockIds).difference(snapshot_ids)
        if missing:
            raise ValueError("selectedBlockIds contains an unknown block")
        return self


class NotePreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposalId: str
    action: Literal["create", "append", "noop"]
    noteId: str
    targetRelativePath: str
    markdownPreview: str
    diff: str
    expectedRevision: str | None
    expiresAt: str


class NoteCommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposalId: str = Field(min_length=1, max_length=200)


class NoteCommitResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["created", "updated", "unchanged"]
    noteId: str
    targetRelativePath: str
    revision: str
