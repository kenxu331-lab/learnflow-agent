"""Deterministic normalization from PageSnapshot v1 to Document AST."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import MutableSequence

from app.document_engine.models import (
    CalloutNode,
    CodeBlockNode,
    DiagramNode,
    DocumentAST,
    DocumentDiagnostics,
    DocumentNode,
    ImageNode,
    ListBlockNode,
    ListItemNode,
    ParagraphNode,
    SectionNode,
    SourceBlockMapping,
    TableNode,
)
from app.document_engine.quality import evaluate_quality, log_quality_diagnostics
from app.notes.resolver import normalize_source_url
from app.schemas.page_snapshot import PageSnapshot

_ANCHOR_SUFFIX = re.compile(r"(?:\s*¶)+\s*$")
_SITE_TITLE_SUFFIX = re.compile(r"\s*(?:-{1,3}|—|–|\|)\s*FastAPI\s*$", re.I)
_LANGUAGE = re.compile(r"[^A-Za-z0-9+#._-]")
_KNOWN_LANGUAGES = {
    "bash",
    "css",
    "console",
    "html",
    "mermaid",
    "javascript",
    "js",
    "json",
    "python",
    "py",
    "sh",
    "shell",
    "shell-session",
    "sql",
    "text",
    "toml",
    "ts",
    "typescript",
    "yaml",
}


def _line_endings(value: str) -> str:
    return value.replace("\r\n", "\n").replace("\r", "\n")


def _clean_heading(value: str) -> str:
    return _ANCHOR_SUFFIX.sub("", _line_endings(value)).strip()


def _clean_document_title(value: str) -> str:
    return _SITE_TITLE_SUFFIX.sub("", _clean_heading(value)).strip()


def _heading_compare_key(value: str) -> str:
    """Compare headings without treating punctuation separators as content."""

    return re.sub(
        r"[^\w]+",
        "",
        _SITE_TITLE_SUFFIX.sub("", _clean_heading(value)).casefold(),
    )


def _clean_prose(value: str) -> str:
    normalized = _line_endings(value).strip()
    return re.sub(r"\n{3,}", "\n\n", normalized)


def _clean_language(value: str | None) -> str | None:
    if not value:
        return None
    candidate = _LANGUAGE.sub("", value.splitlines()[0]).strip().lower()
    if candidate in {"console", "sh", "shell-session", "shell"}:
        return "bash"
    return candidate if candidate in _KNOWN_LANGUAGES else None


def _infer_language(text: str) -> str | None:
    stripped = text.strip()
    if stripped.startswith(("{", "[")):
        try:
            json.loads(stripped)
        except (json.JSONDecodeError, TypeError):
            pass
        else:
            return "json"

    python_markers = (
        "def ",
        "async def ",
        "import ",
        "from ",
        "@app.",
        "print(",
    )
    if any(marker in text for marker in python_markers):
        return "python"
    shell_markers = ("$ ", "curl ", "pip install ", "uvicorn ", "python -m ")
    if any(marker in text for marker in shell_markers):
        return "bash"
    return None


def _diagram_asset_path(source_url: str, svg: str) -> str:
    digest = hashlib.sha256(
        f"{source_url}\u0000{svg}".encode()
    ).hexdigest()[:20]
    return f"assets/diagram-{digest}.svg"


def _append_node(container: MutableSequence[DocumentNode], node: DocumentNode) -> None:
    if isinstance(node, ListBlockNode) and container:
        previous = container[-1]
        if isinstance(previous, ListBlockNode):
            previous.items.extend(node.items)
            return
    container.append(node)


class SourceNormalizer:
    """Normalize only what the PageSnapshot contract can justify."""

    def normalize(self, snapshot: PageSnapshot) -> DocumentAST:
        document_title = _clean_document_title(
            snapshot.contentTitle or snapshot.title
        )
        source_url = normalize_source_url(snapshot.url)
        page_identity = source_url
        mappings: list[SourceBlockMapping] = []
        warnings = list(snapshot.extraction.warnings)
        if snapshot.extraction.truncated:
            warnings.append("来源快照已截断，文档可能不完整。")

        first_heading_seen = False
        duplicate_title_skipped = False
        heading_blocks = [
            block for block in snapshot.blocks if block.type == "heading"
        ]
        if (
            heading_blocks
            and _heading_compare_key(heading_blocks[0].text)
            == _heading_compare_key(document_title)
        ):
            heading_blocks = heading_blocks[1:]
        first_structural_level = (
            max(1, min(heading_blocks[0].level or 2, 6))
            if heading_blocks
            else 2
        )
        root: list[DocumentNode] = []
        section_stack: list[SectionNode] = []

        for block in snapshot.blocks:
            normalized_text = (
                _clean_heading(block.text)
                if block.type == "heading"
                else _clean_prose(block.text)
            )
            if block.type != "code" and not normalized_text:
                mappings.append(
                    SourceBlockMapping(
                        source_block_id=block.id,
                        stable_key=block.stableKey,
                        outcome="filtered",
                        reason="empty_content",
                    )
                )
                continue
            target = section_stack[-1].children if section_stack else root
            if block.type == "heading":
                title = _clean_heading(block.text)
                if (
                    not first_heading_seen
                    and _heading_compare_key(title)
                    == _heading_compare_key(document_title)
                ):
                    mappings.append(
                        SourceBlockMapping(
                            source_block_id=block.id,
                            stable_key=block.stableKey,
                            outcome="filtered",
                            reason="duplicate_document_title",
                        )
                    )
                    duplicate_title_skipped = True
                    first_heading_seen = True
                    continue

                first_heading_seen = True
                original_level = max(1, min(block.level or 2, 6))
                normalized_level = max(2, original_level - first_structural_level + 2)
                while (
                    section_stack
                    and section_stack[-1].normalized_level >= normalized_level
                ):
                    section_stack.pop()
                if section_stack:
                    normalized_level = min(
                        normalized_level,
                        section_stack[-1].normalized_level + 1,
                    )
                section = SectionNode(
                    title=title,
                    original_level=original_level,
                    normalized_level=normalized_level,
                    source_block_ids=[block.id],
                )
                target = section_stack[-1].children if section_stack else root
                target.append(section)
                section_stack.append(section)
                mappings.append(
                    SourceBlockMapping(
                        source_block_id=block.id,
                        stable_key=block.stableKey,
                        outcome="rendered",
                    )
                )
                continue

            target = section_stack[-1].children if section_stack else root
            if block.callout and block.type != "heading":
                if (
                    target
                    and isinstance(target[-1], CalloutNode)
                    and target[-1].source_callout_id == block.callout.id
                ):
                    target = target[-1].children
                else:
                    callout = CalloutNode(
                        style=block.callout.kind,
                        title=block.callout.title,
                        source_callout_id=block.callout.id,
                    )
                    target.append(callout)
                    target = callout.children
            if block.type == "paragraph":
                _append_node(
                    target,
                    ParagraphNode(
                        text=_clean_prose(block.text),
                        segments=block.inline,
                        source_block_ids=[block.id],
                    ),
                )
            elif block.type == "code":
                language = _clean_language(block.language) or _infer_language(
                    block.text
                )
                if language is None:
                    warnings.append(f"代码块 {block.id} 未能确定语言，保留无语言围栏。")
                _append_node(
                    target,
                    CodeBlockNode(
                        text=_line_endings(block.text),
                        language=language,
                        variant=block.variant,
                        source_block_ids=[block.id],
                    ),
                )
            elif block.type == "list":
                if "\n" in block.text:
                    warnings.append(
                        f"列表块 {block.id} 的嵌套关系无法从 PageSnapshot v1 "
                        "确定，按单层列表保留。"
                    )
                _append_node(
                    target,
                    ListBlockNode(
                        items=[
                            ListItemNode(
                                text=_clean_prose(block.text),
                                segments=block.inline,
                                source_block_id=block.id,
                            )
                        ]
                    ),
                )
            elif block.type == "table" and block.table:
                _append_node(
                    target,
                    TableNode(
                        headers=block.table.headers,
                        rows=block.table.rows,
                        source_block_ids=[block.id],
                    ),
                )
            elif block.type == "image" and block.image:
                _append_node(
                    target,
                    ImageNode(
                        src=block.image.src,
                        alt=block.image.alt or block.text,
                        title=block.image.title,
                        source_block_ids=[block.id],
                    ),
                )
            elif block.type == "diagram" and block.diagram:
                _append_node(
                    target,
                    DiagramNode(
                        format=block.diagram.format,
                        svg=block.diagram.svg,
                        alt=block.diagram.alt or block.text,
                        asset_relative_path=_diagram_asset_path(
                            source_url,
                            block.diagram.svg,
                        ),
                        source_block_ids=[block.id],
                    ),
                )
            else:
                mappings.append(
                    SourceBlockMapping(
                        source_block_id=block.id,
                        stable_key=block.stableKey,
                        outcome="unsupported",
                        reason=f"unsupported_block_type:{block.type}",
                    )
                )
                continue

            mappings.append(
                SourceBlockMapping(
                    source_block_id=block.id,
                    stable_key=block.stableKey,
                    outcome="rendered",
                )
            )

        if duplicate_title_skipped:
            warnings.append("页面首个标题与文档标题重复，已避免重复输出。")

        rendered_count = sum(mapping.outcome == "rendered" for mapping in mappings)
        filtered_count = sum(mapping.outcome == "filtered" for mapping in mappings)
        unsupported_count = sum(
            mapping.outcome == "unsupported" for mapping in mappings
        )
        diagnostics = DocumentDiagnostics(
            rendered_block_count=rendered_count,
            filtered_block_count=filtered_count,
            unsupported_block_count=unsupported_count,
            truncated=snapshot.extraction.truncated,
            warnings=list(dict.fromkeys(warnings)),
        )
        document = DocumentAST(
            document_title=document_title,
            source_url=source_url,
            page_identity=page_identity,
            nodes=root,
            source_block_map=mappings,
            diagnostics=diagnostics,
        )
        issues = evaluate_quality(snapshot, document)
        document.diagnostics.issues = issues
        document.diagnostics.qualityStatus = "warning" if issues else "ok"
        document.diagnostics.warnings = list(
            dict.fromkeys(
                document.diagnostics.warnings
                + [issue.message for issue in issues]
            )
        )
        log_quality_diagnostics(snapshot, document, issues)
        return document
