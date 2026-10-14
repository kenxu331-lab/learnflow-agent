import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  commitNote,
  commitDocument,
  ingestPageSnapshot,
  previewNote,
  previewDocument,
  recommendAi,
  getStudyConversation,
  getKnowledgeJobs,
  getKnowledgeStatus,
  setKnowledgeExtractionConsent,
  streamStudyChat,
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

  it("constructs an AI recommendation request with the extended timeout", async () => {
    const response = {
      schemaVersion: 1,
      recommendations: [
        {
          blockId: "block-1",
          category: "core_concept",
          reason: "解释核心机制",
        },
      ],
      analysis: {
        model: "fake-deepseek-flash",
        analyzedBlockCount: 1,
        truncated: false,
      },
    } as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );
    const payload = {
      snapshot,
      learningGoal: "理解核心机制",
    };

    const result = await recommendAi(payload);

    expect(result).toEqual({ ok: true, response });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/ai/notes/recommend",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(payload),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("constructs a read-only Document Engine V2 preview request", async () => {
    const response = {
      status: "preview",
      schemaVersion: 2,
      proposalId: "document-proposal-1",
      action: "create",
      noteId: "learnflow-1",
      targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
      diff: "+# Tutorial\n",
      expectedRevision: null,
      expiresAt: "2026-10-12T20:00:00Z",
      title: "Tutorial",
      sourceUrl: snapshot.url,
      markdownPreview: "# Tutorial\n",
      diagnostics: {
        renderedBlockCount: 1,
        filteredBlockCount: 0,
        unsupportedBlockCount: 0,
        truncated: false,
        warnings: [],
        qualityStatus: "ok",
        issues: [],
      },
    } as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );

    const result = await previewDocument(snapshot);

    expect(result).toEqual({ ok: true, response });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/documents/preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ snapshot }),
      }),
    );
  });

  it("commits a Document Engine V2 proposal by ID", async () => {
    const response = {
      status: "created",
      noteId: "learnflow-1",
      targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
      revision: "sha256:revision",
    } as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );

    const result = await commitDocument("document-proposal-1");

    expect(result).toEqual({ ok: true, response });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/documents/commit",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ proposalId: "document-proposal-1" }),
      }),
    );
  });

  it("rejects a malformed Document Engine V2 response", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "preview",
          schemaVersion: 2,
          title: "Tutorial",
          sourceUrl: snapshot.url,
          markdownPreview: "# Tutorial\n",
          diagnostics: null,
        }),
        { status: 200 },
      ),
    );

    const result = await previewDocument(snapshot);

    expect(result).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
    });
  });

  it("maps AI timeout and invalid response errors", async () => {
    fetchMock.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const timeoutResult = await recommendAi({ snapshot, learningGoal: "" });
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ recommendations: [] }), { status: 200 }),
    );
    const invalidResult = await recommendAi({ snapshot, learningGoal: "" });

    expect(timeoutResult).toMatchObject({
      ok: false,
      error: { code: "TIMEOUT" },
    });
    expect(invalidResult).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESPONSE" },
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

  it("parses Study Chat SSE deltas and the persisted completion", async () => {
    const assistantMessage = {
      schemaVersion: 1,
      messageId: "message-1",
      role: "assistant",
      content: "答案",
      selectedText: null,
      source: {
        sourceUrl: snapshot.url,
        headingPath: [],
        sourceNodeId: null,
        sourceFingerprint: null,
      },
      origin: "ai",
      createdAt: "2026-10-13T00:00:00Z",
    } as const;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('event: delta\ndata: {"text":"答"}\n\n'),
        );
        controller.enqueue(
          new TextEncoder().encode(
            `event: done\ndata: ${JSON.stringify({
              schemaVersion: 1,
              conversationId: "conversation-1",
              message: assistantMessage,
            })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    fetchMock.mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

    const deltas: string[] = [];
    const result = await streamStudyChat(
      {
        schemaVersion: 1,
        conversationId: "conversation-1",
        sessionId: "session-1",
        sourceUrl: snapshot.url,
        pageTitle: snapshot.title,
        headingPath: ["Tutorial"],
        question: "解释",
        cloudConsent: true,
        snapshot,
      },
      (delta) => deltas.push(delta),
    );

    expect(result).toEqual({
      ok: true,
      response: {
        schemaVersion: 1,
        conversationId: "conversation-1",
        message: assistantMessage,
      },
    });
    expect(deltas).toEqual(["答"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/study/chat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "text/event-stream" }),
      }),
    );
  });

  it("restores a chapter conversation through the local API", async () => {
    const responseBody = {
      schemaVersion: 1,
      conversationId: "conversation-1",
      sessionId: "session-1",
      sourceUrl: snapshot.url,
      pageTitle: snapshot.title,
      messages: [],
    } as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(responseBody), { status: 200 }),
    );

    const result = await getStudyConversation("conversation-1");

    expect(result).toEqual({ ok: true, response: responseBody });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/study/conversations/conversation-1",
      expect.objectContaining({
        headers: { Authorization: "Bearer local-token" },
      }),
    );
  });

  it("reads independent knowledge extraction status", async () => {
    const response = {
      consent: {
        scopeId: "scope-1",
        state: "revoked",
        policyVersion: null,
      },
      queuedJobCount: 2,
      runningJobCount: 1,
    } as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );

    const result = await getKnowledgeStatus();

    expect(result).toEqual({ ok: true, response });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/knowledge/status",
      expect.objectContaining({
        headers: { Authorization: "Bearer local-token" },
      }),
    );
  });

  it("updates independent knowledge extraction consent", async () => {
    const response = {
      scopeId: "scope-1",
      state: "active",
      policyVersion: "s2-a-v1",
    } as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );

    const result = await setKnowledgeExtractionConsent(true);

    expect(result).toEqual({ ok: true, response });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/knowledge/consent",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ enabled: true, policyVersion: "s2-a-v1" }),
      }),
    );
  });

  it("reads knowledge extraction job outcomes", async () => {
    const response = [
      {
        jobId: "job-1",
        chapterId: "chapter-1",
        conversationId: "conversation-1",
        state: "needs_review",
        attemptCount: 0,
        lastErrorCode: "knowledge_invalid_output",
        lastErrorMessage: "知识提炼模型返回结构无效。",
        updatedAt: "2026-10-14T06:07:42.254399Z",
      },
    ] as const;
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(response), { status: 200 }),
    );

    const result = await getKnowledgeJobs();

    expect(result).toEqual({ ok: true, response });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/knowledge/jobs",
      expect.objectContaining({
        headers: { Authorization: "Bearer local-token" },
      }),
    );
  });
});
