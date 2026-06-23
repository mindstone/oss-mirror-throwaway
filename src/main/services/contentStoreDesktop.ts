// CORE-MOVE-EXEMPT: Desktop-only adapter for the @core/contentStore boundary.
// The boundary interface lives in src/core/contentStore.ts (cross-surface);
// this file implements it against the desktop userData filesystem layout.
// Cloud and mobile get separate implementations in cloud-service/cloud-client.
//
/**
 * DesktopContentStore — Electron implementation of the `ContentStore` boundary.
 *
 * Stores session-scoped opaque-content blobs (large tool output, command
 * output, file content materializations) under
 * `${userData}/contentStore/${sessionId}/${contentId}.bin`.
 *
 * Conventions
 * -----------
 * - **Content-addressed**: `contentId` is `sha256(bytes).slice(0,32)`. Two
 *   writes with the same bytes resolve to the same `contentId` and dedupe.
 * - **No MIME validation**: `mimeType` is an opaque renderer hint; unlike
 *   `AssetStore`, text content has no magic-byte signature and no allowlist.
 * - **Atomic writes**: bytes go to `${path}.${uuid}.tmp`, then are published
 *   via `fs.link(tmpPath, finalPath)` and the tmp name is removed. `link` is
 *   atomic and fails with EEXIST if the final path is already claimed; this
 *   is what makes the concurrent same-content different-byte case
 *   deterministic (one writer succeeds, others throw `conflict`). Every fs
 *   op runs under `withRetryOnEmfile` so transient EMFILE storms don't fail
 *   the producer.
 * - **Idempotent re-writes**: identical `{sessionId, contentId}` + identical
 *   bytes ⇒ no-op success.
 * - **Path containment**: `sessionId` and `contentId` are charset-validated
 *   before any path join, and every resolved path is verified to live under
 *   the session's content folder; traversal attempts throw.
 * - **Structured errors**: every error path throws `ContentStoreError` with a
 *   stable `code` from `CONTENT_STORE_ERROR_CODES`, and emits a single
 *   structured warn log with redacted IDs.
 * - **ENOSPC mapping**: any fs-mutating step (`mkdir`, `writeFile`, `link`,
 *   `rename` on soft-delete/restore) maps `ENOSPC` to
 *   `{ code: 'storage-full' }`.
 * - **Log redaction**: never logs raw session IDs, content IDs, or paths.
 *   Uses `sha256(sessionId).slice(0,8)` and `contentId.slice(-8)`.
 *
 * @see docs/plans/260518_cloud_sync_reconciliation_hardening.md § Stage B1a
 */

import { randomUUID, createHash } from 'node:crypto';
import { existsSync, promises as fsp } from 'node:fs';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';
import { getDataPath } from '@core/utils/dataPaths';
import { withRetryOnEmfile } from '@core/utils/emfileRetry';
import type {
  ContentStore,
  ContentStoreErrorCode,
  ContentStoreHasResult,
  ContentStoreReadResult,
  ContentStoreWriteResult,
} from '@core/contentStore';

const log = createScopedLogger({ service: 'contentStoreDesktop' });

const CONTENT_DIR_NAME = 'contentStore';
const DELETED_CONTENT_DIR_NAME = 'contentStore-deleted';
const CONTENT_FILE_EXT = '.bin';
const MANIFEST_FILE = '_manifest.json';

export interface ContentStoreFs {
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
  /**
   * Optional durability hooks (Stage B1a § HIGH #6). When present, the
   * default fs adapter calls these after writeFile/link to fsync the file
   * data and the parent directory entry so we survive abrupt power loss
   * (the tmp blob is the only path to bytes; if it isn't durable, a crash
   * between writeFile and link wipes the content even though we already
   * told the producer it succeeded). Tests inject mocks without these and
   * simply skip the fsync step.
   */
  fsyncFile?(p: string): Promise<void>;
  fsyncDir?(p: string): Promise<void>;
}

interface DesktopContentStoreOptions {
  /** Override the root userData directory. Defaults to `getDataPath()`. */
  baseDir?: string;
  /** Override the dependency-injected fs module (tests). */
  fs?: ContentStoreFs;
}

export class ContentStoreError extends Error {
  readonly code: ContentStoreErrorCode;
  constructor(code: ContentStoreErrorCode, message: string) {
    super(message);
    this.name = 'ContentStoreError';
    this.code = code;
  }
}

type WriteOp = 'writeContent';
type FsStep = 'mkdir' | 'writeFile' | 'link';

export class DesktopContentStore implements ContentStore {
  private readonly baseDirOverride?: string;
  private readonly fs: ContentStoreFs;
  private readonly listeners: Set<(sessionId: string, contentId: string) => void> = new Set();

  constructor(options: DesktopContentStoreOptions = {}) {
    this.baseDirOverride = options.baseDir;
    this.fs = options.fs ?? createDefaultFs();
  }

  onContentWritten(listener: (sessionId: string, contentId: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async markContentUploaded(sessionId: string, contentId: string): Promise<void> {
    await this.updateManifestUploadStatus({
      sessionId,
      contentId,
      uploadStatus: 'uploaded',
      op: 'markContentUploaded',
    });
  }

  async markContentFailed(
    sessionId: string,
    contentId: string,
    reason: string,
  ): Promise<void> {
    await this.updateManifestUploadStatus({
      sessionId,
      contentId,
      uploadStatus: 'missing',
      op: 'markContentFailed',
      reason,
    });
  }

  async listSessionContentStatuses(
    sessionId: string,
  ): Promise<Record<string, 'pending' | 'uploaded' | 'missing'>> {
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'listSessionContentStatuses', redacted);

    const sessionDir = this.resolveSessionContentDir(sessionId);
    const manifestPath = path.join(sessionDir, MANIFEST_FILE);
    try {
      const data = await withRetryOnEmfile(() => this.fs.readFile(manifestPath));
      const parsed = JSON.parse(data.toString()) as Record<
        string,
        { uploadStatus?: unknown }
      >;
      const result: Record<string, 'pending' | 'uploaded' | 'missing'> = {};
      for (const [contentId, value] of Object.entries(parsed)) {
        if (
          value
          && typeof value === 'object'
          && (value.uploadStatus === 'pending'
            || value.uploadStatus === 'uploaded'
            || value.uploadStatus === 'missing')
        ) {
          result[contentId] = value.uploadStatus;
        }
      }
      return result;
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode !== 'ENOENT') {
        log.warn(
          { ...redacted, op: 'listSessionContentStatuses', errCode },
          'Failed to read content status manifest',
        );
      }
      return {};
    }
  }

  async listSessionContentUploadRecords(
    sessionId: string,
  ): Promise<Record<string, {
    uploadStatus: 'pending' | 'uploaded' | 'missing';
    firstQueuedAt?: number;
  }>> {
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'listSessionContentUploadRecords', redacted);

    const sessionDir = this.resolveSessionContentDir(sessionId);
    const manifestPath = path.join(sessionDir, MANIFEST_FILE);
    try {
      const data = await withRetryOnEmfile(() => this.fs.readFile(manifestPath));
      const parsed = JSON.parse(data.toString()) as Record<
        string,
        { uploadStatus?: unknown; firstQueuedAt?: unknown }
      >;
      const result: Record<string, {
        uploadStatus: 'pending' | 'uploaded' | 'missing';
        firstQueuedAt?: number;
      }> = {};
      for (const [contentId, value] of Object.entries(parsed)) {
        if (
          value
          && typeof value === 'object'
          && (value.uploadStatus === 'pending'
            || value.uploadStatus === 'uploaded'
            || value.uploadStatus === 'missing')
        ) {
          result[contentId] = {
            uploadStatus: value.uploadStatus,
            ...(typeof value.firstQueuedAt === 'number' && Number.isFinite(value.firstQueuedAt)
              ? { firstQueuedAt: value.firstQueuedAt }
              : {}),
          };
        }
      }
      return result;
    } catch (err) {
      const errCode = (err as NodeJS.ErrnoException).code;
      if (errCode !== 'ENOENT') {
        log.warn(
          { ...redacted, op: 'listSessionContentUploadRecords', errCode },
          'Failed to read content upload manifest records',
        );
      }
      return {};
    }
  }

  async writeContent(args: {
    sessionId: string;
    contentId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<ContentStoreWriteResult> {
    const { sessionId, contentId, bytes, mimeType } = args;
    const redacted = redactIds(sessionId, contentId);

    assertSafeSessionIdOrLogAndThrow(sessionId, 'writeContent', redacted);
    assertSafeContentIdOrLogAndThrow(contentId, 'writeContent', redacted);

    const sessionDir = this.resolveSessionContentDir(sessionId);
    const finalPath = this.resolveContentPath(sessionDir, `${contentId}${CONTENT_FILE_EXT}`);

    const existing = await this.tryReadFile(finalPath);
    if (existing) {
      if (existing.equals(bytes)) {
        return {
          ref: {
            contentId,
            mimeType,
            byteSize: bytes.byteLength,
            etag: contentId,
          },
          status: 'duplicate',
        };
      }
      log.warn(
        { ...redacted, op: 'writeContent', reason: 'conflict' },
        'Rejected write: content already exists with different bytes',
      );
      throw new ContentStoreError(
        'conflict',
        'Content already exists with different bytes',
      );
    }

    await this.writeFileAtomic(sessionDir, finalPath, bytes, 'writeContent', redacted);

    await this.updateManifestUploadStatus({
      sessionId,
      contentId,
      uploadStatus: 'pending',
      op: 'writeContent',
      mimeType,
      byteSize: bytes.byteLength,
    });

    for (const listener of this.listeners) {
      listener(sessionId, contentId);
    }

    return {
      ref: {
        contentId,
        mimeType,
        byteSize: bytes.byteLength,
        etag: contentId,
      },
      status: 'created',
    };
  }

  async readContent(args: {
    sessionId: string;
    contentId: string;
  }): Promise<ContentStoreReadResult> {
    const { sessionId, contentId } = args;
    const redacted = redactIds(sessionId, contentId);

    assertSafeSessionIdOrLogAndThrow(sessionId, 'readContent', redacted);

    let resolvedPath: string;
    try {
      resolvedPath = this.resolveContentPathForRead(sessionId, contentId);
    } catch (err) {
      const code = (err as ContentStoreError).code;
      if (code === 'path-traversal') {
        log.warn(
          { ...redacted, op: 'readContent', reason: 'permission-denied' },
          'Rejected read: contentId path traversal attempt',
        );
        return { reason: 'permission-denied' };
      }
      throw err;
    }

    let bytes: Buffer;
    try {
      bytes = await withRetryOnEmfile(() => this.fs.readFile(resolvedPath));
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        log.warn(
          { ...redacted, op: 'readContent', reason: 'not-found' },
          'Read: content not found',
        );
        return { reason: 'not-found' };
      }
      if (nodeErr.code === 'EACCES' || nodeErr.code === 'EPERM') {
        log.warn(
          { ...redacted, op: 'readContent', reason: 'permission-denied' },
          'Rejected read: filesystem permission denied',
        );
        return { reason: 'permission-denied' };
      }
      log.warn(
        { ...redacted, op: 'readContent', reason: 'unknown', errCode: nodeErr.code },
        'Read failed with unexpected fs error',
      );
      return { reason: 'unknown' };
    }

    const computedId = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    if (computedId !== contentId) {
      log.warn(
        { ...redacted, op: 'readContent', reason: 'corrupt' },
        'Read returned bytes whose content hash no longer matches the contentId',
      );
      return { reason: 'corrupt' };
    }

    const mimeType = await this.lookupMimeFromManifest(sessionId, contentId);
    return {
      reason: 'ok',
      bytes,
      mimeType: mimeType ?? 'application/octet-stream',
      byteSize: bytes.byteLength,
    };
  }

  async hasContent(args: {
    sessionId: string;
    contentId: string;
  }): Promise<ContentStoreHasResult> {
    const { sessionId, contentId } = args;
    const redacted = redactIds(sessionId, contentId);

    assertSafeSessionIdOrLogAndThrow(sessionId, 'hasContent', redacted);

    let resolvedPath: string;
    try {
      resolvedPath = this.resolveContentPathForRead(sessionId, contentId);
    } catch (err) {
      const code = (err as ContentStoreError).code;
      if (code === 'path-traversal') {
        log.warn(
          { ...redacted, op: 'hasContent', reason: 'path-traversal' },
          'hasContent rejected: contentId path traversal attempt',
        );
      }
      return { has: false };
    }

    try {
      const stat = await withRetryOnEmfile(() => this.fs.stat(resolvedPath));
      return { has: true, byteSize: stat.size };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn(
          { ...redacted, op: 'hasContent', reason: 'unknown', errCode: code },
          'hasContent stat failed with unexpected fs error',
        );
      }
      return { has: false };
    }
  }

  async listSessionContent(args: { sessionId: string }): Promise<string[]> {
    const { sessionId } = args;
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'listSessionContent', redacted);

    const sessionDir = this.resolveSessionContentDir(sessionId);
    let entries: string[];
    try {
      entries = await withRetryOnEmfile(() => this.fs.readdir(sessionDir));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.warn(
          { ...redacted, op: 'listSessionContent', reason: 'not-found' },
          'listSessionContent: session content folder does not exist',
        );
        return [];
      }
      log.warn(
        { ...redacted, op: 'listSessionContent', reason: 'unknown', errCode: code },
        'listSessionContent readdir failed with unexpected fs error',
      );
      throw err;
    }

    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(CONTENT_FILE_EXT)) continue;
      const stem = entry.slice(0, entry.length - CONTENT_FILE_EXT.length);
      ids.push(stem);
    }
    ids.sort();
    return ids;
  }

  async deleteSession(args: { sessionId: string }): Promise<void> {
    const { sessionId } = args;
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'deleteSession', redacted);

    const sessionDir = this.resolveSessionContentDir(sessionId);
    try {
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

  async moveSessionContentToDeleted(args: {
    sessionId: string;
    timestamp: number;
  }): Promise<void> {
    const { sessionId, timestamp } = args;
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(sessionId, 'moveSessionContentToDeleted', redacted);

    const from = this.resolveSessionContentDir(sessionId);
    const to = this.resolveDeletedContentDir(sessionId, timestamp);

    try {
      await withRetryOnEmfile(() =>
        this.fs.mkdir(path.dirname(to), { recursive: true }),
      );
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOSPC') {
        log.warn(
          { ...redacted, op: 'moveSessionContentToDeleted', reason: 'storage-full', step: 'mkdir' },
          'Storage full: ENOSPC during soft-delete mkdir',
        );
        throw new ContentStoreError('storage-full', 'Disk is full');
      }
      log.warn(
        { ...redacted, op: 'moveSessionContentToDeleted', reason: 'unknown', step: 'mkdir', errCode: nodeErr.code },
        'moveSessionContentToDeleted mkdir failed with unexpected fs error',
      );
      throw err;
    }

    try {
      await withRetryOnEmfile(() => this.fs.rename(from, to));
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        log.warn(
          { ...redacted, op: 'moveSessionContentToDeleted', reason: 'not-found' },
          'moveSessionContentToDeleted: source content folder does not exist',
        );
        return;
      }
      if (nodeErr.code === 'ENOSPC') {
        log.warn(
          { ...redacted, op: 'moveSessionContentToDeleted', reason: 'storage-full', step: 'rename' },
          'Storage full: ENOSPC during soft-delete rename',
        );
        throw new ContentStoreError('storage-full', 'Disk is full');
      }
      log.warn(
        { ...redacted, op: 'moveSessionContentToDeleted', reason: 'unknown', step: 'rename', errCode: nodeErr.code },
        'moveSessionContentToDeleted rename failed with unexpected fs error',
      );
      throw err;
    }
  }

  async restoreSessionContentFromDeleted(args: {
    sessionId: string;
    timestamp: number;
  }): Promise<void> {
    const { sessionId, timestamp } = args;
    const redacted = redactIds(sessionId, '');
    assertSafeSessionIdOrLogAndThrow(
      sessionId,
      'restoreSessionContentFromDeleted',
      redacted,
    );

    const from = this.resolveDeletedContentDir(sessionId, timestamp);
    const to = this.resolveSessionContentDir(sessionId);

    if (await this.pathExists(to)) {
      log.warn(
        { ...redacted, op: 'restoreSessionContentFromDeleted', reason: 'restore-conflict' },
        'Restore aborted: active content folder already exists',
      );
      throw new ContentStoreError(
        'restore-conflict',
        'Active content folder already exists for this session',
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
          { ...redacted, op: 'restoreSessionContentFromDeleted', reason: 'storage-full', step: 'mkdir' },
          'Storage full: ENOSPC during restore mkdir',
        );
        throw new ContentStoreError('storage-full', 'Disk is full');
      }
      log.warn(
        { ...redacted, op: 'restoreSessionContentFromDeleted', reason: 'unknown', step: 'mkdir', errCode: nodeErr.code },
        'restoreSessionContentFromDeleted mkdir failed with unexpected fs error',
      );
      throw err;
    }

    try {
      await withRetryOnEmfile(() => this.fs.rename(from, to));
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        log.warn(
          { ...redacted, op: 'restoreSessionContentFromDeleted', reason: 'not-found' },
          'restoreSessionContentFromDeleted: trash content folder does not exist',
        );
        throw err;
      }
      if (nodeErr.code === 'ENOSPC') {
        log.warn(
          { ...redacted, op: 'restoreSessionContentFromDeleted', reason: 'storage-full', step: 'rename' },
          'Storage full: ENOSPC during restore rename',
        );
        throw new ContentStoreError('storage-full', 'Disk is full');
      }
      log.warn(
        { ...redacted, op: 'restoreSessionContentFromDeleted', reason: 'unknown', step: 'rename', errCode: nodeErr.code },
        'restoreSessionContentFromDeleted rename failed with unexpected fs error',
      );
      throw err;
    }
  }

  private baseDir(): string {
    return this.baseDirOverride ?? getDataPath();
  }

  private resolveSessionContentDir(sessionId: string): string {
    return path.join(this.baseDir(), CONTENT_DIR_NAME, sessionId);
  }

  private resolveDeletedContentDir(sessionId: string, timestamp: number): string {
    return path.join(
      this.baseDir(),
      DELETED_CONTENT_DIR_NAME,
      `${sessionId}_${timestamp}`,
    );
  }

  private resolveContentPath(sessionDir: string, filename: string): string {
    const resolvedDir = path.resolve(sessionDir);
    const resolvedTarget = path.resolve(sessionDir, filename);
    const relative = path.relative(resolvedDir, resolvedTarget);
    if (
      relative === ''
      || relative === '..'
      || relative.startsWith('..' + path.sep)
      || path.isAbsolute(relative)
      || relative.includes(path.sep)
    ) {
      throw new ContentStoreError(
        'path-traversal',
        'Content filename escapes the session content directory',
      );
    }
    return resolvedTarget;
  }

  private resolveContentPathForRead(sessionId: string, contentId: string): string {
    assertSafeContentId(contentId);
    const sessionDir = this.resolveSessionContentDir(sessionId);
    return this.resolveContentPath(sessionDir, `${contentId}${CONTENT_FILE_EXT}`);
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

  private async lookupMimeFromManifest(
    sessionId: string,
    contentId: string,
  ): Promise<string | undefined> {
    const sessionDir = this.resolveSessionContentDir(sessionId);
    const manifestPath = path.join(sessionDir, MANIFEST_FILE);
    try {
      const data = await withRetryOnEmfile(() => this.fs.readFile(manifestPath));
      const parsed = JSON.parse(data.toString()) as Record<string, { mimeType?: unknown }>;
      const entry = parsed[contentId];
      if (entry && typeof entry === 'object' && typeof entry.mimeType === 'string') {
        return entry.mimeType;
      }
    } catch {
      // Manifest absent / unreadable — fall back to caller default
    }
    return undefined;
  }

  private async updateManifestUploadStatus(args: {
    sessionId: string;
    contentId: string;
    uploadStatus: 'pending' | 'uploaded' | 'missing';
    op: 'writeContent' | 'markContentUploaded' | 'markContentFailed';
    reason?: string;
    mimeType?: string;
    byteSize?: number;
  }): Promise<void> {
    const redacted = redactIds(args.sessionId, args.contentId);
    assertSafeSessionIdOrLogAndThrow(args.sessionId, args.op, redacted);
    assertSafeContentIdOrLogAndThrow(args.contentId, args.op, redacted);

    const sessionDir = this.resolveSessionContentDir(args.sessionId);
    const manifestPath = path.join(sessionDir, MANIFEST_FILE);
    const manifest: Record<
      string,
      {
        uploadStatus: 'pending' | 'uploaded' | 'missing';
        reason?: string;
        mimeType?: string;
        byteSize?: number;
        firstQueuedAt?: number;
      }
    > = {};

    try {
      const data = await withRetryOnEmfile(() => this.fs.readFile(manifestPath));
      const parsed = JSON.parse(data.toString()) as Record<
        string,
        {
          uploadStatus?: unknown;
          reason?: unknown;
          mimeType?: unknown;
          byteSize?: unknown;
          firstQueuedAt?: unknown;
        }
      >;
      for (const [contentId, value] of Object.entries(parsed)) {
        if (
          value
          && typeof value === 'object'
          && (value.uploadStatus === 'pending'
            || value.uploadStatus === 'uploaded'
            || value.uploadStatus === 'missing')
        ) {
          manifest[contentId] = {
            uploadStatus: value.uploadStatus,
            ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
            ...(typeof value.mimeType === 'string' ? { mimeType: value.mimeType } : {}),
            ...(typeof value.byteSize === 'number' ? { byteSize: value.byteSize } : {}),
            ...(typeof value.firstQueuedAt === 'number' && Number.isFinite(value.firstQueuedAt)
              ? { firstQueuedAt: value.firstQueuedAt }
              : {}),
          };
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(
          { ...redacted, op: args.op, errCode: (err as NodeJS.ErrnoException).code },
          'Failed to read content manifest',
        );
      }
    }

    const previous = manifest[args.contentId];
    manifest[args.contentId] = {
      uploadStatus: args.uploadStatus,
      ...(args.reason ? { reason: args.reason } : previous?.reason ? { reason: previous.reason } : {}),
      ...(args.mimeType
        ? { mimeType: args.mimeType }
        : previous?.mimeType
          ? { mimeType: previous.mimeType }
          : {}),
      ...(args.byteSize !== undefined
        ? { byteSize: args.byteSize }
        : previous?.byteSize !== undefined
          ? { byteSize: previous.byteSize }
          : {}),
      ...(args.uploadStatus === 'pending'
        ? { firstQueuedAt: previous?.firstQueuedAt ?? Date.now() }
        : previous?.firstQueuedAt !== undefined
          ? { firstQueuedAt: previous.firstQueuedAt }
          : {}),
    };

    try {
      await withRetryOnEmfile(() => this.fs.mkdir(sessionDir, { recursive: true }));
      const tmpPath = `${manifestPath}.${randomUUID()}.tmp`;
      await withRetryOnEmfile(() =>
        this.fs.writeFile(tmpPath, Buffer.from(JSON.stringify(manifest))),
      );
      await this.bestEffortFsyncFile(tmpPath);
      await withRetryOnEmfile(() => this.fs.rename(tmpPath, manifestPath));
      await this.bestEffortFsyncDir(sessionDir);
    } catch (err) {
      log.warn(
        { ...redacted, op: args.op, errCode: (err as NodeJS.ErrnoException).code },
        'Failed to write content manifest',
      );
    }
  }

  /**
   * Atomic, race-safe publish of `bytes` to `finalPath`.
   *
   * Flow: `writeFile(tmpPath)` → `link(tmpPath, finalPath)` → `unlink(tmpPath)`.
   * `link` is atomic and fails with EEXIST if `finalPath` is already claimed,
   * which is how concurrent same-content writes deterministically resolve to
   * one success and others as `conflict` (never silent overwrite). On EEXIST
   * we read the winner's bytes and treat identical bytes as idempotent success.
   *
   * ENOSPC at any fs-mutating step (`mkdir`, `writeFile`, `link`) is mapped
   * to structured `{ code: 'storage-full' }` so producers can fall back
   * gracefully to inline content.
   */
  private async writeFileAtomic(
    sessionDir: string,
    finalPath: string,
    bytes: Buffer,
    op: WriteOp,
    redacted: { sessionIdHash: string; contentIdSuffix: string },
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

    // fsync the tmp file BEFORE link: link only publishes a directory entry
    // pointing at the inode; if the inode's data is still in the page cache
    // when the kernel crashes, the published file ends up empty. See
    // Stage B1a § HIGH #6.
    await this.bestEffortFsyncFile(tmpPath);

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
          'Concurrent write conflict: another writer claimed this content path',
        );
        throw new ContentStoreError(
          'conflict',
          'Content already exists with different bytes',
        );
      }
      this.mapAndThrowFsError(err, op, redacted, 'link');
    }

    // fsync the parent directory so the newly published name survives a
    // crash even before subsequent metadata operations.
    await this.bestEffortFsyncDir(sessionDir);

    await this.bestEffortUnlink(tmpPath);
  }

  private async bestEffortFsyncFile(targetPath: string): Promise<void> {
    if (!this.fs.fsyncFile) return;
    try {
      await this.fs.fsyncFile(targetPath);
    } catch {
      // fsync is a durability hint; best-effort.
    }
  }

  private async bestEffortFsyncDir(targetPath: string): Promise<void> {
    if (!this.fs.fsyncDir) return;
    try {
      await this.fs.fsyncDir(targetPath);
    } catch {
      // fsync is a durability hint; best-effort.
    }
  }

  private mapAndThrowFsError(
    err: unknown,
    op: WriteOp,
    redacted: { sessionIdHash: string; contentIdSuffix: string },
    step: FsStep,
  ): never {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOSPC') {
      log.warn(
        { ...redacted, op, reason: 'storage-full', step },
        `Storage full: ENOSPC during ${step}`,
      );
      throw new ContentStoreError('storage-full', 'Disk is full');
    }
    log.warn(
      { ...redacted, op, reason: 'unknown', step, errCode: nodeErr.code },
      `Content ${step} failed with unexpected fs error`,
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

const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

function assertSafeContentId(contentId: string): void {
  if (!SAFE_ID_REGEX.test(contentId)) {
    throw new ContentStoreError(
      'path-traversal',
      'Content id contains disallowed characters or invalid length',
    );
  }
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_ID_REGEX.test(sessionId)) {
    throw new ContentStoreError(
      'path-traversal',
      'Session id contains disallowed characters or invalid length',
    );
  }
}

function assertSafeSessionIdOrLogAndThrow(
  sessionId: string,
  op: string,
  redacted: { sessionIdHash: string; contentIdSuffix: string },
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

function assertSafeContentIdOrLogAndThrow(
  contentId: string,
  op: string,
  redacted: { sessionIdHash: string; contentIdSuffix: string },
): void {
  try {
    assertSafeContentId(contentId);
  } catch (err) {
    log.warn(
      { ...redacted, op, reason: 'path-traversal', target: 'contentId' },
      `Rejected ${op}: contentId path traversal attempt`,
    );
    throw err;
  }
}

function redactIds(sessionId: string, contentId: string): {
  sessionIdHash: string;
  contentIdSuffix: string;
} {
  return {
    sessionIdHash: createHash('sha256').update(sessionId).digest('hex').slice(0, 8),
    contentIdSuffix: contentId.slice(-8),
  };
}

// Suppress unused warnings; exported for parity with assetStoreDesktop test fixtures.
void existsSync;

function createDefaultFs(): ContentStoreFs {
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
    fsyncFile: async (p) => {
      const handle = await fsp.open(p, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
    fsyncDir: async (p) => {
      // POSIX requires opening a directory read-only for fsync to be valid;
      // Windows surfaces an EISDIR for the open call and skips the sync, so
      // we swallow it best-effort upstream.
      const handle = await fsp.open(p, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },
  };
}
