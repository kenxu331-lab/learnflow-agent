import type { ArchiveConfirmation } from "../backend/archive-types";

export function renderArchiveCard(view: ArchiveConfirmation, review: (view: ArchiveConfirmation, status: HTMLElement) => Promise<void>): HTMLElement {
  const card = document.createElement("section"); card.className = "archive-confirmation-card";
  card.dataset.confirmationId = view.confirmationId;
  const title = document.createElement("h3"); title.textContent = `归档确认 · ${view.plans.length} 条知识`;
  const path = document.createElement("p"); path.textContent = `目标文件：${view.targetRelativePath}`;
  const status = document.createElement("p"); status.setAttribute("role", "status"); status.textContent = view.message;
  const positions = document.createElement("p"); positions.textContent = view.plans.map((plan) => `${plan.knowledgeId} · 版本 ${plan.knowledgeVersion} · ${plan.headingPath.join(" / ")} · 第 ${plan.plannedEdit?.anchorLine ?? "?"} 行`).join("\n");
  const button = document.createElement("button"); button.type = "button";
  button.textContent = ["pending", "interrupted", "applying"].includes(view.state) ? "查看 Diff 并确认归档" : "查看归档结果";
  button.addEventListener("click", async () => { button.disabled = true; try { await review(view, status); } finally { button.disabled = false; } });
  card.append(title, path, positions, status, button);
  return card;
}
