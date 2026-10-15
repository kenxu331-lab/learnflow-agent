import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishCandidateResponse } from "../src/backend/types";
import { highlightCode, renderActivityTrace } from "../src/sidepanel/message-presentation";

const preview = vi.hoisted(() => vi.fn());
vi.mock("../src/backend/api-client", () => ({ prepareArchive: preview, getArchive: preview, decideArchive: vi.fn() }));
import { confirmArchivePreview, initializeArchiveDialog } from "../src/sidepanel/archive-preview";

const candidate = { knowledgeId: "k1", knowledgeVersion: 1, body: "真实候选" } as PublishCandidateResponse;
function dialogDom() {
  document.body.innerHTML = `<dialog id="archive-confirm"><div id="archive-plans"></div><p id="archive-confirm-status"></p><button id="archive-approve"></button><button id="archive-cancel"></button><button id="archive-confirm-close"></button></dialog>`;
  const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = (value = "") => { dialog.returnValue = value; dialog.open = false; dialog.dispatchEvent(new Event("close")); };
  initializeArchiveDialog(() => "c1");
  return dialog;
}

describe("V3 real archive preview", () => {
  beforeEach(() => preview.mockReset());
  it("shows the backend file/line/diff and requires an explicit confirmation", async () => {
    dialogDom();
    preview.mockResolvedValue({ ok: true, response: { confirmationId: "a1", conversationId: "c1", state: "pending", expiresAt: "2099-01-01", message: "待确认", diff: "+ 真实注解", plans: [{ knowledgeId: "k1", knowledgeVersion: 1, planId: "p1", targetRelativePath: "LearnFlow/doc.md", headingPath: ["依赖注入"], conflictStatus: "clear", conflictReason: null, plannedEdit: { action: "insert", anchorLine: 12 } }] } });
    const decision = confirmArchivePreview([candidate]);
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>("#archive-approve")!.disabled).toBe(false));
    expect(document.querySelector("#archive-plans")!.textContent).toContain("LearnFlow/doc.md");
    expect(document.querySelector("#archive-plans")!.textContent).toContain("第 12 行");
    expect(document.querySelector("pre")!.textContent).toBe("+ 真实注解");
    document.querySelector<HTMLButtonElement>("#archive-approve")!.click();
    expect(await decision).toBe(true);
    expect(preview).toHaveBeenCalledTimes(1);
  });
  it("keeps conflict confirmation disabled and returns false on cancel", async () => {
    dialogDom();
    preview.mockResolvedValue({ ok: true, response: { confirmationId: "a1", conversationId: "c1", state: "needs_review", expiresAt: "2099-01-01", message: "原文锚点发生变化", diff: "", plans: [{ planId: "p1", targetRelativePath: "LearnFlow/doc.md", headingPath: [], conflictStatus: "needs_review", conflictReason: "原文锚点发生变化", plannedEdit: null }] } });
    const decision = confirmArchivePreview([candidate]);
    await vi.waitFor(() => expect(document.body.textContent).toContain("原文锚点发生变化"));
    expect(document.querySelector<HTMLButtonElement>("#archive-approve")!.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>("#archive-cancel")!.click();
    expect(await decision).toBe(false);
  });
});

describe("V3 message presentation", () => {
  it("highlights tutorial code while preserving literal markup", () => {
    const host = document.createElement("div");
    const pre = document.createElement("pre"); const code = document.createElement("code");
    code.textContent = 'def hello():\n    return "<img onerror=evil()>"'; pre.append(code); host.append(pre);
    highlightCode(host);
    expect(host.querySelector("img")).toBeNull();
    expect(host.querySelector(".token-keyword")!.textContent).toBe("def");
    expect(code.textContent).toContain("<img onerror=evil()>");
  });
  it("renders future runtime events collapsed without emitting any execution", () => {
    const trace = renderActivityTrace([{ type: "tool_failed", activityId: "a", toolName: "preview_archive", error: "冲突", createdAt: "2026-10-14" }]);
    expect(trace.open).toBe(false);
    expect(trace.textContent).toContain("冲突");
  });
});
