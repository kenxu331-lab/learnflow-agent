"""Tests for the M01-03 deterministic Markdown note service."""

from __future__ import annotations

import asyncio
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api import notes as notes_api
from app.core.config import Settings, get_settings
from app.core.middleware import RequestSizeLimitMiddleware
from app.main import app
from app.notes.errors import NoteServiceError
from app.notes.markdown import (
    CONTROLLED_BEGIN,
    CONTROLLED_END,
    PERSONAL_BEGIN,
    PERSONAL_END,
    build_new_document,
)
from app.notes.proposals import ProposalStore
from app.notes.resolver import NoteResolver, normalize_source_url
from app.notes.service import MarkdownNoteService
from app.notes.vault import VaultGuard
from app.schemas.notes import NotePreviewRequest
from app.schemas.page_snapshot import PageSnapshot, utf16_length

TOKEN = "test-local-token"
HOST_HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
    "Host": "127.0.0.1:8000",
}


def snapshot_payload(
    *,
    title: str = "Tutorial",
    blocks: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    selected_blocks = blocks or [
        {"id": "heading-1", "type": "heading", "text": "Intro", "level": 1},
        {"id": "paragraph-1", "type": "paragraph", "text": "你好😀"},
        {
            "id": "code-1",
            "type": "code",
            "text": "  print('x')\n    print('y')",
            "language": "python",
        },
        {"id": "list-1", "type": "list", "text": "one"},
    ]
    character_count = sum(
        utf16_length(str(block["text"])) for block in selected_blocks
    )
    return {
        "schemaVersion": 1,
        "url": "https://example.com/tutorial#section",
        "title": title,
        "capturedAt": "2026-10-11T00:00:00Z",
        "blocks": selected_blocks,
        "extraction": {
            "strategy": "article",
            "truncated": False,
            "warnings": [],
        },
        "stats": {
            "characterCount": character_count,
            "codeBlockCount": sum(block["type"] == "code" for block in selected_blocks),
            "blockCount": len(selected_blocks),
        },
    }


def preview_payload(
    *,
    snapshot: dict[str, object] | None = None,
    selected: list[str] | None = None,
    personal: str | None = "第一次理解",
) -> dict[str, object]:
    payload = snapshot or snapshot_payload()
    block_ids = (
        selected
        if selected is not None
        else [str(block["id"]) for block in payload["blocks"][:2]]
    )
    return {
        "snapshot": payload,
        "selectedBlockIds": block_ids,
        "personalNote": personal,
    }


def vault_note_path(root: Path, relative_path: str) -> Path:
    """Build a platform-native path from the service's POSIX relative path."""

    return root.joinpath(*relative_path.split("/"))


@pytest.fixture(autouse=True)
def configured_token(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LEARNFLOW_LOCAL_API_TOKEN", TOKEN)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def vault(tmp_path: Path) -> Path:
    root = tmp_path / "test-vault"
    root.mkdir()
    (root / ".obsidian").mkdir()
    return root


@pytest.fixture
def note_service(vault: Path):
    previous = notes_api.service
    notes_api.service = MarkdownNoteService(
        Settings(local_api_token=TOKEN, vault_path=str(vault))
    )
    yield notes_api.service
    notes_api.service = previous


def post_preview(payload: object, **headers: str):
    request_headers = dict(HOST_HEADERS)
    request_headers.update(headers)
    return TestClient(app).post(
        "/api/v1/notes/preview",
        json=payload,
        headers=request_headers,
    )


def post_commit(proposal_id: str, **headers: str):
    request_headers = dict(HOST_HEADERS)
    request_headers.update(headers)
    return TestClient(app).post(
        "/api/v1/notes/commit",
        json={"proposalId": proposal_id},
        headers=request_headers,
    )


def test_preview_requires_configured_obsidian_vault() -> None:
    previous = notes_api.service
    notes_api.service = MarkdownNoteService(
        Settings(_env_file=None, local_api_token=TOKEN)
    )
    try:
        response = post_preview(preview_payload())
    finally:
        notes_api.service = previous

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "vault_not_configured"


def test_invalid_vault_and_missing_obsidian_marker_are_rejected(tmp_path: Path) -> None:
    missing = MarkdownNoteService(
        Settings(local_api_token=TOKEN, vault_path=str(tmp_path / "missing"))
    )
    with pytest.raises(NoteServiceError, match="可访问"):
        missing.preview(NotePreviewRequest.model_validate(preview_payload()))

    plain = tmp_path / "plain"
    plain.mkdir()
    service = MarkdownNoteService(
        Settings(local_api_token=TOKEN, vault_path=str(plain))
    )
    with pytest.raises(NoteServiceError, match="Obsidian Vault"):
        service.preview(NotePreviewRequest.model_validate(preview_payload()))


def test_url_normalization_and_identity_are_stable_when_title_changes() -> None:
    normalized = normalize_source_url("HTTPS://Example.COM:443/tutorial#part")
    assert normalized == "https://example.com/tutorial"
    resolver = NoteResolver()
    first = resolver.resolve(normalized)
    second = resolver.resolve("https://example.com/tutorial")
    assert first.chapter_id == second.chapter_id
    assert first.note_id == second.note_id
    assert first.target_relative_path == second.target_relative_path
    assert resolver.resolve("https://example.com/other").note_id != first.note_id


def test_resolver_and_vault_reject_dangerous_paths(vault: Path) -> None:
    guard = VaultGuard(Settings(vault_path=str(vault)))
    for relative_path in (
        "../outside.md",
        "LearnFlow/../outside.md",
        "LearnFlow\\outside.md",
        "C:/outside.md",
        "LearnFlow/" + chr(0) + ".md",
    ):
        with pytest.raises(NoteServiceError, match="路径"):
            guard.target_path(relative_path)

    identity = NoteResolver().resolve("https://example.com/CON/..?item=1")
    assert "/CON/" not in identity.target_relative_path
    assert identity.target_relative_path.startswith("LearnFlow/")


def test_selection_validation_rejects_empty_duplicate_and_unknown_ids() -> None:
    payload = snapshot_payload()
    cases = [
        {"selectedBlockIds": [], "message": "too_short"},
        {"selectedBlockIds": ["heading-1", "heading-1"], "message": "duplicates"},
        {"selectedBlockIds": ["unknown"], "message": "unknown"},
        {"selectedBlockIds": [""], "message": "empty"},
    ]
    for case in cases:
        request = preview_payload(snapshot=payload, selected=case["selectedBlockIds"])
        with pytest.raises(ValueError, match=case["message"]):
            NotePreviewRequest.model_validate(request)

    duplicate_blocks = snapshot_payload(
        blocks=[
            {"id": "same", "type": "paragraph", "text": "one"},
            {"id": "same", "type": "paragraph", "text": "two"},
        ]
    )
    with pytest.raises(ValueError, match="unique"):
        NotePreviewRequest.model_validate(
            preview_payload(snapshot=duplicate_blocks, selected=["same"])
        )


def test_markdown_preserves_order_unicode_code_and_escapes_controls() -> None:
    payload = snapshot_payload(
        blocks=[
            {
                "id": "heading-1",
                "type": "heading",
                "text": "中文😀",
                "level": 2,
            },
            {
                "id": "code-1",
                "type": "code",
                "text": "  first\n    second\n```\n<!-- LEARNFLOW_CONTROLLED_END -->",
                "language": "python\n```",
            },
        ]
    )
    snapshot = PageSnapshot.model_validate(payload)
    identity = NoteResolver().resolve(snapshot.url)
    markdown = build_new_document(
        identity,
        snapshot,
        snapshot.blocks,
        "<!-- LEARNFLOW_PERSONAL_END -->",
        snapshot.capturedAt,
    )
    assert markdown.index("中文😀") < markdown.index("first")
    assert "    second" in markdown
    assert "<!-- LEARNFLOW_ESCAPED_CONTROLLED_END -->" in markdown
    assert "<!-- LEARNFLOW_ESCAPED_PERSONAL_END -->" in markdown
    assert "```python" in markdown
    assert "````" in markdown


def test_preview_does_not_create_directories_or_files(
    note_service, vault: Path
) -> None:
    request = NotePreviewRequest.model_validate(preview_payload())
    proposal, identity = note_service.preview(request)

    assert proposal.action == "create"
    assert identity.target_relative_path.startswith("LearnFlow/")
    assert not (vault / "LearnFlow").exists()


def test_commit_creates_an_obsidian_readable_note(note_service, vault: Path) -> None:
    request = NotePreviewRequest.model_validate(preview_payload())
    proposal, identity = note_service.preview(request)

    result = note_service.commit(proposal.proposal_id)
    path = vault_note_path(vault, identity.target_relative_path)
    assert result["status"] == "created"
    assert path.exists()
    assert path.read_text(encoding="utf-8").startswith("---\n")
    assert result["revision"] == (
        "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    )


def test_notes_api_preview_and_commit_return_only_metadata(
    note_service, vault: Path
) -> None:
    preview_response = post_preview(preview_payload())

    assert preview_response.status_code == 200
    preview = preview_response.json()
    assert preview["action"] == "create"
    assert preview["targetRelativePath"].startswith("LearnFlow/")
    assert "snapshot" not in preview

    commit_response = post_commit(preview["proposalId"])

    assert commit_response.status_code == 200
    assert commit_response.json()["status"] == "created"
    assert "markdownPreview" not in commit_response.json()
    assert list(vault.rglob("*.md"))


def test_append_preserves_personal_notes_and_deduplicates(
    note_service, vault: Path
) -> None:
    first_request = NotePreviewRequest.model_validate(
        preview_payload(personal="我的原始笔记")
    )
    first_proposal, identity = note_service.preview(first_request)
    note_service.commit(first_proposal.proposal_id)
    path = vault_note_path(vault, identity.target_relative_path)

    manually_edited = path.read_text(encoding="utf-8") + "\n手动补充内容\n"
    path.write_text(manually_edited, encoding="utf-8")
    second_blocks = [
        {"id": "heading-1", "type": "heading", "text": "Intro", "level": 1},
        {"id": "paragraph-1", "type": "paragraph", "text": "你好😀"},
        {"id": "new", "type": "paragraph", "text": "新摘录"},
    ]
    second_payload = snapshot_payload(title="Changed title", blocks=second_blocks)
    second_request = NotePreviewRequest.model_validate(
        preview_payload(
            snapshot=second_payload,
            selected=["heading-1", "paragraph-1", "new"],
            personal="新的个人笔记",
        )
    )
    second_proposal, second_identity = note_service.preview(second_request)
    assert second_identity.target_relative_path == identity.target_relative_path
    assert second_proposal.action == "append"
    note_service.commit(second_proposal.proposal_id)

    content = path.read_text(encoding="utf-8")
    assert content.count("我的原始笔记") == 1
    assert content.count("新的个人笔记") == 1
    assert "手动补充内容" in content
    assert content.count("新摘录") == 1

    noop_proposal, _ = note_service.preview(second_request)
    assert noop_proposal.action == "noop"
    assert note_service.commit(noop_proposal.proposal_id)["status"] == "unchanged"


def test_personal_note_dedupe_uses_exact_fingerprints_not_substrings(
    note_service, vault: Path
) -> None:
    first_request = NotePreviewRequest.model_validate(
        preview_payload(personal="note")
    )
    first, identity = note_service.preview(first_request)
    note_service.commit(first.proposal_id)
    path = vault_note_path(vault, identity.target_relative_path)

    same, _ = note_service.preview(first_request)
    assert same.action == "noop"

    longer_request = NotePreviewRequest.model_validate(
        preview_payload(personal="notebook")
    )
    longer, _ = note_service.preview(longer_request)
    assert longer.action == "append"
    note_service.commit(longer.proposal_id)

    escaped_request = NotePreviewRequest.model_validate(
        preview_payload(personal="<!-- LEARNFLOW_PERSONAL_END -->")
    )
    escaped, _ = note_service.preview(escaped_request)
    assert escaped.action == "append"
    note_service.commit(escaped.proposal_id)
    repeated_escaped, _ = note_service.preview(escaped_request)
    assert repeated_escaped.action == "noop"

    content = path.read_text(encoding="utf-8")
    assert content.count("\nnotebook\n") == 1
    assert content.count("LEARNFLOW_ESCAPED_PERSONAL_END") == 1


def test_legacy_block_markers_are_not_reimported_with_stable_keys(
    note_service, vault: Path
) -> None:
    legacy_payload = snapshot_payload(
        blocks=[
            {**block, "id": f"block-{index + 1}"}
            for index, block in enumerate(snapshot_payload()["blocks"])
        ]
    )
    legacy_request = NotePreviewRequest.model_validate(
        preview_payload(snapshot=legacy_payload)
    )
    first, identity = note_service.preview(legacy_request)
    note_service.commit(first.proposal_id)

    stable_blocks = [
        {**block, "stableKey": "v1-" + ("0" * 16) + "-0"}
        for block in legacy_payload["blocks"]
    ]
    stable_payload = snapshot_payload(blocks=stable_blocks)
    stable_request = NotePreviewRequest.model_validate(
        preview_payload(snapshot=stable_payload)
    )
    proposal, stable_identity = note_service.preview(stable_request)

    assert stable_identity.target_relative_path == identity.target_relative_path
    assert proposal.action == "noop"
    content = vault_note_path(vault, identity.target_relative_path).read_text(
        encoding="utf-8"
    )
    assert content.count(CONTROLLED_BEGIN) == 1
    assert content.count(CONTROLLED_END) == 1


def test_new_stable_duplicate_is_not_treated_as_legacy_marker(
    note_service, vault: Path
) -> None:
    duplicate_blocks = [
        {
            "id": "first",
            "stableKey": "v1-1111111111111111-0",
            "type": "paragraph",
            "text": "same text",
        },
        {
            "id": "second",
            "stableKey": "v1-1111111111111111-1",
            "type": "paragraph",
            "text": "same text",
        },
    ]
    snapshot = snapshot_payload(blocks=duplicate_blocks)
    second_only = NotePreviewRequest.model_validate(
        preview_payload(snapshot=snapshot, selected=["second"], personal=None)
    )
    first_proposal, identity = note_service.preview(second_only)
    note_service.commit(first_proposal.proposal_id)

    first_only = NotePreviewRequest.model_validate(
        preview_payload(snapshot=snapshot, selected=["first"], personal=None)
    )
    second_proposal, _ = note_service.preview(first_only)
    assert second_proposal.action == "append"
    note_service.commit(second_proposal.proposal_id)

    content = vault_note_path(vault, identity.target_relative_path).read_text(
        encoding="utf-8"
    )
    assert content.count("<!-- LF_BLOCK") == 2


def test_legacy_personal_text_is_not_reimported(note_service, vault: Path) -> None:
    request = NotePreviewRequest.model_validate(preview_payload(personal=None))
    proposal, identity = note_service.preview(request)
    note_service.commit(proposal.proposal_id)
    path = vault_note_path(vault, identity.target_relative_path)
    content = path.read_text(encoding="utf-8")
    legacy = content.replace(
        f"{PERSONAL_BEGIN}\n\n{PERSONAL_END}",
        f"{PERSONAL_BEGIN}\nlegacy note\n{PERSONAL_END}",
    )
    path.write_text(legacy, encoding="utf-8")

    repeated, _ = note_service.preview(
        NotePreviewRequest.model_validate(preview_payload(personal="legacy note"))
    )
    assert repeated.action == "noop"


def test_personal_region_whitespace_is_preserved_when_appending(
    note_service, vault: Path
) -> None:
    first_request = NotePreviewRequest.model_validate(
        preview_payload(personal="first")
    )
    first, identity = note_service.preview(first_request)
    note_service.commit(first.proposal_id)
    path = vault_note_path(vault, identity.target_relative_path)
    content = path.read_text(encoding="utf-8")
    content = content.replace(
        "first\n<!-- LEARNFLOW_PERSONAL_END -->",
        "first\n\n  manual spaces  \n<!-- LEARNFLOW_PERSONAL_END -->",
    )
    path.write_text(content, encoding="utf-8")

    second_request = NotePreviewRequest.model_validate(
        preview_payload(personal="second")
    )
    second, _ = note_service.preview(second_request)
    normalized = second.markdown.replace("\r\n", "\n")
    assert "\nfirst\n\n  manual spaces  \n" in normalized
    assert "\nsecond\n" in normalized


def test_unmanaged_or_damaged_notes_are_not_overwritten(
    note_service, vault: Path
) -> None:
    request = NotePreviewRequest.model_validate(preview_payload())
    _, identity = note_service.preview(request)
    path = vault_note_path(vault, identity.target_relative_path)
    path.parent.mkdir(parents=True)
    path.write_text("# User file\n", encoding="utf-8")
    with pytest.raises(NoteServiceError, match="拒绝覆盖"):
        note_service.preview(request)

    path.write_text(
        "---\nlearnflow_id: "
        + identity.note_id
        + "\n---\n"
        + "<!-- LEARNFLOW_CONTROLLED_BEGIN -->\n",
        encoding="utf-8",
    )
    with pytest.raises(NoteServiceError, match="标记"):
        note_service.preview(request)


def test_preview_then_external_change_returns_conflict(
    note_service, vault: Path
) -> None:
    request = NotePreviewRequest.model_validate(preview_payload())
    proposal, identity = note_service.preview(request)
    path = vault_note_path(vault, identity.target_relative_path)
    path.parent.mkdir(parents=True)
    path.write_text("external", encoding="utf-8")

    with pytest.raises(NoteServiceError) as error:
        note_service.commit(proposal.proposal_id)
    assert error.value.code == "note_conflict"
    assert path.read_text(encoding="utf-8") == "external"


def test_missing_expired_and_restarted_proposals_are_stable(note_service) -> None:
    with pytest.raises(NoteServiceError) as missing:
        note_service.commit("missing-proposal")
    assert missing.value.code == "proposal_expired"

    expiring = ProposalStore(ttl_seconds=0)
    proposal = expiring.put(
        action="noop",
        note_id="note",
        target_relative_path="LearnFlow/example.md",
        expected_revision=None,
        markdown="",
        diff="",
    )
    with pytest.raises(NoteServiceError) as expired:
        expiring.get(proposal.proposal_id)
    assert expired.value.code == "proposal_expired"

    request = NotePreviewRequest.model_validate(preview_payload())
    proposal, _ = note_service.preview(request)
    restarted = MarkdownNoteService(
        Settings(vault_path=note_service.vault.settings.vault_path)
    )
    with pytest.raises(NoteServiceError) as restarted_error:
        restarted.commit(proposal.proposal_id)
    assert restarted_error.value.code == "proposal_expired"


def test_repeated_and_concurrent_commit_are_idempotent(note_service) -> None:
    request = NotePreviewRequest.model_validate(preview_payload())
    proposal, _ = note_service.preview(request)

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                note_service.commit,
                [proposal.proposal_id, proposal.proposal_id],
            )
        )
    assert results[0] == results[1]
    assert note_service.commit(proposal.proposal_id) == results[0]


def test_write_failure_cleans_temporary_file(
    note_service, monkeypatch: pytest.MonkeyPatch
):
    request = NotePreviewRequest.model_validate(preview_payload())
    first, identity = note_service.preview(request)
    note_service.commit(first.proposal_id)
    second, _ = note_service.preview(
        request.model_copy(update={"personalNote": "追加"})
    )

    def fail_replace(*args, **kwargs):
        raise OSError("simulated write failure")

    monkeypatch.setattr("app.notes.vault.os.replace", fail_replace)
    with pytest.raises(NoteServiceError) as error:
        note_service.commit(second.proposal_id)
    assert error.value.code == "vault_write_failed"
    parent = vault_note_path(
        Path(note_service.vault.root()), identity.target_relative_path
    )
    assert list(parent.parent.glob(".learnflow-*.tmp")) == []


def test_create_write_failure_cleans_temporary_file(
    note_service, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = NotePreviewRequest.model_validate(preview_payload())
    _, identity = note_service.preview(request)

    def fail_fsync(_descriptor: int) -> None:
        raise OSError("simulated fsync failure")

    monkeypatch.setattr("app.notes.vault.os.fsync", fail_fsync)
    with pytest.raises(NoteServiceError) as error:
        note_service.vault.create(identity.target_relative_path, "content")
    assert error.value.code == "vault_write_failed"
    target = vault_note_path(
        Path(note_service.vault.root()), identity.target_relative_path
    )
    assert not target.exists()
    assert list(target.parent.glob(".learnflow-*.tmp")) == []


def test_create_cleanup_failure_does_not_fail_published_commit(
    note_service, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = NotePreviewRequest.model_validate(preview_payload())
    proposal, identity = note_service.preview(request)
    original_unlink = os.unlink

    def fail_temporary_unlink(path: str) -> None:
        if Path(path).name.startswith(".learnflow-"):
            raise OSError("simulated cleanup failure")
        original_unlink(path)

    monkeypatch.setattr("app.notes.vault.os.unlink", fail_temporary_unlink)
    result = note_service.commit(proposal.proposal_id)

    target = vault_note_path(
        Path(note_service.vault.root()), identity.target_relative_path
    )
    assert result["status"] == "created"
    assert target.exists()
    assert target.read_text(encoding="utf-8") == proposal.markdown
    assert list(target.parent.glob(".learnflow-*.tmp"))


def test_create_race_does_not_overwrite_file_that_appears_at_publish(
    note_service, monkeypatch: pytest.MonkeyPatch
) -> None:
    request = NotePreviewRequest.model_validate(preview_payload())
    _, identity = note_service.preview(request)
    target = vault_note_path(
        Path(note_service.vault.root()), identity.target_relative_path
    )

    def publish_race(_temporary: str, destination: str) -> None:
        destination_path = Path(destination)
        destination_path.write_text("racer", encoding="utf-8")
        raise FileExistsError(destination)

    monkeypatch.setattr("app.notes.vault.os.link", publish_race)
    with pytest.raises(NoteServiceError) as error:
        note_service.vault.create(identity.target_relative_path, "generated")
    assert error.value.code == "note_conflict"
    assert target.read_text(encoding="utf-8") == "racer"
    assert list(target.parent.glob(".learnflow-*.tmp")) == []


@pytest.mark.parametrize("path", ["/api/v1/notes/preview", "/api/v1/notes/commit"])
def test_notes_reject_non_local_host(path: str) -> None:
    response = TestClient(app).post(
        path,
        json=preview_payload() if path.endswith("preview") else {"proposalId": "x"},
        headers={**HOST_HEADERS, "Host": "example.com:8000"},
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "invalid_host"


def test_notes_reject_invalid_origin() -> None:
    response = post_preview(preview_payload(), Origin="https://evil.example")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "invalid_origin"


def test_notes_extension_preflight_is_allowed() -> None:
    origin = "chrome-extension://" + ("b" * 32)
    response = TestClient(app).options(
        "/api/v1/notes/preview",
        headers={
            "Host": "127.0.0.1:8000",
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert response.status_code in {200, 204}
    assert response.headers["access-control-allow-origin"] == origin


def test_notes_reject_non_json_content_type() -> None:
    response = TestClient(app).post(
        "/api/v1/notes/preview",
        content=json.dumps(preview_payload()),
        headers={**HOST_HEADERS, "Content-Type": "text/plain"},
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_media_type"


def test_notes_authentication_happens_before_note_processing() -> None:
    headers = {
        key: value
        for key, value in HOST_HEADERS.items()
        if key != "Authorization"
    }
    response = TestClient(app).post(
        "/api/v1/notes/preview",
        json=preview_payload(),
        headers=headers,
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_local_token"


def test_notes_streaming_body_limit_without_content_length() -> None:
    async def run_test() -> list[dict[str, object]]:
        events: list[dict[str, object]] = []
        downstream_called = False
        messages = iter(
            [
                {"type": "http.request", "body": b"12345", "more_body": True},
                {"type": "http.request", "body": b"67890X", "more_body": False},
            ]
        )

        async def receive() -> dict[str, object]:
            return next(messages)

        async def send(message: dict[str, object]) -> None:
            events.append(message)

        async def downstream(scope, receive, send) -> None:
            nonlocal downstream_called
            downstream_called = True

        middleware = RequestSizeLimitMiddleware(
            downstream,
            max_bytes=10,
        )
        await middleware(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/v1/notes/preview",
                "headers": [(b"content-type", b"application/json")],
            },
            receive,
            send,
        )
        assert downstream_called is False
        return events

    events = asyncio.run(run_test())
    assert events[0]["status"] == 413
