"""Contracts for S1 Study Chat and the future Learning Memory extractor."""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictStr,
    model_validator,
)

from app.schemas.activity import StudyActivity
from app.schemas.archive import ArchiveConfirmationView, KnowledgeReference
from app.schemas.knowledge_view import KnowledgeTaskView
from app.schemas.page_snapshot import PageSnapshot

MAX_CONVERSATION_ID = 200
MAX_SESSION_ID = 200
MAX_DOCUMENT_ID = 300
MAX_PAGE_TITLE = 500
MAX_HEADING_DEPTH = 20
MAX_HEADING_LENGTH = 300
MAX_SOURCE_NODE_ID = 300
MAX_SOURCE_FINGERPRINT = 200
MAX_SELECTED_TEXT = 12_000
MAX_QUESTION = 4_000
MAX_MESSAGE = 40_000


class StudyChatRequest(BaseModel):
    """A user question bound to one captured chapter and one conversation."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    conversationId: StrictStr = Field(min_length=1, max_length=MAX_CONVERSATION_ID)
    sessionId: StrictStr = Field(min_length=1, max_length=MAX_SESSION_ID)
    documentId: StrictStr | None = Field(default=None, max_length=MAX_DOCUMENT_ID)
    sourceUrl: StrictStr = Field(min_length=1, max_length=2_048)
    pageTitle: StrictStr = Field(min_length=1, max_length=MAX_PAGE_TITLE)
    headingPath: list[StrictStr] = Field(
        default_factory=list, max_length=MAX_HEADING_DEPTH
    )
    sourceNodeId: StrictStr | None = Field(default=None, max_length=MAX_SOURCE_NODE_ID)
    sourceFingerprint: StrictStr | None = Field(
        default=None, max_length=MAX_SOURCE_FINGERPRINT
    )
    selectedText: StrictStr | None = Field(default=None, max_length=MAX_SELECTED_TEXT)
    question: StrictStr = Field(min_length=1, max_length=MAX_QUESTION)
    cloudConsent: StrictBool
    readonlyAgent: StrictBool = False
    knowledgeTools: StrictBool = False
    archiveTools: StrictBool = False
    snapshot: PageSnapshot

    @model_validator(mode="after")
    def validate_source(self) -> StudyChatRequest:
        if self.knowledgeTools and not self.readonlyAgent:
            raise ValueError("knowledgeTools requires Agent mode")
        if self.archiveTools and not self.knowledgeTools:
            raise ValueError("archiveTools requires knowledgeTools")
        parsed = urlsplit(self.sourceUrl)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("sourceUrl must use HTTP or HTTPS")
        snapshot_url = urlsplit(self.snapshot.url)
        if (parsed.scheme, parsed.netloc, parsed.path, parsed.query) != (
            snapshot_url.scheme,
            snapshot_url.netloc,
            snapshot_url.path,
            snapshot_url.query,
        ):
            raise ValueError("sourceUrl must match snapshot.url")
        if not self.question.strip():
            raise ValueError("question must not be blank")
        if self.selectedText is not None and not self.selectedText.strip():
            self.selectedText = None
        return self


class StudySource(BaseModel):
    """Stable source metadata retained beside a message or selection."""

    model_config = ConfigDict(extra="forbid")

    sourceUrl: StrictStr
    headingPath: list[StrictStr] = Field(default_factory=list)
    sourceNodeId: StrictStr | None = None
    sourceFingerprint: StrictStr | None = None


class StudyMessage(BaseModel):
    """A persisted message; fields are intentionally usable by S2 Extractor."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    messageId: StrictStr
    role: Literal["user", "assistant"]
    content: StrictStr = Field(max_length=MAX_MESSAGE)
    selectedText: StrictStr | None = None
    source: StudySource | None = None
    origin: Literal["user", "ai"]
    createdAt: datetime
    activities: list[StudyActivity] = Field(default_factory=list)
    knowledge: KnowledgeTaskView | None = None
    archiveConfirmations: list[ArchiveConfirmationView] = Field(default_factory=list)


class StudyConversationResponse(BaseModel):
    """Conversation restoration payload for a chapter switch."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    conversationId: StrictStr
    sessionId: StrictStr
    documentId: StrictStr | None = None
    sourceUrl: StrictStr
    pageTitle: StrictStr
    messages: list[StudyMessage]
    selectedKnowledge: list[KnowledgeReference] = Field(default_factory=list)


class StudyChatComplete(BaseModel):
    """Final SSE event for one completed assistant message."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1] = 1
    conversationId: StrictStr
    message: StudyMessage
