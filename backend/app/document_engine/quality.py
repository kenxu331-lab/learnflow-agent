"""Deterministic quality checks for source structure versus Document AST."""

from __future__ import annotations

import json
import logging
from collections.abc import Iterable
from urllib.parse import urlsplit, urlunsplit

from app.document_engine.models import (
    CalloutNode,
    CodeBlockNode,
    DocumentAST,
    DocumentNode,
    ImageNode,
    ParagraphNode,
    QualityIssue,
    SectionNode,
    TableNode,
)
from app.schemas.page_snapshot import PageSnapshot

logger = logging.getLogger("learnflow.document_engine")


def _walk(nodes: Iterable[DocumentNode]) -> Iterable[DocumentNode]:
    for node in nodes:
        yield node
        if isinstance(node, (SectionNode, CalloutNode)):
            yield from _walk(node.children)


def evaluate_quality(
    snapshot: PageSnapshot, document: DocumentAST
) -> list[QualityIssue]:
    structure = snapshot.extraction.structure
    if structure is None:
        return []

    nodes = list(_walk(document.nodes))
    headings = sum(isinstance(node, SectionNode) for node in nodes)
    code_blocks = sum(isinstance(node, CodeBlockNode) for node in nodes)
    tables = sum(isinstance(node, TableNode) for node in nodes)
    images = sum(isinstance(node, ImageNode) for node in nodes)
    callouts = sum(isinstance(node, CalloutNode) for node in nodes)
    inline_links = sum(
        sum(segment.type == "link" for segment in node.segments or [])
        for node in nodes
        if isinstance(node, (ParagraphNode,))
    )
    issues: list[QualityIssue] = []

    def add(code: str, message: str, evidence: dict[str, int | str | bool]) -> None:
        issues.append(
            QualityIssue(
                severity="warning",
                code=code,
                message=message,
                evidence=evidence,
            )
        )

    if structure.headingCount > headings + document.diagnostics.filtered_block_count:
        add(
            "heading_coverage_gap",
            "页面结构中的标题没有全部进入文档结构。",
            {"source": structure.headingCount, "rendered": headings},
        )
    if structure.codeBlockCount > code_blocks:
        add(
            "code_coverage_gap",
            "页面结构中的代码块没有全部进入文档结构。",
            {"source": structure.codeBlockCount, "rendered": code_blocks},
        )
    if structure.tableCount > tables:
        add(
            "table_coverage_gap",
            "页面包含表格，但部分表格未能结构化。",
            {"source": structure.tableCount, "rendered": tables},
        )
    if structure.calloutCount > callouts:
        add(
            "callout_coverage_gap",
            "页面包含提示框，但部分提示框未能结构化。",
            {"source": structure.calloutCount, "rendered": callouts},
        )
    if structure.linkCount > inline_links:
        add(
            "link_coverage_gap",
            "页面中的部分链接没有进入内联结构。",
            {"source": structure.linkCount, "rendered": inline_links},
        )
    if structure.imageCount:
        if structure.imageCount > images:
            add(
                "image_coverage_gap",
                "页面中的部分图片没有进入文档结构。",
                {"source": structure.imageCount, "rendered": images},
            )
        add(
            "images_not_persisted",
            "页面图片已保留为远程引用，但当前未下载到 Obsidian Vault。",
            {"source": structure.imageCount, "rendered": images},
        )
    if snapshot.extraction.truncated:
        add(
            "source_truncated",
            "来源快照已截断，文档可能不完整。",
            {"truncated": True},
        )
    return issues


def log_quality_diagnostics(
    snapshot: PageSnapshot,
    document: DocumentAST,
    issues: list[QualityIssue],
) -> None:
    parsed = urlsplit(snapshot.url)
    safe_url = urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))
    payload = {
        "event": "document_quality",
        "sourceUrl": safe_url,
        "parserVersion": snapshot.extraction.structure.parserVersion
        if snapshot.extraction.structure
        else "unknown",
        "qualityStatus": document.diagnostics.qualityStatus,
        "issues": [issue.model_dump(mode="json") for issue in issues],
    }
    logger.info(json.dumps(payload, ensure_ascii=False, sort_keys=True))
