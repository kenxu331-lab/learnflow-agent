"""Deterministic Obsidian Markdown rendering and controlled-region merging."""

from __future__ import annotations

import difflib
import hashlib
import json
import re
from datetime import datetime
from urllib.parse import quote

from app.notes.errors import NoteServiceError
from app.notes.resolver import NoteIdentity
from app.schemas.page_snapshot import ContentBlock, PageSnapshot

CONTROLLED_BEGIN = "<!-- LEARNFLOW_CONTROLLED_BEGIN -->"
CONTROLLED_END = "<!-- LEARNFLOW_CONTROLLED_END -->"
PERSONAL_BEGIN = "<!-- LEARNFLOW_PERSONAL_BEGIN -->"
PERSONAL_END = "<!-- LEARNFLOW_PERSONAL_END -->"
BLOCK_MARKER = re.compile(
    r"<!-- LF_BLOCK id=(?P<id>[^ ]+) fingerprint=(?P<fingerprint>[0-9a-f]+) -->"
)
PERSONAL_NOTE_MARKER = re.compile(
    r"<!-- LF_PERSONAL_NOTE fingerprint=(?P<fingerprint>[0-9a-f]+) -->"
)
STABLE_KEY_OCCURRENCE = re.compile(r"^v1-[0-9a-f]{16}-(?P<occurrence>[0-9]+)$")
LEGACY_BLOCK_ID = re.compile(r"^block-[1-9][0-9]*$")


def _quote(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _escape_control_markers(value: str) -> str:
    escaped = value.replace("<!-- LEARNFLOW_", "<!-- LEARNFLOW_ESCAPED_")
    escaped = escaped.replace("<!-- LF_BLOCK", "<!-- LF_BLOCK_ESCAPED")
    return escaped.replace("<!-- LF_PERSONAL_NOTE", "<!-- LF_PERSONAL_NOTE_ESCAPED")


def _fingerprint(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def _block_marker(block: ContentBlock) -> str:
    identity = quote(block.stableKey or block.id, safe="-_.~")
    return f"<!-- LF_BLOCK id={identity} fingerprint={_fingerprint(block.text)} -->"


def _block_key(block: ContentBlock) -> tuple[str, str]:
    return quote(block.stableKey or block.id, safe="-_.~"), _fingerprint(block.text)


def _stable_occurrence(stable_key: str) -> int | None:
    match = STABLE_KEY_OCCURRENCE.fullmatch(stable_key)
    return int(match.group("occurrence")) if match else None


def _normalize_line_endings(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _render_personal_note(value: str, newline: str = "\n") -> str:
    normalized = _normalize_line_endings(_escape_control_markers(value))
    record = (
        "### Personal note\n"
        f"<!-- LF_PERSONAL_NOTE fingerprint={_fingerprint(value)} -->\n"
        f"{normalized}"
    )
    return record.replace("\n", newline)


def _personal_note_is_present(personal_body: str, personal_note: str) -> bool:
    fingerprint = _fingerprint(personal_note)
    if any(
        match.group("fingerprint") == fingerprint
        for match in PERSONAL_NOTE_MARKER.finditer(personal_body)
    ):
        return True

    # Compatibility with notes written before personal records had markers.
    legacy_body = _normalize_line_endings(personal_body).strip("\n")
    legacy_note = _normalize_line_endings(_escape_control_markers(personal_note))
    return bool(legacy_body) and legacy_body == legacy_note


def _append_personal_note(personal_body: str, personal_note: str) -> str:
    newline = "\r\n" if "\r\n" in personal_body else "\n"
    record = _render_personal_note(personal_note, newline)
    if not personal_body:
        return newline + record + newline
    prefix = personal_body
    if not prefix.endswith(("\n", "\r")):
        prefix += newline
    return prefix + record + newline


def _code_fence(text: str) -> str:
    longest = max((len(run) for run in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def render_block(block: ContentBlock) -> str:
    text = _escape_control_markers(block.text)
    marker = _block_marker(block)
    if block.type == "heading":
        level = block.level or 2
        body = f"{'#' * level} {text}"
    elif block.type == "code":
        fence = _code_fence(text)
        language = re.sub(r"[\r\n`]", "", block.language or "").strip()[:64]
        body = f"{fence}{language}\n{text}\n{fence}"
    elif block.type == "list":
        body = f"- {text}"
    else:
        body = text
    return f"{marker}\n{body}"


def _section(text: str, begin: str, end: str) -> tuple[str, str, str]:
    if text.count(begin) != 1 or text.count(end) != 1:
        raise NoteServiceError(
            "note_structure_invalid",
            "LearnFlow 受控区域标记损坏。",
            409,
        )
    begin_index = text.index(begin)
    end_index = text.index(end)
    if end_index < begin_index:
        raise NoteServiceError(
            "note_structure_invalid",
            "LearnFlow 受控区域顺序无效。",
            409,
        )
    content_start = begin_index + len(begin)
    return text[:content_start], text[content_start:end_index], text[end_index:]


def _frontmatter_value(text: str, key: str) -> str | None:
    match = re.search(
        rf"(?m)^{re.escape(key)}:\s*(['\"]?)([^'\"\r\n]+)\1\s*$",
        text,
    )
    return match.group(2) if match else None


def _validate_managed_document(text: str, identity: NoteIdentity) -> None:
    if (
        not (text.startswith("---\n") or text.startswith("---\r\n"))
        or _frontmatter_value(text, "learnflow_id") != identity.note_id
    ):
        raise NoteServiceError(
            "note_not_managed",
            "目标文件不是由 LearnFlow 管理，拒绝覆盖。",
            409,
        )
    _section(text, CONTROLLED_BEGIN, CONTROLLED_END)
    _section(text, PERSONAL_BEGIN, PERSONAL_END)
    if text.index(CONTROLLED_BEGIN) > text.index(PERSONAL_BEGIN):
        raise NoteServiceError(
            "note_structure_invalid",
            "LearnFlow 受控区域顺序无效。",
            409,
        )


def build_new_document(
    identity: NoteIdentity,
    snapshot: PageSnapshot,
    blocks: list[ContentBlock],
    personal_note: str | None,
    now: datetime,
) -> str:
    rendered_blocks = "\n\n".join(render_block(block) for block in blocks)
    note = _render_personal_note(personal_note) if personal_note else ""
    frontmatter = "\n".join(
        [
            "---",
            f"learnflow_id: {_quote(identity.note_id)}",
            f"chapter_id: {_quote(identity.chapter_id)}",
            f"source_url: {_quote(identity.normalized_url)}",
            f"title: {_quote(snapshot.title)}",
            f"created_at: {_quote(now.isoformat())}",
            f"updated_at: {_quote(now.isoformat())}",
            "schema_version: 1",
            "---",
        ]
    )
    return (
        f"{frontmatter}\n\n# {_escape_control_markers(snapshot.title)}\n\n"
        f"## 来源\n\n- URL: {_quote(identity.normalized_url)}\n\n"
        f"## LearnFlow 受控摘录\n\n{CONTROLLED_BEGIN}\n"
        f"{rendered_blocks}\n{CONTROLLED_END}\n\n"
        f"## 个人学习笔记\n\n{PERSONAL_BEGIN}\n{note}\n{PERSONAL_END}\n"
    )


def merge_document(
    existing: str,
    identity: NoteIdentity,
    snapshot: PageSnapshot,
    blocks: list[ContentBlock],
    personal_note: str | None,
    now: datetime,
) -> tuple[str, bool]:
    _validate_managed_document(existing, identity)
    _, controlled_body, _ = _section(existing, CONTROLLED_BEGIN, CONTROLLED_END)
    _, personal_body, _ = _section(existing, PERSONAL_BEGIN, PERSONAL_END)
    controlled_begin_index = existing.index(CONTROLLED_BEGIN)
    controlled_end_index = existing.index(CONTROLLED_END)
    personal_begin_index = existing.index(PERSONAL_BEGIN)
    personal_end_index = existing.index(PERSONAL_END)
    existing_keys = {
        (match.group("id"), match.group("fingerprint"))
        for match in BLOCK_MARKER.finditer(controlled_body)
    }
    legacy_keys_by_fingerprint: dict[str, list[str]] = {}
    for match in BLOCK_MARKER.finditer(controlled_body):
        if LEGACY_BLOCK_ID.fullmatch(match.group("id")):
            legacy_keys_by_fingerprint.setdefault(
                match.group("fingerprint"), []
            ).append(match.group("id"))

    def is_block_present(block: ContentBlock) -> bool:
        key = _block_key(block)
        if key in existing_keys:
            return True
        if block.stableKey:
            occurrence = _stable_occurrence(block.stableKey)
            fingerprint = _fingerprint(block.text)
            if occurrence is not None and occurrence < len(
                legacy_keys_by_fingerprint.get(fingerprint, [])
            ):
                return True
        return False

    additions = [
        render_block(block)
        for block in blocks
        if not is_block_present(block)
    ]
    next_controlled_body = controlled_body
    if additions:
        newline = "\r\n" if "\r\n" in controlled_body else "\n"
        rendered_additions = [
            _normalize_line_endings(addition).replace("\n", newline)
            for addition in additions
        ]
        separator = newline * 2
        next_controlled_body = (
            controlled_body.rstrip("\r\n")
            + separator
            + separator.join(rendered_additions)
            + newline
        )

    next_personal_body = personal_body
    if personal_note and not _personal_note_is_present(personal_body, personal_note):
        next_personal_body = _append_personal_note(personal_body, personal_note)

    updated = (
        existing[: controlled_begin_index + len(CONTROLLED_BEGIN)]
        + next_controlled_body
        + existing[controlled_end_index : personal_begin_index + len(PERSONAL_BEGIN)]
        + next_personal_body
        + existing[personal_end_index:]
    )
    changed = updated != existing
    if changed:
        updated = re.sub(
            r"(?m)^updated_at:[^\r\n]*",
            f"updated_at: {_quote(now.isoformat())}",
            updated,
            count=1,
        )
    return updated, changed


def unified_diff(before: str | None, after: str) -> str:
    old_lines = (before or "").splitlines(keepends=True)
    new_lines = after.splitlines(keepends=True)
    return "".join(
        difflib.unified_diff(
            old_lines,
            new_lines,
            fromfile="current",
            tofile="proposal",
        )
    )
