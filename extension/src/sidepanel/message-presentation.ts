import type { StudyActivityEvent } from "./activity-types";

/** Small safe lexer for common tutorial code. Never interprets code as HTML. */
export function highlightCode(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>("pre code").forEach((code) => {
    const text = code.textContent ?? "";
    code.replaceChildren();
    const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|#[^\n]*|\b(?:def|class|async|await|return|import|from|if|else|elif|for|while|try|except|with|as|const|let|function|new|true|false|None|True|False|throw|public|private|void)\b|\b\d+(?:\.\d+)?\b)/g;
    let cursor = 0;
    for (const match of text.matchAll(tokens)) {
      code.append(document.createTextNode(text.slice(cursor, match.index)));
      const token = document.createElement("span");
      const value = match[0];
      token.className = `token-${/^["']/.test(value) ? "string" : /^(#|\/\/)/.test(value) ? "comment" : /^\d/.test(value) ? "number" : "keyword"}`;
      token.textContent = value; code.append(token); cursor = match.index + value.length;
    }
    code.append(document.createTextNode(text.slice(cursor)));
  });
}

/** Render execution facts only, never model reasoning or fabricated progress. */
export function renderActivityTrace(events: StudyActivityEvent[]): HTMLDetailsElement {
  const trace = document.createElement("details"); trace.className = "activity-trace";
  const summary = document.createElement("summary"); summary.textContent = `执行过程 · ${events.length} 个事件`;
  const list = document.createElement("div");
  for (const event of events) {
    const row = document.createElement("p");
    const labels = { tool_started: "调用工具", tool_finished: "工具完成", tool_failed: "工具失败", confirmation_required: "等待确认", task_completed: "任务完成", task_failed: "任务未完成", task_waiting: "等待知识任务" };
    row.textContent = `${labels[event.type]}${"toolName" in event && event.toolName ? ` · ${event.toolName}` : ""}${"summary" in event && event.summary ? ` · ${event.summary}` : ""}${"error" in event && event.error ? `：${event.error}` : ""}`;
    list.append(row);
  }
  trace.append(summary, list); return trace;
}
