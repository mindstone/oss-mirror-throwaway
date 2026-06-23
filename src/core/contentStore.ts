/**
 * ContentStore — platform-agnostic session-scoped opaque-content boundary.
 *
 * Owns large opaque text blobs (tool output, command output, file content
 * materializations) keyed by an opaque, session-scoped `contentId`. Mirrors
 * the {@link AssetStore} pattern from `src/core/assetStore.ts` for the same
 * structural reasons: prevent unbounded inline blob accumulation in session
 * JSON that wedges sync into a "too large" state.
 *
 * Unlike `AssetStore`, content has no magic-byte signature and no MIME
 * allowlist — the input is opaque text/binary whose `mimeType` is carried
 * for renderer hinting only. The store is content-addressed: `contentId`
 * is `sha256(bytes).slice(0,32)` and the boundary contract is to write to
 * a temp file, fsync it, atomically rename, and fsync the directory before
 * returning. Any failure throws and the producer keeps the inline content.
 *
 * @see docs/plans/260518_cloud_sync_reconciliation_hardening.md § Stage B1a
 */

import type { ContentRef } from '@shared/types/agent';

/**
 * Stable error codes thrown by `ContentStore` implementations (via
 * `ContentStoreError`). Producers and consumers downstream match on
 * these codes; the list is the authoritative source.
 *
 * Unlike `AssetStore`, `'mime-rejected'` and `'magic-byte-mismatch'` do NOT
 * apply — text content has no magic-byte signature, and `mimeType` is an
 * opaque renderer hint rather than a validated allowlist.
 */
export const CONTENT_STORE_ERROR_CODES = [
  'path-traversal',
  'conflict',
  'storage-full',
  'restore-conflict',
  'corrupt',
  'unknown',
] as const;

export type ContentStoreErrorCode = (typeof CONTENT_STORE_ERROR_CODES)[number];

export type ContentStoreWriteStatus = 'created' | 'duplicate';

export interface ContentStoreWriteResult {
  ref: ContentRef;
  status?: ContentStoreWriteStatus;
}

/**
 * Discriminated read result. The `ok` variant carries decoded bytes; all
 * failure variants carry a known non-`ok` reason.
 *
 * Stage B1b (UI taxonomy) maps these reasons to user-facing tiles via the
 * `ContentResolutionReason` open-union.
 */
export type ContentStoreReadFailureReason =
  | 'not-found'
  | 'permission-denied'
  | 'corrupt'
  | 'unknown';

export type ContentStoreReadResult =
  | { reason: 'ok'; bytes: Buffer; mimeType: string; byteSize: number }
  | { reason: ContentStoreReadFailureReason };

export interface ContentStoreHasResult {
  has: boolean;
  byteSize?: number;
}

export interface ContentStoreWriteArgs {
  sessionId: string;
  contentId: string;
  bytes: Buffer;
  mimeType: string;
}

export interface ContentStoreReadArgs {
  sessionId: string;
  contentId: string;
}

export interface ContentStoreHasArgs {
  sessionId: string;
  contentId: string;
}

export interface ContentStoreListArgs {
  sessionId: string;
}

export interface ContentStoreDeleteArgs {
  sessionId: string;
}

export interface ContentStoreSoftDeleteArgs {
  sessionId: string;
  timestamp: number;
}

/**
 * Session-scoped opaque-content store. Implementations must:
 *
 * - Atomic publish: write to `${path}.${uuid}.tmp`, fsync, `link` (or rename)
 *   to the canonical path, fsync the directory. Never emit a `contentRef`
 *   pointing to a partially-written or absent file.
 * - Throw on conflicting re-writes (same `{sessionId, contentId}` + different
 *   bytes). Idempotent re-write with identical bytes is a no-op success.
 * - Tolerate `ENOSPC` at any fs-mutating step by throwing
 *   `{ code: 'storage-full' }` so producers can fall back to inline content.
 * - Validate `sessionId` and `contentId` against a tight charset before
 *   constructing any filesystem path; reject `''`, `.`, `..`, `/`, `\`,
 *   NUL, and any traversal sequence with `{ code: 'path-traversal' }`.
 *   `contentId` is expected to be `sha256(bytes).slice(0,32)`.
 * - Never log raw session IDs, content IDs, or filesystem paths. Use hashed
 *   prefixes per the log redaction convention shared with `AssetStore`.
 */
export interface ContentStore {
  writeContent(args: ContentStoreWriteArgs): Promise<ContentStoreWriteResult>;

  readContent(args: ContentStoreReadArgs): Promise<ContentStoreReadResult>;

  hasContent(args: ContentStoreHasArgs): Promise<ContentStoreHasResult>;

  listSessionContent(args: ContentStoreListArgs): Promise<string[]>;

  deleteSession(args: ContentStoreDeleteArgs): Promise<void>;

  moveSessionContentToDeleted(args: ContentStoreSoftDeleteArgs): Promise<void>;

  restoreSessionContentFromDeleted(args: ContentStoreSoftDeleteArgs): Promise<void>;

  /** Marks a content blob as uploaded in the store's internal manifest. */
  markContentUploaded?(sessionId: string, contentId: string): Promise<void>;

  /** Marks a content blob as terminally failed in the store's internal manifest. */
  markContentFailed?(sessionId: string, contentId: string, reason: string): Promise<void>;

  /** Lists manifest upload statuses keyed by contentId. */
  listSessionContentStatuses?(
    sessionId: string,
  ): Promise<Record<string, 'pending' | 'uploaded' | 'missing'>>;

  /** Lists durable upload metadata keyed by contentId. */
  listSessionContentUploadRecords?(
    sessionId: string,
  ): Promise<Record<string, {
    uploadStatus: 'pending' | 'uploaded' | 'missing';
    firstQueuedAt?: number;
  }>>;

  /** Subscribe to content written events. */
  onContentWritten?(
    listener: (sessionId: string, contentId: string) => void,
  ): () => void;
}

let _contentStore: ContentStore | null = null;

export function setContentStore(impl: ContentStore): void {
  _contentStore = impl;
}

export function getContentStore(): ContentStore {
  if (!_contentStore) {
    throw new Error(
      'ContentStore not initialized. Call setContentStore() in bootstrap.',
    );
  }
  return _contentStore;
}

/**
 * Producer-side offload threshold. Tool-result content blocks larger than
 * this are offloaded to the content store; smaller blocks stay inline. See
 * `docs/plans/260518_cloud_sync_reconciliation_hardening.md` § Stage B1a.
 */
export const CONTENT_REF_THRESHOLD_BYTES = 200 * 1024;

/** Length of the inline `summary` preserved alongside a `ContentRef`. */
export const CONTENT_REF_SUMMARY_CHAR_LIMIT = 500;
