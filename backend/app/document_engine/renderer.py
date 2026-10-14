"""Zero-token Markdown renderer for Document AST V2."""

from __future__ import annotations

import hashlib
import html
import json
import re
from urllib.parse import quote

from app.document_engine.models import (
    CalloutNode,
    CodeBlockNode,
    DiagramNode,
    DocumentAST,
    DocumentNode,
    ImageNode,
    ListBlockNode,
    ParagraphNode,
    SectionNode,
    TableNode,
)
from app.notes.resolver import NoteIdentity


def _escape_prose(value: str) -> str:
    escaped = html.escape(value, quote=False).replace("`", r"\`")
    # Keep source text from becoming an internal-looking control marker while
    # preserving what the reader sees after Markdown entity decoding.
    escaped = escaped.replace("LF_BLOCK", "LF&#95;BLOCK")
    escaped = escaped.replace("LEARNFLOW_", "LEARNFLOW&#95;")
    return escaped


def _escape_heading(value: str) -> str:
    escaped = _escape_prose(value)
    return re.sub(r"^\s*#+\s*", lambda match: "\\" + match.group(0), escaped)


def _escape_list_item(value: str) -> str:
    lines = _escape_prose(value).split("\n")
    if not lines:
        return ""
    if len(lines) == 1:
        return lines[0]
    return lines[0] + "\n" + "\n".join(f"  {line}" for line in lines[1:])


def _code_fence(value: str) -> str:
    longest = max((len(run) for run in re.findall(r"`+", value)), default=0)
    return "`" * max(3, longest + 1)


def _inline_code(value: str) -> str:
    longest = max((len(run) for run in re.findall(r"`+", value)), default=0)
    fence = "`" * max(1, longest + 1)
    padding = " " if value.startswith("`") or value.endswith("`") else ""
    return f"{fence}{padding}{value}{padding}{fence}"


def _render_inline(segments, fallback: str) -> str:
    if not segments:
        return _escape_prose(fallback)
    rendered: list[str] = []
    for segment in segments:
        text = _escape_prose(segment.text)
        if segment.type == "code":
            code = _inline_code(text)
            if segment.url:
                rendered.append(
                    f"[{code}](<{html.escape(segment.url, quote=False)}>)"
                )
            else:
                rendered.append(code)
        elif segment.type == "link" and segment.url:
            rendered.append(
                f"[{text}](<{html.escape(segment.url, quote=False)}>)"
            )
        else:
            rendered.append(text)
    return "".join(rendered)


class MarkdownRendererV2:
    """Render a DocumentAST without persistence markers or dynamic content."""

    def render(self, document: DocumentAST) -> str:
        parts = [
            f"# {_escape_heading(document.document_title)}",
            f"来源：<{html.escape(document.source_url, quote=False)}>",
        ]
        for node in document.nodes:
            rendered = self._render_node(node)
            if rendered:
                parts.append(rendered)
        return "\n\n".join(parts).rstrip() + "\n"

    def render_managed(self, document: DocumentAST, identity: NoteIdentity) -> str:
        mappings = {item.source_block_id: item for item in document.source_block_map}
        body = "\n\n".join(
            self._render_managed_node(node, mappings)
            for node in document.nodes
        )
        frontmatter = "\n".join(
            [
                "---",
                f"learnflow_id: {json.dumps(identity.note_id, ensure_ascii=False)}",
                f"chapter_id: {json.dumps(identity.chapter_id, ensure_ascii=False)}",
                "source_url: "
                f"{json.dumps(identity.normalized_url, ensure_ascii=False)}",
                f"title: {json.dumps(document.document_title, ensure_ascii=False)}",
                "schema_version: 2",
                "---",
            ]
        )
        return (
            f"{frontmatter}\n\n# {_escape_heading(document.document_title)}\n\n"
            f"来源：<{html.escape(document.source_url, quote=False)}>\n\n"
            "## LearnFlow 受控摘录\n\n"
            f"<!-- LEARNFLOW_CONTROLLED_BEGIN -->\n{body}\n"
            "<!-- LEARNFLOW_CONTROLLED_END -->\n\n"
            "## 个人学习笔记\n\n"
            "<!-- LEARNFLOW_PERSONAL_BEGIN -->\n<!-- LEARNFLOW_PERSONAL_END -->\n"
        )

    @staticmethod
    def _managed_marker(source_id: str, mappings) -> str:
        mapping = mappings.get(source_id)
        if mapping is None or mapping.outcome != "rendered":
            return ""
        marker_id = quote(mapping.stable_key or mapping.source_block_id, safe="-_.~")
        fingerprint = (
            mapping.content_hash
            or hashlib.sha256(source_id.encode("utf-8")).hexdigest()
        )[:24]
        return f"<!-- LF_BLOCK id={marker_id} fingerprint={fingerprint} -->"

    def _managed_prefix(self, source_ids: list[str], mappings) -> str:
        return "\n".join(
            marker
            for source_id in source_ids
            if (marker := self._managed_marker(source_id, mappings))
        )

    def _render_managed_node(self, node: DocumentNode, mappings) -> str:
        if isinstance(node, SectionNode):
            children = [
                self._render_managed_node(child, mappings)
                for child in node.children
            ]
            body = "\n\n".join(part for part in children if part)
            heading = f"{'#' * node.normalized_level} {_escape_heading(node.title)}"
            rendered = f"{heading}\n\n{body}" if body else heading
        elif isinstance(node, CalloutNode):
            style = "info" if node.style == "details" else node.style
            header = f"> [!{style}]"
            if node.title:
                header += f" {_escape_heading(node.title)}"
            children = [
                self._render_managed_node(child, mappings)
                for child in node.children
            ]
            body = "\n\n".join(part for part in children if part)
            rendered = header if not body else header + "\n" + "\n".join(
                f"> {line}" for line in body.split("\n")
            )
        elif isinstance(node, ParagraphNode):
            rendered = _render_inline(node.segments, node.text)
        elif isinstance(node, CodeBlockNode):
            fence = _code_fence(node.text)
            rendered = f"{fence}{node.language or ''}\n{node.text}\n{fence}"
            if node.variant:
                rendered = f"**{_escape_heading(node.variant)}**\n\n{rendered}"
        elif isinstance(node, ListBlockNode):
            rendered = "\n".join(
                f"- {_render_inline(item.segments, item.text)}" for item in node.items
            )
        elif isinstance(node, TableNode):
            headers = node.headers or ["内容"]
            width = len(headers)
            rows = [row + [""] * (width - len(row)) for row in node.rows]
            lines = [
                "| " + " | ".join(_escape_prose(cell) for cell in headers) + " |",
                "| " + " | ".join("---" for _ in headers) + " |",
            ]
            lines.extend(
                "| " + " | ".join(_escape_prose(cell) for cell in row[:width]) + " |"
                for row in rows
            )
            rendered = "\n".join(lines)
        elif isinstance(node, ImageNode):
            alt = _escape_prose(node.alt).replace("]", r"\]")
            rendered = f"![{alt}](<{html.escape(node.src, quote=False)}>)"
        elif isinstance(node, DiagramNode):
            alt = _escape_prose(node.alt).replace("]", r"\]")
            rendered = (
                f"![{alt}](<{html.escape(node.asset_relative_path, quote=False)}>)"
            )
        else:
            raise TypeError(f"unsupported managed node: {type(node).__name__}")
        source_ids = getattr(node, "source_block_ids", [])
        if isinstance(node, ListBlockNode):
            source_ids = [item.source_block_id for item in node.items]
        marker = self._managed_prefix(source_ids, mappings)
        return f"{marker}\n{rendered}" if marker else rendered

    def _render_node(self, node: DocumentNode) -> str:
        if isinstance(node, SectionNode):
            children = [self._render_node(child) for child in node.children]
            body = "\n\n".join(part for part in children if part)
            heading = f"{'#' * node.normalized_level} {_escape_heading(node.title)}"
            return f"{heading}\n\n{body}" if body else heading
        if isinstance(node, CalloutNode):
            style = "info" if node.style == "details" else node.style
            header = f"> [!{style}]"
            if node.title:
                header += f" { _escape_heading(node.title) }"
            children = [self._render_node(child) for child in node.children]
            body = "\n\n".join(part for part in children if part)
            if not body:
                return header
            return header + "\n" + "\n".join(f"> {line}" for line in body.split("\n"))
        if isinstance(node, ParagraphNode):
            return _render_inline(node.segments, node.text)
        if isinstance(node, CodeBlockNode):
            fence = _code_fence(node.text)
            language = node.language or ""
            rendered = f"{fence}{language}\n{node.text}\n{fence}"
            if node.variant:
                return f"**{_escape_heading(node.variant)}**\n\n{rendered}"
            return rendered
        if isinstance(node, ListBlockNode):
            return "\n".join(
                f"- {_render_inline(item.segments, item.text)}" for item in node.items
            )
        if isinstance(node, TableNode):
            headers = node.headers or ["内容"]
            width = len(headers)
            rows = [row + [""] * (width - len(row)) for row in node.rows]
            lines = [
                "| " + " | ".join(_escape_prose(cell) for cell in headers) + " |",
                "| " + " | ".join("---" for _ in headers) + " |",
            ]
            lines.extend(
                "| " + " | ".join(_escape_prose(cell) for cell in row[:width]) + " |"
                for row in rows
            )
            return "\n".join(lines)
        if isinstance(node, ImageNode):
            alt = _escape_prose(node.alt).replace("]", r"\]")
            rendered = f"![{alt}](<{html.escape(node.src, quote=False)}>)"
            if node.title:
                title = node.title.replace('"', r'\"')
                rendered = (
                    f"![{alt}](<{html.escape(node.src, quote=False)}> \"{title}\")"
                )
            return rendered
        if isinstance(node, DiagramNode):
            alt = _escape_prose(node.alt).replace("]", r"\]")
            return f"![{alt}](<{html.escape(node.asset_relative_path, quote=False)}>)"
        raise TypeError(f"unsupported document node: {type(node).__name__}")
