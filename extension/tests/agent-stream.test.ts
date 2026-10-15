import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getStudyConversation, streamStudyChat } from "../src/backend/api-client";
import type { StudyChatPayload } from "../src/backend/types";
import { renderActivityTrace } from "../src/sidepanel/message-presentation";

const payload: StudyChatPayload = {
  schemaVersion: 1, readonlyAgent: true, conversationId: "c1", sessionId: "s1",
  sourceUrl: "https://example.com/tutorial", pageTitle: "教程", question: "解释",
  headingPath: [], cloudConsent: true,
  snapshot: { schemaVersion: 1, url: "https://example.com/tutorial", title: "教程", capturedAt: "2026-10-15T00:00:00Z", blocks: [], extraction: { strategy: "article", truncated: false, warnings: [] }, stats: { characterCount: 0, blockCount: 0, codeBlockCount: 0 } },
};
const activity = { type: "tool_finished", eventId: "r1:2", runId: "r1", conversationId: "c1", sourceUrl: payload.sourceUrl, sequence: 2, activityId: "t1", toolName: "read_learning_context", summary: "返回 1 个原文块", error: "", createdAt: "2026-10-15T00:00:00Z" };
const message = { schemaVersion: 1, messageId: "m1", role: "assistant", content: "解释", origin: "ai", createdAt: activity.createdAt, activities: [activity] };
const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe("readonly agent SSE", () => {
  beforeEach(() => {
    vi.stubGlobal("chrome", { storage: { local: { get: vi.fn().mockResolvedValue({ localApiToken: "test" }) } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("parses fragmented real activity frames separately from text", async () => {
    const wire = frame("activity", activity) + frame("delta", { text: "解释" }) + frame("done", { schemaVersion: 1, conversationId: "c1", message });
    const encoded = new TextEncoder().encode(wire);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < encoded.length; i += 7) controller.enqueue(encoded.slice(i, i + 7));
      controller.close();
    } }))));
    const onActivity = vi.fn(); const onText = vi.fn();
    const result = await streamStudyChat(payload, onText, undefined, onActivity);
    expect(result.ok).toBe(true);
    expect(onActivity).toHaveBeenCalledWith(activity);
    expect(onText).toHaveBeenCalledExactlyOnceWith("解释");
  });

  it.each([{ ...activity, conversationId: "other" }, { ...activity, sourceUrl: "https://other.com" }, { ...activity, sequence: -1 }])("rejects cross-source or malformed activity", async (event) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(frame("activity", event))));
    const callback = vi.fn();
    expect((await streamStudyChat(payload, vi.fn(), undefined, callback)).ok).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it("restores persisted activity as a collapsed trace", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 1, conversationId: "c1", sessionId: "s1", sourceUrl: payload.sourceUrl, pageTitle: "教程", messages: [message] }))));
    const result = await getStudyConversation("c1");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("restoration failed");
    const trace = renderActivityTrace(result.response.messages[0].activities!);
    expect(trace.open).toBe(false);
    expect(trace.textContent).toContain("返回 1 个原文块");
  });
});
