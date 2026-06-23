import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { detectCloudStorage } from '@core/utils/cloudStorageUtils';
import { parseUseToolEnvelopeJson } from '@core/rebelCore/superMcpEnvelope';
import { getSettings } from '@core/services/settingsStore';
import { resolveEffectiveAssociatedAccounts } from '@core/services/space/associatedAccounts';
import { createScopedLogger } from '@core/logger';
import { parseEmailFromSlug, parseMultiInstanceServer } from '@shared/utils/mcpInstanceUtils';
import type { SpaceStorageProvider } from '@shared/types';
import { getCurrentUserProvider } from '@core/currentUserProvider';
import { getMcpServerNames, readMcpServerDetails } from './mcpConfigManager';
import { getTextEntryFromToolResult, resolveMcpConfigPath, withSuperMcpClient } from './mcpService';
import { scanSpaces } from './spaceService';
import { sharedSkillMutationService, type SharedSkillActor, type SharedSkillTarget } from './sharedSkillMutationService';
import { readDriveFileIdFromXattr } from './driveFileIdLookup';
import {
  getCachedRevisionHashes,
  pruneCachedRevisionHashes,
  setCachedRevisionHashes,
  type FileRevisionHashes,
} from '@core/services/driveRevisionHashCache';
import { getOrGenerateAnonymousId, trackMainEvent } from '../analytics';
import { mainTracking } from '../tracking';

const GOOGLE_WORKSPACE_BASE_NAME = 'GoogleWorkspace';
const GOOGLE_DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_HISTORY_UNAVAILABLE_PREFIX = 'drive-history-unavailable';
const SEARCH_PAGE_SIZE = 200;
const MAX_BRANCH_CANDIDATES = 40;
const MAX_TOOL_OUTPUT_CHARS = 500_000;
const REVISION_DOWNLOAD_CONCURRENCY = 5;
const REVISION_HASH_CACHE_CAP = 500;
const INITIAL_DEDUP_REVISION_WINDOW = 10;
const log = createScopedLogger({ service: 'driveSkillHistoryService' });

type SkillHistoryFailure = { success: false; error: string };

interface DrivePackageCandidate {
  packageId: string;
  email: string | null;
}

interface DriveFileEntry {
  id?: string;
  name?: string;
  mimeType?: string;
  modifiedTime?: string;
  size?: string | number;
}

interface DriveRevisionActor {
  displayName?: string;
  emailAddress?: string;
}

interface DriveRevisionEntry {
  id?: string;
  modifiedTime?: string;
  mimeType?: string;
  size?: string | number;
  keepForever?: boolean;
  published?: boolean;
  lastModifyingUser?: DriveRevisionActor;
}

interface DriveOperationResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  encoding?: 'text' | 'base64';
  mimeType?: string;
  fileName?: string;
}

interface DriveResolution {
  packageId: string;
  email: string | null;
  fileId: string;
  updatedAt: number;
}

interface ResolvedDriveContext {
  target: SharedSkillTarget;
  coreDirectory: string;
  cacheKey: string;
  packageId: string;
  email: string | null;
  fileId: string;
}

interface ResolvedSpaceContext {
  sourcePath: string | null;
  storageProvider: SpaceStorageProvider | null;
  emails: string[];
}

export interface SkillHistoryVersionSummary {
  snapshotId: string;
  filename: string;
  timestampMs: number;
  contentHash: string;
  summary: string;
  actorKind: 'human' | 'agent';
  actorId: string | null;
  actorLabel: string | null;
  actorEmail: string | null;
  skillWorkspacePath: string;
  restoredFromSnapshotId: string | null;
}

export interface SkillHistorySnapshotPayload {
  snapshotId: string;
  timestampMs: number;
  contentHash: string;
  summary: string;
  actorKind: 'human' | 'agent';
  actorId: string | null;
  actorLabel: string | null;
  actorEmail: string | null;
  skillWorkspacePath: string;
  body: string;
  restoredFromSnapshotId: string | null;
  restoredFromSkillPath: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePosix(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function normalizeEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function unavailableError(reason: string): string {
  return `${DRIVE_HISTORY_UNAVAILABLE_PREFIX}:${reason}`;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function safeTimestampMs(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sha256Hex(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function decodeRevisionContent(raw: string, encoding?: 'text' | 'base64'): string {
  if (encoding === 'base64') {
    return Buffer.from(raw, 'base64').toString('utf8');
  }
  return raw;
}

function relativeInsideSpace(target: SharedSkillTarget): string {
  const rel = path.posix.relative(normalizePosix(target.spacePath), normalizePosix(target.relativePath));
  if (!rel || rel === '.' || rel.startsWith('../')) {
    return path.posix.basename(normalizePosix(target.relativePath));
  }
  return rel;
}

function extractDrivePathPrefixFromSourcePath(sourcePath: string | null): string[] {
  if (!sourcePath) return [];
  const segments = normalizePosix(sourcePath).split('/').filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());

  const myDriveIdx = lowerSegments.findIndex((segment) => segment === 'my drive');
  if (myDriveIdx >= 0) {
    return segments.slice(myDriveIdx + 1);
  }

  const sharedDriveIdx = lowerSegments.findIndex(
    (segment) => segment === 'shared drives' || segment === 'shareddrives',
  );
  if (sharedDriveIdx >= 0) {
    return segments.slice(sharedDriveIdx + 1);
  }

  return [];
}

function buildDrivePathSegments(target: SharedSkillTarget, sourcePath: string | null): string[] {
  const prefix = extractDrivePathPrefixFromSourcePath(sourcePath);
  const insideSpaceSegments = normalizePosix(relativeInsideSpace(target)).split('/').filter(Boolean);
  return [...prefix, ...insideSpaceSegments];
}

async function buildDrivePathSegmentVariants(target: SharedSkillTarget, sourcePath: string | null): Promise<string[][]> {
  const insideSpaceSegments = normalizePosix(relativeInsideSpace(target)).split('/').filter(Boolean);
  const prefixedSegments = buildDrivePathSegments(target, sourcePath).filter(Boolean);
  const realPath = await fs.realpath(target.absolutePath).catch(() => null);
  const realDriveSegments = realPath ? extractDrivePathPrefixFromSourcePath(realPath) : [];

  const variants: string[][] = [realDriveSegments, prefixedSegments, insideSpaceSegments];
  if (insideSpaceSegments.length >= 3) {
    variants.push(insideSpaceSegments.slice(-3));
  }
  if (insideSpaceSegments.length >= 2) {
    variants.push(insideSpaceSegments.slice(-2));
  }

  const seen = new Set<string>();
  const deduped: string[][] = [];
  for (const variant of variants) {
    if (variant.length === 0) continue;
    const key = variant.join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(variant);
  }
  return deduped;
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

/**
 * Run an async worker over a list with a bounded concurrency cap.
 * Preserves per-item error isolation — a throw on one item does not
 * halt the whole batch.
 */
async function runWithConcurrency<T>(
  concurrency: number,
  items: readonly T[],
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        await worker(items[index] as T);
      } catch {
        // Per-item failures are surfaced by the worker itself; this
        // helper must keep the batch going.
      }
    }
  });

  await Promise.all(runners);
}

async function ensureUniquePath(targetPath: string): Promise<string> {
  const extension = path.extname(targetPath);
  const directory = path.dirname(targetPath);
  const baseName = path.basename(targetPath, extension);

  let candidate = targetPath;
  let suffix = 2;
  while (await fs.stat(candidate).then(() => true).catch(() => false)) {
    candidate = path.join(directory, `${baseName}-${suffix}${extension}`);
    suffix += 1;
  }

  return candidate;
}

class DriveSkillHistoryService {
  private readonly resolutionCache = new Map<string, DriveResolution>();
  private readonly revisionMetaCache = new Map<string, Map<string, DriveRevisionEntry>>();

  async listVersions(
    skillWorkspacePath: string,
    coreDirectory: string,
  ): Promise<{ success: true; versions: SkillHistoryVersionSummary[] } | SkillHistoryFailure> {
    const resolved = await this.resolveDriveContext(skillWorkspacePath, coreDirectory);
    if (!resolved.success) {
      return resolved;
    }

    const revisionsResult = await this.fetchRevisions(resolved.context);
    if (!revisionsResult.success) {
      return revisionsResult;
    }

    // Google Drive creates revisions for all sorts of non-edit events
    // (collaborators' Drive for Desktop touching mtime, Rebel's own
    // attribution-repair writes, sync housekeeping). Collapse any
    // adjacent revisions whose content bytes are identical so the UI
    // only shows revisions that actually changed the file.
    //
    // Hashes are cached persistently keyed by (file_id, revision_id),
    // so the first-open cost is paid at most once per revision ever
    // seen on this device. Cross-user within a company: each device
    // pays its own one-time cost; the Drive API calls themselves are
    // cached server-side by Google. Revisions are immutable — once
    // hashed, never re-downloaded for dedup.
    const deduped = await this.dedupRevisionsByContent(resolved.context, revisionsResult.revisions);

    const versions = deduped.map((revision) => this.mapRevisionToSummary(resolved.context.target, revision));
    versions.sort((a, b) => b.timestampMs - a.timestampMs);

    return { success: true, versions };
  }

  async getSnapshot(
    skillWorkspacePath: string,
    snapshotId: string,
    coreDirectory: string,
  ): Promise<{ success: true; snapshot: SkillHistorySnapshotPayload } | SkillHistoryFailure> {
    const resolved = await this.resolveDriveContext(skillWorkspacePath, coreDirectory);
    if (!resolved.success) {
      return resolved;
    }
    return this.getSnapshotForContext(resolved.context, snapshotId);
  }

  async restoreVersion(
    skillWorkspacePath: string,
    snapshotId: string,
    coreDirectory: string,
    actor: SharedSkillActor,
  ): Promise<
    | { success: true; path: string; currentHash: string; updatedAt: number }
    | { success: false; error: string; conflict?: boolean; currentHash?: string }
  > {
    const resolved = await this.resolveDriveContext(skillWorkspacePath, coreDirectory);
    if (!resolved.success) {
      return resolved;
    }

    const loaded = await this.getSnapshotForContext(resolved.context, snapshotId);
    if (!loaded.success) {
      return loaded;
    }

    const writeResult = await sharedSkillMutationService.writeManagedSkillFile(
      resolved.context.target.absolutePath,
      loaded.snapshot.body,
      coreDirectory,
      actor,
      {
        restoreLineage: {
          restoredFromVersionId: loaded.snapshot.snapshotId,
          restoredFromSkillPath: normalizePosix(resolved.context.target.relativePath),
        },
      },
    );

    if (!writeResult) {
      return { success: false, error: unavailableError('write-target-unavailable') };
    }
    if (writeResult.conflict) {
      return {
        success: false,
        error: 'Skill was modified; reload and try again.',
        conflict: true,
        currentHash: writeResult.currentHash,
      };
    }

    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'skill_restored',
      properties: {
        skill_id: normalizePosix(resolved.context.target.relativePath),
        restored_to_version: loaded.snapshot.snapshotId,
        restored_by: actor.user?.id ?? null,
      },
    });

    return {
      success: true,
      path: writeResult.path,
      currentHash: writeResult.currentHash,
      updatedAt: writeResult.updatedAt,
    };
  }

  async forkSnapshotToChiefOfStaff(
    skillWorkspacePath: string,
    snapshotId: string,
    coreDirectory: string,
    forkName?: string,
  ): Promise<{ success: true; forkPath: string; forkWorkspaceRelative: string } | SkillHistoryFailure> {
    const resolved = await this.resolveDriveContext(skillWorkspacePath, coreDirectory);
    if (!resolved.success) {
      return resolved;
    }

    const loaded = await this.getSnapshotForContext(resolved.context, snapshotId);
    if (!loaded.success) {
      return loaded;
    }

    const cosRoot = await this.resolveChiefOfStaffRoot(coreDirectory);
    if (!cosRoot) {
      return { success: false, error: 'Chief-of-Staff space not found.' };
    }

    const userStem = forkName?.trim()
      ? forkName.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80)
      : '';
    const dateStamp = new Date().toISOString().slice(0, 10);
    const baseName = path.posix.basename(normalizePosix(resolved.context.target.relativePath));
    const stem = baseName.toLowerCase().endsWith('.md') ? baseName.slice(0, -3) : baseName;
    const fallbackStem = stem.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
    const safeStem = userStem || `${fallbackStem || 'skill'}-${dateStamp}-copy`;

    const skillsRoot = path.join(cosRoot, 'skills');
    await fs.mkdir(skillsRoot, { recursive: true });

    let forkAbsolute: string;
    let forkRelative: string;
    const cosWorkspaceRel = normalizePosix(path.relative(coreDirectory, cosRoot));

    if (resolved.context.target.shape === 'folder') {
      const uniqueDir = await ensureUniquePath(path.join(skillsRoot, safeStem));
      forkAbsolute = path.join(uniqueDir, 'SKILL.md');
      await fs.mkdir(uniqueDir, { recursive: true });
      forkRelative = path.posix.join(
        cosWorkspaceRel,
        'skills',
        path.basename(path.dirname(forkAbsolute)),
        path.basename(forkAbsolute),
      );
    } else {
      const fileName = `${safeStem}.md`;
      forkAbsolute = await ensureUniquePath(path.join(skillsRoot, fileName));
      forkRelative = path.posix.join(cosWorkspaceRel, 'skills', path.basename(forkAbsolute));
    }

    await fs.writeFile(forkAbsolute, loaded.snapshot.body, 'utf8');

    trackMainEvent({
      anonymousId: getOrGenerateAnonymousId(),
      event: 'skill_forked',
      properties: {
        source_skill_id: normalizePosix(resolved.context.target.relativePath),
        fork_skill_id: normalizePosix(forkRelative),
        forked_by: getCurrentUserProvider().getCurrentUser()?.id ?? null,
      },
    });
    const currentUser = getCurrentUserProvider().getCurrentUser();
    mainTracking.skillCreated({
      skillPath: normalizePosix(forkRelative),
      skillScope: 'private',
      source: 'skill_fork',
      creatorId: currentUser?.id ?? null,
      creatorEmail: currentUser?.email ?? null,
      creatorName: currentUser?.name ?? null,
    });

    return { success: true, forkPath: forkAbsolute, forkWorkspaceRelative: forkRelative };
  }

  private async resolveDriveContext(
    skillWorkspacePath: string,
    coreDirectory: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<{ success: true; context: ResolvedDriveContext } | SkillHistoryFailure> {
    const target = await this.resolveTarget(skillWorkspacePath, coreDirectory);
    if (!target) {
      return { success: false, error: unavailableError('not-shared-skill') };
    }

    const cacheKey = normalizePosix(target.absolutePath).toLowerCase();
    if (!options.forceRefresh) {
      const cached = this.resolutionCache.get(cacheKey);
      if (cached) {
        return {
          success: true,
          context: {
            target,
            coreDirectory,
            cacheKey,
            packageId: cached.packageId,
            email: cached.email,
            fileId: cached.fileId,
          },
        };
      }
    }

    const spaceContext = await this.resolveSpaceContext(target, coreDirectory);
    if (spaceContext.storageProvider !== 'google_drive') {
      return { success: false, error: unavailableError('not-google-drive-backed') };
    }

    const packages = await this.resolveGoogleWorkspacePackages(spaceContext.emails);
    if (packages.length === 0) {
      return { success: false, error: unavailableError('google-account-unresolved') };
    }

    let resolvedFile: { packageId: string; email: string | null; fileId: string } | null = null;
    let resolutionStrategy: 'xattr' | 'path-search' | null = null;

    // Primary: read the Drive file_id directly from the filesystem.
    // This is an O(1) lookup guaranteed to match the exact file shown
    // in Finder — no fuzzy path walking, no wrong-file matches.
    const realPath = await fs.realpath(target.absolutePath).catch(() => target.absolutePath);
    const directFileId = await readDriveFileIdFromXattr(realPath);
    if (directFileId) {
      const [candidate] = packages;
      if (candidate) {
        resolvedFile = {
          packageId: candidate.packageId,
          email: candidate.email,
          fileId: directFileId,
        };
        resolutionStrategy = 'xattr';
      }
    }

    // Fallback: path-segment search via the Workspace MCP. Slower and
    // looser, but necessary for spaces where the xattr is absent
    // (non-desktop surfaces in the future, or Drive sync variants
    // that use different metadata). Kept narrow to avoid wrong-file
    // matches — no bare-filename fallback.
    if (!resolvedFile) {
      const pathSegmentVariants = await buildDrivePathSegmentVariants(target, spaceContext.sourcePath);
      for (const candidate of packages) {
        for (const pathSegments of pathSegmentVariants) {
          const fileId = await this.resolveDriveFileId(candidate, pathSegments, target);
          if (!fileId) continue;
          resolvedFile = { packageId: candidate.packageId, email: candidate.email, fileId };
          resolutionStrategy = 'path-search';
          break;
        }
        if (resolvedFile) break;
      }
    }

    if (!resolvedFile) {
      log.warn(
        {
          skillWorkspacePath,
          absolutePath: target.absolutePath,
          sourcePath: spaceContext.sourcePath,
          storageProvider: spaceContext.storageProvider,
          packageCandidates: packages.map((candidate) => candidate.packageId),
        },
        'Drive history resolution could not match skill to a Drive file',
      );
      return { success: false, error: unavailableError('file-id-unresolved') };
    }

    log.info(
      {
        skillWorkspacePath,
        strategy: resolutionStrategy,
        packageId: resolvedFile.packageId,
        fileIdLength: resolvedFile.fileId.length,
      },
      'Drive history resolution succeeded',
    );

    this.resolutionCache.set(cacheKey, {
      packageId: resolvedFile.packageId,
      email: resolvedFile.email,
      fileId: resolvedFile.fileId,
      updatedAt: Date.now(),
    });

    return {
      success: true,
      context: {
        target,
        coreDirectory,
        cacheKey,
        packageId: resolvedFile.packageId,
        email: resolvedFile.email,
        fileId: resolvedFile.fileId,
      },
    };
  }

  /**
   * Collapse adjacent revisions that have identical content. Hashes
   * are resolved from the persistent (`file_id`, `revision_id`) cache
   * first; any revisions without a cached hash are downloaded in
   * parallel (bounded concurrency) once, then written back to the
   * cache so future panel opens are free.
   *
   * Important UX constraint: do NOT block the initial history panel on
   * hashing every revision the file has ever had. In practice, that
   * can mean dozens of sequential MCP tool calls and ~30-60s waits on
   * first open. We only dedup the recent window the user actually sees
   * first; older revisions are left in their raw Drive order until
   * they become relevant.
   *
   * Ordering semantics: we want the user to see the revision that
   * *introduced* each distinct content state, not later no-op writes.
   * So when a run of revisions share a content hash, we keep the
   * earliest (oldest) one in the run.
   *
   * Failures downloading a revision are non-fatal — the revision is
   * left in the list with a synthetic unique hash so it is never
   * collapsed and the UI can still offer preview (which may then
   * surface the real Drive error).
   */
  private async dedupRevisionsByContent(
    context: ResolvedDriveContext,
    revisions: DriveRevisionEntry[],
  ): Promise<DriveRevisionEntry[]> {
    if (revisions.length <= 1) {
      return revisions;
    }

    // The revisions list comes back newest-first from Drive. Dedup only
    // the recent window users see immediately; preserve the tail raw to
    // keep first-open latency bounded at company scale.
    const recentWindow = revisions.slice(0, INITIAL_DEDUP_REVISION_WINDOW);
    const untouchedTail = revisions.slice(INITIAL_DEDUP_REVISION_WINDOW);
    if (untouchedTail.length > 0) {
      log.debug(
        {
          fileId: context.fileId,
          totalRevisions: revisions.length,
          dedupWindow: recentWindow.length,
          tailLeftRaw: untouchedTail.length,
        },
        'Limiting initial Drive revision dedup to recent window',
      );
    }

    const cached = getCachedRevisionHashes(context.fileId);
    const needsDownload: DriveRevisionEntry[] = [];
    const hashByRevisionId = new Map<string, string>();

    for (const revision of recentWindow) {
      if (!revision.id) continue;
      const entry = cached[revision.id];
      if (entry) {
        hashByRevisionId.set(revision.id, entry.hash);
      } else {
        needsDownload.push(revision);
      }
    }

    if (needsDownload.length > 0) {
      const updates: FileRevisionHashes = {};
      const now = Date.now();

      await runWithConcurrency(REVISION_DOWNLOAD_CONCURRENCY, needsDownload, async (revision) => {
        if (!revision.id) return;
        const hash = await this.downloadAndHashRevision(context, revision.id);
        if (hash) {
          hashByRevisionId.set(revision.id, hash);
          updates[revision.id] = { hash, cachedAt: now };
        } else {
          // Preserve the revision in the UI by giving it a unique
          // synthetic hash — prevents spurious collapse with an
          // adjacent legitimately-hashed revision.
          hashByRevisionId.set(revision.id, `unhashable:${revision.id}`);
        }
      });

      if (Object.keys(updates).length > 0) {
        setCachedRevisionHashes(context.fileId, updates);
        pruneCachedRevisionHashes(context.fileId, REVISION_HASH_CACHE_CAP);
      }
    }

    // Sort ascending by modifiedTime so "earliest wins" collapse is
    // natural. Revisions without a timestamp fall to the end and are
    // treated as distinct (they can't be safely collapsed).
    const ordered = [...recentWindow].sort(
      (a, b) => safeTimestampMs(a.modifiedTime) - safeTimestampMs(b.modifiedTime),
    );

    const kept: DriveRevisionEntry[] = [];
    let lastHash: string | null = null;
    for (const revision of ordered) {
      const hash = revision.id ? hashByRevisionId.get(revision.id) ?? null : null;
      if (hash && lastHash && hash === lastHash) {
        // Same content as the immediately-prior kept revision → skip.
        continue;
      }
      kept.push(revision);
      lastHash = hash;
    }

    if (kept.length !== recentWindow.length) {
      log.info(
        {
          fileId: context.fileId,
          before: recentWindow.length,
          after: kept.length,
          collapsedNoOps: recentWindow.length - kept.length,
          untouchedTail: untouchedTail.length,
        },
        'Collapsed no-op Drive revisions by content hash',
      );
    }

    const dedupedRecentNewestFirst = [...kept].sort(
      (a, b) => safeTimestampMs(b.modifiedTime) - safeTimestampMs(a.modifiedTime),
    );
    return [...dedupedRecentNewestFirst, ...untouchedTail];
  }

  private async downloadAndHashRevision(
    context: ResolvedDriveContext,
    revisionId: string,
  ): Promise<string | null> {
    const operation = await this.callDriveOperation(
      context.packageId,
      context.email,
      'download_file_revision',
      { file_id: context.fileId, revision_id: revisionId },
      60_000,
    );

    if (!operation.success) {
      log.debug(
        { fileId: context.fileId, revisionId, driveError: operation.error ?? 'unknown' },
        'download_file_revision failed during dedup; revision kept as distinct',
      );
      return null;
    }

    const data = operation.data?.data;
    if (typeof data !== 'string') {
      return null;
    }
    const body = decodeRevisionContent(data, operation.encoding);
    return sha256Hex(body);
  }

  private async fetchRevisions(
    context: ResolvedDriveContext,
  ): Promise<{ success: true; revisions: DriveRevisionEntry[] } | SkillHistoryFailure> {
    const operation = await this.callDriveOperation(
      context.packageId,
      context.email,
      'list_file_revisions',
      { file_id: context.fileId },
    );

    if (!operation.success) {
      const retried = await this.maybeRetryAfterResolutionRefresh(context, 'list_file_revisions', { file_id: context.fileId });
      if (!retried.success) {
        return { success: false, error: `Could not load Google Drive revision history: ${operation.error ?? 'unknown error'}` };
      }
      return this.extractRevisionsFromOperation(context, retried.operation);
    }

    return this.extractRevisionsFromOperation(context, operation);
  }

  private extractRevisionsFromOperation(
    context: ResolvedDriveContext,
    operation: DriveOperationResult,
  ): { success: true; revisions: DriveRevisionEntry[] } | SkillHistoryFailure {
    if (!operation.success) {
      return { success: false, error: `Could not load Google Drive revision history: ${operation.error ?? 'unknown error'}` };
    }

    const revisionsRaw = operation.data?.revisions;
    const revisions = Array.isArray(revisionsRaw)
      ? revisionsRaw.filter(isRecord).map((entry) => entry as unknown as DriveRevisionEntry)
      : [];

    const index = new Map<string, DriveRevisionEntry>();
    for (const revision of revisions) {
      if (!revision.id) continue;
      index.set(revision.id, revision);
    }
    this.revisionMetaCache.set(context.cacheKey, index);
    return { success: true, revisions };
  }

  private async getSnapshotForContext(
    context: ResolvedDriveContext,
    snapshotId: string,
  ): Promise<{ success: true; snapshot: SkillHistorySnapshotPayload } | SkillHistoryFailure> {
    const revisionMeta = await this.getRevisionMeta(context, snapshotId);
    const operation = await this.callDriveOperation(
      context.packageId,
      context.email,
      'download_file_revision',
      {
        file_id: context.fileId,
        revision_id: snapshotId,
      },
      60_000,
    );

    if (!operation.success) {
      const retried = await this.maybeRetryAfterResolutionRefresh(context, 'download_file_revision', {
        file_id: context.fileId,
        revision_id: snapshotId,
      });
      if (!retried.success || !retried.operation.success) {
        const driveError =
          (!retried.success ? operation.error : retried.operation.error) ?? 'unknown error';
        log.warn(
          {
            fileId: context.fileId,
            snapshotId,
            driveError,
          },
          'download_file_revision failed after retry',
        );
        return {
          success: false,
          error: `Could not load this Google Drive revision: ${driveError}`,
        };
      }
      return this.mapSnapshotPayload(context.target, snapshotId, retried.operation, revisionMeta.revision);
    }

    return this.mapSnapshotPayload(context.target, snapshotId, operation, revisionMeta.revision);
  }

  private async getRevisionMeta(
    context: ResolvedDriveContext,
    snapshotId: string,
  ): Promise<{ revision: DriveRevisionEntry | null }> {
    const cached = this.revisionMetaCache.get(context.cacheKey);
    if (cached?.has(snapshotId)) {
      return { revision: cached.get(snapshotId) ?? null };
    }

    const revisions = await this.fetchRevisions(context);
    if (!revisions.success) {
      return { revision: null };
    }
    const refreshed = this.revisionMetaCache.get(context.cacheKey);
    return { revision: refreshed?.get(snapshotId) ?? null };
  }

  private mapSnapshotPayload(
    target: SharedSkillTarget,
    snapshotId: string,
    operation: DriveOperationResult,
    revision: DriveRevisionEntry | null,
  ): { success: true; snapshot: SkillHistorySnapshotPayload } | SkillHistoryFailure {
    if (!operation.success) {
      return { success: false, error: 'Could not load this Google Drive revision.' };
    }

    const data = operation.data?.data;
    if (typeof data !== 'string') {
      return { success: false, error: 'Google Drive revision payload was empty.' };
    }

    const body = decodeRevisionContent(data, operation.encoding);
    return {
      success: true,
      snapshot: {
        snapshotId,
        timestampMs: safeTimestampMs(revision?.modifiedTime),
        contentHash: sha256Hex(body),
        summary: this.buildRevisionSummary(revision),
        actorKind: 'human',
        actorId: null,
        actorLabel: revision?.lastModifyingUser?.displayName ?? null,
        actorEmail: revision?.lastModifyingUser?.emailAddress ?? null,
        skillWorkspacePath: normalizePosix(target.relativePath),
        body,
        restoredFromSnapshotId: null,
        restoredFromSkillPath: null,
      },
    };
  }

  private mapRevisionToSummary(target: SharedSkillTarget, revision: DriveRevisionEntry): SkillHistoryVersionSummary {
    const snapshotId = revision.id ?? '';
    return {
      snapshotId,
      filename: `drive-revision-${snapshotId || 'unknown'}.md`,
      timestampMs: safeTimestampMs(revision.modifiedTime),
      contentHash: snapshotId || 'unknown-drive-revision',
      summary: this.buildRevisionSummary(revision),
      actorKind: 'human',
      actorId: null,
      actorLabel: revision.lastModifyingUser?.displayName ?? null,
      actorEmail: revision.lastModifyingUser?.emailAddress ?? null,
      skillWorkspacePath: normalizePosix(target.relativePath),
      restoredFromSnapshotId: null,
    };
  }

  private buildRevisionSummary(revision: DriveRevisionEntry | null): string {
    if (!revision) return 'Edited in Google Drive';
    const actor = revision.lastModifyingUser?.displayName?.trim()
      || revision.lastModifyingUser?.emailAddress?.trim()
      || null;
    if (actor) {
      return `Edited in Google Drive by ${actor}`;
    }
    return revision.keepForever ? 'Pinned Google Drive revision' : 'Edited in Google Drive';
  }

  private async callDriveOperation(
    packageId: string,
    email: string | null,
    toolName: 'search_drive_files' | 'list_file_revisions' | 'download_file_revision',
    args: Record<string, unknown>,
    timeout = 30_000,
  ): Promise<DriveOperationResult> {
    try {
      const payload = await this.callDriveTool(packageId, toolName, email, args, timeout);
      return this.toDriveOperationResult(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }

  private async callDriveTool(
    packageId: string,
    toolName: string,
    email: string | null,
    args: Record<string, unknown>,
    timeout = 30_000,
  ): Promise<unknown> {
    return withSuperMcpClient(async (client) => {
      const result = await client.callTool(
        {
          name: 'use_tool',
          arguments: {
            package_id: packageId,
            tool_id: `${packageId}__${toolName}`,
            args: email ? { email, ...args } : args,
            max_output_chars: MAX_TOOL_OUTPUT_CHARS,
          },
        },
        undefined,
        { timeout },
      );

      const textEntry = getTextEntryFromToolResult(result);
      if (!textEntry) {
        throw new Error(`No response from ${toolName}`);
      }
      return this.unwrapToolPayload(textEntry.text);
    });
  }

  private unwrapToolPayload(text: string): unknown {
    const envelope = parseUseToolEnvelopeJson<{ result?: unknown }>(text);
    const inner = envelope && 'result' in envelope ? envelope.result : this.tryParseJson(text);
    return this.unwrapNestedPayload(inner);
  }

  private unwrapNestedPayload(payload: unknown): unknown {
    if (typeof payload === 'string') {
      const parsed = this.tryParseJson(payload);
      return parsed ? this.unwrapNestedPayload(parsed) : payload;
    }
    if (!isRecord(payload)) {
      return payload;
    }

    if (typeof payload.success === 'boolean') {
      return payload;
    }

    if (Array.isArray(payload.files) || Array.isArray(payload.revisions)) {
      return payload;
    }

    const content = payload.content;
    if (!Array.isArray(content)) {
      return payload;
    }
    const textBlock = content.find(
      (entry) => isRecord(entry) && entry.type === 'text' && typeof entry.text === 'string',
    ) as { text: string } | undefined;
    if (!textBlock) {
      return payload;
    }

    const parsed = this.tryParseJson(textBlock.text);
    return parsed ? this.unwrapNestedPayload(parsed) : textBlock.text;
  }

  private tryParseJson(text: string): unknown | null {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private toDriveOperationResult(payload: unknown): DriveOperationResult {
    if (isRecord(payload) && typeof payload.success === 'boolean') {
      const payloadData = payload.data;
      const data = isRecord(payloadData)
        ? payloadData
        : payloadData === undefined
          ? undefined
          : { data: payloadData };
      return {
        success: payload.success,
        data,
        error: typeof payload.error === 'string' ? payload.error : undefined,
        encoding: payload.encoding === 'base64' || payload.encoding === 'text'
          ? payload.encoding
          : undefined,
        mimeType: typeof payload.mimeType === 'string' ? payload.mimeType : undefined,
        fileName: typeof payload.fileName === 'string' ? payload.fileName : undefined,
      };
    }

    if (isRecord(payload) && Array.isArray(payload.files)) {
      return { success: true, data: { files: payload.files } };
    }

    if (isRecord(payload) && Array.isArray(payload.revisions)) {
      return { success: true, data: { revisions: payload.revisions } };
    }

    if (typeof payload === 'string') {
      return { success: false, error: payload };
    }

    log.warn({ payload }, 'Unexpected Google Drive tool payload shape');
    return { success: false, error: 'Unexpected Google Drive tool response.' };
  }

  private async resolveDriveFileId(
    candidate: DrivePackageCandidate,
    pathSegments: string[],
    target: SharedSkillTarget,
  ): Promise<string | null> {
    if (pathSegments.length === 0) {
      return null;
    }

    const localMtimeMs = await fs.stat(target.absolutePath).then((stat) => stat.mtimeMs).catch(() => null);
    let parentIds: Array<string | null> = [null];

    for (let index = 0; index < pathSegments.length; index += 1) {
      const segment = pathSegments[index];
      const isLast = index === pathSegments.length - 1;
      const nextParentIds: string[] = [];
      const query = `name = '${escapeDriveQueryValue(segment)}'`;

      for (const parentId of parentIds) {
        const operation = await this.callDriveOperation(
          candidate.packageId,
          candidate.email,
          'search_drive_files',
          {
            return_json: true,
            options: {
              pageSize: SEARCH_PAGE_SIZE,
              trashed: false,
              query,
              ...(parentId ? { folderId: parentId } : {}),
              ...(!isLast ? { mimeType: GOOGLE_DRIVE_FOLDER_MIME } : {}),
            },
          },
        );

        if (!operation.success) {
          continue;
        }

        const filesRaw = operation.data?.files;
        if (!Array.isArray(filesRaw)) {
          continue;
        }
        const files = filesRaw.filter(isRecord).map((file) => file as unknown as DriveFileEntry);

        if (!isLast) {
          for (const file of files) {
            if (file.id && file.mimeType === GOOGLE_DRIVE_FOLDER_MIME && file.name === segment) {
              nextParentIds.push(file.id);
            }
          }
          continue;
        }

        const exactMatches = files.filter((file) => file.id && file.name === segment);
        if (exactMatches.length === 1) {
          const [match] = exactMatches;
          return match?.id ?? null;
        }
        if (exactMatches.length > 1) {
          return this.pickBestFileId(exactMatches, localMtimeMs);
        }
      }

      parentIds = unique(nextParentIds).slice(0, MAX_BRANCH_CANDIDATES).map((id) => id ?? null);
      if (!isLast && parentIds.length === 0) {
        return null;
      }
    }

    return null;
  }

  private pickBestFileId(matches: DriveFileEntry[], localMtimeMs: number | null): string | null {
    const withIds = matches.filter((entry): entry is DriveFileEntry & { id: string } => typeof entry.id === 'string');
    if (withIds.length === 0) return null;
    if (withIds.length === 1) return withIds[0].id;
    if (localMtimeMs === null) return withIds[0].id;

    const sorted = [...withIds].sort((a, b) => {
      const aDelta = Math.abs(safeTimestampMs(a.modifiedTime) - localMtimeMs);
      const bDelta = Math.abs(safeTimestampMs(b.modifiedTime) - localMtimeMs);
      return aDelta - bDelta;
    });
    return sorted[0]?.id ?? null;
  }

  private async resolveGoogleWorkspacePackages(spaceEmails: string[]): Promise<DrivePackageCandidate[]> {
    const settings = getSettings();
    const configPath = resolveMcpConfigPath(settings);
    if (!configPath) {
      return [];
    }

    const names = await getMcpServerNames(configPath);
    const candidates: DrivePackageCandidate[] = [];

    for (const name of names) {
      if (name !== GOOGLE_WORKSPACE_BASE_NAME) {
        const parsed = parseMultiInstanceServer(name);
        if (!parsed.isInstance || parsed.baseName !== GOOGLE_WORKSPACE_BASE_NAME) {
          continue;
        }
      }

      let email: string | null = null;
      try {
        const details = await readMcpServerDetails(configPath, name);
        email = normalizeEmail(details.email);
      } catch {
        const parsed = parseMultiInstanceServer(name);
        if (parsed.emailSlug) {
          email = normalizeEmail(parseEmailFromSlug(parsed.emailSlug));
        }
      }
      candidates.push({ packageId: name, email });
    }

    const currentUserEmail = normalizeEmail(getCurrentUserProvider().getCurrentUser()?.email);
    const preferred = new Set(spaceEmails.map((email) => email.toLowerCase()));

    const ranked = [...candidates].sort((a, b) => {
      const rankA = this.accountRank(a.email, preferred, currentUserEmail);
      const rankB = this.accountRank(b.email, preferred, currentUserEmail);
      if (rankA !== rankB) return rankA - rankB;
      return a.packageId.localeCompare(b.packageId);
    });

    return ranked;
  }

  private accountRank(
    email: string | null,
    preferredEmails: Set<string>,
    currentUserEmail: string | null,
  ): number {
    if (email && preferredEmails.has(email)) return 0;
    if (email && currentUserEmail && email === currentUserEmail) return 1;
    if (email) return 2;
    return 3;
  }

  private async resolveSpaceContext(target: SharedSkillTarget, coreDirectory: string): Promise<ResolvedSpaceContext> {
    const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
    const normalizedSpacePath = normalizePosix(target.spacePath).toLowerCase();
    const normalizedAbsolute = path.resolve(target.spaceAbsolutePath);

    const matched = spaces.find((space) => {
      const samePath = normalizePosix(space.path).toLowerCase() === normalizedSpacePath;
      const sameAbsolute = path.resolve(space.absolutePath) === normalizedAbsolute;
      return samePath || sameAbsolute;
    });

    const settingsSpace = getSettings().spaces?.find(
      (space) => normalizePosix(space.path).toLowerCase() === normalizedSpacePath,
    );

    const sourcePath = matched?.sourcePath ?? settingsSpace?.sourcePath ?? null;
    const detectedProvider = sourcePath ? detectCloudStorage(sourcePath).provider : undefined;
    const storageProvider = (settingsSpace?.storageProvider ?? detectedProvider ?? null) as SpaceStorageProvider | null;
    const emails = (resolveEffectiveAssociatedAccounts(settingsSpace?.associatedAccounts, matched?.emails) ?? [])
      .map((value) => normalizeEmail(value))
      .filter((value): value is string => Boolean(value));

    return { sourcePath, storageProvider, emails };
  }

  private async resolveTarget(skillWorkspacePath: string, coreDirectory: string): Promise<SharedSkillTarget | null> {
    const absolute = path.isAbsolute(skillWorkspacePath)
      ? path.resolve(skillWorkspacePath)
      : path.resolve(coreDirectory, skillWorkspacePath);
    return sharedSkillMutationService.classifySharedSkillPath(absolute, coreDirectory);
  }

  private async resolveChiefOfStaffRoot(coreDirectory: string): Promise<string | null> {
    const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
    const cos = spaces.find(
      (space) => space.type === 'chief-of-staff' || normalizePosix(space.path).toLowerCase() === 'chief-of-staff',
    );
    return cos ? path.resolve(cos.absolutePath) : null;
  }

  private async maybeRetryAfterResolutionRefresh(
    context: ResolvedDriveContext,
    toolName: 'list_file_revisions' | 'download_file_revision',
    args: Record<string, unknown>,
  ): Promise<{ success: true; operation: DriveOperationResult } | { success: false }> {
    const refreshed = await this.resolveDriveContext(context.target.absolutePath, context.coreDirectory, {
      forceRefresh: true,
    });
    if (!refreshed.success) {
      return { success: false };
    }

    const operation = await this.callDriveOperation(
      refreshed.context.packageId,
      refreshed.context.email,
      toolName,
      {
        ...args,
        file_id: refreshed.context.fileId,
      },
    );
    if (!operation.success) {
      return { success: false };
    }
    return { success: true, operation };
  }
}

export const driveSkillHistoryService = new DriveSkillHistoryService();
