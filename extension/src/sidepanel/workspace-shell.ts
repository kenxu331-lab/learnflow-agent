import { getAnnotationIntents, getKnowledgeDrafts, getKnowledgeJobs, getPublishCandidates } from "../backend/api-client";
import type { PublishCandidateResponse } from "../backend/types";

interface WorkspaceActions {
  command: (text: string) => Promise<unknown>;
  organize: () => Promise<unknown>;
  preview: (candidate: PublishCandidateResponse) => Promise<unknown>;
  source: () => { url?: string; conversationId?: string };
}

export function initializeWorkspaceShell(actions: WorkspaceActions) {
  const notes = document.getElementById("notesView");
  const settings = document.getElementById("settings");
  const shade = document.getElementById("drawer-shade");
  const tools = document.getElementById("tools-menu");
  const toolsButton = document.getElementById("tools-menu-button");
  const advanced = document.getElementById("advanced-tools");
  document.getElementById("drawer-advanced")?.append(...(advanced ? [advanced] : []));
  if (advanced instanceof HTMLDetailsElement) advanced.open = true;
  let refreshGeneration = 0;
  function closeTools() {
    if (tools) tools.hidden = true;
    toolsButton?.setAttribute("aria-expanded", "false");
  }
  function close() {
    closeTools();
    notes?.classList.remove("active");
    if (settings) settings.hidden = true;
    if (shade) shade.hidden = true;
  }
  function open(tab = "notes") {
    closeTools();
    if (settings) settings.hidden = true;
    notes?.classList.add("active");
    if (shade) shade.hidden = false;
    document.querySelectorAll<HTMLElement>("[data-drawer-page]").forEach((page) => {
      page.hidden = page.dataset.drawerPage !== tab;
    });
    document.querySelectorAll<HTMLElement>("[data-drawer-tab]").forEach((button) => {
      button.classList.toggle("selected", button.dataset.drawerTab === tab);
    });
    if (tab === "knowledge") void refreshKnowledge();
    if (tab === "history") void refreshHistory();
  }
  async function refreshKnowledge() {
    const host = document.getElementById("knowledge-drawer-list");
    if (!host) return;
    const generation = ++refreshGeneration;
    const source = actions.source();
    host.textContent = "正在加载知识候选…";
    const result = await getPublishCandidates();
    if (generation !== refreshGeneration || actions.source().url !== source.url) return;
    host.replaceChildren();
    if (!result.ok) { host.textContent = result.error.message; return; }
    const urlKey = (url: string) => { const parsed = new URL(url); parsed.hash = ""; return parsed.toString().replace(/\/$/, ""); };
    const candidates = result.response.filter((item) => source.url && urlKey(item.sourceUrl) === urlKey(source.url));
    for (const candidate of candidates) {
      const card = document.createElement("section");
      card.className = "knowledge-archive-card";
      const title = document.createElement("h3");
      title.textContent = candidate.headingPath.join(" / ") || "章节知识";
      const body = document.createElement("p"); body.textContent = candidate.body;
      const meta = document.createElement("p"); meta.className = "knowledge-archive-topic";
      meta.textContent = `核验：${candidate.verificationStatus} · 版本 ${candidate.knowledgeVersion}`;
      const preview = document.createElement("button"); preview.type = "button"; preview.className = "btn-outline"; preview.textContent = "归档预览";
      preview.addEventListener("click", async () => { preview.disabled = true; try { await actions.preview(candidate); } finally { preview.disabled = false; } });
      card.append(title, body, meta, preview); host.append(card);
    }
    const jobs = await getKnowledgeJobs();
    if (generation !== refreshGeneration || actions.source().url !== source.url) return;
    const chapter = candidates[0]?.chapterId ?? (jobs.ok ? jobs.response.find((job) => job.conversationId === source.conversationId)?.chapterId : undefined);
    if (chapter) {
      const drafts = await getKnowledgeDrafts(chapter);
      if (generation !== refreshGeneration || actions.source().url !== source.url) return;
      if (drafts.ok) for (const draft of drafts.response) {
        const detail = document.createElement("details"); detail.className = "activity-trace";
        const summary = document.createElement("summary"); summary.textContent = `${draft.topic} · 核验依据`;
        const body = document.createElement("div"); body.textContent = draft.body;
        for (const claim of draft.claims) {
          const line = document.createElement("p"); line.textContent = `${claim.text}\n核验：${claim.verificationStatus} ${claim.verificationReason ?? ""}`; body.append(line);
        }
        detail.append(summary, body); host.append(detail);
      }
    }
    if (!host.childElementCount) host.textContent = "当前章节还没有知识候选。可以使用 /提炼。";
  }
  async function refreshHistory() {
    const host = document.getElementById("archive-history-list"); if (!host) return;
    host.textContent = "正在加载真实归档记录…";
    const result = await getAnnotationIntents();
    if (!result.ok) { host.textContent = result.error.message; return; }
    host.replaceChildren();
    for (const intent of result.response) {
      const row = document.createElement("div"); row.className = "archive-result";
      row.textContent = `${intent.status} · ${intent.operation}\n${intent.targetNoteId}\n${intent.failureCode ?? ""}\n${new Date(intent.updatedAt).toLocaleString("zh-CN")}`;
      row.style.whiteSpace = "pre-wrap"; host.append(row);
    }
    if (!result.response.length) host.textContent = "尚无归档记录。";
  }
  toolsButton?.addEventListener("click", () => {
    if (!tools) return;
    tools.hidden = !tools.hidden; toolsButton.setAttribute("aria-expanded", String(!tools.hidden));
  });
  document.querySelectorAll<HTMLElement>("[data-drawer-tab]").forEach((button) => button.addEventListener("click", () => open(button.dataset.drawerTab)));
  document.querySelectorAll<HTMLElement>("[data-workspace-action]").forEach((button) => button.addEventListener("click", async () => {
    closeTools();
    const action = button.dataset.workspaceAction;
    if (action === "extract") { button.setAttribute("disabled", ""); try { await actions.command("/提炼"); } finally { button.removeAttribute("disabled"); } }
    else if (action === "archive") await actions.command("/归档 all");
    else if (action === "section") { open("notes"); await actions.organize(); }
    else open(action);
  }));
  shade?.addEventListener("click", close);
  document.getElementById("notesBtn")?.addEventListener("click", () => open("notes"));
  tools?.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("button")) closeTools();
  });
  document.getElementById("settings-close")?.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });
  return { open, close };
}
