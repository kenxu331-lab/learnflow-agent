import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commitAnnotation, decideArchive, prepareArchive, selectArchiveKnowledge } from "../src/backend/api-client";
import { clearArchiveApproval, isArchiveConfirmation, type ArchiveConfirmation } from "../src/backend/archive-types";
import type { PublishCandidateResponse } from "../src/backend/types";
import { confirmArchivePreview, initializeArchiveDialog, reviewArchiveConfirmation } from "../src/sidepanel/archive-preview";
import { renderArchiveCard } from "../src/sidepanel/archive-card";
import { renderKnowledgeResults } from "../src/sidepanel/knowledge-results";
import type { KnowledgeTaskView } from "../src/backend/knowledge-view";

let sequence = 0;
function fixture(): ArchiveConfirmation {
  return { confirmationId: `approval-${++sequence}`, conversationId: "c1", chapterId: "chapter1", sourceUrl: "https://example.com/doc", state: "pending", planDigest: "a".repeat(64), targetRelativePath: "LearnFlow/doc.md", expectedFileRevision: "b".repeat(64), plannedContentHash: "c".repeat(64), diff: "+ 知识一\n+ 知识二", message: "尚未写入，请核对 Diff。", createdAt: "2026-10-15T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z", approvedAt: null, results: [], plans: [1, 2].map((index) => ({ planId: `p${index}`, knowledgeId: `k${index}`, knowledgeVersion: 1, targetRelativePath: "LearnFlow/doc.md", headingPath: [`小节${index}`], conflictStatus: "clear", conflictReason: null, diff: "", plannedEdit: { action: "insert", anchorLine: index * 10, annotation: `知识${index}` } })) };
}
const refs = [1, 2].map((i) => ({ knowledgeId: `k${i}`, version: 1 }));
const candidates = refs.map((ref) => ({ knowledgeId: ref.knowledgeId, knowledgeVersion: ref.version })) as PublishCandidateResponse[];
function dom() {
  document.body.innerHTML = `<dialog id="archive-confirm"><div id="archive-plans"></div><p id="archive-confirm-status"></p><button id="archive-approve"></button><button id="archive-cancel"></button><button id="archive-confirm-close"></button></dialog>`;
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = (value = "") => { dialog.returnValue = value; dialog.open = false; dialog.dispatchEvent(new Event("close")); };
  initializeArchiveDialog(() => "c1");
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  dom();
  candidates.forEach((candidate) => clearArchiveApproval(candidate.knowledgeId, candidate.knowledgeVersion));
  fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("chrome", { storage: { local: { get: vi.fn().mockResolvedValue({ localApiToken: "local" }) } } });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

describe("persisted archive approval boundary", () => {
  it("preview and rendering do not commit; one approval commits the batch once", async () => {
    const view = fixture();
    const receipt: ArchiveConfirmation = { ...view, state: "published", approvedAt: view.createdAt, message: "已归档到 LearnFlow/doc.md", results: view.plans.map((plan) => ({ status: "published", intentId: `intent-${plan.knowledgeId}`, plan })) };
    fetchMock.mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith("/prepare") ? view : receipt))));
    const choice = confirmArchivePreview(candidates);
    await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>("dialog")!.open).toBe(true));
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#archive-approve")!.disabled).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await commitAnnotation("k1", 1)).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector("pre")!.textContent).toContain("知识二");
    document.querySelector<HTMLButtonElement>("#archive-approve")!.click();
    expect(await choice).toBe(true);
    const first = await commitAnnotation("k1", 1);
    const second = await commitAnnotation("k2", 1);
    expect(first.ok && first.response.status).toBe("published");
    expect(second.ok && second.response.status).toBe("published");
    const decisions = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/decision"));
    expect(decisions).toHaveLength(1);
    expect(JSON.parse(decisions[0][1].body)).toEqual({ conversationId: "c1", planDigest: view.planDigest, decision: "confirm" });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/annotations/commit"))).toBe(false);
  });

  it("closing preview leaves the confirmation pending and performs no decision", async () => {
    const view = fixture(); fetchMock.mockResolvedValue(new Response(JSON.stringify(view)));
    const choice = confirmArchivePreview(candidates);
    await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>("dialog")!.open).toBe(true));
    document.querySelector<HTMLButtonElement>("#archive-confirm-close")!.click();
    expect(await choice).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("explicit cancellation records cancel, never confirm", async () => {
    const view = fixture(); fetchMock.mockImplementation((url: string) => Promise.resolve(new Response(JSON.stringify(url.endsWith("/decision") ? { ...view, state: "cancelled" } : view))));
    const choice = confirmArchivePreview(candidates);
    await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>("dialog")!.open).toBe(true));
    document.querySelector<HTMLButtonElement>("#archive-cancel")!.click();
    expect(await choice).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).decision).toBe("cancel");
  });

  it("restored expired or changed plans cannot be approved", async () => {
    const view = { ...fixture(), state: "needs_review" as const, message: "文件版本已变化，请重新预览。" };
    fetchMock.mockResolvedValue(new Response(JSON.stringify(view)));
    const choice = reviewArchiveConfirmation(view);
    await vi.waitFor(() => expect(document.querySelector<HTMLDialogElement>("dialog")!.open).toBe(true));
    expect(document.querySelector<HTMLButtonElement>("#archive-approve")!.disabled).toBe(true);
    expect(document.body.textContent).toContain("文件版本已变化");
    document.querySelector<HTMLButtonElement>("#archive-confirm-close")!.click();
    expect(await choice).toBe(false);
  });

  it("surfaces the backend reason when preparing fails instead of doing nothing", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: "target_missing", message: "目标 Markdown 尚未保存。" } }), { status: 409 }));
    expect(await confirmArchivePreview(candidates)).toBe(false);
    expect(document.querySelector<HTMLDialogElement>("dialog")!.open).toBe(true);
    expect(document.body.textContent).toContain("目标 Markdown 尚未保存");
    expect(document.querySelector<HTMLButtonElement>("#archive-approve")!.disabled).toBe(true);
  });

  it("rejects malformed success receipts and wrong-conversation plans", async () => {
    const view = fixture();
    expect(isArchiveConfirmation({ ...view, state: "published", results: [] })).toBe(false);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...view, conversationId: "other" })));
    expect((await prepareArchive("c1", refs)).ok).toBe(false);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...view, planDigest: "d".repeat(64) })));
    expect((await decideArchive(view, "confirm")).ok).toBe(false);
  });

  it("selection stores only stable knowledge IDs and versions, without preparing or writing", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(refs)));
    expect((await selectArchiveKnowledge("c1", refs)).ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain("/archive/selection");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ conversationId: "c1", references: refs });
    const view = fixture(); const review = vi.fn().mockResolvedValue(undefined);
    const card = renderArchiveCard(view, review);
    expect(review).not.toHaveBeenCalled();
    expect(card.textContent).toContain("尚未写入");
    card.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("knowledge checkboxes restore selected versions and only call the selection callback", () => {
    const toggle = vi.fn();
    const knowledge = { conversationId: "c1", chapterId: "ch", sourceUrl: "https://example.com", state: "completed", message: "完成", noNewContent: false, duplicateCount: 0, updatedAt: "2026-10-15", items: [{ knowledgeId: "k1", version: 1, topic: "知识", body: "正文", sourceUrl: "https://example.com", kind: "concept", verificationStatus: "supported", publishStatus: "eligible", archived: false, claims: [], duplicateIds: [], similarTo: [], publishCandidate: candidates[0] }] } as KnowledgeTaskView;
    const card = renderKnowledgeResults(knowledge, (host, text) => { host.textContent = text; }, { selected: new Set(["k1:1"]), toggle });
    const checkbox = card.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    document.body.append(card);
    expect(checkbox.checked).toBe(true);
    checkbox.click();
    expect(toggle).toHaveBeenCalledWith({ knowledgeId: "k1", version: 1 }, false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
