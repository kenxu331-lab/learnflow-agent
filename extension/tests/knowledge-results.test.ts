import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeResultPoller } from "../src/sidepanel/knowledge-poller";
import { renderKnowledgeResults } from "../src/sidepanel/knowledge-results";
import { isKnowledgeView, type KnowledgeTaskView } from "../src/backend/knowledge-view";
import type { StudyMessage } from "../src/backend/types";

const view: KnowledgeTaskView = {
  taskId: "t1", conversationId: "c1", chapterId: "ch1", sourceUrl: "https://example.com",
  state: "completed", message: "提炼与核验完成，未归档。", noNewContent: false,
  duplicateCount: 1, updatedAt: "2026-10-15T00:00:00Z",
  items: [{ knowledgeId: "k1", version: 1, topic: "依赖注入", kind: "concept", body: "Depends(fn) 由框架调用。", sourceUrl: "https://example.com", verificationStatus: "supported", publishStatus: "eligible", archived: false, duplicateIds: ["k2"], similarTo: [], claims: [{ claimId: "claim1", text: "由框架调用", kind: "tutorial_fact", verificationStatus: "supported", verificationReason: "教程 block-3 支持。", evidenceIds: ["ev1"] }] }],
};
const message = (id: string, knowledge?: KnowledgeTaskView): StudyMessage => ({ schemaVersion: 1, messageId: id, role: "assistant", content: "结果", origin: "ai", createdAt: view.updatedAt, knowledge });
const markdown = (host: HTMLElement, text: string) => { host.textContent = text; };

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

describe("real knowledge result cards", () => {
  it("shows actual claim status and dedup metadata without archive side effects", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const root = renderKnowledgeResults(view, markdown);
    expect(root.textContent).toContain("未归档");
    expect(root.querySelectorAll(".knowledge-result-card")).toHaveLength(1);
    root.querySelector<HTMLDetailsElement>("details")!.open = true;
    expect(root.textContent).toContain("教程 block-3 支持");
    expect(root.textContent).toContain("已合并展示 1 条相同内容");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("no-new-content asks yes/no and viewing existing knowledge sends no requests", () => {
    const root = renderKnowledgeResults({ ...view, state: "no_new_events", noNewContent: true }, markdown);
    document.body.append(root);
    expect(root.querySelectorAll(".knowledge-result-card")).toHaveLength(0);
    const buttons = root.querySelectorAll<HTMLButtonElement>("button");
    expect([...buttons].map((button) => button.textContent)).toEqual(["是", "否"]);
    buttons[0].click();
    expect(root.querySelectorAll(".knowledge-result-card")).toHaveLength(1);
    buttons[1].click();
    expect(root.querySelectorAll(".knowledge-result-card")).toHaveLength(0);
  });

  it("preserves needs_review reasons and treats untrusted tool text as data", () => {
    const root = renderKnowledgeResults({ ...view, state: "needs_review", items: [{ ...view.items[0], topic: "<img src=x onerror=evil()>", verificationStatus: "insufficient_evidence", publishStatus: "not_eligible", evidenceGapReason: "anchor_unresolved", claims: [{ ...view.items[0].claims[0], verificationStatus: "insufficient_evidence", verificationReason: "缺少证据，不能归档。" }] }] }, markdown);
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("不能归档");
    expect(root.textContent).toContain("anchor_unresolved");
  });

  it("validates persisted knowledge payloads", () => {
    expect(isKnowledgeView(view)).toBe(true);
    expect(isKnowledgeView({ ...view, items: [{ topic: "fake success" }] })).toBe(false);
  });
});

describe("knowledge result refresh lifecycle", () => {
  it("restores waiting tasks and refreshes only while pending and idle", async () => {
    vi.useFakeTimers();
    let busy = false;
    const refresh = vi.fn().mockResolvedValue(undefined);
    const poller = new KnowledgeResultPoller(() => busy, refresh);
    poller.update([message("m1", { ...view, state: "verifying" })]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    busy = true;
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(1);
    busy = false;
    // A normal follow-up must not forget an older pending knowledge request.
    poller.update([message("m2")], false);
    await vi.advanceTimersByTimeAsync(3000);
    expect(refresh).toHaveBeenCalledTimes(2);
    poller.update([message("m1", view), message("m2")]);
    await vi.advanceTimersByTimeAsync(6000);
    expect(refresh).toHaveBeenCalledTimes(2);
    poller.dispose();
  });

  it("does not overlap slow refreshes and stops on chapter switch", async () => {
    vi.useFakeTimers();
    let resolve: (() => void) | undefined;
    const refresh = vi.fn().mockImplementation(() => new Promise<void>((done) => { resolve = done; }));
    const poller = new KnowledgeResultPoller(() => false, refresh);
    poller.update([message("m1", { ...view, state: "queued" })]);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    poller.dispose();
    resolve?.();
    await vi.advanceTimersByTimeAsync(6000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
