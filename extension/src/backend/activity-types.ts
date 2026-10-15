/** Public execution facts shared by SSE, persisted messages and presentation. */
type Envelope = {
  eventId?: string;
  runId?: string;
  conversationId?: string;
  sourceUrl?: string;
  sequence?: number;
  activityId: string;
  createdAt: string;
};

export type StudyActivityEvent = Envelope & (
  | { type: "tool_started" | "tool_finished"; toolName: string; summary?: string }
  | { type: "tool_failed"; toolName: string; error: string }
  | { type: "confirmation_required"; action: string; summary: string }
  | { type: "task_completed"; summary: string }
  | { type: "task_failed"; error: string }
  | { type: "task_waiting"; summary: string }
);

export function isRuntimeActivity(value: unknown): value is StudyActivityEvent {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return ["tool_started", "tool_finished", "tool_failed", "task_completed", "task_failed", "task_waiting", "confirmation_required"].includes(String(item.type)) &&
    (item.type !== "confirmation_required" || typeof item.action === "string") &&
    ["eventId", "runId", "conversationId", "sourceUrl", "activityId", "createdAt", "toolName", "summary", "error"].every((key) => typeof item[key] === "string") &&
    typeof item.sequence === "number" && Number.isSafeInteger(item.sequence) && item.sequence > 0;
}
