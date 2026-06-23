/**
 * Chief-of-Staff Pending Service
 *
 * Manages pending memory writes in the user's Chief-of-Staff space.
 * Files requiring approval are written to `Chief-of-Staff/memory/pending/`
 * with YAML frontmatter containing the intended destination.
 *
 * This replaces the Electron userData staging approach for better:
 * - Visibility (files are real, visible in Finder)
 * - Sync (leverages whatever backs CoS - iCloud, Dropbox, etc.)
 * - Data preservation (no data loss on rejection)
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import fm from 'front-matter';
import { createScopedLogger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import { toPortablePath } from '@core/utils/portablePath';
import { getSettings } from '@core/services/settingsStore';
import { BlockSourceSchema, type BlockSource } from '@rebel/shared';
import { hashFile } from './hashUtils';
import { getAllStagedFiles, getStagedContent, discardStagedFile } from './legacyStagingReader';
import { isProtectedSystemPath } from './constants';

const log = createScopedLogger({ service: 'cosPendingService' });

const PENDING_FOLDER = 'memory/pending';

/**
 * Tracks pending file paths whose frontmatter has already failed validation
 * during this process lifetime. Validation is deterministic (it only inspects
 * the file's own attributes), so a file that fails once will keep failing on
 * every refresh until edited — repeated warnings are pure noise. We log warn
 * on the first encounter per path and debug on subsequent ones. Mtime is not
 * tracked here intentionally: if the user edits an invalid file back to a
 * valid state the success path takes over, and an invalid→invalid edit is a
 * rare-enough case that the small loss of fidelity is fine.
 *
 * Bounded by `INVALID_FRONTMATTER_WARN_CAP` to prevent unbounded growth in
 * pathological cases (e.g. thousands of invalid files in a watched dir).
 */
const INVALID_FRONTMATTER_WARN_CAP = 256;
const invalidFrontmatterPathsWarned = new Set<string>();

function recordInvalidFrontmatterWarned(filePath: string): boolean {
  if (invalidFrontmatterPathsWarned.has(filePath)) return false;
  if (invalidFrontmatterPathsWarned.size >= INVALID_FRONTMATTER_WARN_CAP) {
    const firstKey = invalidFrontmatterPathsWarned.values().next().value;
    if (firstKey !== undefined) invalidFrontmatterPathsWarned.delete(firstKey);
  }
  invalidFrontmatterPathsWarned.add(filePath);
  return true;
}

/** @internal — for tests only */
export function _resetInvalidFrontmatterWarnedForTests(): void {
  invalidFrontmatterPathsWarned.clear();
}

const coalescedPendingIdsBySession = new Map<string, Map<string, string>>();
const destinationLocks = new Map<string, Promise<void>>();

async function withDestinationLock<T>(canonicalDestination: string, fn: () => Promise<T>): Promise<T> {
  const prior = destinationLocks.get(canonicalDestination) ?? Promise.resolve();
  let resolveCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve;
  });
  const queued = prior.then(() => current);
  destinationLocks.set(canonicalDestination, queued);

  try {
    await prior;
    return await fn();
  } finally {
    resolveCurrent();
    if (destinationLocks.get(canonicalDestination) === queued) {
      destinationLocks.delete(canonicalDestination);
    }
  }
}

function registerCoalescedPendingId(sessionId: string, coalesceKey: string, pendingId: string): void {
  const sessionMap = coalescedPendingIdsBySession.get(sessionId) ?? new Map<string, string>();
  sessionMap.set(coalesceKey, pendingId);
  coalescedPendingIdsBySession.set(sessionId, sessionMap);
}

function cleanupCoalescedPendingId(pendingId: string): void {
  for (const [sessionId, sessionMap] of coalescedPendingIdsBySession.entries()) {
    for (const [coalesceKey, mappedPendingId] of sessionMap.entries()) {
      if (mappedPendingId === pendingId) {
        sessionMap.delete(coalesceKey);
      }
    }
    if (sessionMap.size === 0) {
      coalescedPendingIdsBySession.delete(sessionId);
    }
  }
}

/**
 * Canonicalize a path for consistent comparison.
 * - Resolves to absolute path
 * - Normalizes separators (always uses forward slashes)
 * - Case-insensitive on Windows/macOS, case-sensitive on Linux
 *
 * Use this for comparing paths that may have different casing or separators.
 */
export function canonicalizePath(p: string): string {
  // Resolve to absolute and normalize separators
  const resolved = toPortablePath(path.resolve(p));

  // Case-insensitive on Windows/macOS, case-sensitive on Linux
  if (process.platform === 'linux') {
    return resolved;
  }
  return resolved.toLowerCase();
}

export interface PendingFileFrontmatter {
  pending_destination: string;
  staged_at: string;
  session_id: string;
  summary: string;
  original_space: string;
  base_hash: string;
  /** Which policy source blocked this write before staging */
  blocked_by?: BlockSource;
  /** Sharing level of the target space at staging time */
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  /** Optional JSON-encoded transcript metadata for deferred event emission on approval */
  pending_transcript_meta?: string;
  /** Distinguishes normal memory approvals from shared-skill confirmation checkpoints */
  approval_kind?: 'memory_write' | 'shared_skill_checkpoint';
  /** For shared_skill_checkpoint: the name of the person who owns/authored the skill */
  author_label?: string;
  /** Stable identifier for dedup between approval events and staged files */
  tool_use_id?: string;
}

function isValidApprovalKind(
  value: unknown,
): value is 'memory_write' | 'shared_skill_checkpoint' {
  return value === 'memory_write' || value === 'shared_skill_checkpoint';
}

function isValidBlockedBySource(
  value: unknown,
): value is BlockSource {
  return BlockSourceSchema.safeParse(value).success;
}

function isValidSharing(
  value: unknown,
): value is 'private' | 'restricted' | 'company-wide' | 'public' {
  return value === 'private' || value === 'restricted' || value === 'company-wide' || value === 'public';
}

export interface PendingFile {
  id: string;
  filename: string;
  filePath: string;
  frontmatter: PendingFileFrontmatter;
  content: string;
  coalesced?: boolean;
}

export interface PublishResult {
  status: 'success' | 'conflict' | 'not-found' | 'error' | 'invalid-destination' | 'already-resolved';
  error?: string;
  conflict?: {
    currentContent: string;
    pendingContent: string;
  };
}

/**
 * Get the Chief-of-Staff pending folder path.
 * Returns null if CoS is not available (no coreDirectory configured).
 */
export function getCosPendingDir(): string | null {
  const settings = getSettings();
  const coreDirectory = settings?.coreDirectory;

  if (!coreDirectory) {
    log.debug('No coreDirectory configured, CoS pending unavailable');
    return null;
  }

  const cosSpace = settings?.spaces?.find(s =>
    s.type === 'chief-of-staff' || s.path.toLowerCase().replace(/\/$/, '') === 'chief-of-staff'
  );
  const cosDir = cosSpace?.path.replace(/\/$/, '') || 'Chief-of-Staff';
  return path.join(coreDirectory, cosDir, PENDING_FOLDER);
}

/**
 * Ensure the pending folder exists.
 */
async function ensurePendingDir(): Promise<string | null> {
  const pendingDir = getCosPendingDir();
  if (!pendingDir) return null;

  await fs.mkdir(pendingDir, { recursive: true });
  return pendingDir;
}

/**
 * Validate that a destination path is safe to write to.
 * Must be within workspace and NOT in rebel-system.
 *
 * Uses canonicalizePath() for consistent cross-platform path comparison.
 * @internal
 */
export function validateDestination(destination: string, coreDirectory: string): boolean {
  const normalizedDest = toPortablePath(path.normalize(destination));
  const normalizedCore = toPortablePath(path.normalize(coreDirectory));

  // Must be relative path (workspace-relative) or absolute within workspace
  const absoluteDest = path.isAbsolute(normalizedDest)
    ? normalizedDest
    : path.join(normalizedCore, normalizedDest);

  // Use canonicalizePath for platform-aware comparison
  const canonicalDest = canonicalizePath(absoluteDest);
  const canonicalCore = canonicalizePath(normalizedCore);

  // Must be within workspace
  if (!canonicalDest.startsWith(canonicalCore + '/')) {
    log.warn({ destination, coreDirectory }, 'Destination outside workspace');
    return false;
  }

  // Must NOT be in rebel-system (read-only)
  if (isProtectedSystemPath(absoluteDest)) {
    log.warn({ destination }, 'Destination in rebel-system (protected)');
    return false;
  }

  return true;
}

/**
 * Generate a filename for a pending file.
 * Format: YYMMDD_HHmmss_sanitized-name_HASH.pending.md
 *
 * Includes a short hash of the full destination path to prevent collisions
 * when two files with the same basename (e.g., space-a/notes.md and
 * space-b/notes.md) are staged within the same second (FM #18).
 *
 * @internal
 */
export function generatePendingFilename(destinationPath: string): string {
  const now = new Date();
  const dateStr = now.toISOString().slice(2, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');

  // Extract base filename from destination
  const baseName = path.basename(destinationPath, path.extname(destinationPath));

  // Sanitize: replace problematic chars with dashes, collapse multiple dashes
  const sanitized = baseName
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  // Short hash of full destination path for collision resistance
  const destHash = crypto.createHash('sha256').update(destinationPath).digest('hex').slice(0, 6);

  return `${dateStr}_${timeStr}_${sanitized || 'memory'}_${destHash}.pending.md`;
}

/**
 * Escape a string value for YAML.
 * Quotes the string and escapes internal quotes/newlines/tabs.
 * @internal
 */
export function yamlEscape(value: string): string {
  // Guard against non-string values
  if (typeof value !== 'string') value = String(value ?? '');
  
  // If the value contains problematic characters or starts with YAML structural indicators, quote it
  if (/[\n\r\t":{}[\]&*#?|<>=!%@`,]/.test(value) || value.trim() !== value || /^[-?:>](\s|$)/.test(value)) {
    // Use double quotes with escapes
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
  }
  // Simple values can be unquoted if they don't look like special YAML types
  if (/^(true|false|null|~|\d+(\.\d+)?([eE][+-]?\d+)?)$/i.test(value)) {
    return `"${value}"`;
  }
  return value;
}

/**
 * Serialize frontmatter + content to markdown.
 * @internal
 */
export function serializePendingFile(frontmatter: PendingFileFrontmatter, content: string): string {
  const lines = [
    '---',
    `pending_destination: ${yamlEscape(frontmatter.pending_destination)}`,
    `staged_at: ${yamlEscape(frontmatter.staged_at)}`,
    `session_id: ${yamlEscape(frontmatter.session_id)}`,
    `summary: ${yamlEscape(frontmatter.summary)}`,
    `original_space: ${yamlEscape(frontmatter.original_space)}`,
    `base_hash: ${yamlEscape(frontmatter.base_hash)}`,
  ];

  if (frontmatter.pending_transcript_meta) {
    lines.push(`pending_transcript_meta: ${yamlEscape(frontmatter.pending_transcript_meta)}`);
  }

  if (frontmatter.blocked_by) {
    lines.push(`blocked_by: ${yamlEscape(frontmatter.blocked_by)}`);
  }

  if (frontmatter.sharing) {
    lines.push(`sharing: ${yamlEscape(frontmatter.sharing)}`);
  }

  if (frontmatter.approval_kind) {
    lines.push(`approval_kind: ${yamlEscape(frontmatter.approval_kind)}`);
  }

  if (frontmatter.author_label) {
    lines.push(`author_label: ${yamlEscape(frontmatter.author_label)}`);
  }

  if (frontmatter.tool_use_id) {
    lines.push(`tool_use_id: ${yamlEscape(frontmatter.tool_use_id)}`);
  }

  lines.push('---', '');

  return lines.join('\n') + content;
}

/**
 * Parse a pending file's frontmatter and content.
 * @internal
 */
export function parsePendingFile(
  markdown: string,
  filePath: string
): { frontmatter: PendingFileFrontmatter; content: string } | null {
  try {
    const parsed = fm<Partial<PendingFileFrontmatter>>(markdown);

    // Validate required fields exist and are strings
    const attrs = parsed.attributes;
    if (
      typeof attrs.pending_destination !== 'string' ||
      typeof attrs.staged_at !== 'string' ||
      typeof attrs.session_id !== 'string'
    ) {
      if (recordInvalidFrontmatterWarned(filePath)) {
        log.warn({ filePath, attrs }, 'Pending file missing or invalid required frontmatter fields');
      } else {
        log.debug({ filePath }, 'Pending file frontmatter still invalid (warned once earlier)');
      }
      return null;
    }

    const frontmatter: PendingFileFrontmatter = {
      pending_destination: attrs.pending_destination,
      staged_at: attrs.staged_at,
      session_id: attrs.session_id,
      summary: typeof attrs.summary === 'string' ? attrs.summary : 'Memory update',
      original_space: typeof attrs.original_space === 'string' ? attrs.original_space : 'Unknown',
      base_hash: typeof attrs.base_hash === 'string' ? attrs.base_hash : 'unknown',
    };

    if (typeof attrs.pending_transcript_meta === 'string') {
      frontmatter.pending_transcript_meta = attrs.pending_transcript_meta;
    }

    if (isValidBlockedBySource(attrs.blocked_by)) {
      frontmatter.blocked_by = attrs.blocked_by;
    }

    if (isValidSharing(attrs.sharing)) {
      frontmatter.sharing = attrs.sharing;
    }

    if (isValidApprovalKind(attrs.approval_kind)) {
      frontmatter.approval_kind = attrs.approval_kind;
    }

    if (typeof attrs.author_label === 'string') {
      frontmatter.author_label = attrs.author_label;
    }

    if (typeof attrs.tool_use_id === 'string') {
      frontmatter.tool_use_id = attrs.tool_use_id;
    }

    return { frontmatter, content: parsed.body };
  } catch (error) {
    log.warn({ err: error, filePath }, 'Failed to parse pending file');
    return null;
  }
}

export interface WriteToPendingOptions {
  destinationPath: string;
  content: string;
  sessionId: string;
  summary: string;
  spaceName: string;
  baseHash?: string;
  blockedBy?: BlockSource;
  /** Sharing level of the target space at staging time */
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  /** Optional JSON-encoded transcript metadata for deferred event emission on approval */
  transcriptMeta?: string;
  /** Distinguishes normal memory approvals from shared-skill confirmation checkpoints */
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  /** For shared_skill_checkpoint: the name of the person who owns/authored the skill */
  authorLabel?: string;
  /** Stable identifier for dedup between approval events and staged files */
  toolUseId?: string;
  /**
   * Optional first-wins coalesce key. When present, an existing pending write
   * registered for the same (sessionId, coalesceKey) is returned unchanged.
   */
  coalesceKey?: string;
}

export interface ConflictDetectionResult {
  hasConflict: boolean;
  /** True if file existed when staged but has been modified since */
  fileModifiedSinceStaging: boolean;
  /** True if file didn't exist when staged but exists now */
  newFileConflict: boolean;
}

/**
 * Detect if a pending file has conflicts with its destination.
 * Used both at listing time (upfront UI feedback) and at publish time.
 * 
 * @param baseHash - The hash stored when the file was staged ('new-file' if destination didn't exist)
 * @param absolutePath - The absolute path to the destination file
 * @returns Conflict detection result
 */
export async function detectPendingConflict(
  baseHash: string,
  absolutePath: string
): Promise<ConflictDetectionResult> {
  const currentHash = await hashFile(absolutePath);
  const fileExistedAtStaging = baseHash !== 'new-file';
  const fileExistsNow = currentHash !== null;
  const fileModifiedSinceStaging = fileExistsNow && currentHash !== baseHash;
  const newFileConflict = !fileExistedAtStaging && fileExistsNow;
  
  return {
    hasConflict: fileModifiedSinceStaging || newFileConflict,
    fileModifiedSinceStaging,
    newFileConflict,
  };
}

/**
 * Write a file to the pending folder.
 * Returns the created PendingFile, or null if CoS is unavailable or destination is invalid.
 */
export async function writeToPending(options: WriteToPendingOptions): Promise<PendingFile | null> {
  const pendingDir = await ensurePendingDir();
  if (!pendingDir) {
    log.info('CoS pending unavailable, cannot write to pending');
    return null;
  }

  const settings = getSettings();
  const coreDirectory = settings?.coreDirectory;

  if (!coreDirectory) {
    return null;
  }

  // Validate destination at write-time (not just approval-time)
  if (!validateDestination(options.destinationPath, coreDirectory)) {
    log.warn({ destination: options.destinationPath }, 'Invalid destination, refusing to stage');
    return null;
  }

  // Resolve to absolute path for hash computation
  const absoluteDestPath = path.isAbsolute(options.destinationPath)
    ? options.destinationPath
    : path.join(coreDirectory, options.destinationPath);

  const canonicalDestination = canonicalizePath(absoluteDestPath);

  // Normalize destination to workspace-relative for storage
  // Use case-insensitive comparison on Windows/macOS to handle path casing differences
  const canonicalCore = canonicalizePath(coreDirectory);
  const isUnderWorkspace = canonicalDestination.startsWith(canonicalCore + '/') || canonicalDestination === canonicalCore;

  const normalizedDest = isUnderWorkspace
    ? toPortablePath(path.relative(coreDirectory, absoluteDestPath))
    : options.destinationPath;

  return withDestinationLock(canonicalDestination, async () => {
    const existingFiles = await listPendingFiles();
    const destinationMatches = existingFiles.filter((file) => {
      const pendingDestination = file.frontmatter.pending_destination;
      const absolutePending = path.isAbsolute(pendingDestination)
        ? pendingDestination
        : path.join(coreDirectory, pendingDestination);
      return canonicalizePath(absolutePending) === canonicalDestination;
    });

    const crossSessionMatch = destinationMatches.find(
      (file) => file.frontmatter.session_id !== options.sessionId,
    );

    if (crossSessionMatch) {
      log.warn(
        {
          destination: normalizedDest,
          requestedSessionId: options.sessionId,
          existingSessionId: crossSessionMatch.frontmatter.session_id,
          reason: 'destination_locked',
        },
        'Refusing to replace pending file locked by another session',
      );
      return null;
    }

    if (options.coalesceKey) {
      const existingPendingId = coalescedPendingIdsBySession.get(options.sessionId)?.get(options.coalesceKey);
      const existingPending = existingFiles.find((file) =>
        file.id === existingPendingId &&
        file.frontmatter.session_id === options.sessionId
      );
      if (existingPending) {
        log.info(
          { id: existingPending.id, sessionId: options.sessionId, coalesceKey: options.coalesceKey },
          'Coalesced into existing pending memory write',
        );
        return { ...existingPending, coalesced: true };
      }
      if (existingPendingId) {
        cleanupCoalescedPendingId(existingPendingId);
      }
    }

    const sameSessionDestinationMatches = destinationMatches.filter(
      (file) => file.frontmatter.session_id === options.sessionId,
    );
    const sameSessionExisting = sameSessionDestinationMatches[0];
    const baseHash = sameSessionExisting?.frontmatter.base_hash
      ?? options.baseHash
      ?? (await hashFile(absoluteDestPath))
      ?? 'new-file';

    const frontmatter: PendingFileFrontmatter = {
      pending_destination: toPortablePath(normalizedDest),
      staged_at: new Date().toISOString(),
      session_id: options.sessionId,
      summary: options.summary,
      original_space: options.spaceName,
      base_hash: baseHash,
      blocked_by: options.blockedBy,
      sharing: options.sharing,
    };

    if (options.transcriptMeta) {
      frontmatter.pending_transcript_meta = options.transcriptMeta;
    }

    if (options.approvalKind) {
      frontmatter.approval_kind = options.approvalKind;
    }

    if (options.authorLabel) {
      frontmatter.author_label = options.authorLabel;
    }

    if (options.toolUseId) {
      frontmatter.tool_use_id = options.toolUseId;
    }

    const filename = generatePendingFilename(normalizedDest);
    const filePath = path.join(pendingDir, filename);
    const fileContent = serializePendingFile(frontmatter, options.content);

    const tmpPath = `${filePath}.tmp`;
    try {
      await fs.writeFile(tmpPath, fileContent, 'utf-8');
      await fs.rename(tmpPath, filePath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      throw error;
    }

    for (const existing of sameSessionDestinationMatches) {
      if (existing.filePath === filePath) {
        continue;
      }
      if (existing.frontmatter.session_id !== options.sessionId) {
        continue;
      }

      log.info({ oldFile: existing.filename, newFile: filename }, 'Replacing existing pending file for same destination');
      await fs.unlink(existing.filePath).catch((err) => {
        log.warn(
          { err, filePath: existing.filePath },
          'Failed to unlink prior pending file after writing replacement',
        );
      });
      cleanupCoalescedPendingId(existing.id);
    }

    const id = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 12);

    log.info({ filePath, destination: normalizedDest }, 'Wrote file to pending');

    if (options.coalesceKey) {
      registerCoalescedPendingId(options.sessionId, options.coalesceKey, id);
    }

    return {
      id,
      filename,
      filePath,
      frontmatter,
      content: options.content,
      coalesced: false,
    };
  });
}

/**
 * List all pending files.
 */
export async function listPendingFiles(): Promise<PendingFile[]> {
  const pendingDir = getCosPendingDir();
  if (!pendingDir) return [];

  try {
    await fs.access(pendingDir);
  } catch {
    return [];
  }

  const files: PendingFile[] = [];

  try {
    const entries = await fs.readdir(pendingDir);

    for (const entry of entries) {
      if (!entry.endsWith('.pending.md')) continue;

      const filePath = path.join(pendingDir, entry);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const parsed = parsePendingFile(content, filePath);

        if (parsed) {
          const id = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 12);
          files.push({
            id,
            filename: entry,
            filePath,
            frontmatter: parsed.frontmatter,
            content: parsed.content,
          });
        }
      } catch (error) {
        log.warn({ err: error, filePath }, 'Failed to read pending file');
      }
    }
  } catch (error) {
    log.warn({ err: error, pendingDir }, 'Failed to list pending directory');
  }

  return files;
}

/**
 * Get a specific pending file by ID.
 */
export async function getPendingFile(id: string): Promise<PendingFile | null> {
  const files = await listPendingFiles();
  return files.find((f) => f.id === id) ?? null;
}

/**
 * Get pending file content (body only, no frontmatter).
 */
export async function getPendingContent(id: string): Promise<string | null> {
  const file = await getPendingFile(id);
  return file?.content ?? null;
}

export type PendingFileLookupResult =
  | { kind: 'none' }
  | { kind: 'found'; file: PendingFile; content: string }
  | { kind: 'candidate_unreadable'; filePath: string; reason: string };

function hashDestinationSegment(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 6);
}

function buildLookupHashCandidates(
  destination: string,
  absoluteRequested: string,
  coreDirectory: string,
): Set<string> {
  const candidates = new Set<string>();
  const addCandidate = (value: string): void => {
    if (!value) return;
    candidates.add(hashDestinationSegment(value));
  };

  addCandidate(destination);
  addCandidate(toPortablePath(destination));
  addCandidate(absoluteRequested);
  addCandidate(toPortablePath(absoluteRequested));

  const relativeRequested = toPortablePath(path.relative(coreDirectory, absoluteRequested));
  if (relativeRequested && relativeRequested !== '.' && !relativeRequested.startsWith('../')) {
    addCandidate(relativeRequested);
  }

  return candidates;
}

/**
 * Get a pending file by its intended destination path.
 *
 * This is used by stagedReadHook to intercept file reads and return staged content.
 * Path matching uses canonicalizePath() for platform-aware comparison:
 * - Case-insensitive on Windows/macOS
 * - Case-sensitive on Linux
 *
 * @param destination - The destination path to look up (absolute or workspace-relative)
 * @param sessionId - Optional session ID filter for read-after-write consistency
 * @returns Lookup result that can distinguish found/not-found/unreadable candidates.
 */
export async function getPendingFileByDestination(
  destination: string,
  sessionId?: string
): Promise<PendingFileLookupResult> {
  const settings = getSettings();
  const coreDirectory = settings?.coreDirectory;

  if (!coreDirectory) {
    return { kind: 'none' };
  }

  const pendingDir = getCosPendingDir();
  if (!pendingDir) {
    return { kind: 'none' };
  }

  try {
    await fs.access(pendingDir);
  } catch {
    return { kind: 'none' };
  }

  let entries: string[];
  try {
    entries = await fs.readdir(pendingDir);
  } catch (error) {
    log.warn({ err: error, pendingDir }, 'Failed to read pending directory during destination lookup');
    return { kind: 'none' };
  }

  // Resolve the requested destination to an absolute path
  const absoluteRequested = path.isAbsolute(destination)
    ? destination
    : path.join(coreDirectory, destination);

  const canonicalRequested = canonicalizePath(absoluteRequested);
  const hashCandidates = [...buildLookupHashCandidates(destination, absoluteRequested, coreDirectory)];
  if (hashCandidates.length === 0) {
    return { kind: 'none' };
  }

  let lastUnreadable: { filePath: string; reason: string } | null = null;
  let sawParseableCandidateWithoutMatch = false;

  for (const entry of entries) {
    if (!entry.endsWith('.pending.md')) {
      continue;
    }
    if (!hashCandidates.some((hash) => entry.includes(hash))) {
      continue;
    }

    const filePath = path.join(pendingDir, entry);
    try {
      const markdown = await fs.readFile(filePath, 'utf-8');
      const parsed = parsePendingFile(markdown, filePath);
      if (!parsed) {
        lastUnreadable = {
          filePath,
          reason: 'failed_to_parse_pending_frontmatter',
        };
        log.warn({ filePath }, 'Skipping unparseable pending file during destination lookup');
        continue;
      }

      const pendingDestination = parsed.frontmatter.pending_destination;
      const absolutePending = path.isAbsolute(pendingDestination)
        ? pendingDestination
        : path.join(coreDirectory, pendingDestination);
      const canonicalPending = canonicalizePath(absolutePending);

      if (canonicalRequested !== canonicalPending) {
        sawParseableCandidateWithoutMatch = true;
        continue;
      }

      if (sessionId !== undefined && parsed.frontmatter.session_id !== sessionId) {
        sawParseableCandidateWithoutMatch = true;
        continue;
      }

      const id = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 12);
      const pendingFile: PendingFile = {
        id,
        filename: entry,
        filePath,
        frontmatter: parsed.frontmatter,
        content: parsed.content,
      };

      log.debug(
        { destination, pendingFile: pendingFile.filename, sessionId },
        'Found pending file for destination'
      );

      return { kind: 'found', file: pendingFile, content: pendingFile.content };
    } catch (error) {
      lastUnreadable = {
        filePath,
        reason: error instanceof Error ? error.message : String(error),
      };
      log.warn({ err: error, filePath }, 'Skipping unreadable pending file during destination lookup');
      continue;
    }
  }

  if (lastUnreadable && !sawParseableCandidateWithoutMatch) {
    return { kind: 'candidate_unreadable', ...lastUnreadable };
  }

  return { kind: 'none' };
}

function getFsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

function mapFsErrorToMessage(error: unknown): string {
  switch (getFsErrorCode(error)) {
    case 'EINVAL':
      return 'Couldn\'t save the file — the path may contain invalid characters or be locked by another app.';
    case 'ENOTDIR':
      return 'Couldn\'t save the file — a file exists where a folder was expected in the path.';
    case 'EPERM':
    case 'EACCES':
      return 'Couldn\'t save the file — permission denied. Check your access to the destination folder.';
    case 'EBUSY':
      return 'Couldn\'t save the file — it\'s in use by another application. Try again in a moment.';
    case 'ENAMETOOLONG':
      return 'Couldn\'t save the file — the path is too long. Try a shorter workspace path.';
    case 'ENOSPC':
      return 'Couldn\'t save the file — your disk is full.';
    case 'ENOENT':
      return 'Couldn\'t save the file — the destination folder no longer exists.';
    case undefined:
    default:
      return 'Couldn\'t save the file. Please try again.';
  }
}

function broadcastStagedFilesChanged(): void {
  try {
    getBroadcastService().sendToAllWindows('memory:staged-files-changed');
  } catch (error) {
    log.warn({ err: error }, 'Failed to broadcast staged-files-changed');
  }
}

function resolvePendingDestinationAbsolute(
  pendingDestination: string,
  coreDirectory?: string,
): string {
  if (path.isAbsolute(pendingDestination)) {
    return pendingDestination;
  }
  if (coreDirectory) {
    return path.join(coreDirectory, pendingDestination);
  }
  return path.resolve(pendingDestination);
}

async function publishPendingFileRecord(
  id: string,
  file: PendingFile,
  coreDirectory: string,
): Promise<PublishResult> {
  // Validate destination
  if (!validateDestination(file.frontmatter.pending_destination, coreDirectory)) {
    return { status: 'invalid-destination', error: 'Destination path is invalid or protected' };
  }

  // Resolve absolute destination path
  const absoluteDest = resolvePendingDestinationAbsolute(file.frontmatter.pending_destination, coreDirectory);

  // Conflict detection using shared helper
  const conflict = await detectPendingConflict(file.frontmatter.base_hash, absoluteDest);

  if (conflict.hasConflict) {
    const currentContent = await fs.readFile(absoluteDest, 'utf-8');
    log.info(
      {
        id,
        destination: absoluteDest,
        fileModifiedSinceStaging: conflict.fileModifiedSinceStaging,
        newFileConflict: conflict.newFileConflict,
      },
      'Conflict detected during approval',
    );
    return {
      status: 'conflict',
      conflict: {
        currentContent,
        pendingContent: file.content,
      },
    };
  }

  const destinationDir = path.dirname(absoluteDest);
  const tempPath = `${absoluteDest}.tmp`;

  try {
    // Ensure destination directory exists (throws ENOTDIR if a file
    // exists where a parent directory is expected — mapped to a
    // friendly message in the catch block below).
    await fs.mkdir(destinationDir, { recursive: true });

    // Write body content only (no frontmatter)
    await fs.writeFile(tempPath, file.content, 'utf-8');
    await fs.rename(tempPath, absoluteDest);

    // Delete pending file
    await fs.unlink(file.filePath).catch(() => {});
    cleanupCoalescedPendingId(id);

    log.info({ id, destination: absoluteDest }, 'Approved pending file');
    broadcastStagedFilesChanged();
    return { status: 'success' };
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    const friendlyMessage = mapFsErrorToMessage(error);
    log.error({ err: error, id, destination: absoluteDest }, 'Failed to approve pending file');
    return { status: 'error', error: friendlyMessage };
  }
}

async function keepPendingFilePrivateRecord(
  id: string,
  file: PendingFile,
  coreDirectory: string,
): Promise<PublishResult & { destinationPath?: string }> {
  const settings = getSettings();

  // Destination: Chief-of-Staff/memory/topics/{filename}.md (without .pending)
  const cosSpace = settings?.spaces?.find((s) =>
    s.type === 'chief-of-staff' || s.path.toLowerCase().replace(/\/$/, '') === 'chief-of-staff',
  );
  const cosDir = cosSpace?.path.replace(/\/$/, '') || 'Chief-of-Staff';
  const cosPath = path.join(coreDirectory, cosDir, 'memory', 'topics');

  // Derive clean filename from the original destination path in frontmatter
  // (not from the staged filename which has timestamp prefix + hash suffix)
  const cleanFilename = path.basename(file.frontmatter.pending_destination);
  const destinationPath = path.join(cosPath, cleanFilename);

  try {
    // Ensure destination directory exists
    await fs.mkdir(cosPath, { recursive: true });

    // Check if file already exists at destination
    try {
      await fs.access(destinationPath);
      // File exists - add timestamp suffix to avoid overwrite
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const uniqueFilename = cleanFilename.replace(/\.md$/, `-${timestamp}.md`);
      const uniquePath = path.join(cosPath, uniqueFilename);

      await fs.writeFile(uniquePath, file.content, 'utf-8');
      await fs.unlink(file.filePath);
      cleanupCoalescedPendingId(id);

      log.info({ id, destination: uniquePath }, 'Kept pending file private (with unique suffix)');
      broadcastStagedFilesChanged();
      return { status: 'success', destinationPath: uniquePath };
    } catch {
      // File doesn't exist - write directly
      await fs.writeFile(destinationPath, file.content, 'utf-8');
      await fs.unlink(file.filePath);
      cleanupCoalescedPendingId(id);

      log.info({ id, destination: destinationPath }, 'Kept pending file private');
      broadcastStagedFilesChanged();
      return { status: 'success', destinationPath };
    }
  } catch (error) {
    log.error({ err: error, id }, 'Failed to keep pending file private');
    return { status: 'error', error: mapFsErrorToMessage(error) };
  }
}

async function deletePendingFileRecord(id: string, file: PendingFile): Promise<PublishResult> {
  try {
    await fs.unlink(file.filePath);
    cleanupCoalescedPendingId(id);
    log.info({ id, filename: file.filename }, 'Deleted pending file');
    broadcastStagedFilesChanged();
    return { status: 'success' };
  } catch (error) {
    log.error({ err: error, id }, 'Failed to delete pending file');
    return { status: 'error', error: mapFsErrorToMessage(error) };
  }
}

/**
 * Approve a pending file to its destination.
 * Strips frontmatter and writes only body content.
 */
export async function publishPendingFile(id: string): Promise<PublishResult> {
  const initialFile = await getPendingFile(id);
  if (!initialFile) {
    log.info({ id }, 'Pending file already resolved (not found during publish)');
    return { status: 'already-resolved' };
  }

  const settings = getSettings();
  const coreDirectory = settings?.coreDirectory;

  if (!coreDirectory) {
    return { status: 'error', error: 'No workspace configured' };
  }

  const absoluteDest = resolvePendingDestinationAbsolute(
    initialFile.frontmatter.pending_destination,
    coreDirectory ?? undefined,
  );
  const canonicalDestination = canonicalizePath(absoluteDest);

  return withDestinationLock(canonicalDestination, async () => {
    const file = await getPendingFile(id);
    if (!file) {
      log.info({ id }, 'Pending file already resolved (not found inside publish lock)');
      return { status: 'already-resolved' };
    }

    return publishPendingFileRecord(id, file, coreDirectory);
  });
}

/**
 * Approve with conflict resolution (force overwrite or discard).
 */
export async function publishWithConflictResolution(
  id: string,
  resolution: 'keep-pending' | 'keep-current'
): Promise<PublishResult> {
  const initialFile = await getPendingFile(id);
  if (!initialFile) {
    log.info({ id }, 'Pending file already resolved (not found during conflict resolution)');
    return { status: 'already-resolved' };
  }

  const settings = getSettings();
  const coreDirectory = settings?.coreDirectory;
  if (!coreDirectory) {
    return { status: 'error', error: 'No workspace configured' };
  }

  const absoluteDest = resolvePendingDestinationAbsolute(
    initialFile.frontmatter.pending_destination,
    coreDirectory ?? undefined,
  );
  const canonicalDestination = canonicalizePath(absoluteDest);

  return withDestinationLock(canonicalDestination, async () => {
    const file = await getPendingFile(id);
    if (!file) {
      log.info({ id }, 'Pending file already resolved (not found inside conflict-resolution lock)');
      return { status: 'already-resolved' };
    }

    if (resolution === 'keep-current') {
      return deletePendingFileRecord(id, file);
    }

    // keep-pending: update base_hash to current and retry publish
    const lockAbsoluteDest = resolvePendingDestinationAbsolute(
      file.frontmatter.pending_destination,
      coreDirectory,
    );
    const currentHash = (await hashFile(lockAbsoluteDest)) ?? 'new-file';
    const updatedFrontmatter = { ...file.frontmatter, base_hash: currentHash };
    const updatedContent = serializePendingFile(updatedFrontmatter, file.content);
    const tmpPath = `${file.filePath}.tmp`;

    try {
      await fs.writeFile(tmpPath, updatedContent, 'utf-8');
      await fs.rename(tmpPath, file.filePath);
    } catch (error) {
      await fs.unlink(tmpPath).catch(() => {});
      log.error({ err: error, id, filePath: file.filePath }, 'Failed to update pending base hash during conflict resolution');
      return { status: 'error', error: mapFsErrorToMessage(error) };
    }

    const updatedFile: PendingFile = {
      ...file,
      frontmatter: updatedFrontmatter,
    };

    return publishPendingFileRecord(id, updatedFile, coreDirectory);
  });
}

/**
 * Keep a pending file private by moving it to Chief-of-Staff memory/topics.
 * User wants to keep the content but not send to the original target space.
 */
export async function keepPendingFilePrivate(id: string): Promise<PublishResult & { destinationPath?: string }> {
  const initialFile = await getPendingFile(id);
  if (!initialFile) {
    log.info({ id }, 'Pending file already resolved (not found during keep-private)');
    return { status: 'already-resolved' };
  }

  const settings = getSettings();
  const coreDirectory = settings?.coreDirectory;
  if (!coreDirectory) {
    return { status: 'error', error: 'No workspace configured' };
  }

  const absoluteDest = resolvePendingDestinationAbsolute(
    initialFile.frontmatter.pending_destination,
    coreDirectory ?? undefined,
  );
  const canonicalDestination = canonicalizePath(absoluteDest);

  return withDestinationLock(canonicalDestination, async () => {
    const file = await getPendingFile(id);
    if (!file) {
      log.info({ id }, 'Pending file already resolved (not found inside keep-private lock)');
      return { status: 'already-resolved' };
    }

    return keepPendingFilePrivateRecord(id, file, coreDirectory);
  });
}

/**
 * Delete a pending file (user chose to discard).
 */
export async function deletePendingFile(id: string): Promise<PublishResult> {
  const initialFile = await getPendingFile(id);
  if (!initialFile) {
    return { status: 'not-found', error: 'Pending file not found' };
  }

  const settings = getSettings();
  const coreDirectory = settings?.coreDirectory;
  const absoluteDest = resolvePendingDestinationAbsolute(
    initialFile.frontmatter.pending_destination,
    coreDirectory ?? undefined,
  );
  const canonicalDestination = canonicalizePath(absoluteDest);

  return withDestinationLock(canonicalDestination, async () => {
    const file = await getPendingFile(id);
    if (!file) {
      return { status: 'not-found', error: 'Pending file not found' };
    }

    return deletePendingFileRecord(id, file);
  });
}

/**
 * Check if CoS pending is available (i.e., coreDirectory is configured).
 * Used by migration logic and memoryWriteHook to determine if staging is possible.
 */
export function isCosPendingAvailable(): boolean {
  return getCosPendingDir() !== null;
}

/**
 * For testing - reset internal state.
 */
export function _resetForTesting(): void {
  coalescedPendingIdsBySession.clear();
  destinationLocks.clear();
}

// ============================================================================
// Migration from legacy Electron userData staging
// ============================================================================

const MIGRATION_MARKER = '.migration-complete';

/**
 * Check if migration from legacy staging has been completed.
 */
async function isMigrationComplete(): Promise<boolean> {
  const pendingDir = getCosPendingDir();
  if (!pendingDir) return true; // No CoS, nothing to migrate to

  try {
    await fs.access(path.join(pendingDir, MIGRATION_MARKER));
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark migration as complete.
 */
async function markMigrationComplete(): Promise<void> {
  const pendingDir = await ensurePendingDir();
  if (!pendingDir) return;

  await fs.writeFile(path.join(pendingDir, MIGRATION_MARKER), new Date().toISOString(), 'utf-8');
}

/**
 * Migrate legacy Electron userData staged files to CoS pending.
 * Called on app startup to ensure users' files from the legacy staging system
 * are migrated to the new CoS pending approach.
 *
 * Migration is best-effort:
 * - Files that migrate successfully are removed from legacy staging
 * - Files that fail to migrate are logged but left in place
 * - Partial migration is acceptable (only internal users affected)
 */
export async function migrateLegacyStagedFiles(): Promise<{
  migrated: number;
  failed: number;
  skipped: number;
}> {
  const result = { migrated: 0, failed: 0, skipped: 0 };

  // Check if CoS pending is available
  if (!isCosPendingAvailable()) {
    log.debug('CoS pending not available, skipping migration');
    return result;
  }

  // Check if already migrated
  if (await isMigrationComplete()) {
    log.debug('Migration already complete');
    return result;
  }

  log.info('Starting migration of legacy staged files to CoS pending');

  // Get all legacy staged files
  const legacyFiles = await getAllStagedFiles();
  if (legacyFiles.length === 0) {
    log.info('No legacy staged files to migrate');
    await markMigrationComplete();
    return result;
  }

  log.info({ count: legacyFiles.length }, 'Found legacy staged files to migrate');

  for (const legacyFile of legacyFiles) {
    try {
      // Get the content from legacy staging
      const content = await getStagedContent(legacyFile.id);
      if (!content) {
        log.warn({ id: legacyFile.id }, 'Legacy staged file has no content, skipping');
        result.skipped++;
        continue;
      }

      // Write to CoS pending
      const pendingFile = await writeToPending({
        destinationPath: legacyFile.realPath,
        content,
        sessionId: legacyFile.sessionId,
        summary: legacyFile.summary,
        spaceName: legacyFile.spaceName,
        baseHash: legacyFile.baseHash,
      });

      if (pendingFile) {
        // Successfully migrated - remove from legacy staging
        await discardStagedFile(legacyFile.id);
        log.info({ id: legacyFile.id, newFile: pendingFile.filename }, 'Migrated legacy staged file');
        result.migrated++;
      } else {
        // writeToPending returned null (invalid destination or CoS unavailable)
        log.warn({ id: legacyFile.id, realPath: legacyFile.realPath }, 'Failed to migrate - invalid destination');
        result.failed++;
      }
    } catch (error) {
      log.error({ err: error, id: legacyFile.id }, 'Failed to migrate legacy staged file');
      result.failed++;
    }
  }

  // Mark migration complete even if some files failed
  // (they'll remain accessible via legacy staging)
  await markMigrationComplete();

  log.info(result, 'Migration complete');
  return result;
}
