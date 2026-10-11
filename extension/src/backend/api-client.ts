import { isPageSnapshot } from "../capture/capture-service";
import type { PageSnapshot } from "../capture/types";
import type {
  BackendClientResult,
  BackendIngestResponse,
} from "./types";

export const LOCAL_INGEST_URL =
  "http://127.0.0.1:8000/api/v1/pages/ingest";
export const BACKEND_TIMEOUT_MS = 10_000;

function failure(
  code: Exclude<BackendClientResult, { ok: true }>["error"]["code"],
  message: string,
): BackendClientResult {
  return { ok: false, error: { code, message } };
}

function isBackendIngestResponse(value: unknown): value is BackendIngestResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const response = value as Record<string, unknown>;
  const stats = response.stats as Record<string, unknown> | undefined;
  return (
    response.status === "validated" &&
    typeof response.requestId === "string" &&
    response.schemaVersion === 1 &&
    stats !== undefined &&
    typeof stats.characterCount === "number" &&
    typeof stats.codeBlockCount === "number" &&
    typeof stats.blockCount === "number"
  );
}

function statusFailure(status: number): BackendClientResult {
  if (status === 401) {
    return failure("UNAUTHORIZED", "本地服务拒绝了访问 Token。");
  }
  if (status === 413) {
    return failure("PAYLOAD_TOO_LARGE", "页面快照超过本地服务请求体限制。");
  }
  if (status === 415) {
    return failure("UNSUPPORTED_MEDIA_TYPE", "本地服务不接受当前请求格式。");
  }
  if (status === 422) {
    return failure("INVALID_PAYLOAD", "本地服务拒绝了页面快照结构。");
  }
  if (status >= 500) {
    return failure("SERVER_ERROR", "本地服务处理失败，请查看后端日志。");
  }
  return failure("UNKNOWN_ERROR", `本地服务返回 HTTP ${status}。`);
}

export async function ingestPageSnapshot(
  snapshot: PageSnapshot,
): Promise<BackendClientResult> {
  if (!isPageSnapshot(snapshot)) {
    return failure("INVALID_SNAPSHOT", "页面快照结构无效，无法发送。");
  }

  let stored: unknown;
  try {
    stored = await chrome.storage.local.get("localApiToken");
  } catch {
    return failure("STORAGE_ERROR", "无法读取本地服务 Token。");
  }

  const token =
    typeof stored === "object" &&
    stored !== null &&
    "localApiToken" in stored &&
    typeof stored.localApiToken === "string"
      ? stored.localApiToken
      : "";
  if (!token) {
    return failure("NO_TOKEN", "请先保存本地服务 Token。");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const response = await fetch(LOCAL_INGEST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(snapshot),
      signal: controller.signal,
    });

    if (!response.ok) {
      return statusFailure(response.status);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure("INVALID_RESPONSE", "本地服务返回了无效响应。");
    }

    if (!isBackendIngestResponse(body)) {
      return failure("INVALID_RESPONSE", "本地服务响应结构无效。");
    }
    return { ok: true, response: body };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return failure("TIMEOUT", "本地服务请求超时。");
    }
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  } finally {
    clearTimeout(timeoutId);
  }
}
