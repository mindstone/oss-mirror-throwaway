import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';

const shareLog = createScopedLogger({ service: 'shareLinksService' });

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

export interface ShareEntry {
  shareId: string;
  createdAt: number;
  expiresAt?: number;
  passwordHash?: string;
  title?: string;
  resourceType?: ShareResourceType; // undefined = 'conversation' (backward compat)
  filePath?: string; // workspace-relative path, present when resourceType='file'
}

export interface ShareLinksMap {
  [key: string]: ShareEntry; // key = sessionId (conversations) or 'file:<path>' (files)
}

export type ExpiryOption = '24h' | '7d' | '30d' | 'never';
export type ShareResourceType = 'conversation' | 'file';

export const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const EXPIRY_MS: Record<string, number> = { '24h': 864e5, '7d': 6048e5, '30d': 2592e6 };
export const VALID_EXPIRY: ReadonlySet<string> = new Set<string>(['24h', '7d', '30d', 'never']);
export const PASSWORD_MIN = 1;
export const PASSWORD_MAX = 128;
const SCRYPT_KEY_LEN = 32;
const SCRYPT_OPTS: crypto.ScryptOptions = { N: 1 << 14, r: 8, p: 1 };

const MIME_MAP: Record<string, string> = {
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.xml': 'application/xml',
};

/** Cap for including text content inline in JSON responses (~1MB). */
export const MAX_TEXT_CONTENT_SIZE = 1_048_576;

const FILE_SHARE_DOWNLOAD_TTL_MS = 300_000;

const getErrorMessage = (err: unknown): string => err instanceof Error ? err.message : String(err);

// ---------------------------------------------------------------------------
// Pure validators / helpers
// ---------------------------------------------------------------------------

export function isValidShareId(shareId: string): boolean {
  return SHARE_ID_RE.test(shareId);
}

export function isValidPassword(pw: unknown): pw is string {
  return typeof pw === 'string' && pw.length >= PASSWORD_MIN && pw.length <= PASSWORD_MAX;
}

export function isValidExpiryOption(value: unknown): value is ExpiryOption {
  return typeof value === 'string' && VALID_EXPIRY.has(value);
}

export function computeExpiresAt(option?: ExpiryOption, now: () => number = Date.now): number | undefined {
  if (!option || option === 'never') return undefined;
  return now() + EXPIRY_MS[option];
}

export function isExpired(entry: ShareEntry, now: () => number = Date.now): boolean {
  return entry.expiresAt != null && now() > entry.expiresAt;
}

/** Build the share-links.json key for a file share. */
export function fileShareKey(filePath: string): string {
  return `file:${filePath}`;
}

export function generateShareId(): string {
  return crypto.randomBytes(16).toString('base64url');
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

export function hashPassword(pw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, SCRYPT_KEY_LEN, SCRYPT_OPTS, (err, derived) =>
      err ? reject(err) : resolve(`${salt.toString('hex')}:${derived.toString('hex')}`));
  });
}

export function verifyPassword(pw: string, stored: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const [saltHex, hashHex] = stored.split(':');
    if (!saltHex || !hashHex) return resolve(false);
    const expected = Buffer.from(hashHex, 'hex');
    crypto.scrypt(pw, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTS, (err, actual) =>
      err ? reject(err) : resolve(actual.length === expected.length && crypto.timingSafeEqual(actual, expected)));
  });
}

export function signFileDownloadUrl(
  shareId: string,
  secret: string,
  ttlMs: number,
): { sig: string; exp: number } {
  const exp = Date.now() + ttlMs;
  const sig = crypto.createHmac('sha256', secret).update(`${shareId}:${exp}`).digest('hex');
  return { sig, exp };
}

export function verifyFileDownloadSignature(input: {
  shareId: string;
  sig: string;
  exp: string;
  secret: string;
  now?: () => number;
}): boolean {
  const expMs = parseInt(input.exp, 10);
  if (Number.isNaN(expMs) || (input.now ?? Date.now)() > expMs) {
    return false;
  }

  const expectedSig = crypto.createHmac('sha256', input.secret)
    .update(`${input.shareId}:${input.exp}`)
    .digest('hex');

  try {
    const sigBuf = Buffer.from(input.sig, 'hex');
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Markdown / HTML
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s{0,3}[-*_]{3,}\s*$/gm, '')
    .replace(/\*\*|__|[*_~]/g, '')
    .replace(/!\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// File / MIME helpers
// ---------------------------------------------------------------------------

export function getMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}

export function isTextMime(mime: string): boolean {
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml';
}

/**
 * Build a Content-Disposition header value with sanitized filename.
 * Strips control characters and uses RFC 5987 `filename*=UTF-8''...` for Unicode.
 */
export function buildContentDisposition(fileName: string): string {
  const sanitized = fileName.replace(/[\r\n\x00-\x1f]/g, '_');
  const asciiName = sanitized.replace(/[^\x20-\x7e]/g, '_');
  const encodedName = encodeURIComponent(sanitized).replace(/'/g, '%27');
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

export interface ResolvedFile {
  resolved: string;
  size: number;
  mtimeMs: number;
}

/**
 * Resolve a workspace-relative file path to an absolute path with full validation.
 * Checks: path traversal, symlink escape, file existence, regular file type.
 */
export async function resolveSharedFilePath(
  filePath: string,
  workspaceDir: string,
): Promise<({ ok: true } & ResolvedFile) | { ok: false }> {
  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolved = path.resolve(resolvedWorkspace, filePath);

  // Path traversal check
  if (!resolved.startsWith(resolvedWorkspace + path.sep) && resolved !== resolvedWorkspace) {
    return { ok: false };
  }

  try {
    // Symlink protection: resolve real path and verify it's still in workspace
    const realPath = await fs.realpath(resolved);
    if (!realPath.startsWith(resolvedWorkspace + path.sep) && realPath !== resolvedWorkspace) {
      return { ok: false };
    }
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) return { ok: false };
    return { ok: true, resolved: realPath, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { ok: false };
  }
}

export interface ValidatedFile {
  resolved: string;
}

export interface FileValidationError {
  error: string;
  code: string;
  status: number;
}

/**
 * Validate that `filePath` resolves inside `workspaceDir` and points to a regular file.
 * Returns the resolved absolute path on success, or an error string on failure.
 */
export async function validateFilePath(
  filePath: string,
  workspaceDir: string,
): Promise<({ ok: true } & ValidatedFile) | ({ ok: false } & FileValidationError)> {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'filePath is required', code: 'INVALID_BODY', status: 400 };
  }

  const resolvedWorkspace = path.resolve(workspaceDir);
  const resolved = path.resolve(resolvedWorkspace, filePath);

  // Path traversal check
  if (!resolved.startsWith(resolvedWorkspace + path.sep) && resolved !== resolvedWorkspace) {
    return { ok: false, error: 'Path traversal not allowed', code: 'INVALID_PATH', status: 400 };
  }

  // File existence and type check
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return { ok: false, error: 'Path is not a regular file', code: 'INVALID_PATH', status: 400 };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: 'File not found', code: 'FILE_NOT_FOUND', status: 404 };
    }
    return { ok: false, error: 'Unable to access file', code: 'FILE_ACCESS_ERROR', status: 500 };
  }

  return { ok: true, resolved };
}

export interface SharedFileMetadata {
  resourceType: 'file';
  fileName: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
  updatedAt: number;
  content?: string;
}

/**
 * Build file metadata JSON for shared file endpoints.
 * Returns null if the file is no longer available.
 */
export async function buildSharedFileMetadata(
  shareId: string,
  entry: ShareEntry,
  workspaceDir: string,
): Promise<SharedFileMetadata | null> {
  const filePath = entry.filePath;
  if (!filePath) return null;

  const fileResult = await resolveSharedFilePath(filePath, workspaceDir);
  if (!fileResult.ok) return null;

  const fileName = path.basename(filePath);
  const mimeType = getMimeType(fileName);

  const result: SharedFileMetadata = {
    resourceType: 'file',
    fileName,
    mimeType,
    size: fileResult.size,
    downloadUrl: `/api/shared/${shareId}/download`,
    updatedAt: fileResult.mtimeMs,
  };

  // Include content for text files (capped at ~1MB)
  if (isTextMime(mimeType) && fileResult.size <= MAX_TEXT_CONTENT_SIZE) {
    try {
      result.content = await fs.readFile(fileResult.resolved, 'utf-8');
    } catch {
      // Metadata still valid without inline content
    }
  }

  return result;
}

// TODO(share-service): unify validateFilePath + resolveSharedFilePath once we can
// preserve both create-time and read-time path semantics behind one explicit mode.

// ---------------------------------------------------------------------------
// Session sanitisation
// ---------------------------------------------------------------------------

export interface ShareableSessionMessage {
  id: string;
  role: string;
  text: string;
  createdAt: number;
  isHidden?: boolean;
}

export interface ShareableSession {
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  deletedAt?: number | null;
  privateMode?: boolean;
  messages?: ShareableSessionMessage[];
}

export interface SharedConversation {
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  messages: Array<Pick<ShareableSessionMessage, 'id' | 'role' | 'text' | 'createdAt'>>;
}

export function sanitizeSession(session: ShareableSession): SharedConversation {
  return {
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: (session.messages || [])
      .filter((m) => !m.isHidden)
      .map((m) => ({ id: m.id, role: m.role, text: m.text, createdAt: m.createdAt })),
  };
}

// ---------------------------------------------------------------------------
// Rate limiting — in-memory, per-key, with periodic cleanup
// ---------------------------------------------------------------------------

export interface RateLimiterApi {
  isLimited(key: string): boolean;
  reset(): void;
}

class RateLimiter implements RateLimiterApi {
  private hits = new Map<string, number[]>();
  private maxHits: number;
  private windowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor(maxHits: number, windowMs: number) {
    this.maxHits = maxHits;
    this.windowMs = windowMs;
    this.cleanupTimer = setInterval(() => this.cleanup(), windowMs);
    this.cleanupTimer.unref();
  }

  isLimited(key: string): boolean {
    const now = Date.now();
    const timestamps = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    timestamps.push(now);
    this.hits.set(key, timestamps);
    return timestamps.length > this.maxHits;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, timestamps] of this.hits) {
      const active = timestamps.filter(t => now - t < this.windowMs);
      if (active.length === 0) this.hits.delete(key);
      else this.hits.set(key, active);
    }
  }

  reset(): void { this.hits.clear(); }
}

export const managementLimiter: RateLimiterApi = new RateLimiter(30, 60_000);
export const publicReadLimiter: RateLimiterApi = new RateLimiter(60, 60_000);
export const unlockLimiter: RateLimiterApi = new RateLimiter(5, 300_000);

/** Test-only: reset all rate limiters and mutex between tests. */
export function resetRateLimitersForTests(): void {
  managementLimiter.reset();
  publicReadLimiter.reset();
  unlockLimiter.reset();
  _mutexQueue = Promise.resolve();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let _mutexQueue: Promise<void> = Promise.resolve();

/**
 * Acquire a write lock around share-links.json mutations.
 * Ensures only one read-modify-write cycle runs at a time.
 * The lock is released when `fn` settles (resolves or rejects).
 */
export function withShareLinksMutex<T>(fn: () => Promise<T>): Promise<T> {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const prev = _mutexQueue;
  _mutexQueue = gate;
  return prev.then(fn).finally(() => {
    if (release === undefined) {
      throw new Error('Invariant violated: share-links mutex release was not assigned by Promise constructor');
    }
    release();
  });
}

export function getShareFilePath(): string {
  // TODO(share-service): migrate this to a desktop/mobile-aware data-path boundary
  // once those surfaces adopt share links. Today cloud reads REBEL_USER_DATA per call.
  return path.join(process.env.REBEL_USER_DATA || '/data', 'share-links.json');
}

export async function readShareLinks(): Promise<ShareLinksMap> {
  let raw: string;
  try {
    raw = await fs.readFile(getShareFilePath(), 'utf-8');
  } catch (err: unknown) {
    // File doesn't exist yet → empty store (normal on first run)
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    // Permission errors, I/O errors → fail closed (do NOT silently return {})
    shareLog.error({ error: getErrorMessage(err) }, 'Failed to read share-links.json');
    throw err;
  }
  try {
    return JSON.parse(raw) as ShareLinksMap;
  } catch (err: unknown) {
    // Corrupt/invalid JSON → fail closed
    shareLog.error({ error: getErrorMessage(err) }, 'share-links.json contains invalid JSON');
    throw new Error('share-links.json is corrupt');
  }
}

export async function writeShareLinks(map: ShareLinksMap): Promise<void> {
  const filePath = getShareFilePath();
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.share-links-${Date.now()}.tmp`);
  await fs.writeFile(tmpPath, JSON.stringify(map), 'utf-8');
  await fs.rename(tmpPath, filePath);
}

export function findShareByShareId(
  map: ShareLinksMap,
  shareId: string,
): { sessionId: string; entry: ShareEntry } | null {
  for (const [sessionId, entry] of Object.entries(map)) {
    if (entry.shareId === shareId) return { sessionId, entry };
  }
  return null;
}

// TODO(share-service): consider migrating to KeyValueStore once we add a one-shot
// disk migration that preserves the existing cloud share-links.json format.

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ShareLinksError =
  | { kind: 'session_not_found' }
  | { kind: 'session_deleted' }
  | { kind: 'private_session' }
  | { kind: 'invalid_expiry' }
  | { kind: 'invalid_password'; message?: string }
  | { kind: 'invalid_body'; message: string }
  | { kind: 'invalid_path'; status: number; code: string; message: string }
  | { kind: 'no_share'; resourceType: ShareResourceType }
  | { kind: 'unauthorized' }
  | { kind: 'password_required'; resourceType: ShareResourceType }
  | { kind: 'resource_unavailable' }
  | { kind: 'conversation_unavailable' }
  | { kind: 'invalid_share_id'; resourceType: ShareResourceType }
  | { kind: 'write_failed'; message: string }
  | { kind: 'download_secret_unconfigured' };

export type ShareLinksResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ShareLinksError };

const ok = <T>(value: T): ShareLinksResult<T> => ({ ok: true, value });
const err = <T>(error: ShareLinksError): ShareLinksResult<T> => ({ ok: false, error });

export interface ConversationShareDeps {
  getSession: (id: string) => Promise<ShareableSession | null>;
}

export interface ShareSummary {
  shareId: string;
  expiresAt?: number;
  hasPassword: boolean;
}

export interface ShareUpdateSummary {
  expiresAt?: number;
  hasPassword: boolean;
}

export interface FileShareDeps {
  workspaceDir: string;
}

export interface SharedReadDeps extends ConversationShareDeps {
  workspaceDir: string;
}

export type SharedResource =
  | { type: 'conversation'; data: SharedConversation }
  | { type: 'file'; data: SharedFileMetadata };

export interface AuthorizedDownload {
  resolved: string;
  size: number;
  fileName: string;
  mimeType: string;
  disposition: string;
}

export interface ShareListEntry {
  sessionId?: string;
  shareId: string;
  title?: string;
  createdAt: number;
  expiresAt?: number;
  hasPassword: boolean;
  resourceType: ShareResourceType;
  filePath?: string;
}

export interface SharePreviewData {
  title: string;
  description: string;
}

export interface SharePreviewDeps {
  getSession: (id: string) => Promise<ShareableSession | null>;
  getSettings?: () => { coreDirectory?: string | null };
}

// ---------------------------------------------------------------------------
// Domain operations: conversation share
// ---------------------------------------------------------------------------

export async function createConversationShare(
  sessionId: string,
  input: { expiresIn?: unknown; password?: unknown },
  deps: ConversationShareDeps,
): Promise<ShareLinksResult<ShareSummary>> {
  const session = await deps.getSession(sessionId);
  if (!session) return err({ kind: 'session_not_found' });
  if (session.deletedAt) return err({ kind: 'session_deleted' });
  if (session.privateMode) return err({ kind: 'private_session' });

  const expiresIn = input.expiresIn as ExpiryOption | undefined;
  const pw = input.password;
  if (expiresIn && !isValidExpiryOption(expiresIn)) return err({ kind: 'invalid_expiry' });
  if (pw !== undefined && !isValidPassword(pw)) return err({ kind: 'invalid_password' });

  // Hash password outside mutex (expensive crypto operation)
  const passwordHash = isValidPassword(pw) ? await hashPassword(pw) : undefined;

  return withShareLinksMutex(async () => {
    const map = await readShareLinks();

    // Idempotent: return existing share if one exists and is not expired
    if (map[sessionId] && !isExpired(map[sessionId])) {
      const existing = map[sessionId];
      return ok({ shareId: existing.shareId, expiresAt: existing.expiresAt, hasPassword: !!existing.passwordHash });
    }

    const shareId = generateShareId();
    map[sessionId] = {
      shareId,
      createdAt: Date.now(),
      expiresAt: computeExpiresAt(expiresIn),
      passwordHash,
      title: session.title || undefined,
    };

    try {
      await writeShareLinks(map);
    } catch (writeErr) {
      shareLog.error({ error: getErrorMessage(writeErr) }, 'Failed to write share links');
      return err({ kind: 'write_failed', message: 'Failed to create share link' });
    }

    shareLog.info({ sessionId }, 'Share link created');
    return ok({ shareId, expiresAt: map[sessionId].expiresAt, hasPassword: !!passwordHash });
  });
}

export async function getConversationShare(sessionId: string): Promise<ShareLinksResult<ShareSummary>> {
  const map = await readShareLinks();
  const entry = map[sessionId];
  if (!entry) return err({ kind: 'no_share', resourceType: 'conversation' });
  return ok({ shareId: entry.shareId, expiresAt: entry.expiresAt, hasPassword: !!entry.passwordHash });
}

export async function updateConversationShare(
  sessionId: string,
  input: { expiresIn?: unknown; password?: unknown },
): Promise<ShareLinksResult<ShareUpdateSummary>> {
  if (input.expiresIn !== undefined && !isValidExpiryOption(input.expiresIn)) {
    return err({ kind: 'invalid_expiry' });
  }
  if (input.password !== undefined && input.password !== null && !isValidPassword(input.password)) {
    return err({ kind: 'invalid_password' });
  }

  // Hash password outside mutex (expensive crypto operation)
  const newPasswordHash = isValidPassword(input.password) ? await hashPassword(input.password) : undefined;

  return withShareLinksMutex(async () => {
    const map = await readShareLinks();
    const entry = map[sessionId];
    if (!entry) return err({ kind: 'no_share', resourceType: 'conversation' });

    if (input.expiresIn !== undefined) {
      entry.expiresAt = computeExpiresAt(input.expiresIn as ExpiryOption);
    }
    if (input.password !== undefined) {
      if (input.password === null) {
        entry.passwordHash = undefined;
      } else {
        entry.passwordHash = newPasswordHash;
      }
    }

    try {
      await writeShareLinks(map);
    } catch (writeErr) {
      shareLog.error({ error: getErrorMessage(writeErr) }, 'Failed to write share links after update');
      return err({ kind: 'write_failed', message: 'Failed to update share link' });
    }

    shareLog.info({ sessionId }, 'Share link updated');
    return ok({ expiresAt: entry.expiresAt, hasPassword: !!entry.passwordHash });
  });
}

export async function revokeConversationShare(sessionId: string): Promise<ShareLinksResult<{ success: true }>> {
  return withShareLinksMutex(async () => {
    const map = await readShareLinks();
    const entry = map[sessionId];
    if (entry) {
      delete map[sessionId];
      try {
        await writeShareLinks(map);
      } catch (writeErr) {
        shareLog.error({ error: getErrorMessage(writeErr) }, 'Failed to write share links after revoke');
        return err({ kind: 'write_failed', message: 'Failed to revoke share link' });
      }
      shareLog.info({ sessionId }, 'Share link revoked');
    }
    return ok({ success: true });
  });
}

// ---------------------------------------------------------------------------
// Domain operations: file share
// ---------------------------------------------------------------------------

export async function createFileShare(
  input: { filePath?: unknown; expiresIn?: unknown; password?: unknown },
  deps: FileShareDeps,
): Promise<ShareLinksResult<ShareSummary>> {
  const filePath = input.filePath as string | undefined;
  const validation = await validateFilePath(filePath || '', deps.workspaceDir);
  if (!validation.ok) {
    return err({ kind: 'invalid_path', status: validation.status, code: validation.code, message: validation.error });
  }

  const expiresIn = input.expiresIn as ExpiryOption | undefined;
  const pw = input.password;
  if (expiresIn && !isValidExpiryOption(expiresIn)) return err({ kind: 'invalid_expiry' });
  if (pw !== undefined && !isValidPassword(pw)) return err({ kind: 'invalid_password' });

  // Hash password outside mutex
  const passwordHash = isValidPassword(pw) ? await hashPassword(pw) : undefined;
  const key = fileShareKey(filePath!);

  return withShareLinksMutex(async () => {
    const map = await readShareLinks();

    // Idempotent: return existing share if one exists and is not expired
    if (map[key] && !isExpired(map[key])) {
      const existing = map[key];
      return ok({
        shareId: existing.shareId,
        expiresAt: existing.expiresAt,
        hasPassword: !!existing.passwordHash,
      });
    }

    const shareId = generateShareId();
    const fileName = path.basename(filePath!);
    map[key] = {
      shareId,
      createdAt: Date.now(),
      expiresAt: computeExpiresAt(expiresIn),
      passwordHash,
      title: fileName,
      resourceType: 'file',
      filePath: filePath!,
    };

    try {
      await writeShareLinks(map);
    } catch (writeErr) {
      shareLog.error({ error: getErrorMessage(writeErr) }, 'Failed to write share links');
      return err({ kind: 'write_failed', message: 'Failed to create file share link' });
    }

    shareLog.info({ filePath: filePath! }, 'File share link created');
    return ok({
      shareId,
      expiresAt: map[key].expiresAt,
      hasPassword: !!passwordHash,
    });
  });
}

export async function getFileShare(filePath: string): Promise<ShareLinksResult<ShareSummary>> {
  const key = fileShareKey(filePath);
  const map = await readShareLinks();
  const entry = map[key];
  if (!entry || isExpired(entry)) return err({ kind: 'no_share', resourceType: 'file' });
  return ok({ shareId: entry.shareId, expiresAt: entry.expiresAt, hasPassword: !!entry.passwordHash });
}

export async function updateFileShare(
  input: { filePath?: unknown; expiresIn?: unknown; password?: unknown },
): Promise<ShareLinksResult<ShareUpdateSummary>> {
  const filePath = input.filePath as string | undefined;
  if (!filePath) return err({ kind: 'invalid_body', message: 'filePath is required' });

  if (input.expiresIn !== undefined && !isValidExpiryOption(input.expiresIn)) {
    return err({ kind: 'invalid_expiry' });
  }
  if (input.password !== undefined && input.password !== null && !isValidPassword(input.password)) {
    return err({ kind: 'invalid_password' });
  }

  // Hash password outside mutex
  const newPasswordHash = isValidPassword(input.password) ? await hashPassword(input.password) : undefined;
  const key = fileShareKey(filePath);

  return withShareLinksMutex(async () => {
    const map = await readShareLinks();
    const entry = map[key];
    if (!entry || isExpired(entry)) return err({ kind: 'no_share', resourceType: 'file' });

    if (input.expiresIn !== undefined) {
      entry.expiresAt = computeExpiresAt(input.expiresIn as ExpiryOption);
    }
    if (input.password !== undefined) {
      if (input.password === null) {
        entry.passwordHash = undefined;
      } else {
        entry.passwordHash = newPasswordHash;
      }
    }

    try {
      await writeShareLinks(map);
    } catch (writeErr) {
      shareLog.error({ error: getErrorMessage(writeErr) }, 'Failed to write share links after file share update');
      return err({ kind: 'write_failed', message: 'Failed to update file share link' });
    }

    shareLog.info({ filePath }, 'File share link updated');
    return ok({ expiresAt: entry.expiresAt, hasPassword: !!entry.passwordHash });
  });
}

export async function revokeFileShare(filePath: string): Promise<ShareLinksResult<{ success: true }>> {
  const key = fileShareKey(filePath);

  return withShareLinksMutex(async () => {
    const map = await readShareLinks();
    if (map[key]) {
      delete map[key];
      try {
        await writeShareLinks(map);
      } catch (writeErr) {
        shareLog.error({ error: getErrorMessage(writeErr) }, 'Failed to write share links after file share revoke');
        return err({ kind: 'write_failed', message: 'Failed to revoke file share link' });
      }
      shareLog.info({ filePath }, 'File share link revoked');
    }
    return ok({ success: true });
  });
}

export async function listActiveShares(): Promise<ShareListEntry[]> {
  const map = await readShareLinks();
  return Object.entries(map)
    .filter(([, entry]) => !isExpired(entry))
    .map(([key, entry]) => ({
      sessionId: entry.resourceType === 'file' ? undefined : key,
      shareId: entry.shareId,
      title: entry.title,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      hasPassword: !!entry.passwordHash,
      resourceType: entry.resourceType ?? 'conversation',
      filePath: entry.filePath,
    }));
}

// ---------------------------------------------------------------------------
// Domain operations: public read
// ---------------------------------------------------------------------------

export async function readSharedResource(
  shareId: string,
  deps: SharedReadDeps,
): Promise<ShareLinksResult<SharedResource>> {
  if (!isValidShareId(shareId)) return err({ kind: 'invalid_share_id', resourceType: 'conversation' });

  const map = await readShareLinks();
  const match = findShareByShareId(map, shareId);
  if (!match || isExpired(match.entry)) return err({ kind: 'conversation_unavailable' });

  if (match.entry.passwordHash) {
    return err({ kind: 'password_required', resourceType: match.entry.resourceType ?? 'conversation' });
  }

  // ---- File share branch ----
  if (match.entry.resourceType === 'file') {
    const metadata = await buildSharedFileMetadata(shareId, match.entry, deps.workspaceDir);
    if (!metadata) return err({ kind: 'resource_unavailable' });
    return ok({ type: 'file', data: metadata });
  }

  // ---- Conversation share branch (existing behavior) ----
  const session = await deps.getSession(match.sessionId);
  if (!session || session.deletedAt || session.privateMode) return err({ kind: 'conversation_unavailable' });

  return ok({ type: 'conversation', data: sanitizeSession(session) });
}

export async function unlockSharedResource(
  shareId: string,
  password: string,
  deps: SharedReadDeps & { downloadSecret?: string },
): Promise<ShareLinksResult<SharedResource>> {
  if (!isValidShareId(shareId)) return err({ kind: 'invalid_share_id', resourceType: 'conversation' });

  const map = await readShareLinks();
  const match = findShareByShareId(map, shareId);
  if (!match || isExpired(match.entry)) return err({ kind: 'conversation_unavailable' });

  if (match.entry.passwordHash) {
    const passwordOk = await verifyPassword(password, match.entry.passwordHash);
    if (!passwordOk) return err({ kind: 'invalid_password', message: "That's not it. Try again." });
  }

  // ---- File share branch ----
  if (match.entry.resourceType === 'file') {
    const metadata = await buildSharedFileMetadata(shareId, match.entry, deps.workspaceDir);
    if (!metadata) return err({ kind: 'resource_unavailable' });

    // For password-protected files, generate HMAC-signed download URL
    if (match.entry.passwordHash) {
      if (!deps.downloadSecret) {
        shareLog.error('REBEL_SHARE_DOWNLOAD_SECRET not configured for password-protected file download');
        return err({ kind: 'download_secret_unconfigured' });
      }
      const { sig, exp } = signFileDownloadUrl(shareId, deps.downloadSecret, FILE_SHARE_DOWNLOAD_TTL_MS);
      metadata.downloadUrl = `/api/shared/${shareId}/download?sig=${sig}&exp=${exp}`;
    }

    return ok({ type: 'file', data: metadata });
  }

  // ---- Conversation share branch (existing behavior) ----
  const session = await deps.getSession(match.sessionId);
  if (!session || session.deletedAt || session.privateMode) return err({ kind: 'conversation_unavailable' });

  return ok({ type: 'conversation', data: sanitizeSession(session) });
}

export async function authorizeSharedFileDownload(
  shareId: string,
  opts: { sig?: string | null; exp?: string | null; downloadSecret?: string; workspaceDir: string },
): Promise<ShareLinksResult<AuthorizedDownload>> {
  if (!isValidShareId(shareId)) return err({ kind: 'invalid_share_id', resourceType: 'file' });

  const map = await readShareLinks();
  const match = findShareByShareId(map, shareId);
  if (!match || isExpired(match.entry) || match.entry.resourceType !== 'file') {
    return err({ kind: 'resource_unavailable' });
  }

  // Password-protected files require a valid HMAC-signed URL
  if (match.entry.passwordHash) {
    if (!opts.sig || !opts.exp) return err({ kind: 'unauthorized' });

    if (!opts.downloadSecret) {
      shareLog.error('REBEL_SHARE_DOWNLOAD_SECRET not configured for password-protected download');
      return err({ kind: 'download_secret_unconfigured' });
    }

    if (!verifyFileDownloadSignature({
      shareId,
      sig: opts.sig,
      exp: opts.exp,
      secret: opts.downloadSecret,
    })) {
      return err({ kind: 'unauthorized' });
    }
  }

  // Resolve and validate the file path (traversal + symlink protection)
  const filePath = match.entry.filePath;
  if (!filePath) return err({ kind: 'resource_unavailable' });

  const fileResult = await resolveSharedFilePath(filePath, opts.workspaceDir);
  if (!fileResult.ok) return err({ kind: 'resource_unavailable' });

  const fileName = path.basename(filePath);
  const mimeType = getMimeType(fileName);
  const disposition = buildContentDisposition(fileName);

  return ok({
    resolved: fileResult.resolved,
    size: fileResult.size,
    fileName,
    mimeType,
    disposition,
  });
}

// ---------------------------------------------------------------------------
// OG preview helpers — used by server.ts to inject meta tags for social cards
// ---------------------------------------------------------------------------

/**
 * Resolve a shareId to preview metadata for OG tags.
 * Enforces the same privacy/availability checks as handleSharedConversation.
 * Returns null if the share is invalid or the session is unavailable.
 */
export async function getSharePreviewData(
  shareId: string,
  deps: SharePreviewDeps,
): Promise<SharePreviewData | null> {
  const map = await readShareLinks();
  const match = findShareByShareId(map, shareId);
  if (!match || isExpired(match.entry)) return null;
  if (match.entry.passwordHash) return null;

  // ---- File share preview ----
  if (match.entry.resourceType === 'file') {
    const fileName = match.entry.filePath ? path.basename(match.entry.filePath) : 'Shared file';
    const title = escapeHtml(fileName);
    let description = 'Shared file via Rebel';

    if (deps.getSettings && match.entry.filePath) {
      const workspaceDir = deps.getSettings().coreDirectory || '/data/workspace';
      const mimeType = getMimeType(fileName);
      if (isTextMime(mimeType)) {
        const fileResult = await resolveSharedFilePath(match.entry.filePath, workspaceDir);
        if (fileResult.ok && fileResult.size > 0 && fileResult.size <= MAX_TEXT_CONTENT_SIZE) {
          try {
            const content = await fs.readFile(fileResult.resolved, 'utf-8');
            const stripped = stripMarkdown(content).trim();
            if (stripped) {
              description = stripped.length > 150
                ? `${stripped.slice(0, 149).trimEnd()}\u2026`
                : stripped;
            }
          } catch {
            // Fall back to generic description
          }
        }
      }
    }

    return { title, description: escapeHtml(description) };
  }

  // ---- Conversation share preview (existing behavior) ----
  const session = await deps.getSession(match.sessionId);
  if (!session || session.deletedAt || session.privateMode) return null;

  const title = stripMarkdown(session.title || '').trim() || 'Shared conversation';

  const firstAssistant = (session.messages || []).find(
    (m) => m.role === 'assistant' && !m.isHidden && m.text?.trim(),
  );
  let description = 'A conversation shared via Rebel';
  if (firstAssistant) {
    const stripped = stripMarkdown(firstAssistant.text).trim();
    if (stripped) {
      description = stripped.length > 150
        ? `${stripped.slice(0, 149).trimEnd()}\u2026`
        : stripped;
    }
  }

  return {
    title: escapeHtml(title),
    description: escapeHtml(description),
  };
}
