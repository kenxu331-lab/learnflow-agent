export type BlockType = "heading" | "paragraph" | "code" | "list";

export interface ContentBlock {
  id: string;
  /** Stable persistence hint; id remains the per-capture UI/message identity. */
  stableKey?: string;
  type: BlockType;
  text: string;
  level?: number;
  language?: string;
}

export interface PageSnapshot {
  schemaVersion: 1;
  url: string;
  title: string;
  capturedAt: string;
  blocks: ContentBlock[];
  extraction: {
    strategy: "article" | "main" | "fallback";
    truncated: boolean;
    warnings: string[];
  };
  stats: {
    characterCount: number;
    codeBlockCount: number;
    blockCount: number;
  };
}

export const PAGE_CAPTURE_REQUEST = "PAGE_CAPTURE_REQUEST" as const;

export interface PageCaptureRequest {
  type: typeof PAGE_CAPTURE_REQUEST;
}

export type CaptureErrorCode =
  | "NO_ACTIVE_TAB"
  | "URL_UNAVAILABLE"
  | "UNSUPPORTED_URL"
  | "PERMISSION_DENIED"
  | "INJECTION_FAILED"
  | "STALE_TAB"
  | "EMPTY_CONTENT"
  | "INVALID_RESULT"
  | "UNKNOWN_ERROR";

export interface PageCaptureError {
  code: CaptureErrorCode;
  message: string;
}

export interface PageCaptureSuccess {
  ok: true;
  snapshot: PageSnapshot;
}

export interface PageCaptureFailure {
  ok: false;
  error: PageCaptureError;
}

export type PageCaptureResponse = PageCaptureSuccess | PageCaptureFailure;

export function isPageCaptureRequest(
  message: unknown,
): message is PageCaptureRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === PAGE_CAPTURE_REQUEST
  );
}
