import type { KnowledgeTaskView } from "../backend/knowledge-view";
import type { KnowledgeReference } from "../backend/archive-types";

/** Read-only cards. Creating or expanding a card never archives anything. */
export function renderKnowledgeResults(view: KnowledgeTaskView, markdown: (host: HTMLElement, text: string) => void, selection?: { selected: Set<string>; toggle: (ref: KnowledgeReference, checked: boolean) => void }): HTMLElement {
  const root = document.createElement("section"); root.className = "knowledge-results";
  if (view.taskId) root.dataset.taskId = view.taskId;
  root.dataset.state = view.state;
  const status = document.createElement("p"); status.setAttribute("role", "status");
  status.textContent = `${view.message}${view.duplicateCount ? ` 已合并展示 ${view.duplicateCount} 条相同内容，原记录保留。` : ""}`;
  root.append(status);
  const list = document.createElement("div");
  const renderItems = () => {
    list.replaceChildren();
    for (const item of view.items) {
      const card = document.createElement("section"); card.className = "knowledge-result-card";
      card.dataset.knowledgeKey = `${item.knowledgeId}:${item.version}`;
      if (selection && item.publishCandidate && !item.archived) {
        const label = document.createElement("label");
        const checkbox = document.createElement("input"); checkbox.type = "checkbox";
        checkbox.dataset.archiveSelection = `${item.knowledgeId}:${item.version}`;
        checkbox.checked = selection.selected.has(checkbox.dataset.archiveSelection);
        checkbox.addEventListener("change", () => selection.toggle({ knowledgeId: item.knowledgeId, version: item.version }, checkbox.checked));
        label.append(checkbox, document.createTextNode(" 选择此知识用于归档")); card.append(label);
      }
      const title = document.createElement("h3"); title.textContent = item.topic;
      const meta = document.createElement("p");
      meta.textContent = `${item.archived ? "已归档" : "未归档"} · 核验：${item.verificationStatus} · 资格：${item.publishStatus}`;
      const body = document.createElement("div"); markdown(body, item.body);
      const detail = document.createElement("details"); const summary = document.createElement("summary"); summary.textContent = "查看核验依据";
      detail.append(summary);
      for (const claim of item.claims) {
        const line = document.createElement("p"); line.textContent = `${claim.text}\n${claim.verificationStatus}：${claim.verificationReason ?? "暂无核验说明"}\n证据：${claim.evidenceIds.join("、")}`;
        detail.append(line);
      }
      if (item.evidenceGapReason) { const gap = document.createElement("p"); gap.textContent = `证据问题：${item.evidenceGapReason}`; detail.append(gap); }
      const source = document.createElement("p"); source.textContent = `来源：${item.sourceUrl}`;
      card.append(title, meta, body, source, detail);
      if (item.similarTo.length || item.duplicateIds.length) {
        const note = document.createElement("small"); note.textContent = item.similarTo.length ? "存在近似知识，保留分别展示，请人工判断差异。" : `另有 ${item.duplicateIds.length} 条相同内容，已折叠展示。`;
        card.append(note);
      }
      list.append(card);
    }
    if (!view.items.length) list.textContent = "当前没有可展示的知识候选。";
  };
  if (view.noNewContent) {
    const question = document.createElement("p"); question.textContent = "没有可提炼的新知识，是否查看最近已有内容？";
    const yes = document.createElement("button"); yes.type = "button"; yes.textContent = "是";
    const no = document.createElement("button"); no.type = "button"; no.textContent = "否";
    yes.addEventListener("click", () => { renderItems(); yes.disabled = true; });
    no.addEventListener("click", () => { list.replaceChildren(); yes.disabled = false; });
    root.append(question, yes, no);
  } else renderItems();
  root.append(list);
  return root;
}
