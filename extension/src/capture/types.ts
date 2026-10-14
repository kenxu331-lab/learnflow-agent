export type BlockType =
  | "heading"
  | "paragraph"
  | "code"
  | "list"
  | "table"
  | "image"
  | "diagram";

export interface TableData {
  headers: string[];
  rows: string[][];
}

export interface ImageData {
  src: string;
  alt: string;
  title?: string;
}

export interface DiagramData {
  format: "svg";
  svg: string;
  alt: string;
}

export type InlineSegmentType = "text" | "code" | "link";

export interface InlineSegment {
  type: InlineSegmentType;
  text: string;
  url?: string;
}

export type CalloutKind = "note" | "tip" | "warning" | "danger" | "details";

export interface CalloutMetadata {
  id: string;
  kind: CalloutKind;
  title?: string;
}

export interface ContentBlock {
  id: string;
  /** Stable persistence hint; id remains the per-capture UI/message identity. */
  stableKey?: string;
  type: BlockType;
  text: string;
  level?: number;
  language?: string;
  variant?: string;
  inline?: InlineSegment[];
  callout?: CalloutMetadata;
  table?: TableData;
  image?: ImageData;
  diagram?: DiagramData;
}

export interface PageSnapshot {
  schemaVersion: 1;
  url: string;
  title: string;
  contentTitle?: string;
  capturedAt: string;
  blocks: ContentBlock[];
  extraction: {
    strategy: "article" | "main" | "fallback";
    truncated: boolean;
    warnings: string[];
    structure?: ExtractionStructure;
  };
  stats: {
    characterCount: number;
    codeBlockCount: number;
    blockCount: number;
  };
}

export interface ExtractionStructure {
  parserVersion: string;
  rootKind: "article" | "main" | "fallback";
  headingCount: number;
  paragraphCount: number;
  codeBlockCount: number;
  listItemCount: number;
  tableCount: number;
  imageCount: number;
  calloutCount: number;
  linkCount: number;
}

export const PAGE_CAPTURE_REQUEST = "PAGE_CAPTURE_REQUEST" as const;
export const PAGE_SELECTION_REQUEST = "PAGE_SELECTION_REQUEST" as const;

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

export interface PageSelection {
  schemaVersion: 1;
  text: string;
  sourceUrl: string;
  pageTitle: string;
  headingPath: string[];
  sourceNodeId?: string;
  sourceFingerprint: string;
}

export type PageSelectionErrorCode =
  | "NO_ACTIVE_TAB"
  | "NO_SELECTION"
  | "PERMISSION_DENIED"
  | "INVALID_RESULT"
  | "UNKNOWN_ERROR";

export interface PageSelectionSuccess {
  ok: true;
  selection: PageSelection;
}

export interface PageSelectionFailure {
  ok: false;
  error: { code: PageSelectionErrorCode; message: string };
}

export type PageSelectionResponse = PageSelectionSuccess | PageSelectionFailure;

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

export function isPageSelectionRequest(
  message: unknown,
): message is { type: typeof PAGE_SELECTION_REQUEST } {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === PAGE_SELECTION_REQUEST
  );
}
