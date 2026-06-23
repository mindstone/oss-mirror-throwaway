/**
 * AssetStore — platform-agnostic session-scoped binary asset boundary.
 *
 * Owns image (and future-binary) asset files keyed by an opaque, session-scoped
 * `assetId`. Replaces the previous practice of persisting long-lived base64
 * inside session JSON. Desktop implementation lives in
 * `src/main/services/assetStoreDesktop.ts`; cloud implementation will live in
 * `cloud-service/src/services/assetStoreCloud.ts`.
 *
 * Lifecycle is bound to the owning session: deleting a session deletes its
 * asset folder, soft-deleting moves the asset folder alongside the JSON, and
 * restore reverses the move.
 *
 * @see docs/plans/260516_image_asset_architecture.md § Stage 2
 */

import type { KnownAssetResolutionReason, ImageRef } from '@shared/types/agent';

/**
 * Stable error codes thrown by `AssetStore` implementations (via
 * `AssetStoreError`). Producers and consumers downstream (Stages 3-9) match on
 * these codes; the list is the authoritative source.
 *
 * Add new codes here before throwing them in any impl. Removing a code is a
 * breaking change because downstream code paths may pattern-match on it.
 */
export const ASSET_STORE_ERROR_CODES = [
  'mime-rejected',
  'magic-byte-mismatch',
  'path-traversal',
  'conflict',
  'storage-full',
  'restore-conflict',
  'corrupt',
  'unknown',
] as const;

export type AssetStoreErrorCode = (typeof ASSET_STORE_ERROR_CODES)[number];

export type AssetStoreWriteStatus = 'created' | 'duplicate';

export interface AssetStoreWriteResult {
  ref: ImageRef;
  status?: AssetStoreWriteStatus;
}

/**
 * Discriminated read result. The `ok` variant carries decoded bytes; all
 * failure variants carry a known non-`ok` reason. Consumers narrow on
 * `reason` before accessing `bytes`.
 *
 * Stage 9 (UI taxonomy) maps the failure reasons to user-facing tiles.
 */
export type AssetStoreReadFailureReason = Exclude<KnownAssetResolutionReason, 'ok'>;

export type AssetStoreReadResult =
  | { reason: 'ok'; bytes: Buffer; mimeType: string; byteSize: number }
  | { reason: AssetStoreReadFailureReason };

export interface AssetStoreHasResult {
  has: boolean;
  byteSize?: number;
}

export interface AssetStoreWriteArgs {
  sessionId: string;
  assetId: string;
  bytes: Buffer;
  mimeType: string;
}

export interface AssetStoreThumbnailWriteArgs {
  sessionId: string;
  assetId: string;
  thumbnailAssetId: string;
  bytes: Buffer;
}

export interface AssetStoreWriteFromTempFileArgs {
  sessionId: string;
  assetId: string;
  tempPath: string;
  mimeType: string;
}

export type AssetStoreGenerateThumbnailResult =
  | { bytes: Buffer; mimeType: 'image/png' }
  | { reason: 'unsupported' | 'failed' };

export interface AssetStoreReadArgs {
  sessionId: string;
  assetId: string;
}

export interface AssetStoreHasArgs {
  sessionId: string;
  assetId: string;
}

export interface AssetStoreListArgs {
  sessionId: string;
}

export interface AssetStoreDeleteArgs {
  sessionId: string;
}

export interface AssetStoreSoftDeleteArgs {
  sessionId: string;
  timestamp: number;
}

/**
 * Session-scoped binary asset store. Implementations must:
 *
 * - Reject writes with a MIME outside `ALLOWED_IMAGE_MIME_TYPES`.
 * - Verify magic bytes against the declared MIME on every write (defense
 *   against producer-side mislabeling).
 * - Re-sniff magic bytes on every read (defense against post-write tampering
 *   or corruption). Return `{ reason: 'corrupt' }` on mismatch.
 * - Throw on conflicting re-writes (same `{sessionId, assetId}` + different
 *   bytes), including the concurrent-write race where two writers reach the
 *   atomic publish step simultaneously. Idempotent re-write with identical
 *   bytes is a no-op.
 * - Never silently overwrite. Never silently drop.
 * - Tolerate `ENOSPC` at any fs-mutating step (`mkdir`, `writeFile`, atomic
 *   publish) by throwing a structured `{ code: 'storage-full' }` error so
 *   producers can fall back gracefully.
 * - Validate `sessionId` and `assetId` against a tight charset before
 *   constructing any filesystem path; reject `''`, `.`, `..`, `/`, `\`, NUL,
 *   and any traversal sequence with `{ code: 'path-traversal' }`. Producers
 *   are expected to supply IDs matching the D2 format (`${turnId}-${eventSeq}-${index}`
 *   for `assetId`; UUID-style for `sessionId`).
 * - Never log raw session IDs, asset IDs, or filesystem paths. Use hashed
 *   prefixes per the log redaction convention.
 */
export interface AssetStore {
  writeAsset(args: AssetStoreWriteArgs): Promise<AssetStoreWriteResult>;

  writeAssetFromTempFile?(
    args: AssetStoreWriteFromTempFileArgs,
  ): Promise<AssetStoreWriteResult>;

  writeThumbnail(args: AssetStoreThumbnailWriteArgs): Promise<void>;

  generateThumbnail(
    bytes: Buffer,
    mimeType: string,
  ): Promise<AssetStoreGenerateThumbnailResult>;

  readAsset(args: AssetStoreReadArgs): Promise<AssetStoreReadResult>;

  hasAsset(args: AssetStoreHasArgs): Promise<AssetStoreHasResult>;

  listSessionAssets(args: AssetStoreListArgs): Promise<string[]>;

  deleteSession(args: AssetStoreDeleteArgs): Promise<void>;

  moveSessionAssetsToDeleted(args: AssetStoreSoftDeleteArgs): Promise<void>;

  restoreSessionAssetsFromDeleted(args: AssetStoreSoftDeleteArgs): Promise<void>;

  /** Marks an asset as uploaded in the store's internal manifest (if applicable) */
  markAssetUploaded?(sessionId: string, assetId: string): Promise<void>;

  /** Marks an asset as terminally failed in the store's internal manifest (if applicable) */
  markAssetFailed?(sessionId: string, assetId: string, reason: string): Promise<void>;

  /** Lists manifest upload statuses keyed by asset id (if the implementation persists them) */
  listSessionAssetStatuses?(
    sessionId: string,
  ): Promise<Record<string, 'pending' | 'uploaded' | 'missing'>>;
  
  /** Subscribe to asset written events */
  onAssetWritten?(listener: (sessionId: string, assetId: string) => void): () => void;
}

let _assetStore: AssetStore | null = null;

export function setAssetStore(impl: AssetStore): void {
  _assetStore = impl;
}

export function getAssetStore(): AssetStore {
  if (!_assetStore) {
    throw new Error(
      'AssetStore not initialized. Call setAssetStore() in bootstrap.',
    );
  }
  return _assetStore;
}

/**
 * Test helper. Resets the bound implementation so test suites can swap mocks
 * without leaking state between describe blocks.
 */
export function resetAssetStoreForTesting(): void {
  _assetStore = null;
}
