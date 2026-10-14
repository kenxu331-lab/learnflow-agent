"""Stable source URL to note identity and controlled relative path mapping."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from urllib.parse import unquote, urlsplit, urlunsplit

from app.notes.errors import NoteServiceError


@dataclass(frozen=True)
class NoteIdentity:
    normalized_url: str
    chapter_id: str
    note_id: str
    target_relative_path: str
    legacy_target_relative_path: str


_INVALID_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_RESERVED_NAMES = {
    "CON",
    "PRN",
    "AUX",
    "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}


def _safe_segment(value: str, fallback: str) -> str:
    cleaned = _INVALID_FILENAME.sub("_", value).strip(" .")
    cleaned = re.sub(r"\s+", "-", cleaned)
    if not cleaned or cleaned.upper() in _RESERVED_NAMES:
        return fallback
    return cleaned[:80]


def _title_segment(title: str | None) -> str | None:
    if not title:
        return None
    cleaned = re.sub(r"(?:\s*¶)+\s*$", "", title).strip()
    if not cleaned:
        return None
    candidate = _safe_segment(cleaned, "")
    return candidate or None


def normalize_source_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        if parsed.scheme.lower() not in {"http", "https"} or not hostname:
            raise ValueError
        hostname = hostname.encode("idna").decode("ascii").lower()
        port = parsed.port
    except (UnicodeError, ValueError) as exc:
        raise NoteServiceError(
            "invalid_source_url",
            "PageSnapshot 来源 URL 必须是有效的 HTTP 或 HTTPS 地址。",
            422,
        ) from exc

    default_port = (parsed.scheme.lower() == "http" and port == 80) or (
        parsed.scheme.lower() == "https" and port == 443
    )
    host = hostname
    if ":" in hostname and not hostname.startswith("["):
        host = f"[{hostname}]"
    if port and not default_port:
        host = f"{host}:{port}"
    path = parsed.path or "/"
    return urlunsplit((parsed.scheme.lower(), host, path, parsed.query, ""))


class NoteResolver:
    """Resolve a validated source URL to a stable, safe LearnFlow path."""

    def resolve(self, url: str, title: str | None = None) -> NoteIdentity:
        normalized = normalize_source_url(url)
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
        parsed = urlsplit(normalized)
        host = _safe_segment(parsed.hostname or "unknown-host", "unknown-host")
        path_part = unquote(parsed.path).strip("/").split("/")[-1]
        slug = _safe_segment(path_part or "index", "index")
        if parsed.query:
            slug = _safe_segment(f"{slug}-query", slug)
        short_hash = digest[:20]
        legacy_path = f"LearnFlow/{host}/{slug}--{short_hash}.md"
        filename = _title_segment(title) or slug
        return NoteIdentity(
            normalized_url=normalized,
            chapter_id=f"chapter-{digest[:32]}",
            note_id=f"learnflow-{digest[:32]}",
            target_relative_path=f"LearnFlow/{host}/{filename}.md",
            legacy_target_relative_path=legacy_path,
        )

    @staticmethod
    def collision_target(identity: NoteIdentity) -> str:
        path = identity.target_relative_path
        if path.endswith(".md"):
            path = path[:-3]
        digest = hashlib.sha256(identity.normalized_url.encode("utf-8")).hexdigest()
        return f"{path}--{digest[:20]}.md"

    @staticmethod
    def content_matches_identity(text: str, identity: NoteIdentity) -> bool:
        return any(
            marker in text
            for marker in (
                f'learnflow_id: "{identity.note_id}"',
                f'source_url: "{identity.normalized_url}"',
                f"来源：<{identity.normalized_url}>",
            )
        )
