import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commitNote,
  ingestPageSnapshot,
  previewNote,
} from "../src/backend/api-client";
import type { PageSnapshot } from "../src/capture/types";

const snapshot: PageSnapshot = {
  schemaVersion: 1,
  url: "https://example.com/tutorial",
  title: "Tutorial",
  capturedAt: "2026-10-11T00:00:00.000Z",
  blocks: [{ id: "block-1", type: "paragraph", text: "Tutorial text." }],
  extraction: { strategy: "article", truncated: false, warnings: [] },
  stats: { characterCount: 14, codeBlockCount: 0, blockCount: 1 },
};

const backendResponse = {
  status: "validated" as const,
  requestId: "request-1",
  schemaVersion: 1 as const,
  stats: snapshot.stats,
};

describe("backend HTTP client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let storageGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    storageGet = vi.fn().mockResolvedValue({ localApiToken: "local-token" });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", { storage: { local: { get: storageGet } } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("constructs an authenticated JSON POST", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(backendResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await ingestPageSnapshot(snapshot);

    expect(result).toEqual({ ok: true, response: backendResponse });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/pages/ingest",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer local-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(snapshot),
      }),
    );
  });

  it("does not send without a saved token", async () => {
    storageGet.mockResolvedValue({});

    const result = await ingestPageSnapshot(snapshot);

    expect(result).toMatchObject({ ok: false, error: { code: "NO_TOKEN" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, "UNAUTHORIZED"],
    [422, "INVALID_PAYLOAD"],
    [500, "SERVER_ERROR"],
  ] as const)("maps HTTP %s to %s", async (status, code) => {
    fetchMock.mockResolvedValue(new Response("", { status }));

    const result = await ingestPageSnapshot(snapshot);

    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it("maps a connection failure", async () => {
    fetchMock.mockRejectedValue(new Error("connect failed"));

    const result = await ingestPageSnapshot(snapshot);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "NETWORK_ERROR" },
    });
  });

  it("constructs a preview request with the snapshot and selected IDs", async () => {
    const response = {
      proposalId: "proposal-1",
      action: "create",
      noteId: "learnflow-1",
      targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
      markdownPreview: "# Tutorial",
      diff: "+# Tutorial",
      expectedRevision: null,
      expiresAt: "2026-10-11T20:00:00Z",
    } as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );

    const payload = {
      snapshot,
      selectedBlockIds: ["block-1"],
      personalNote: "理解",
    };
    const result = await previewNote(payload);

    expect(result).toEqual({ ok: true, response });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/notes/preview",
      expect.objectContaining({ body: JSON.stringify(payload) }),
    );
  });

  it("sends only the proposal ID when committing a note", async () => {
    const response = {
      status: "created",
      noteId: "learnflow-1",
      targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
      revision: "sha256:revision",
    } as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );

    const result = await commitNote("proposal-1");

    expect(result).toEqual({ ok: true, response });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/notes/commit",
      expect.objectContaining({
        body: JSON.stringify({ proposalId: "proposal-1" }),
      }),
    );
  });

  it.each([
    [409, "NOTE_CONFLICT"],
    [410, "PROPOSAL_EXPIRED"],
  ] as const)("maps note HTTP %s to %s", async (status, code) => {
    fetchMock.mockResolvedValue(new Response("", { status }));

    const result = await commitNote("proposal-1");

    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  it("distinguishes an unconfigured Vault response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "vault_not_configured" } }),
        { status: 503 },
      ),
    );

    const result = await previewNote({
      snapshot,
      selectedBlockIds: ["block-1"],
      personalNote: "",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VAULT_NOT_CONFIGURED" },
    });
  });

  it.each([
    ["null stats", { ...backendResponse, stats: null }],
    ["array stats", { ...backendResponse, stats: [] }],
    [
      "wrong stat type",
      { ...backendResponse, stats: { ...snapshot.stats, blockCount: "1" } },
    ],
    ["empty request id", { ...backendResponse, requestId: "   " }],
    ["negative stat", { ...backendResponse, stats: { ...snapshot.stats, blockCount: -1 } }],
  ] as const)("rejects malformed HTTP 200 response: %s", async (_name, body) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await ingestPageSnapshot(snapshot);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  });

  it.each([
    ["null preview response", null],
    ["array preview response", []],
    ["blank proposal id", { proposalId: " " }],
    [
      "blank expected revision",
      {
        proposalId: "proposal-1",
        action: "append",
        noteId: "learnflow-1",
        targetRelativePath: "LearnFlow/example.md",
        markdownPreview: "# Note",
        diff: "",
        expectedRevision: " ",
        expiresAt: "2026-10-11T20:00:00Z",
      },
    ],
  ] as const)("rejects malformed note preview response: %s", async (_name, body) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200 }),
    );

    const result = await previewNote({
      snapshot,
      selectedBlockIds: ["block-1"],
      personalNote: "",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  });

  it("maps an abort to a timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));

    const result = await ingestPageSnapshot(snapshot);

    expect(result).toMatchObject({ ok: false, error: { code: "TIMEOUT" } });
  });
});
