export type CommandIntent =
  | { kind: "dialogue" }
  | { kind: "extract" }
  | { kind: "archive-list" }
  | { kind: "archive-one"; index: number }
  | { kind: "archive-all" }
  | { kind: "confirm-archive" }
  | { kind: "cancel" }
  | {
      kind: "suggestion";
      requested: string;
      correctedCommand: string;
      message: string;
    }
  | { kind: "invalid-command"; message: string };

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase().replaceAll("　", " ");
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0];
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      row[rightIndex] = Math.min(
        row[rightIndex] + 1,
        row[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[right.length];
}

function naturalLanguageIntent(value: string): CommandIntent | undefined {
  const text = normalize(value).replace(/[。！!？?，,：:；;]+$/g, "");
  if (/^(?:请|帮我)?(?:提炼|总结)(?:当前对话|本次对话|知识)?$/.test(text)) {
    return { kind: "extract" };
  }
  if (
    /^(?:请|帮我)?(?:把|将)?(?:这些|当前|最近)?(?:知识|候选)?(?:都|全部|所有)?归档(?:到笔记)?$/.test(
      text,
    )
  ) {
    return { kind: "archive-all" };
  }
  if (/^(?:确认归档|确认)$/.test(text)) {
    return { kind: "confirm-archive" };
  }
  if (/^(?:取消归档|取消)$/.test(text)) {
    return { kind: "cancel" };
  }
  return undefined;
}

export function routeCommandIntent(value: string): CommandIntent {
  const text = value.trim();
  if (!text.startsWith("/")) {
    return naturalLanguageIntent(text) ?? { kind: "dialogue" };
  }

  const match = text.match(/^\/\s*([^\s]+)(?:\s+(.+))?$/);
  if (!match) {
    return {
      kind: "invalid-command",
      message: "指令格式无法识别。支持：/提炼、/归档、/归档 1、/归档 all。",
    };
  }

  const name = normalize(match[1]);
  const argument = normalize(match[2] ?? "");
  if (name === "提炼") {
    return argument
      ? { kind: "invalid-command", message: "提炼指令不需要参数，请输入 /提炼。" }
      : { kind: "extract" };
  }
  if (["确认归档", "确认"].includes(name) && !argument) {
    return { kind: "confirm-archive" };
  }
  if (["取消归档", "取消"].includes(name) && !argument) {
    return { kind: "cancel" };
  }
  if (["查看提炼", "知识", "知识列表"].includes(name) && !argument) {
    return { kind: "archive-list" };
  }
  if (name !== "归档") {
    return {
      kind: "invalid-command",
      message: `无法识别指令 /${match[1]}。支持：/提炼、/归档、/归档 1、/归档 all。`,
    };
  }
  if (!argument) return { kind: "archive-list" };
  if (/^(?:all|全部|所有)$/i.test(argument)) return { kind: "archive-all" };
  if (/^(?:第\s*)?\d+\s*条?$/.test(argument)) {
    const number = Number(argument.replace(/[^0-9]/g, ""));
    return number > 0
      ? { kind: "archive-one", index: number }
      : { kind: "invalid-command", message: "归档序号必须从 1 开始。" };
  }
  if (editDistance(argument, "all") <= 1) {
    return {
      kind: "suggestion",
      requested: argument,
      correctedCommand: "/归档 all",
      message: `检测到你可能想执行“归档全部”，但参数“${argument}”不正确。`,
    };
  }
  return {
    kind: "invalid-command",
    message: "无法识别归档参数。请使用 /归档 1、/归档 all 或 /归档 全部。",
  };
}
