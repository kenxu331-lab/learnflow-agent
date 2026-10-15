import type { AnnotationPlanResponse } from "./types";

export interface KnowledgeReference { knowledgeId: string; version: number }
export interface ArchiveConfirmation {
  confirmationId: string; conversationId: string; chapterId: string; sourceUrl: string;
  state: "pending" | "applying" | "interrupted" | "published" | "noop" | "cancelled" | "expired" | "needs_review" | "failed";
  planDigest: string; targetRelativePath: string; expectedFileRevision: string;
  plannedContentHash: string; diff: string; plans: AnnotationPlanResponse[];
  message: string; createdAt: string; expiresAt: string; approvedAt?: string | null;
  results: { status: "published" | "noop" | "needs_review" | "failed"; intentId?: string | null; plan: AnnotationPlanResponse; failureCode?: string | null }[];
}
export function isArchiveConfirmation(value: unknown): value is ArchiveConfirmation {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const plan = (p: unknown): p is AnnotationPlanResponse => {
    if (!p || typeof p !== "object") return false;
    const row = p as Record<string, unknown>;
    if (!["planId", "knowledgeId", "targetRelativePath", "diff", "conflictStatus"].every((key) => typeof row[key] === "string") || !Number.isSafeInteger(row.knowledgeVersion) || !Array.isArray(row.headingPath) || !row.headingPath.every((h) => typeof h === "string")) return false;
    if (row.plannedEdit === null) return true;
    if (!row.plannedEdit || typeof row.plannedEdit !== "object") return false;
    const edit = row.plannedEdit as Record<string, unknown>;
    return ["insert", "update", "noop", "needs_review"].includes(String(edit.action)) && typeof edit.annotation === "string" && (edit.anchorLine === null || Number.isSafeInteger(edit.anchorLine));
  };
  const valid = ["confirmationId", "conversationId", "chapterId", "sourceUrl", "planDigest", "targetRelativePath", "expectedFileRevision", "plannedContentHash", "diff", "message", "createdAt", "expiresAt"].every((key) => typeof v[key] === "string") &&
    ["pending", "applying", "interrupted", "published", "noop", "cancelled", "expired", "needs_review", "failed"].includes(String(v.state)) &&
    /^[0-9a-f]{64}$/.test(String(v.planDigest)) && Array.isArray(v.plans) && v.plans.length > 0 && v.plans.every(plan) &&
    Array.isArray(v.results) && v.results.every((r: unknown) => !!r && typeof r === "object" && "status" in r && ["published", "noop", "needs_review", "failed"].includes(String(r.status)) && "plan" in r && plan(r.plan));
  if (!valid) return false;
  const view = value as ArchiveConfirmation;
  if (["published", "noop"].includes(view.state)) return typeof view.approvedAt === "string" && view.results.length === view.plans.length && new Set(view.results.map((r) => `${r.plan.knowledgeId}:${r.plan.knowledgeVersion}`)).size === view.plans.length && view.results.every((r) => ["published", "noop"].includes(r.status) && r.plan.targetRelativePath === view.targetRelativePath && view.plans.some((p) => p.knowledgeId === r.plan.knowledgeId && p.knowledgeVersion === r.plan.knowledgeVersion)) && (view.state !== "noop" || view.results.every((r) => r.status === "noop"));
  return true;
}

// An in-memory bridge for legacy slash/card callers. Only the real preview
// approval button populates it; durable authority remains in the backend.
const approvals = new Map<string, ArchiveConfirmation>();
const executions = new Map<string, Promise<unknown>>();
export function bindArchiveApproval(view: ArchiveConfirmation): void {
  view.plans.forEach((plan) => approvals.set(`${plan.knowledgeId}:${plan.knowledgeVersion}`, view));
}
export function clearArchiveApproval(id: string, version: number): void { approvals.delete(`${id}:${version}`); }
export function archiveApproval(id: string, version: number): ArchiveConfirmation | undefined { return approvals.get(`${id}:${version}`); }
export async function onceApproved<T>(id: string, execute: () => Promise<T>): Promise<T> {
  const existing = executions.get(id);
  if (existing) return existing as Promise<T>;
  const result = execute(); executions.set(id, result);
  const value = await result;
  if (typeof value === "object" && value && "ok" in value && value.ok === false) executions.delete(id);
  return value;
}
