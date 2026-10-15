import type { PublishCandidateResponse } from "./types";

export interface KnowledgeItemView {
  knowledgeId: string; version: number; topic: string; kind: string; body: string;
  sourceUrl: string; verificationStatus: string; publishStatus: string;
  evidenceGapReason?: string | null; archived: boolean;
  claims: { claimId: string; text: string; kind: string; verificationStatus: string; verificationReason?: string | null; evidenceIds: string[] }[];
  duplicateIds: string[]; similarTo: string[];
  publishCandidate?: PublishCandidateResponse | null;
}
export interface KnowledgeTaskView {
  taskId?: string | null; conversationId: string; chapterId: string; sourceUrl: string;
  state: string; message: string; noNewContent: boolean; items: KnowledgeItemView[];
  duplicateCount: number; updatedAt: string;
}
export const pendingKnowledgeStates = new Set(["submitting", "waiting_previous", "queued", "extracting", "verifying"]);

export function isKnowledgeView(value: unknown): value is KnowledgeTaskView {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["conversationId", "chapterId", "sourceUrl", "state", "message", "updatedAt"].every((key) => typeof v[key] === "string") &&
    typeof v.noNewContent === "boolean" && typeof v.duplicateCount === "number" && Array.isArray(v.items) && v.items.every((item: unknown) => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return ["knowledgeId", "topic", "kind", "body", "sourceUrl", "verificationStatus", "publishStatus"].every((key) => typeof row[key] === "string") && typeof row.version === "number" && typeof row.archived === "boolean" &&
        Array.isArray(row.claims) && row.claims.every((claim: unknown) => {
          if (!claim || typeof claim !== "object") return false;
          const c = claim as Record<string, unknown>;
          return ["claimId", "text", "kind", "verificationStatus"].every((key) => typeof c[key] === "string") &&
            Array.isArray(c.evidenceIds) && c.evidenceIds.every((id) => typeof id === "string") &&
            (c.verificationReason === undefined || c.verificationReason === null || typeof c.verificationReason === "string");
        }) &&
        Array.isArray(row.duplicateIds) && row.duplicateIds.every((id) => typeof id === "string") && Array.isArray(row.similarTo) && row.similarTo.every((id) => typeof id === "string");
    });
}
