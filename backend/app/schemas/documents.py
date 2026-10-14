"""HTTP schemas for read-only Document Engine V2 previews."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.document_engine.models import QualityIssue
from app.schemas.page_snapshot import PageSnapshot


class DocumentPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    snapshot: PageSnapshot


class DocumentPreviewDiagnostics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    renderedBlockCount: int = Field(ge=0)
    filteredBlockCount: int = Field(ge=0)
    unsupportedBlockCount: int = Field(ge=0)
    truncated: bool
    warnings: list[str]
    qualityStatus: Literal["ok", "warning", "blocked"]
    issues: list[QualityIssue]


class DocumentPreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["preview"]
    schemaVersion: Literal[2]
    proposalId: str
    action: Literal["create", "replace", "noop"]
    noteId: str
    targetRelativePath: str
    diff: str
    expectedRevision: str | None
    expiresAt: str
    title: str
    sourceUrl: str
    markdownPreview: str
    diagnostics: DocumentPreviewDiagnostics


class DocumentCommitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposalId: str = Field(min_length=1, max_length=200)


class DocumentCommitResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: Literal["created", "updated", "unchanged"]
    noteId: str
    targetRelativePath: str
    revision: str
