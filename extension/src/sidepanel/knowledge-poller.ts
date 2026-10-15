import { pendingKnowledgeStates } from "../backend/knowledge-view";
import type { StudyMessage } from "../backend/types";

/** Poll saved messages only; never submit or rerun a model/tool task. */
export class KnowledgeResultPoller {
  private pending = new Set<string>();
  private timer?: number;
  private refreshing = false;
  constructor(private busy: () => boolean, private refresh: () => Promise<void>) {}

  update(messages: StudyMessage[], replace = true): void {
    if (replace) this.pending.clear();
    for (const message of messages) {
      if (message.knowledge && pendingKnowledgeStates.has(message.knowledge.state)) this.pending.add(message.messageId);
      else this.pending.delete(message.messageId);
    }
    if (!this.pending.size && this.timer !== undefined) {
      window.clearInterval(this.timer); this.timer = undefined;
    }
    if (this.pending.size && this.timer === undefined) this.timer = window.setInterval(() => {
      if (this.busy() || this.refreshing) return;
      this.refreshing = true;
      void this.refresh().finally(() => { this.refreshing = false; });
    }, 3000);
  }
  dispose(): void { this.update([]); }
}
