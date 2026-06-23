import fs from 'node:fs';
import path from 'node:path';
import { getDataPath } from '@main/utils/dataPaths';
import { toPortablePath } from '@core/utils/portablePath';
import { createScopedLogger } from '@core/logger';
import { writeFileAtomicInTargetDirSync } from './cloudAtomicWrite';

const log = createScopedLogger({ service: 'cloudPendingUpdateStore' });

export interface PendingCloudUpdate {
  relativePath: string;
  cloudHash: string;
  baselineLocalHash: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface PersistedPendingCloudUpdate extends PendingCloudUpdate {
  coreDirectory: string;
}

const CASE_INSENSITIVE_PLATFORMS = new Set(['darwin', 'win32']);
const pendingCloudUpdates = new Map<string, PersistedPendingCloudUpdate>();
let loaded = false;
let persistPathOverride: string | null = null;

function normalizePathForKey(inputPath: string): string {
  const portable = toPortablePath(path.resolve(inputPath)).normalize('NFC');
  return CASE_INSENSITIVE_PLATFORMS.has(process.platform) ? portable.toLowerCase() : portable;
}

function normalizeRelativePath(inputPath: string): string {
  const portable = toPortablePath(inputPath).normalize('NFC').replace(/^\/+/, '');
  return CASE_INSENSITIVE_PLATFORMS.has(process.platform) ? portable.toLowerCase() : portable;
}

function buildKey(coreDirectory: string, relativePath: string): string {
  return `${normalizePathForKey(coreDirectory)}::${normalizeRelativePath(relativePath)}`;
}

function getStorePath(): string {
  return persistPathOverride ?? path.join(getDataPath(), 'cloud-pending-updates.json');
}

function load(): void {
  if (loaded) return;
  loaded = true;

  const storePath = getStorePath();
  try {
    if (!fs.existsSync(storePath)) return;
    const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) {
      // Clear-on-corrupt is safe HERE: a pending-cloud-update record self-heals
      // from the next manifest fetch (the convergence sweep re-records any
      // still-divergent cloud-newer file). But the corruption must be
      // observable per AGENTS.md silent-failure rule.
      log.warn({ storePath }, 'Pending-cloud-update store is not a JSON array; clearing (self-heals from next manifest fetch)');
      pendingCloudUpdates.clear();
      return;
    }

    pendingCloudUpdates.clear();
    for (const entry of parsed) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as PersistedPendingCloudUpdate).coreDirectory !== 'string' ||
        typeof (entry as PersistedPendingCloudUpdate).relativePath !== 'string' ||
        typeof (entry as PersistedPendingCloudUpdate).cloudHash !== 'string' ||
        typeof (entry as PersistedPendingCloudUpdate).baselineLocalHash !== 'string' ||
        typeof (entry as PersistedPendingCloudUpdate).firstSeenAt !== 'number' ||
        typeof (entry as PersistedPendingCloudUpdate).lastSeenAt !== 'number'
      ) {
        continue;
      }
      const persisted = entry as PersistedPendingCloudUpdate;
      pendingCloudUpdates.set(buildKey(persisted.coreDirectory, persisted.relativePath), persisted);
    }
  } catch (err) {
    // Parse/read failure: clear (self-heals from next manifest fetch) but log it.
    log.warn(
      { storePath, err: err instanceof Error ? err.message : String(err) },
      'Failed to load pending-cloud-update store; clearing (self-heals from next manifest fetch)',
    );
    pendingCloudUpdates.clear();
  }
}

function persist(): void {
  const storePath = getStorePath();
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  // Atomic write (temp-then-rename in the same dir): a crash mid-write must not
  // leave a torn JSON file that load() would discard. userData is intra-volume.
  writeFileAtomicInTargetDirSync(storePath, JSON.stringify(Array.from(pendingCloudUpdates.values()), null, 2));
}

export function recordPendingCloudUpdate(params: {
  coreDirectory: string;
  relativePath: string;
  cloudHash: string;
  baselineLocalHash: string;
  nowMs?: number;
}): PendingCloudUpdate {
  load();
  const nowMs = params.nowMs ?? Date.now();
  const key = buildKey(params.coreDirectory, params.relativePath);
  const existing = pendingCloudUpdates.get(key);
  const entry: PersistedPendingCloudUpdate = {
    coreDirectory: path.resolve(params.coreDirectory),
    relativePath: toPortablePath(params.relativePath),
    cloudHash: params.cloudHash,
    baselineLocalHash: params.baselineLocalHash,
    firstSeenAt: existing?.firstSeenAt ?? nowMs,
    lastSeenAt: nowMs,
  };
  pendingCloudUpdates.set(key, entry);
  persist();
  const { coreDirectory: _coreDirectory, ...publicEntry } = entry;
  return publicEntry;
}

/**
 * Look up the single pending-cloud-update record for one path (or `null`).
 *
 * Lets the sync engine ask "do I already have a surfaced pending update for
 * this path, and does it already cover the current cloud hash?" so it can
 * compress repeat cycles instead of clear+re-record (which re-broadcasts and
 * resets `firstSeenAt`). See Stage 1 of
 * docs/plans/260622_conflict-dialog-false-positives/PLAN.md.
 */
export function getPendingCloudUpdate(
  coreDirectory: string,
  relativePath: string,
): PendingCloudUpdate | null {
  load();
  const existing = pendingCloudUpdates.get(buildKey(coreDirectory, relativePath));
  if (!existing) return null;
  const { coreDirectory: _coreDirectory, ...publicEntry } = existing;
  return publicEntry;
}

/**
 * Refresh an EXISTING pending record's `cloudHash` (and bump `lastSeenAt`)
 * IN PLACE, keeping `firstSeenAt` and `baselineLocalHash` stable. Returns the
 * updated record, or `null` when no record exists for the path (callers must
 * fall back to {@link recordPendingCloudUpdate} for a fresh record).
 *
 * Used by the convergence sweep when a still-divergent cloud file changes to a
 * NEW cloud hash while the local file still equals the recorded baseline: the
 * pending update was already surfaced, so we update the tracked cloud hash
 * rather than clearing + re-recording it (which would re-toast/re-broadcast and
 * reset the age). Data-loss guard: the baseline is never advanced here — the
 * apply path still re-reads the cloud bytes and re-checks the local baseline
 * before writing.
 */
export function updatePendingCloudUpdateCloudHash(params: {
  coreDirectory: string;
  relativePath: string;
  cloudHash: string;
  nowMs?: number;
}): PendingCloudUpdate | null {
  load();
  const key = buildKey(params.coreDirectory, params.relativePath);
  const existing = pendingCloudUpdates.get(key);
  if (!existing) return null;
  const nowMs = params.nowMs ?? Date.now();
  const entry: PersistedPendingCloudUpdate = {
    ...existing,
    cloudHash: params.cloudHash,
    lastSeenAt: nowMs,
  };
  pendingCloudUpdates.set(key, entry);
  persist();
  const { coreDirectory: _coreDirectory, ...publicEntry } = entry;
  return publicEntry;
}

export function clearPendingCloudUpdate(coreDirectory: string, relativePath: string): boolean {
  load();
  const deleted = pendingCloudUpdates.delete(buildKey(coreDirectory, relativePath));
  if (deleted) persist();
  return deleted;
}

export function getPendingCloudUpdates(coreDirectory: string): PendingCloudUpdate[] {
  load();
  const workspacePrefix = `${normalizePathForKey(coreDirectory)}::`;
  return Array.from(pendingCloudUpdates.entries())
    .filter(([key]) => key.startsWith(workspacePrefix))
    .map(([, entry]) => {
      const { coreDirectory: _coreDirectory, ...publicEntry } = entry;
      return publicEntry;
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function _resetPendingCloudUpdatesForTesting(testPersistPath?: string | null): void {
  pendingCloudUpdates.clear();
  loaded = false;
  persistPathOverride = testPersistPath ?? null;
}
