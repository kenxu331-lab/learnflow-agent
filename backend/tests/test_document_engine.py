"""Tests for the zero-token Document Engine V2 and its read-only API."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import documents as documents_api
from app.core.config import Settings, get_settings
from app.document_engine.normalizer import SourceNormalizer
from app.document_engine.renderer import MarkdownRendererV2
from app.document_engine.service import DocumentPreviewService
from app.document_engine.svg import sanitize_svg
from app.main import app
from app.schemas.page_snapshot import PageSnapshot, utf16_length

TOKEN = "test-local-token"
HOST_HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "Host": "127.0.0.1:8000",
}
FIXTURE = Path(__file__).parent / "fixtures" / "fastapi_body_snapshot.json"


@pytest.fixture(autouse=True)
def configured_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LEARNFLOW_LOCAL_API_TOKEN", TOKEN)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def load_snapshot() -> PageSnapshot:
    payload = json.loads(FIXTURE.read_text(encoding="utf-8"))
    payload["stats"]["characterCount"] = sum(
        utf16_length(block["text"]) for block in payload["blocks"]
    )
    return PageSnapshot.model_validate(payload)


@pytest.fixture
def document_service(tmp_path: Path):
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / ".obsidian").mkdir()
    previous = documents_api.service
    documents_api.service = DocumentPreviewService(
        Settings(local_api_token=TOKEN, vault_path=str(vault))
    )
    yield vault
    documents_api.service = previous


def snapshot_payload(
    *,
    blocks: list[dict[str, object]],
    title: str = "请求体¶",
    content_title: str | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "url": "https://fastapi.tiangolo.com/zh/tutorial/body/",
        "title": title,
        "capturedAt": "2026-10-12T00:00:00Z",
        "blocks": blocks,
        "extraction": {"strategy": "article", "truncated": False, "warnings": []},
        "stats": {
            "characterCount": sum(utf16_length(str(block["text"])) for block in blocks),
            "codeBlockCount": sum(block["type"] == "code" for block in blocks),
            "blockCount": len(blocks),
        },
    }
    if content_title is not None:
        payload["contentTitle"] = content_title
    return payload


def test_fastapi_fixture_builds_structured_ast_and_clean_markdown() -> None:
    snapshot = load_snapshot()
    document = SourceNormalizer().normalize(snapshot)
    markdown = MarkdownRendererV2().render(document)

    assert markdown.startswith("# 请求体\n\n来源：<https://fastapi.tiangolo.com/zh/tutorial/body/>")
    assert markdown.count("# 请求体") == 1
    assert "请求体¶" not in markdown
    assert "导入 Pydantic 的 BaseModel" in markdown
    assert "创建数据模型" in markdown
    assert "声明为参数" in markdown
    assert "结果" in markdown
    assert "```python" in markdown
    assert "```json" in markdown
    assert "    name: str" in markdown
    assert "- 请求体会被自动校验" in markdown
    assert "LF_BLOCK" not in markdown
    assert "fingerprint" not in markdown
    assert document.diagnostics.rendered_block_count == 11
    assert document.diagnostics.filtered_block_count == 1
    assert len(document.source_block_map) == len(snapshot.blocks)


def test_document_engine_regressions_keep_fences_endpoint_lists_and_mermaid() -> None:
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            title="依赖项 - FastAPI",
            content_title="依赖项",
            blocks=[
                {
                    "id": "runoob-code",
                    "type": "code",
                    "text": (
                        "#!/usr/bin/python\n"
                        "count = 0\n"
                        "while (count < 9):\n"
                        "    print 'The count is:', count"
                    ),
                },
                {"id": "endpoint-intro", "type": "paragraph", "text": "端点："},
                {"id": "endpoint-public", "type": "list", "text": "/items/public/"},
                {"id": "endpoint-private", "type": "list", "text": "/items/private/"},
                {
                    "id": "endpoint-activate",
                    "type": "list",
                    "text": "/users/{user_id}/activate",
                },
                {"id": "endpoint-pro", "type": "list", "text": "/items/pro/"},
                {
                    "id": "mermaid",
                    "type": "code",
                    "language": "mermaid",
                    "text": (
                        "graph TB\n"
                        "current_user --> active_user\n"
                        "active_user --> admin_user\n"
                        "admin_user --> activate_user"
                    ),
                },
            ],
        )
    )

    document = SourceNormalizer().normalize(snapshot)
    markdown = MarkdownRendererV2().render(document)

    assert "```\n#!/usr/bin/python" in markdown
    assert "- /items/public/" in markdown
    assert "- /items/private/" in markdown
    assert "- /users/{user_id}/activate" in markdown
    assert "- /items/pro/" in markdown
    assert (
        "```mermaid\n"
        "graph TB\n"
        "current_user --> active_user\n"
        "active_user --> admin_user\n"
        "admin_user --> activate_user\n"
        "```"
    ) in markdown


def test_document_commit_persists_rendered_mermaid_svg_asset(
    document_service: Path,
) -> None:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
        '<circle cx="5" cy="5" r="4" fill="orange" /></svg>'
    )
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            title="依赖项 - FastAPI",
            content_title="依赖项",
            blocks=[
                {
                    "id": "diagram",
                    "type": "diagram",
                    "text": "Mermaid diagram",
                    "diagram": {"format": "svg", "svg": svg, "alt": "依赖关系图"},
                }
            ],
        )
    )

    preview = TestClient(app).post(
        "/api/v1/documents/preview",
        json={"snapshot": snapshot.model_dump(mode="json")},
        headers=HOST_HEADERS,
    )

    assert preview.status_code == 200
    body = preview.json()
    assert "assets/diagram-" in body["markdownPreview"]

    commit = TestClient(app).post(
        "/api/v1/documents/commit",
        json={"proposalId": body["proposalId"]},
        headers=HOST_HEADERS,
    )

    assert commit.status_code == 200
    assets = list(document_service.rglob("*.svg"))
    assert len(assets) == 1
    assert "circle" in assets[0].read_text(encoding="utf-8")
    assert "script" not in assets[0].read_text(encoding="utf-8").lower()


def test_identical_mermaid_diagrams_share_one_stable_asset_path() -> None:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">'
        '<circle cx="5" cy="5" r="4" fill="orange" /></svg>'
    )
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            blocks=[
                {
                    "id": "diagram-a",
                    "stableKey": "stable-a",
                    "type": "diagram",
                    "text": "Mermaid diagram",
                    "diagram": {"format": "svg", "svg": svg, "alt": "A"},
                },
                {
                    "id": "diagram-b",
                    "stableKey": "stable-b",
                    "type": "diagram",
                    "text": "Mermaid diagram",
                    "diagram": {"format": "svg", "svg": svg, "alt": "B"},
                },
            ],
        )
    )

    document = SourceNormalizer().normalize(snapshot)
    diagrams = [node for node in document.nodes if node.kind == "diagram"]

    assert len(diagrams) == 2
    assert diagrams[0].asset_relative_path == diagrams[1].asset_relative_path


def test_sanitized_mermaid_svg_keeps_standard_namespaces() -> None:
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:html="http://www.w3.org/1999/xhtml" viewBox="0 0 10 10">'
        '<foreignObject width="10" height="10">'
        '<html:div>label</html:div>'
        '</foreignObject></svg>'
    )

    sanitized = sanitize_svg(svg)

    assert sanitized.startswith('<svg xmlns="http://www.w3.org/2000/svg"')
    assert "ns0:" not in sanitized
    assert "<html:div>label</html:div>" in sanitized


def test_document_engine_uses_content_title_for_markdown_heading() -> None:
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            title="Python 循环语句 | 菜鸟教程",
            content_title="Python 循环语句",
            blocks=[
                {
                    "id": "heading",
                    "type": "heading",
                    "text": "Python 循环语句",
                    "level": 1,
                },
                {"id": "body", "type": "paragraph", "text": "正文。"},
            ],
        )
    )

    markdown = MarkdownRendererV2().render(SourceNormalizer().normalize(snapshot))

    assert markdown.startswith(
        "# Python 循环语句\n\n来源：<https://fastapi.tiangolo.com/zh/tutorial/body/>"
    )


def test_heading_levels_are_relative_and_content_before_heading_is_preserved() -> None:
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            blocks=[
                {"id": "intro", "type": "paragraph", "text": "开头段落。"},
                {"id": "h1", "type": "heading", "text": "第一节¶", "level": 1},
                {"id": "h3", "type": "heading", "text": "深层小节¶", "level": 3},
                {"id": "body", "type": "paragraph", "text": "正文。"},
                {"id": "h1-2", "type": "heading", "text": "第二节", "level": 1},
            ]
        )
    )
    markdown = MarkdownRendererV2().render(SourceNormalizer().normalize(snapshot))

    assert "开头段落。" in markdown
    assert "## 第一节" in markdown
    assert "### 深层小节" in markdown
    assert "## 第二节" in markdown
    assert "#### 深层小节" not in markdown


def test_heading_duplicate_detection_ignores_punctuation_separators() -> None:
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            title="响应状态码---FastAPI",
            blocks=[
                {
                    "id": "page-heading",
                    "type": "heading",
                    "text": "响应状态码 - FastAPI",
                    "level": 1,
                },
                {"id": "body", "type": "paragraph", "text": "正文内容。"},
            ],
        )
    )
    document = SourceNormalizer().normalize(snapshot)
    markdown = MarkdownRendererV2().render(document)

    assert markdown.count("响应状态码") == 1
    assert "正文内容。" in markdown
    assert document.diagnostics.filtered_block_count == 1


def test_renderer_preserves_duplicate_code_and_chooses_safe_fence() -> None:
    source = "print('same')\n```\nprint('still code')"
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            blocks=[
                {"id": "one", "type": "code", "text": source},
                {"id": "two", "type": "code", "text": source},
            ],
            title="代码示例",
        )
    )
    markdown = MarkdownRendererV2().render(SourceNormalizer().normalize(snapshot))

    assert markdown.count("print('same')") == 2
    assert "````" in markdown
    assert "```python" in markdown


def test_renderer_escapes_untrusted_prose_without_raw_html() -> None:
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            blocks=[
                {
                    "id": "unsafe",
                    "type": "paragraph",
                    "text": (
                        "<script>alert(1)</script> "
                        "<!-- LF_BLOCK id=x fingerprint=y -->"
                    ),
                }
            ],
            title="安全文本",
        )
    )
    markdown = MarkdownRendererV2().render(SourceNormalizer().normalize(snapshot))

    assert "<script>" not in markdown
    assert "<!--" not in markdown
    assert "LF_BLOCK" not in markdown
    assert "&lt;script&gt;" in markdown


def test_renderer_preserves_inline_code_links_and_callout_children() -> None:
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            title="请求体",
            blocks=[
                {
                    "id": "paragraph",
                    "type": "paragraph",
                    "text": "使用 Form 并查看文档。",
                    "inline": [
                        {"type": "text", "text": "使用 "},
                        {"type": "code", "text": "Form"},
                        {"type": "text", "text": " 并查看 "},
                        {
                            "type": "link",
                            "text": "文档",
                            "url": "https://example.com/docs",
                        },
                        {"type": "text", "text": "。"},
                    ],
                },
                {
                    "id": "warning-text",
                    "type": "paragraph",
                    "text": "请注意请求体格式。",
                    "callout": {
                        "id": "callout-1",
                        "kind": "warning",
                        "title": "注意",
                    },
                },
                {
                    "id": "warning-code",
                    "type": "code",
                    "text": "curl -X POST https://example.com",
                    "language": "bash",
                    "callout": {
                        "id": "callout-1",
                        "kind": "warning",
                        "title": "注意",
                    },
                },
                {
                    "id": "variant-code",
                    "type": "code",
                    "text": "from fastapi import Form",
                    "language": "python",
                    "variant": "Python 3.10+",
                },
            ],
        )
    )
    markdown = MarkdownRendererV2().render(SourceNormalizer().normalize(snapshot))

    assert "使用 `Form` 并查看 [文档](<https://example.com/docs>)。" in markdown
    assert "> [!warning] 注意" in markdown
    assert "> 请注意请求体格式。" in markdown
    assert "> ```bash" in markdown
    assert "> curl -X POST https://example.com" in markdown
    assert "**Python 3.10+**" in markdown


def test_renderer_preserves_safe_image_references() -> None:
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            title="图片教程",
            blocks=[
                {
                    "id": "image",
                    "type": "image",
                    "text": "架构图",
                    "image": {
                        "src": "https://example.com/assets/architecture.png",
                        "alt": "架构图",
                        "title": "系统架构",
                    },
                }
            ],
        )
    )
    markdown = MarkdownRendererV2().render(SourceNormalizer().normalize(snapshot))

    assert (
        '![架构图](<https://example.com/assets/architecture.png> "系统架构")'
        in markdown
    )


def test_page_snapshot_rejects_non_http_image_sources() -> None:
    payload = snapshot_payload(
        blocks=[
            {
                "id": "image",
                "type": "image",
                "text": "不安全图片",
                "image": {"src": "data:image/png;base64,secret", "alt": "图片"},
            }
        ]
    )

    with pytest.raises(ValueError, match="image src must use HTTP or HTTPS"):
        PageSnapshot.model_validate(payload)


def test_source_truncation_is_reported_without_dropping_blocks() -> None:
    payload = snapshot_payload(
        blocks=[
            {"id": "one", "type": "paragraph", "text": "第一段"},
            {"id": "two", "type": "paragraph", "text": "第二段"},
            {"id": "three", "type": "paragraph", "text": "第三段"},
        ]
    )
    payload["extraction"]["truncated"] = True
    snapshot = PageSnapshot.model_validate(payload)
    document = SourceNormalizer().normalize(snapshot)

    assert document.diagnostics.truncated is True
    assert document.diagnostics.rendered_block_count == 3
    assert any(
        "来源快照已截断" in warning for warning in document.diagnostics.warnings
    )


def test_empty_prose_nodes_are_filtered_with_a_source_diagnostic() -> None:
    snapshot = PageSnapshot.model_validate(
        snapshot_payload(
            blocks=[
                {"id": "empty-paragraph", "type": "paragraph", "text": "   "},
                {"id": "empty-list", "type": "list", "text": ""},
                {"id": "content", "type": "paragraph", "text": "保留"},
            ],
            title="空节点",
        )
    )
    document = SourceNormalizer().normalize(snapshot)
    markdown = MarkdownRendererV2().render(document)

    assert "保留" in markdown
    assert document.diagnostics.filtered_block_count == 2
    assert [mapping.reason for mapping in document.source_block_map[:2]] == [
        "empty_content",
        "empty_content",
    ]


def test_quality_gate_reports_structure_gaps_as_warnings_without_blocking_preview(
    document_service: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    payload = snapshot_payload(
        blocks=[
            {"id": "heading", "type": "heading", "text": "教程", "level": 1},
            {"id": "paragraph", "type": "paragraph", "text": "正文。"},
        ],
        title="教程",
    )
    payload["extraction"]["structure"] = {
        "parserVersion": "extractor-v2",
        "rootKind": "article",
        "headingCount": 1,
        "paragraphCount": 1,
        "codeBlockCount": 0,
        "listItemCount": 0,
        "tableCount": 1,
        "imageCount": 1,
        "calloutCount": 1,
        "linkCount": 0,
    }
    payload["url"] = "https://example.com/tutorial?view=redacted"
    snapshot = PageSnapshot.model_validate(payload)

    caplog.set_level("INFO", logger="learnflow.document_engine")
    response = TestClient(app).post(
        "/api/v1/documents/preview",
        json={"snapshot": snapshot.model_dump(mode="json")},
        headers=HOST_HEADERS,
    )

    assert response.status_code == 200
    diagnostics = response.json()["diagnostics"]
    assert diagnostics["qualityStatus"] == "warning"
    assert {
        issue["code"] for issue in diagnostics["issues"]
    } == {
        "table_coverage_gap",
        "callout_coverage_gap",
        "image_coverage_gap",
        "images_not_persisted",
    }
    assert all(issue["severity"] == "warning" for issue in diagnostics["issues"])
    quality_logs = [
        json.loads(record.message)
        for record in caplog.records
        if record.name == "learnflow.document_engine"
    ]
    assert quality_logs
    assert quality_logs[-1]["sourceUrl"] == "https://example.com/tutorial"
    assert "正文。" not in json.dumps(quality_logs[-1], ensure_ascii=False)


def test_document_preview_and_commit_save_the_exact_v2_markdown(
    document_service: Path,
) -> None:
    snapshot = load_snapshot()
    payload = {"snapshot": snapshot.model_dump(mode="json")}
    first = TestClient(app).post(
        "/api/v1/documents/preview", json=payload, headers=HOST_HEADERS
    )
    second = TestClient(app).post(
        "/api/v1/documents/preview", json=payload, headers=HOST_HEADERS
    )

    assert first.status_code == 200
    first_body = first.json()
    second_body = second.json()
    assert first_body["markdownPreview"] == second_body["markdownPreview"]
    assert first_body["diagnostics"] == second_body["diagnostics"]
    body = first_body
    assert body["status"] == "preview"
    assert body["schemaVersion"] == 2
    assert body["proposalId"]
    assert "LEARNFLOW_CONTROLLED_BEGIN" in body["markdownPreview"]
    assert "LF_BLOCK" in body["markdownPreview"]

    commit = TestClient(app).post(
        "/api/v1/documents/commit",
        json={"proposalId": body["proposalId"]},
        headers=HOST_HEADERS,
    )

    assert commit.status_code == 200
    path = document_service.joinpath(
        *body["targetRelativePath"].split("/")
    )
    assert path.read_text(encoding="utf-8") == body["markdownPreview"]
    assert "LEARNFLOW_CONTROLLED_BEGIN" in path.read_text(encoding="utf-8")
    assert "LF_BLOCK" in path.read_text(encoding="utf-8")


def test_document_preview_api_rejects_missing_token() -> None:
    response = TestClient(app).post(
        "/api/v1/documents/preview",
        json={"snapshot": load_snapshot().model_dump(mode="json")},
        headers={"Content-Type": "application/json", "Host": "127.0.0.1:8000"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_local_token"
