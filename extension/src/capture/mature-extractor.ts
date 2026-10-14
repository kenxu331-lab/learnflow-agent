import { extractWithMatureParsers } from "./mature-parser";

const RESULT_KEY = "__LEARNFLOW_MATURE_SNAPSHOT__";

function publishSnapshot(): void {
  const snapshot = extractWithMatureParsers(document);
  if (snapshot) (globalThis as Record<string, unknown>)[RESULT_KEY] = snapshot;
}

publishSnapshot();
