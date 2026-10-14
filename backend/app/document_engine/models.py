"""Document AST models used by the deterministic Document Engine V2."""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.page_snapshot import InlineSegment


class SourceBlockMapping(BaseModel):
    """Keep source identity separate from user-visible Markdown."""

    model_config = ConfigDict(extra="forbid")

    source_block_id: str
    stable_key: str | None = None
    content_hash: str | None = None
    outcome: Literal["rendered", "filtered", "unsupported"]
    reason: str | None = None


class QualityIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    severity: Literal["warning", "blocking"]
    code: str
    message: str
    evidence: dict[str, int | str | bool] = Field(default_factory=dict)


class ParagraphNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["paragraph"] = "paragraph"
    text: str
    segments: list[InlineSegment] | None = None
    source_block_ids: list[str] = Field(min_length=1)


class CodeBlockNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["code"] = "code"
    text: str
    language: str | None = None
    variant: str | None = None
    source_block_ids: list[str] = Field(min_length=1)


class ListItemNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    segments: list[InlineSegment] | None = None
    source_block_id: str


class ListBlockNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["list"] = "list"
    items: list[ListItemNode] = Field(min_length=1)


class TableNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["table"] = "table"
    headers: list[str]
    rows: list[list[str]]
    source_block_ids: list[str] = Field(min_length=1)


class ImageNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["image"] = "image"
    src: str
    alt: str
    title: str | None = None
    source_block_ids: list[str] = Field(min_length=1)


class DiagramNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["diagram"] = "diagram"
    format: Literal["svg"] = "svg"
    svg: str
    alt: str
    asset_relative_path: str
    source_block_ids: list[str] = Field(min_length=1)


DocumentNode = Annotated[
    Union[
        "ParagraphNode",
        "CodeBlockNode",
        "ListBlockNode",
        "TableNode",
        "ImageNode",
        "DiagramNode",
        "SectionNode",
        "CalloutNode",
    ],
    Field(discriminator="kind"),
]


class SectionNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["section"] = "section"
    title: str
    original_level: int
    normalized_level: int
    source_block_ids: list[str] = Field(min_length=1)
    children: list[DocumentNode] = Field(default_factory=list)


class CalloutNode(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["callout"] = "callout"
    style: Literal["note", "tip", "warning", "danger", "details"]
    title: str | None = None
    source_callout_id: str
    children: list[DocumentNode] = Field(default_factory=list)


class DocumentDiagnostics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rendered_block_count: int = Field(ge=0)
    filtered_block_count: int = Field(ge=0)
    unsupported_block_count: int = Field(ge=0)
    truncated: bool
    warnings: list[str] = Field(default_factory=list)
    qualityStatus: Literal["ok", "warning", "blocked"] = "ok"
    issues: list[QualityIssue] = Field(default_factory=list)


class DocumentAST(BaseModel):
    """A structured representation that does not depend on Markdown syntax."""

    model_config = ConfigDict(extra="forbid")

    document_title: str
    source_url: str
    page_identity: str
    nodes: list[DocumentNode] = Field(default_factory=list)
    source_block_map: list[SourceBlockMapping] = Field(default_factory=list)
    diagnostics: DocumentDiagnostics


SectionNode.model_rebuild()
CalloutNode.model_rebuild()
