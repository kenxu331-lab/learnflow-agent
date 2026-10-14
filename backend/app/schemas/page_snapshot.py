"""Pydantic v2 models for the extension PageSnapshot contract."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

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

MAX_BLOCKS = 300
MAX_CHARACTERS = 60_000
MAX_CODE_CHARACTERS = 12_000
MAX_IMAGE_URL_LENGTH = 2_048
MAX_IMAGE_ALT_LENGTH = 500
MAX_DIAGRAM_SVG_LENGTH = 200_000


def utf16_length(value: str) -> int:
    """Match JavaScript String.length (UTF-16 code units)."""

    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


class ImageData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    src: StrictStr = Field(min_length=1, max_length=MAX_IMAGE_URL_LENGTH)
    alt: StrictStr = Field(default="", max_length=MAX_IMAGE_ALT_LENGTH)
    title: StrictStr | None = Field(default=None, max_length=MAX_IMAGE_ALT_LENGTH)

    @field_validator("src")
    @classmethod
    def validate_src(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("image src must use HTTP or HTTPS")
        return value


class DiagramData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["svg"]
    svg: StrictStr = Field(min_length=20, max_length=MAX_DIAGRAM_SVG_LENGTH)
    alt: StrictStr = Field(default="Mermaid diagram", max_length=MAX_IMAGE_ALT_LENGTH)

    @field_validator("svg")
    @classmethod
    def validate_svg(cls, value: str) -> str:
        if not re.match(r"^\s*<svg(?:\s|>)", value, re.IGNORECASE):
            raise ValueError("diagram svg must start with an SVG element")
        if re.search(r"<\s*script\b|\bon[a-z]+\s*=|javascript:", value, re.IGNORECASE):
            raise ValueError("diagram svg contains executable content")
        return value


class ContentBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: StrictStr = Field(min_length=1, max_length=200)
    stableKey: StrictStr | None = Field(default=None, min_length=1, max_length=200)
    type: Literal[
        "heading",
        "paragraph",
        "code",
        "list",
        "table",
        "image",
        "diagram",
    ]
    text: StrictStr
    level: StrictInt | None = Field(default=None, ge=1, le=6)
    language: StrictStr | None = None
    variant: StrictStr | None = None
    inline: list[InlineSegment] | None = None
    callout: CalloutMetadata | None = None
    table: TableData | None = None
    image: ImageData | None = None
    diagram: DiagramData | None = None


class InlineSegment(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["text", "code", "link"]
    text: StrictStr
    url: StrictStr | None = None


class CalloutMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: StrictStr = Field(min_length=1, max_length=200)
    kind: Literal["note", "tip", "warning", "danger", "details"]
    title: StrictStr | None = None


class TableData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    headers: list[StrictStr]
    rows: list[list[StrictStr]]


ContentBlock.model_rebuild()


class ExtractionMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    strategy: Literal["article", "main", "fallback"]
    truncated: StrictBool
    warnings: list[StrictStr]
    structure: ExtractionStructure | None = None


class ExtractionStructure(BaseModel):
    model_config = ConfigDict(extra="forbid")

    parserVersion: StrictStr
    rootKind: Literal["article", "main", "fallback"]
    headingCount: StrictInt = Field(ge=0)
    paragraphCount: StrictInt = Field(ge=0)
    codeBlockCount: StrictInt = Field(ge=0)
    listItemCount: StrictInt = Field(ge=0)
    tableCount: StrictInt = Field(ge=0)
    imageCount: StrictInt = Field(ge=0)
    calloutCount: StrictInt = Field(ge=0)
    linkCount: StrictInt = Field(ge=0)


ExtractionMetadata.model_rebuild()


class SnapshotStats(BaseModel):
    model_config = ConfigDict(extra="forbid")

    characterCount: StrictInt = Field(ge=0)
    codeBlockCount: StrictInt = Field(ge=0)
    blockCount: StrictInt = Field(ge=0)


class PageSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    url: StrictStr
    title: StrictStr = Field(min_length=1)
    contentTitle: StrictStr | None = Field(default=None, min_length=1)
    capturedAt: datetime
    blocks: list[ContentBlock] = Field(max_length=MAX_BLOCKS)
    extraction: ExtractionMetadata
    stats: SnapshotStats

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("url must use HTTP or HTTPS")
        return value

    @model_validator(mode="after")
    def validate_stats(self) -> PageSnapshot:
        character_count = sum(utf16_length(block.text) for block in self.blocks)
        code_block_count = sum(block.type == "code" for block in self.blocks)

        if character_count > MAX_CHARACTERS:
            raise ValueError("characterCount exceeds the maximum")
        if any(
            block.type == "code" and utf16_length(block.text) > MAX_CODE_CHARACTERS
            for block in self.blocks
        ):
            raise ValueError("a code block exceeds the maximum")
        if self.stats.characterCount != character_count:
            raise ValueError("stats.characterCount does not match blocks")
        if self.stats.codeBlockCount != code_block_count:
            raise ValueError("stats.codeBlockCount does not match blocks")
        if self.stats.blockCount != len(self.blocks):
            raise ValueError("stats.blockCount does not match blocks")
        return self


class IngestResponse(BaseModel):
    status: Literal["validated"]
    requestId: str
    schemaVersion: Literal[1]
    stats: SnapshotStats
