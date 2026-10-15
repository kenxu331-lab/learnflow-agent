import { prepareArchive, getArchive, decideArchive } from "../backend/api-client";
import { bindArchiveApproval, clearArchiveApproval, type ArchiveConfirmation } from "../backend/archive-types";
import type { PublishCandidateResponse } from "../backend/types";

let conversation = (): string | undefined => undefined;
let preparing = false;

function showFailure(message: string): void {
  const dialog = document.querySelector<HTMLDialogElement>("#archive-confirm");
  const status = document.querySelector<HTMLElement>("#archive-confirm-status");
  const approve = document.querySelector<HTMLButtonElement>("#archive-approve");
  document.querySelector("#archive-plans")?.replaceChildren();
  if (status) status.textContent = message;
  if (approve) approve.disabled = true;
  if (dialog && !dialog.open) dialog.showModal();
}

/** Read-only preview. Confirmation is returned to the caller, which performs commit. */
export async function confirmArchivePreview(candidates: PublishCandidateResponse[]): Promise<boolean> {
  if (preparing) return false;
  const conversationId = conversation();
  if (!conversationId) { showFailure("请先恢复当前章节会话，再预览归档。"); return false; }
  candidates.forEach((candidate) => clearArchiveApproval(candidate.knowledgeId, candidate.knowledgeVersion));
  const approve = document.querySelector<HTMLButtonElement>("#archive-approve");
  if (approve) approve.disabled = true;
  preparing = true;
  try {
    const result = await prepareArchive(conversationId, candidates.map((candidate) => ({ knowledgeId: candidate.knowledgeId, version: candidate.knowledgeVersion })));
    if (!result.ok) {
      showFailure(result.error.message);
      return false;
    }
    if (conversation() !== conversationId) return false;
    return await showArchivePreview(result.response);
  } finally { preparing = false; }
}

export async function reviewArchiveConfirmation(view: ArchiveConfirmation): Promise<boolean> {
  const result = await getArchive(view);
  if (!result.ok) { showFailure(result.error.message); return false; }
  if (conversation() && conversation() !== view.conversationId) return false;
  return showArchivePreview(result.response);
}

async function showArchivePreview(view: ArchiveConfirmation): Promise<boolean> {
  const dialog = document.querySelector<HTMLDialogElement>("#archive-confirm");
  const list = document.querySelector<HTMLElement>("#archive-plans");
  const approve = document.querySelector<HTMLButtonElement>("#archive-approve");
  const status = document.querySelector<HTMLElement>("#archive-confirm-status");
  if (!dialog || !list || !approve || !status) return false;
  if (dialog.open) return false;
  list.replaceChildren();
  approve.disabled = true;
  status.textContent = view.message;
  dialog.showModal();
  let canApprove = false;
  const decision = new Promise<boolean>((resolve) => {
    const onClose = async () => {
      approve.removeEventListener("click", onApprove);
      if (dialog.returnValue === "cancelled") await decideArchive(view, "cancel");
      resolve(dialog.returnValue === "confirmed" && canApprove);
    };
    const onApprove = () => { if (canApprove) { bindArchiveApproval(view); dialog.close("confirmed"); } };
    dialog.returnValue = "";
    dialog.addEventListener("close", onClose, { once: true });
    approve.addEventListener("click", onApprove);
  });
  const diff = document.createElement("pre"); diff.textContent = view.diff || "内容已存在，无需重复写入。";
  list.append(diff);
  for (const plan of view.plans) {
    const card = document.createElement("section");
    card.className = "archive-plan";
    const title = document.createElement("strong");
    title.textContent = plan.plannedEdit?.annotation ?? "知识归档";
    const target = document.createElement("p");
      target.textContent = `文件：${plan.targetRelativePath}\n位置：${plan.headingPath.join(" / ")} · ${plan.plannedEdit?.anchorLine ? `第 ${plan.plannedEdit.anchorLine} 行` : "来源锚点"}`;
      target.style.whiteSpace = "pre-wrap";
    card.prepend(title, target);
    list.append(card);
  }
  canApprove = ["pending", "interrupted"].includes(view.state) && Date.parse(view.expiresAt) > Date.now() && view.plans.every((plan) => plan.conflictStatus === "clear" && plan.plannedEdit);
  approve.disabled = !canApprove;
  status.textContent = canApprove ? `已准备 ${view.plans.length} 条知识。确认后才会写入笔记。` : view.message;
  return decision;
}

export function initializeArchiveDialog(context?: () => string | undefined): void {
  if (context) conversation = context;
  const dialog = document.querySelector<HTMLDialogElement>("#archive-confirm");
  document.getElementById("archive-confirm-close")?.addEventListener("click", () => dialog?.close("later"));
  document.getElementById("archive-cancel")?.addEventListener("click", () => dialog?.close("cancelled"));
}
