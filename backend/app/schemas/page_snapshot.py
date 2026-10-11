"""Pydantic v2 models for the extension PageSnapshot contract."""

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


def utf16_length(value: str) -> int:
    """Match JavaScript String.length (UTF-16 code units)."""

    return len(value.encode("utf-16-le", errors="surrogatepass")) // 2


class ContentBlock(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: StrictStr = Field(min_length=1, max_length=200)
    stableKey: StrictStr | None = Field(default=None, min_length=1, max_length=200)
    type: Literal["heading", "paragraph", "code", "list"]
    text: StrictStr
    level: StrictInt | None = Field(default=None, ge=1, le=6)
    language: StrictStr | None = None


class ExtractionMetadata(BaseModel):
    model_config = ConfigDict(extra="forbid")

    strategy: Literal["article", "main", "fallback"]
    truncated: StrictBool
    warnings: list[StrictStr]


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
    def validate_stats(self) -> "PageSnapshot":
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
