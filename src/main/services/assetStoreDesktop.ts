// CORE-MOVE-EXEMPT: Desktop-only adapter for the @core/assetStore boundary.
// The boundary interface lives in src/core/assetStore.ts (cross-surface);
// this file implements it against the desktop userData filesystem layout.
// Cloud and mobile get separate implementations in cloud-service/cloud-client.
//
/**
 * DesktopAssetStore — Electron implementation of the `AssetStore` boundary.
 *
 * Stores session-scoped image assets under
 * `${userData}/sessions/${sessionId}.assets/${assetId}.${ext}`.
 *
 * Conventions
 * -----------
 * - **Extension-keyed MIME**: the on-disk extension (`.png` / `.jpg` / `.gif` /
 *   `.webp`) is the declared MIME at write time. Read paths recover the MIME
 *   from the extension and re-sniff magic bytes against it; mismatch ⇒
 *   `{ reason: 'corrupt' }`. This avoids a metadata sidecar.
 * - **Thumbnails** share the same folder using an `_thumb` suffix on the
 *   parent asset id (`${parentAssetId}_thumb.${ext}`). The MIME for the
 *   thumbnail is determined by sniffing the bytes at write time.
 * - **Atomic writes**: bytes go to `${path}.${uuid}.tmp`, then are published
 *   via `fs.link(tmpPath, finalPath)` and the tmp name is removed. `link` is
 *   atomic and fails with EEXIST if the final path is already claimed; this
 *   is what makes the concurrent same-asset different-byte case deterministic
 *   (one writer succeeds, the other throws `conflict`). Every fs op runs
 *   under `withRetryOnEmfile` so transient EMFILE storms don't fail the
 *   producer.
 * - **Idempotent re-writes**: identical `{sessionId, assetId}` + identical
 *   bytes ⇒ no-op success (both at the upfront read and at the post-link
 *   compare). Different bytes ⇒ throws conflict error.
 * - **Path containment**: `sessionId` and `assetId` are charset-validated
 *   before any path join, and every resolved path is verified to live under
 *   the session's `.assets/` folder; traversal attempts throw.
 * - **Structured errors**: every error path throws `AssetStoreError` with a
 *   stable `code` from `ASSET_STORE_ERROR_CODES`, and emits a single
 *   structured warn log with redacted IDs.
 * - **ENOSPC mapping**: any fs-mutating step (`mkdir`, `writeFile`, `link`,
 *   `rename` on soft-delete/restore) maps `ENOSPC` to
 *   `{ code: 'storage-full' }`.
 * - **Log redaction**: never logs raw session IDs, asset IDs, or paths. Uses
 *   `sha256(sessionId).slice(0,8)` and `assetId.slice(-8)`.
 *
 * @see docs/plans/260516_image_asset_architecture.md § Stage 2
 */

import { randomUUID, createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { withRetryOnEmfile } from '@core/utils/emfileRetry';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  IMAGE_MIME_TO_EXTENSION,
  isAllowedImageMimeType,
  type AllowedImageMimeType,
} from '@shared/markdownImageAssets';
import type {
  AssetStore,
  AssetStoreErrorCode,
  AssetStoreHasResult,
  AssetStoreReadResult,
  AssetStoreWriteResult,
} from '@core/assetStore';

const log = createScopedLogger({ service: 'assetStoreDesktop' });

const SESSIONS_DIR_NAME = 'sessions';
const DELETED_SESSIONS_DIR_NAME = 'sessions-deleted';
const ASSETS_FOLDER_SUFFIX = '.assets';
const THUMB_SUFFIX = '_thumb';

const PRIMARY_EXTENSIONS = Object.values(IMAGE_MIME_TO_EXTENSION) as readonly string[];

export interface AssetStoreFs {
  writeFile(p: string, data: Buffer | Uint8Array): Promise<void>;
  readFile(p: string): Promise<Buffer>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, newPath: string): Promise<void>;
  mkdir(p: string, opts: { recursive: boolean }): Promise<unknown>;
  rm(p: string, opts: { recursive: boolean; force: boolean }): Promise<void>;
  stat(p: string): Promise<{ size: number }>;
  readdir(p: string): Promise<string[]>;
  unlink(p: string): Promise<void>;
  access(p: string): Promise<void>;
}

interface DesktopAssetStoreOptions {
  /** Override the root userData directory. Defaults to `getDataPath()`. */
  baseDir?: string;
  /** Override the dependency-injected fs module (tests). */
  fs?: AssetStoreFs;
}

export class AssetStoreError extends Error {
  readonly code: AssetStoreErrorCode;
  constructor(code: AssetStoreErrorCode, message: string) {
    super(message);
    this.name = 'AssetStoreError';
    this.code = code;
  }
}

type WriteOp = 'writeAsset' | 'writeThumbnail';
type FsStep = 'mkdir' | 'writeFile' | 'link';

export class DesktopAssetStore implements AssetStore {
  private readonly baseDirOverride?: string;
  private readonly fs: AssetStoreFs;
  private readonly listeners: Set<(sessionId: string, assetId: string) => void> = new Set();

  constructor(options: DesktopAssetStoreOptions = {}) {
    this.baseDirOverride = options.baseDir;
    this.fs = options.fs ?? createDefaultFs();
  }

  // ------------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------------

  onAssetWritten(listener: (sessionId: string, assetId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async markAssetUploaded(sessionId: string, assetId: string): Promise<void> {
    await this.updateManifestUploadStatus({
      sessionId,
      assetId,
      uploadStatus: 'uploaded',
      op: 'markAssetUploaded',
    });
  }

  async markAssetFailed(
    sessionId: string,
    assetId: string,
    reason: string,
  ): Promise<void> {
    await this.updateManifestUploadStatus({
      sessionId,
      assetId,
      uploadStatus: 'missing',
      op: 'markAssetFailed',
      reason,
    });
  }

  async listSessionAssetStatuses(
    sessionId: string,
  ): Promise<Record<string, 'pending' | 'uploaded' | 'missing'>> {
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'listSessionAssetStatuses', redacted);

    const sessionDir = this.resolveSessionAssetsDir(sessionId);
    const manifestPath = path.join(sessionDir, '_manifest.json');
    try {
      const data = await withRetryOnEmfile(() => this.fs.readFile(manifestPath));
      const parsed = JSON.parse(data.toString()) as Record<
        string,
        { uploadStatus?: unknown }
      >;
      const result: Record<string, 'pending' | 'uploaded' | 'missing'> = {};
      for (const [assetId, value] of Object.entries(parsed)) {
        if (
          value
          && typeof value === 'object'
          && (value.uploadStatus === 'pending'
            || value.uploadStatus === 'uploaded'
            || value.uploadStatus === 'missing')
        ) {
          result[assetId] = value.uploadStatus;
        }
      }
      return result;
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode !== 'ENOENT') {
        log.warn(
          { ...redacted, op: 'listSessionAssetStatuses', errCode },
          'Failed to read asset status manifest',
        );
      }
      return {};
    }
  }

  async writeAsset(args: {
    sessionId: string;
    assetId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<AssetStoreWriteResult> {
    const { sessionId, assetId, bytes, mimeType } = args;
    const redacted = redactIds(sessionId, assetId);

    assertSafeSessionIdOrLogAndThrow(sessionId, 'writeAsset', redacted);
    assertSafeAssetIdOrLogAndThrow(assetId, 'writeAsset', redacted);

    if (!isAllowedImageMimeType(mimeType)) {
      log.warn(
        { ...redacted, op: 'writeAsset', reason: 'mime-rejected' },
        'Rejected write: MIME not in allowlist',
      );
      throw new AssetStoreError(
        'mime-rejected',
        'MIME type is not in the image allowlist',
      );
    }

    if (!magicBytesMatch(bytes, mimeType)) {
      log.warn(
        { ...redacted, op: 'writeAsset', reason: 'magic-byte-mismatch' },
        'Rejected write: magic bytes do not match declared MIME',
      );
      throw new AssetStoreError(
        'magic-byte-mismatch',
        'Image bytes do not match declared MIME type',
      );
    }

    const sessionDir = this.resolveSessionAssetsDir(sessionId);
    const ext = IMAGE_MIME_TO_EXTENSION[mimeType];
    const finalPath = this.resolveAssetPath(sessionDir, `${assetId}${ext}`);

    const existingLocation = await this.findExistingAssetLocation(sessionDir, assetId);
    if (existingLocation) {
      if (existingLocation.declaredMime !== mimeType) {
        log.warn(
          { ...redacted, op: 'writeAsset', reason: 'conflict' },
          'Rejected write: asset already exists with a different MIME extension',
        );
        throw new AssetStoreError(
          'conflict',
          'Asset already exists with a different MIME type',
        );
      }

      const existing = await this.tryReadFile(existingLocation.path);
      if (existing && existing.equals(bytes)) {
        return {
          ref: {
            assetId,
            mimeType,
            byteSize: bytes.byteLength,
          },
          status: 'duplicate',
        };
      }
      log.warn(
        { ...redacted, op: 'writeAsset', reason: 'conflict' },
        'Rejected write: asset already exists with different bytes',
      );
      throw new AssetStoreError(
        'conflict',
        'Asset already exists with different bytes',
      );
    }

    await this.writeFileAtomic(sessionDir, finalPath, bytes, 'writeAsset', redacted);

    await this.updateManifestUploadStatus({
      sessionId,
      assetId,
      uploadStatus: 'pending',
      op: 'writeAsset',
    });

    for (const listener of this.listeners) {
      listener(sessionId, assetId);
    }

    return {
      ref: {
        assetId,
        mimeType,
        byteSize: bytes.byteLength,
      },
      status: 'created',
    };
  }

  async writeThumbnail(args: {
    sessionId: string;
    assetId: string;
    thumbnailAssetId: string;
    bytes: Buffer;
  }): Promise<void> {
    const { sessionId, assetId, thumbnailAssetId, bytes } = args;
    const redacted = redactIds(sessionId, assetId);

    assertSafeSessionIdOrLogAndThrow(sessionId, 'writeThumbnail', redacted);
    assertSafeAssetIdOrLogAndThrow(assetId, 'writeThumbnail', redacted);
    assertSafeAssetIdOrLogAndThrow(thumbnailAssetId, 'writeThumbnail', redacted);

    const sniffed = sniffMimeFromBytes(bytes);
    if (!sniffed) {
      log.warn(
        { ...redacted, op: 'writeThumbnail', reason: 'mime-rejected' },
        'Rejected thumbnail write: unrecognised image bytes',
      );
      throw new AssetStoreError(
        'mime-rejected',
        'Thumbnail bytes do not match any allowed image MIME',
      );
    }

    const ext = IMAGE_MIME_TO_EXTENSION[sniffed];
    const sessionDir = this.resolveSessionAssetsDir(sessionId);
    const finalPath = this.resolveAssetPath(
      sessionDir,
      `${assetId}${THUMB_SUFFIX}${ext}`,
    );

    const existing = await this.tryReadFile(finalPath);
    if (existing && existing.equals(bytes)) {
      return;
    }
    if (existing) {
      log.warn(
        { ...redacted, op: 'writeThumbnail', reason: 'conflict' },
        'Rejected thumbnail write: existing thumbnail differs from new bytes',
      );
      throw new AssetStoreError(
        'conflict',
        'Thumbnail already exists with different bytes',
      );
    }

    await this.writeFileAtomic(sessionDir, finalPath, bytes, 'writeThumbnail', redacted);
  }

  async generateThumbnail(bytes: Buffer, mimeType: string): Promise<{ bytes: Buffer; mimeType: 'image/png' } | { reason: 'unsupported' | 'failed' }> {
    if (!ALLOWED_IMAGE_MIME_TYPES.includes(mimeType as AllowedImageMimeType)) {
      return { reason: 'unsupported' };
    }
    try {
      const img = nativeImage.createFromBuffer(bytes);
      if (img.isEmpty()) return { reason: 'failed' };
      const resized = img.resize({ width: 320 }); // preserves aspect ratio
      const thumbBytes = resized.toPNG(); // always PNG for thumbnails per D6
      return { bytes: thumbBytes, mimeType: 'image/png' };
    } catch (err) {
      log.warn({ op: 'generateThumbnail', err: (err as Error).message?.slice(0, 100) }, 'thumbnail generation failed');
      return { reason: 'failed' };
    }
  }

  async readAsset(args: {
    sessionId: string;
    assetId: string;
  }): Promise<AssetStoreReadResult> {
    const { sessionId, assetId } = args;
    const redacted = redactIds(sessionId, assetId);

    assertSafeSessionIdOrLogAndThrow(sessionId, 'readAsset', redacted);

    let resolved: { path: string; declaredMime: AllowedImageMimeType };
    try {
      resolved = this.resolvePrimaryAssetPath(sessionId, assetId);
    } catch (err) {
      const code = (err as AssetStoreError).code;
      if (code === 'path-traversal') {
        log.warn(
          { ...redacted, op: 'readAsset', reason: 'permission-denied' },
          'Rejected read: assetId path traversal attempt',
        );
        return { reason: 'permission-denied' };
      }
      throw err;
    }

    let bytes: Buffer;
    try {
      bytes = await withRetryOnEmfile(() => this.fs.readFile(resolved.path));
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        log.warn(
          { ...redacted, op: 'readAsset', reason: 'not-found' },
          'Read: asset not found',
        );
        return { reason: 'not-found' };
      }
      if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
        log.warn(
          { ...redacted, op: 'readAsset', reason: 'permission-denied' },
          'Rejected read: filesystem permission denied',
        );
        return { reason: 'permission-denied' };
      }
      log.warn(
        { ...redacted, op: 'readAsset', reason: 'unknown', errCode: nodeErr.code },
        'Read failed with unexpected fs error',
      );
      return { reason: 'unknown' };
    }

    if (!magicBytesMatch(bytes, resolved.declaredMime)) {
      log.warn(
        { ...redacted, op: 'readAsset', reason: 'corrupt' },
        'Read returned bytes whose magic bytes no longer match the declared MIME',
      );
      return { reason: 'corrupt' };
    }

    return {
      reason: 'ok',
      bytes,
      mimeType: resolved.declaredMime,
      byteSize: bytes.byteLength,
    };
  }

  async hasAsset(args: {
    sessionId: string;
    assetId: string;
  }): Promise<AssetStoreHasResult> {
    const { sessionId, assetId } = args;
    const redacted = redactIds(sessionId, assetId);

    assertSafeSessionIdOrLogAndThrow(sessionId, 'hasAsset', redacted);

    let resolved: { path: string };
    try {
      resolved = this.resolvePrimaryAssetPath(sessionId, assetId);
    } catch (err) {
      const code = (err as AssetStoreError).code;
      if (code === 'path-traversal') {
        log.warn(
          { ...redacted, op: 'hasAsset', reason: 'path-traversal' },
          'hasAsset rejected: assetId path traversal attempt',
        );
      }
      return { has: false };
    }

    try {
      const stat = await withRetryOnEmfile(() => this.fs.stat(resolved.path));
      return { has: true, byteSize: stat.size };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn(
          { ...redacted, op: 'hasAsset', reason: 'unknown', errCode: code },
          'hasAsset stat failed with unexpected fs error',
        );
      }
      return { has: false };
    }
  }

  async listSessionAssets(args: { sessionId: string }): Promise<string[]> {
    const { sessionId } = args;
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'listSessionAssets', redacted);

    const sessionDir = this.resolveSessionAssetsDir(sessionId);
    let entries: string[];
    try {
      entries = await withRetryOnEmfile(() => this.fs.readdir(sessionDir));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.warn(
          { ...redacted, op: 'listSessionAssets', reason: 'not-found' },
          'listSessionAssets: session asset folder does not exist',
        );
        return [];
      }
      log.warn(
        { ...redacted, op: 'listSessionAssets', reason: 'unknown', errCode: code },
        'listSessionAssets readdir failed with unexpected fs error',
      );
      throw err;
    }

    const ids: string[] = [];
    for (const entry of entries) {
      const ext = path.extname(entry).toLowerCase();
      if (!PRIMARY_EXTENSIONS.includes(ext)) continue;
      const stem = entry.slice(0, entry.length - ext.length);
      if (stem.endsWith(THUMB_SUFFIX)) continue;
      ids.push(stem);
    }
    ids.sort();
    return ids;
  }

  async deleteSession(args: { sessionId: string }): Promise<void> {
    const { sessionId } = args;
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'deleteSession', redacted);

    const sessionDir = this.resolveSessionAssetsDir(sessionId);
    try {
      // `force: true` makes missing-folder a silent no-op (expected for
      // sessions that never had any assets) so callers can treat
      // `deleteSession` as idempotent cleanup. Other fs errors still surface.
      await withRetryOnEmfile(() =>
        this.fs.rm(sessionDir, { recursive: true, force: true }),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      log.warn(
        { ...redacted, op: 'deleteSession', reason: 'unknown', errCode: code },
        'deleteSession rm failed with unexpected fs error',
      );
      throw err;
    }
  }

  async moveSessionAssetsToDeleted(args: {
    sessionId: string;
    timestamp: number;
  }): Promise<void> {
    const { sessionId, timestamp } = args;
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'moveSessionAssetsToDeleted', redacted);

    const from = this.resolveSessionAssetsDir(sessionId);
    const to = this.resolveDeletedAssetsDir(sessionId, timestamp);

    try {
      await withRetryOnEmfile(() =>
        this.fs.mkdir(path.dirname(to), { recursive: true }),
      );
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOSPC') {
        log.warn(
          { ...redacted, op: 'moveSessionAssetsToDeleted', reason: 'storage-full', step: 'mkdir' },
          'Storage full: ENOSPC during soft-delete mkdir',
        );
        throw new AssetStoreError('storage-full', 'Disk is full');
      }
      log.warn(
        { ...redacted, op: 'moveSessionAssetsToDeleted', reason: 'unknown', step: 'mkdir', errCode: nodeErr.code },
        'moveSessionAssetsToDeleted mkdir failed with unexpected fs error',
      );
      throw err;
    }

    try {
      await withRetryOnEmfile(() => this.fs.rename(from, to));
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        log.warn(
          { ...redacted, op: 'moveSessionAssetsToDeleted', reason: 'not-found' },
          'moveSessionAssetsToDeleted: source asset folder does not exist',
        );
        return;
      }
      if (nodeErr.code === 'ENOSPC') {
        log.warn(
          { ...redacted, op: 'moveSessionAssetsToDeleted', reason: 'storage-full', step: 'rename' },
          'Storage full: ENOSPC during soft-delete rename',
        );
        throw new AssetStoreError('storage-full', 'Disk is full');
      }
      log.warn(
        { ...redacted, op: 'moveSessionAssetsToDeleted', reason: 'unknown', step: 'rename', errCode: nodeErr.code },
        'moveSessionAssetsToDeleted rename failed with unexpected fs error',
      );
      throw err;
    }
  }

  async restoreSessionAssetsFromDeleted(args: {
    sessionId: string;
    timestamp: number;
  }): Promise<void> {
    const { sessionId, timestamp } = args;
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(
      sessionId,
      'restoreSessionAssetsFromDeleted',
      redacted,
    );

    const from = this.resolveDeletedAssetsDir(sessionId, timestamp);
    const to = this.resolveSessionAssetsDir(sessionId);

    if (await this.pathExists(to)) {
      log.warn(
        { ...redacted, op: 'restoreSessionAssetsFromDeleted', reason: 'restore-conflict' },
        'Restore aborted: active asset folder already exists',
      );
      throw new AssetStoreError(
        'restore-conflict',
        'Active asset folder already exists for this session',
      );
    }

    try {
      await withRetryOnEmfile(() =>
        this.fs.mkdir(path.dirname(to), { recursive: true }),
      );
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOSPC') {
        log.warn(
          { ...redacted, op: 'restoreSessionAssetsFromDeleted', reason: 'storage-full', step: 'mkdir' },
          'Storage full: ENOSPC during restore mkdir',
        );
        throw new AssetStoreError('storage-full', 'Disk is full');
      }
      log.warn(
        { ...redacted, op: 'restoreSessionAssetsFromDeleted', reason: 'unknown', step: 'mkdir', errCode: nodeErr.code },
        'restoreSessionAssetsFromDeleted mkdir failed with unexpected fs error',
      );
      throw err;
    }

    try {
      await withRetryOnEmfile(() => this.fs.rename(from, to));
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        log.warn(
          { ...redacted, op: 'restoreSessionAssetsFromDeleted', reason: 'not-found' },
          'restoreSessionAssetsFromDeleted: trash asset folder does not exist',
        );
        throw err;
      }
      if (nodeErr.code === 'ENOSPC') {
        log.warn(
          { ...redacted, op: 'restoreSessionAssetsFromDeleted', reason: 'storage-full', step: 'rename' },
          'Storage full: ENOSPC during restore rename',
        );
        throw new AssetStoreError('storage-full', 'Disk is full');
      }
      log.warn(
        { ...redacted, op: 'restoreSessionAssetsFromDeleted', reason: 'unknown', step: 'rename', errCode: nodeErr.code },
        'restoreSessionAssetsFromDeleted rename failed with unexpected fs error',
      );
      throw err;
    }
  }

  // ------------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------------

  private baseDir(): string {
    return this.baseDirOverride ?? getDataPath();
  }

  private resolveSessionAssetsDir(sessionId: string): string {
    return path.join(
      this.baseDir(),
      SESSIONS_DIR_NAME,
      `${sessionId}${ASSETS_FOLDER_SUFFIX}`,
    );
  }

  private resolveDeletedAssetsDir(sessionId: string, timestamp: number): string {
    return path.join(
      this.baseDir(),
      DELETED_SESSIONS_DIR_NAME,
      `${sessionId}_${timestamp}${ASSETS_FOLDER_SUFFIX}`,
    );
  }

  private resolveAssetPath(sessionDir: string, filename: string): string {
    const resolvedDir = path.resolve(sessionDir);
    const resolvedTarget = path.resolve(sessionDir, filename);
    const relative = path.relative(resolvedDir, resolvedTarget);
    if (
      relative === '' ||
      relative === '..' ||
      relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative) ||
      relative.includes(path.sep)
    ) {
      throw new AssetStoreError(
        'path-traversal',
        'Asset filename escapes the session asset directory',
      );
    }
    return resolvedTarget;
  }

  private resolvePrimaryAssetPath(
    sessionId: string,
    assetId: string,
  ): { path: string; declaredMime: AllowedImageMimeType } {
    assertSafeAssetId(assetId);
    const sessionDir = this.resolveSessionAssetsDir(sessionId);
    for (const mime of ALLOWED_IMAGE_MIME_TYPES) {
      const ext = IMAGE_MIME_TO_EXTENSION[mime];
      const filename = `${assetId}${ext}`;
      const candidate = this.resolveAssetPath(sessionDir, filename);
      if (existsSyncIgnoringErrors(candidate)) {
        return { path: candidate, declaredMime: mime };
      }
    }
    // Default to the first extension; readAsset will surface ENOENT cleanly.
    const fallback = this.resolveAssetPath(
      sessionDir,
      `${assetId}${IMAGE_MIME_TO_EXTENSION['image/png']}`,
    );
    return { path: fallback, declaredMime: 'image/png' };
  }

  private async findExistingAssetLocation(
    sessionDir: string,
    assetId: string,
  ): Promise<{ path: string; declaredMime: AllowedImageMimeType } | null> {
    for (const mime of ALLOWED_IMAGE_MIME_TYPES) {
      const ext = IMAGE_MIME_TO_EXTENSION[mime];
      const filename = `${assetId}${ext}`;
      const candidate = this.resolveAssetPath(sessionDir, filename);
      if (existsSyncIgnoringErrors(candidate)) {
        return { path: candidate, declaredMime: mime };
      }
    }
    return null;
  }

  private async pathExists(targetPath: string): Promise<boolean> {
    try {
      await withRetryOnEmfile(() => this.fs.access(targetPath));
      return true;
    } catch {
      return false;
    }
  }

  private async tryReadFile(targetPath: string): Promise<Buffer | null> {
    try {
      return await withRetryOnEmfile(() => this.fs.readFile(targetPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  private async updateManifestUploadStatus(args: {
    sessionId: string;
    assetId: string;
    uploadStatus: 'pending' | 'uploaded' | 'missing';
    op: 'writeAsset' | 'markAssetUploaded' | 'markAssetFailed';
    reason?: string;
  }): Promise<void> {
    const redacted = redactIds(args.sessionId, args.assetId);
    assertSafeSessionIdOrLogAndThrow(args.sessionId, args.op, redacted);
    assertSafeAssetIdOrLogAndThrow(args.assetId, args.op, redacted);

    const sessionDir = this.resolveSessionAssetsDir(args.sessionId);
    const manifestPath = path.join(sessionDir, '_manifest.json');
    const manifest: Record<
      string,
      { uploadStatus: 'pending' | 'uploaded' | 'missing'; reason?: string }
    > = {};

    try {
      const data = await withRetryOnEmfile(() => this.fs.readFile(manifestPath));
      const parsed = JSON.parse(data.toString()) as Record<
        string,
        { uploadStatus?: unknown; reason?: unknown }
      >;
      for (const [assetId, value] of Object.entries(parsed)) {
        if (
          value
          && typeof value === 'object'
          && (value.uploadStatus === 'pending'
            || value.uploadStatus === 'uploaded'
            || value.uploadStatus === 'missing')
        ) {
          manifest[assetId] = {
            uploadStatus: value.uploadStatus,
            ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
          };
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(
          { ...redacted, op: args.op, errCode: (err as NodeJS.ErrnoException).code },
          'Failed to read asset manifest',
        );
      }
    }

    manifest[args.assetId] = {
      uploadStatus: args.uploadStatus,
      ...(args.reason ? { reason: args.reason } : {}),
    };

    try {
      await withRetryOnEmfile(() => this.fs.mkdir(sessionDir, { recursive: true }));
      const tmpPath = `${manifestPath}.${randomUUID()}.tmp`;
      await withRetryOnEmfile(() =>
        this.fs.writeFile(tmpPath, Buffer.from(JSON.stringify(manifest))),
      );
      await withRetryOnEmfile(() => this.fs.rename(tmpPath, manifestPath));
    } catch (err) {
      log.warn(
        { ...redacted, op: args.op, errCode: (err as NodeJS.ErrnoException).code },
        'Failed to write asset manifest',
      );
    }
  }

  /**
   * Atomic, race-safe publish of `bytes` to `finalPath`.
   *
   * Flow: `writeFile(tmpPath)` → `link(tmpPath, finalPath)` → `unlink(tmpPath)`.
   * `link` is atomic and fails with EEXIST if `finalPath` is already claimed,
   * which is how concurrent same-asset writes deterministically resolve to one
   * success and one `conflict` throw (never silent overwrite). On EEXIST we
   * read the winner's bytes and treat identical bytes as idempotent success.
   *
   * ENOSPC at any fs-mutating step (`mkdir`, `writeFile`, `link`) is mapped to
   * structured `{ code: 'storage-full' }` so producers can fall back gracefully.
   */
  private async writeFileAtomic(
    sessionDir: string,
    finalPath: string,
    bytes: Buffer,
    op: WriteOp,
    redacted: { sessionIdHash: string; assetIdSuffix: string },
  ): Promise<void> {
    try {
      await withRetryOnEmfile(() => this.fs.mkdir(sessionDir, { recursive: true }));
    } catch (err) {
      this.mapAndThrowFsError(err, op, redacted, 'mkdir');
    }

    const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
    try {
      await withRetryOnEmfile(() => this.fs.writeFile(tmpPath, bytes));
    } catch (err) {
      await this.bestEffortUnlink(tmpPath);
      this.mapAndThrowFsError(err, op, redacted, 'writeFile');
    }

    try {
      await withRetryOnEmfile(() => this.fs.link(tmpPath, finalPath));
    } catch (err) {
      await this.bestEffortUnlink(tmpPath);
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EEXIST') {
        const existing = await this.tryReadFile(finalPath);
        if (existing && existing.equals(bytes)) {
          return;
        }
        log.warn(
          { ...redacted, op, reason: 'conflict' },
          'Concurrent write conflict: another writer claimed this asset path',
        );
        throw new AssetStoreError(
          'conflict',
          'Asset already exists with different bytes',
        );
      }
      this.mapAndThrowFsError(err, op, redacted, 'link');
    }

    // The hardlink at `finalPath` keeps the inode alive even after the tmp
    // name is removed; this cleanup leaves only the canonical file on disk.
    await this.bestEffortUnlink(tmpPath);
  }

  private mapAndThrowFsError(
    err: unknown,
    op: WriteOp,
    redacted: { sessionIdHash: string; assetIdSuffix: string },
    step: FsStep,
  ): never {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOSPC') {
      log.warn(
        { ...redacted, op, reason: 'storage-full', step },
        `Storage full: ENOSPC during ${step}`,
      );
      throw new AssetStoreError('storage-full', 'Disk is full');
    }
    log.warn(
      { ...redacted, op, reason: 'unknown', step, errCode: nodeErr.code },
      `Asset ${step} failed with unexpected fs error`,
    );
    throw err;
  }

  private async bestEffortUnlink(targetPath: string): Promise<void> {
    try {
      await this.fs.unlink(targetPath);
    } catch {
      // Best-effort cleanup; ignore failures.
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reject any identifier that could escape the session asset directory. Both
 * `sessionId` and `assetId` are required to match a tight charset before they
 * are joined into a filesystem path. `.`, `..`, `/`, `\`, NUL, and the empty
 * string are all rejected. The regex deliberately accepts shorter ids than the
 * canonical UUID-style format because test fixtures use short ids; producers
 * in Stage 4 are expected to emit ids matching the D2 format
 * (`${turnId}-${eventSeq}-${index}`).
 */
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeAssetId(assetId: string): void {
  if (!SAFE_ID_REGEX.test(assetId)) {
    throw new AssetStoreError(
      'path-traversal',
      'Asset id contains disallowed characters or invalid length',
    );
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_ID_REGEX.test(sessionId)) {
    throw new AssetStoreError(
      'path-traversal',
      'Session id contains disallowed characters or invalid length',
    );
  }
}

function assertSafeSessionIdOrLogAndThrow(
  sessionId: string,
  op: string,
  redacted: { sessionIdHash: string; assetIdSuffix: string },
): void {
  try {
    assertSafeSessionId(sessionId);
  } catch (err) {
    log.warn(
      { ...redacted, op, reason: 'path-traversal', target: 'sessionId' },
      `Rejected ${op}: sessionId path traversal attempt`,
    );
    throw err;
  }
}

function assertSafeAssetIdOrLogAndThrow(
  assetId: string,
  op: string,
  redacted: { sessionIdHash: string; assetIdSuffix: string },
): void {
  try {
    assertSafeAssetId(assetId);
  } catch (err) {
    log.warn(
      { ...redacted, op, reason: 'path-traversal', target: 'assetId' },
      `Rejected ${op}: assetId path traversal attempt`,
    );
    throw err;
  }
}

function redactIds(sessionId: string, assetId: string): {
  sessionIdHash: string;
  assetIdSuffix: string;
} {
  return {
    sessionIdHash: createHash('sha256')
      .update(sessionId)
      .digest('hex')
      .slice(0, 8),
    assetIdSuffix: assetId.slice(-8),
  };
}

function magicBytesMatch(buffer: Buffer, mimeType: string): boolean {
  if (buffer.length < 12) return false;
  switch (mimeType) {
    case 'image/png':
      return (
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case 'image/gif': {
      const sig = buffer.toString('ascii', 0, 6);
      return sig === 'GIF87a' || sig === 'GIF89a';
    }
    case 'image/webp': {
      const riff = buffer.toString('ascii', 0, 4);
      const webp = buffer.toString('ascii', 8, 12);
      return riff === 'RIFF' && webp === 'WEBP';
    }
    default:
      return false;
  }
}

function sniffMimeFromBytes(buffer: Buffer): AllowedImageMimeType | null {
  for (const mime of ALLOWED_IMAGE_MIME_TYPES) {
    if (magicBytesMatch(buffer, mime)) return mime;
  }
  return null;
}

function existsSyncIgnoringErrors(targetPath: string): boolean {
  try {
    return existsSync(targetPath);
  } catch {
    return false;
  }
}

function createDefaultFs(): AssetStoreFs {
  return {
    writeFile: (p, data) => fsp.writeFile(p, data),
    readFile: async (p) => {
      const buf = await fsp.readFile(p);
      return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    },
    rename: (from, to) => fsp.rename(from, to),
    link: (existing, newPath) => fsp.link(existing, newPath),
    mkdir: (p, opts) => fsp.mkdir(p, opts),
    rm: (p, opts) => fsp.rm(p, opts),
    stat: async (p) => {
      const s = await fsp.stat(p);
      return { size: s.size };
    },
    readdir: (p) => fsp.readdir(p),
    unlink: (p) => fsp.unlink(p),
    access: (p) => fsp.access(p),
  };
}
