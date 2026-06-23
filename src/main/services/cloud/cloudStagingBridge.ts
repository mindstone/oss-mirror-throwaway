/**
 * Cloud Staging Bridge
 *
 * Syncs cloud-staged `.pending.md` files to the desktop. When the cloud agent
 * stages a write, the `.pending.md` file only exists on the cloud filesystem.
 * Desktop needs to learn about it and create a local copy so `useStagedFiles`
 * can display it in the Inbox.
 *
 * Triggered by:
 * 1. `memory:staged-files-changed` WebSocket events from cloud
 * 2. On reconnect catch-up (after desktop was offline)
 * 3. On app focus (pulls any missed state)
 *
 * Uses `pending_destination` (workspace-relative) for dedup — cloud and desktop
 * generate different IDs (sha256 of different absolute paths).
 *
 * Zombie prevention: tracks cloud file IDs persistently. When a bridge-pulled
 * file disappears locally (user resolved it), also resolves the cloud original.
 *
 * Duplicate prevention: workspace sync skips *.pending.md files — the bridge
 * manages all staging sync independently.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { createScopedLogger } from '@core/logger';
import { getBroadcastService } from '@core/broadcastService';
import { toPortablePath } from '@core/utils/portablePath';
import {
  createWorkspaceWriteAuthorityCache,
  resolveWorkspaceWriteAuthority,
} from '@core/utils/cloudStorageUtils';
import { resolveFileLocation, FileLocationResolverError } from '@core/services/fileLocation';
import type { SpaceInfo as ResolverSpaceInfo } from '@shared/ipc/schemas/library';
import type { BlockSource, FileLocation } from '@rebel/shared';
import { listPendingFiles, writeToPending, deletePendingFile, detectPendingConflict } from '../safety/cosPendingService';
import { scanSpaces } from '../spaceService';
import { cloudWorkspaceSync, type SyncClient } from './cloudWorkspaceSync';
import { hashContent } from '../safety/hashUtils';
import {
  clearDriveSettleDeferral,
  evaluateDriveSettleDeferral,
  _resetDriveSettleDeferralsForTesting,
} from './driveSettleDeferral';
import { writeFileAtomicInTargetDir } from './cloudAtomicWrite';

const log = createScopedLogger({ service: 'cloudStagingBridge' });

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface CloudStagedFile {
  id: string;
  realPath: string;
  pendingDestination: string;
  spaceName: string;
  spacePath?: string;
  location?: FileLocation;
  sessionId: string;
  baseHash: string;
  summary: string;
  stagedAt: number;
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  blockedBy?: BlockSource;
  hasConflict?: boolean;
}

interface CloudStagedFileWithLocation extends CloudStagedFile {
  spacePath: string;
  location: FileLocation;
}

// --- Debounce state ---
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSyncArgs: { client: SyncClient; coreDirectory: string } | null = null;
let syncInProgress = false;
let syncRequested = false;
let debounceStartedAt: number | null = null;
const DEBOUNCE_MS = 2_000;
const MAX_DEBOUNCE_WAIT_MS = 15_000;
let driveAwarePullCycle = 0;

/**
 * Dedup file-location warnings for the lifetime of this process.
 */
const fileLocationWarned = new Map<string, boolean>();

function warnFileLocationFallbackOnce(params: {
  pendingDestination: string;
  originalSpace: string | undefined;
  coreDirectory: string;
  reason: 'outside-workspace' | 'resolver-error';
}): void {
  const key = `${params.reason}:${params.pendingDestination}`;
  if (fileLocationWarned.get(key)) {
    return;
  }
  fileLocationWarned.set(key, true);
  log.warn(
    {
      pendingDestination: params.pendingDestination,
      originalSpace: params.originalSpace,
      coreDirectory: params.coreDirectory,
      reason: params.reason,
    },
    'Cloud staging bridge FileLocation fallback',
  );
}

export async function enrichCloudStagedRows(
  rows: readonly CloudStagedFile[],
  spaces: readonly ResolverSpaceInfo[],
  coreDirectory: string,
): Promise<CloudStagedFileWithLocation[]> {
  const enrichedRows: CloudStagedFileWithLocation[] = [];

  for (const row of rows) {
    const pendingDestination = typeof row.pendingDestination === 'string'
      ? row.pendingDestination.trim()
      : '';
    if (!pendingDestination) {
      const key = `empty-pending-destination:${row.id}`;
      if (!fileLocationWarned.get(key)) {
        fileLocationWarned.set(key, true);
        log.warn(
          {
            id: row.id,
            pendingDestination: row.pendingDestination,
          },
          'Skipping cloud staged row with empty pendingDestination',
        );
      }
      continue;
    }

    const originalSpace = row.spaceName || 'Memory';
    let location: FileLocation;
    try {
      location = await resolveFileLocation(
        pendingDestination,
        spaces,
        { coreDirectory },
      );
    } catch (error) {
      if (error instanceof FileLocationResolverError) {
        warnFileLocationFallbackOnce({
          pendingDestination,
          originalSpace,
          coreDirectory,
          reason: 'resolver-error',
        });
        continue;
      }
      throw error;
    }

    if (location.kind === 'legacy-missing-location') {
      log.error(
        {
          pendingDestination,
          originalSpace,
          coreDirectory,
          handler: 'cloudStagingBridge',
        },
        'Skipping cloud staged file row because producer returned forbidden legacy-missing-location',
      );
      continue;
    }

    if (location.kind === 'outside-workspace') {
      warnFileLocationFallbackOnce({
        pendingDestination,
        originalSpace,
        coreDirectory,
        reason: 'outside-workspace',
      });
    }

    enrichedRows.push({
      ...row,
      pendingDestination,
      spaceName: location.kind === 'in-space' ? location.spaceName : originalSpace,
      spacePath: location.kind === 'in-space' ? location.workspaceRelativePath : location.absolutePath,
      location,
    });
  }

  return enrichedRows;
}

/**
 * Tracks cloud file IDs that the bridge has pulled to desktop.
 * Key: pendingDestination (workspace-relative), Value: cloud file ID.
 * Used to resolve cloud originals when the user resolves on desktop.
 * Persisted to disk so zombie prevention survives app restart.
 */
const bridgedCloudIds = new Map<string, string>();

let persistPath: string | null = null;

async function getPersistPath(): Promise<string | null> {
  if (persistPath) return persistPath;
  try {
    const { getPlatformConfig } = await import('@core/platform');
    const config = getPlatformConfig();
    persistPath = path.join(config.userDataPath, 'cloud-staging-bridge.json');
    return persistPath;
  } catch {
    return null;
  }
}

async function loadPersistedState(): Promise<void> {
  const filePath = await getPersistPath();
  if (!filePath) return;
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data) as Record<string, string>;
    bridgedCloudIds.clear();
    for (const [dest, cloudId] of Object.entries(parsed)) {
      if (typeof dest === 'string' && typeof cloudId === 'string') {
        bridgedCloudIds.set(dest, cloudId);
      }
    }
    log.info({ count: bridgedCloudIds.size }, 'Loaded persisted staging bridge state');
  } catch {
    // First run or corrupted — start fresh
  }
}

async function persistState(): Promise<void> {
  const filePath = await getPersistPath();
  if (!filePath) return;
  try {
    const data: Record<string, string> = {};
    for (const [dest, cloudId] of bridgedCloudIds) {
      data[dest] = cloudId;
    }
    await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
  } catch (err) {
    log.warn({ err }, 'Failed to persist staging bridge state');
  }
}

export function scheduleStagingSync(client: SyncClient, coreDirectory: string): void {
  pendingSyncArgs = { client, coreDirectory };

  const now = Date.now();
  if (!debounceStartedAt) debounceStartedAt = now;

  // If we've been deferring too long, fire immediately
  if (now - debounceStartedAt >= MAX_DEBOUNCE_WAIT_MS) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    debounceStartedAt = null;
    const args = pendingSyncArgs;
    pendingSyncArgs = null;
    if (args) {
      syncCloudStagedFiles(args.client, args.coreDirectory).catch((err) => {
        log.warn({ err }, 'Max-wait staging sync failed');
      });
    }
    return;
  }

  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    debounceStartedAt = null;
    const args = pendingSyncArgs;
    pendingSyncArgs = null;
    if (args) {
      syncCloudStagedFiles(args.client, args.coreDirectory).catch((err) => {
        log.warn({ err }, 'Debounced staging sync failed');
      });
    }
  }, DEBOUNCE_MS);
}

/**
 * Clear debounce timers only. Called on disconnect/reconnect to stop pending
 * syncs, but preserves bridgedCloudIds so zombie prevention survives token
 * refreshes and reconnects.
 */
export function clearStagingSyncTimers(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  debounceStartedAt = null;
  pendingSyncArgs = null;
  syncRequested = false;
}

/**
 * Explicitly clear bridge tracking for a destination. NOT called from normal
 * deny/dismiss handlers — zombie prevention in `doSync()` handles cloud cleanup
 * and tracking removal automatically. This exists for edge-case programmatic
 * cleanup (e.g., instance switching). (FOX-2802)
 */
export async function notifyBridgeFileResolved(pendingDestination: string): Promise<void> {
  if (bridgedCloudIds.has(pendingDestination)) {
    bridgedCloudIds.delete(pendingDestination);
    log.info({ dest: pendingDestination }, 'Cleared bridged cloud ID on local resolution');
    await persistState();
  }
}

export async function syncCloudStagedFiles(
  client: SyncClient,
  coreDirectory: string,
): Promise<void> {
  if (syncInProgress) {
    syncRequested = true;
    log.debug('Staging sync already in progress, will re-sync after');
    return;
  }
  syncInProgress = true;

  try {
    await loadPersistedState();
    await doSync(client, coreDirectory);
  } finally {
    syncInProgress = false;
  }

  // Re-sync if events arrived while we were running
  if (syncRequested) {
    syncRequested = false;
    log.debug('Re-syncing after concurrent request');
    return syncCloudStagedFiles(client, coreDirectory);
  }
}

async function doSync(client: SyncClient, coreDirectory: string): Promise<void> {
  log.info('Starting cloud staging bridge sync');
  const authorityCache = createWorkspaceWriteAuthorityCache();
  const cycle = ++driveAwarePullCycle;

  let cloudFiles: CloudStagedFileWithLocation[];
  try {
    const response = await client.post(
      `/api/ipc/${encodeURIComponent('memory:staging-get-all')}`,
      {},
    ) as { files?: CloudStagedFile[] };
    const rawCloudFiles = Array.isArray(response?.files) ? response.files : [];
    const scannedSpaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
    const resolverSpaces: ResolverSpaceInfo[] = scannedSpaces.map((space) => ({
      ...space,
      status: space.status ?? 'ok',
    }));
    cloudFiles = await enrichCloudStagedRows(rawCloudFiles, resolverSpaces, coreDirectory);
  } catch (err) {
    log.warn({ err }, 'Failed to fetch cloud staged files');
    return;
  }

  const cloudByDest = new Map<string, CloudStagedFile>();
  for (const cf of cloudFiles) {
    if (cf.pendingDestination) cloudByDest.set(cf.pendingDestination, cf);
  }

  const localFiles = await listPendingFiles();

  const localByDest = new Map<string, { id: string; pendingDestination: string; baseHash: string }>();
  for (const lf of localFiles) {
    const dest = lf.frontmatter.pending_destination;
    localByDest.set(dest, { id: lf.id, pendingDestination: dest, baseHash: lf.frontmatter.base_hash });
  }

  let changed = false;
  const freshlyBridged = new Set<string>();

  // --- New on cloud, not on desktop: pull and create local .pending.md ---
  for (const [dest, cloudFile] of cloudByDest) {
    if (localByDest.has(dest)) {
      // Already exists locally — just record the cloud ID for zombie prevention
      bridgedCloudIds.set(dest, cloudFile.id);
      continue;
    }

    // Previously bridged but no longer local — user resolved/denied this file.
    // Skip re-download so zombie prevention can discard the cloud record. (FOX-2802)
    if (bridgedCloudIds.has(dest)) {
      continue;
    }

    try {
      const contentResponse = await client.post(
        `/api/ipc/${encodeURIComponent('memory:staging-get-content')}`,
        { params: [{ id: cloudFile.id }] },
      ) as { content?: string | null };

      const content = contentResponse?.content;
      if (content == null) {
        log.warn({ id: cloudFile.id, dest }, 'Cloud staged file has no content, skipping');
        continue;
      }

      const result = await writeToPending({
        destinationPath: dest,
        content,
        sessionId: cloudFile.sessionId,
        summary: cloudFile.summary,
        spaceName: cloudFile.spaceName,
        baseHash: cloudFile.baseHash,
        sharing: cloudFile.sharing,
        blockedBy: cloudFile.blockedBy,
      });

      if (result) {
        bridgedCloudIds.set(dest, cloudFile.id);
        freshlyBridged.add(dest);
        log.info({ dest, cloudId: cloudFile.id }, 'Pulled cloud staged file to local');
        changed = true;
      }
    } catch (err) {
      log.warn({ err, dest, cloudId: cloudFile.id }, 'Failed to pull cloud staged file');
    }
  }

  // --- Bridged file resolved locally but still on cloud: resolve cloud original ---
  for (const [dest, cloudId] of bridgedCloudIds) {
    if (freshlyBridged.has(dest)) continue; // just pulled this sync — not resolved
    if (localByDest.has(dest)) continue; // still pending locally
    if (!cloudByDest.has(dest)) {
      // Also gone from cloud — fully resolved, clean up tracking
      bridgedCloudIds.delete(dest);
      continue;
    }

    // Local file gone (user resolved), cloud original still exists -> clean up cloud
    try {
      await client.post(
        `/api/ipc/${encodeURIComponent('memory:staging-discard')}`,
        { params: [{ id: cloudId }] },
      );
      bridgedCloudIds.delete(dest);
      log.info({ dest, cloudId }, 'Resolved cloud original after desktop resolution');
      changed = true;
    } catch (err) {
      log.warn({ err, dest, cloudId }, 'Failed to resolve cloud original');
    }
  }

  // --- Exists locally (bridged) but not on cloud: cloud resolved it ---
  for (const [dest, localInfo] of localByDest) {
    if (cloudByDest.has(dest)) continue; // still pending on cloud
    if (!bridgedCloudIds.has(dest)) continue; // not bridge-created, skip

    // Cloud resolved this file — try to pull published content, then delete local
    try {
      await pullPublishedFileFromCloud(
        client,
        dest,
        coreDirectory,
        localInfo.baseHash,
        { authorityCache, cycle },
      );
    } catch (err) {
      log.warn({ err, dest }, 'Failed to pull published file (may have been discarded)');
    }

    // Even when pullPublishedFileFromCloud defers on Drive-authoritative
    // paths, we still clear the pending entry here. The file then flows
    // through workspace-manifest pull as a regular "new" cloud file, which
    // continues the same drive-settle deferral counter (including timeout
    // fallback) via cloudWorkspaceSync.pullChangedFiles.
    try {
      await deletePendingFile(localInfo.id);
      bridgedCloudIds.delete(dest);
      log.info({ dest, localId: localInfo.id }, 'Deleted local staged file (resolved on cloud)');
      changed = true;
    } catch (err) {
      log.warn({ err, dest }, 'Failed to delete local pending file after cloud resolution');
    }
  }

  if (changed) {
    getBroadcastService().sendToAllWindows('memory:staged-files-changed');
  }

  await persistState();

  log.info(
    { cloudCount: cloudFiles.length, localCount: localFiles.length, bridgedCount: bridgedCloudIds.size, changed },
    'Cloud staging bridge sync complete',
  );
}

async function pullPublishedFileFromCloud(
  client: SyncClient,
  pendingDestination: string,
  coreDirectory: string,
  baseHash?: string,
  options?: {
    authorityCache: ReturnType<typeof createWorkspaceWriteAuthorityCache>;
    cycle: number;
  },
): Promise<void> {
  const absolutePath = path.isAbsolute(pendingDestination)
    ? pendingDestination
    : path.join(coreDirectory, pendingDestination);

  // Path traversal guard: resolved path must stay within coreDirectory
  const resolved = path.resolve(absolutePath);
  const coreResolved = path.resolve(coreDirectory);
  if (!resolved.startsWith(coreResolved + path.sep) && resolved !== coreResolved) {
    log.warn({ dest: pendingDestination, resolved }, 'Path traversal detected, refusing to write');
    return;
  }
  const relativePath = path.isAbsolute(pendingDestination)
    ? toPortablePath(path.relative(coreResolved, resolved))
    : toPortablePath(pendingDestination);

  const writeAuthority = resolveWorkspaceWriteAuthority(path.dirname(resolved), {
    cache: options?.authorityCache,
  });
  let writeViaAtomicRename = false;
  if (writeAuthority === 'desktop_fs_authoritative') {
    const settleDecision = evaluateDriveSettleDeferral({
      coreDirectory,
      relativePath,
      localPath: resolved,
    });

    if (settleDecision.action === 'delivered') {
      log.info(
        { relPath: relativePath, deferralCount: settleDecision.deferralCount, ageMs: settleDecision.ageMs },
        'drive-settle.delivered',
      );
      return;
    }

    if (settleDecision.action === 'defer') {
      log.info(
        { relPath: relativePath, cycle: options?.cycle ?? 0, ageMs: settleDecision.ageMs },
        'Deferring cloud→desktop pull on Drive-synced workspace',
      );
      return;
    }

    log.warn(
      { relPath: relativePath, deferralCount: settleDecision.deferralCount, ageMs: settleDecision.ageMs },
      'drive-settle.timeout',
    );
    if (await fileExists(resolved)) {
      clearDriveSettleDeferral(coreDirectory, relativePath);
      log.info(
        { relPath: relativePath, cycle: options?.cycle ?? 0 },
        'drive-settle.delivered-before-force-write',
      );
      return;
    }
    writeViaAtomicRename = true;
  }

  const response = await client.post('/api/library/read', {
    path: pendingDestination,
  }) as { content?: string };

  const content = response?.content;
  if (content == null) {
    log.debug({ dest: pendingDestination }, 'Published file not found on cloud (may have been discarded)');
    return;
  }

  // Conflict check: if the local file was modified since staging, skip the write
  if (baseHash) {
    const conflict = await detectPendingConflict(baseHash, absolutePath);
    if (conflict.hasConflict) {
      log.warn(
        { dest: pendingDestination, baseHash, fileModified: conflict.fileModifiedSinceStaging, newFile: conflict.newFileConflict },
        'Staging bridge conflict: local file changed since staging, skipping published file write',
      );
      try {
        getBroadcastService().sendToAllWindows('cloud:workspace-conflicts', { paths: [pendingDestination] });
      } catch (err) {
        log.warn({ err }, 'Failed to broadcast staging conflict');
      }
      return;
    }
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  if (writeViaAtomicRename && await fileExists(absolutePath)) {
    clearDriveSettleDeferral(coreDirectory, relativePath);
    log.info(
      { relPath: relativePath, cycle: options?.cycle ?? 0 },
      'drive-settle.delivered-before-atomic-write',
    );
    return;
  }

  if (writeViaAtomicRename) {
    try {
      await writeFileAtomicInTargetDir(absolutePath, content, 'utf8');
    } catch (err) {
      log.warn(
        { dest: pendingDestination, err: err instanceof Error ? err.message : String(err) },
        'Atomic published-file pull write failed',
      );
      throw err;
    }
    log.info({ dest: pendingDestination }, 'Pulled published file via atomic rename');
  } else {
    await fs.writeFile(absolutePath, content, 'utf-8');
  }

  const stat = await fs.stat(absolutePath);
  cloudWorkspaceSync.recordPulledFile(relativePath, {
    mtime: stat.mtimeMs,
    size: stat.size,
    hash: hashContent(content),
  });
  clearDriveSettleDeferral(coreDirectory, relativePath);

  log.info({ dest: pendingDestination }, 'Pulled published file from cloud');
}

// Exported for testing
export { bridgedCloudIds as _bridgedCloudIdsForTesting };

export function _resetForTesting(testPersistPath?: string | null): void {
  persistPath = testPersistPath ?? null;
  syncInProgress = false;
  syncRequested = false;
  driveAwarePullCycle = 0;
  fileLocationWarned.clear();
  debounceStartedAt = null;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingSyncArgs = null;
  bridgedCloudIds.clear();
  _resetDriveSettleDeferralsForTesting();
}
