import type { PageSnapshot } from "../capture/types";

export const PAGE_INGEST_REQUEST = "PAGE_INGEST_REQUEST" as const;

export interface PageIngestRequest {
  type: typeof PAGE_INGEST_REQUEST;
  snapshot: PageSnapshot;
}

export interface BackendIngestResponse {
  status: "validated";
  requestId: string;
  schemaVersion: 1;
  stats: PageSnapshot["stats"];
}

export type BackendErrorCode =
  | "NO_TOKEN"
  | "INVALID_SNAPSHOT"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "SERVER_ERROR"
  | "INVALID_RESPONSE"
  | "STORAGE_ERROR"
  | "UNKNOWN_ERROR";

export interface BackendClientError {
  code: BackendErrorCode;
  message: string;
}

export interface BackendClientSuccess {
  ok: true;
  response: BackendIngestResponse;
}

export interface BackendClientFailure {
  ok: false;
  error: BackendClientError;
}

export type BackendClientResult = BackendClientSuccess | BackendClientFailure;

export function isPageIngestRequest(
  message: unknown,
): message is PageIngestRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === PAGE_INGEST_REQUEST &&
    "snapshot" in message
  );
}
