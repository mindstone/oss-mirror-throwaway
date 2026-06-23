/**
 * Space Maintenance Retry State
 *
 * Persists per-conflict retry backoff + circuit-breaker state for the daily
 * `.conflict-cloud` merge pipeline (Stage 2). Stored alongside the journal
 * in userData as `space-maintenance-retry-state.json`.
 *
 * Entries are keyed on `(conflictPath, conflictHash)`. When `cloudWorkspaceSync`
 * replaces a conflict file's bytes, the `conflictHash` changes and the old
 * entry becomes stale — it is auto-expired on the next load so a file stuck
 * in `needs-review` is NOT wedged forever when the upstream content updates.
 *
 * Safety contract mirrors the Stage 1 journal:
 *   - Atomic writes via tmp + rename.
 *   - Unknown `schemaVersion` -> safe-skip: the file is left untouched and
 *     an empty in-memory state is returned with `mutable: false`. Callers
 *     MUST honour `mutable` by skipping saves.
 *   - Corrupt JSON / missing file -> fresh empty state, `mutable: true`.
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 2, Principle #5)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'spaceMaintenanceRetryState' });

export const RETRY_STATE_SCHEMA_VERSION = 1 as const;
export const RETRY_STATE_FILE_NAME = 'space-maintenance-retry-state.json';

/**
 * Exponential backoff schedule for proposeMerge failures.
 * Index 0 -> next eligible in 1 day (first retry after first failure),
 * Index 1 -> 3 days, Index 2 -> 7 days. Circuit-break at 3 failures.
 */
export const RETRY_BACKOFF_MS = [
  24 * 60 * 60 * 1000, // 1 day
  3 * 24 * 60 * 60 * 1000, // 3 days
  7 * 24 * 60 * 60 * 1000, // 7 days
] as const;

/** After this many consecutive failures the entry transitions to `'needs-review'`. */
export const RETRY_CIRCUIT_BREAKER_THRESHOLD = 3;

export type RetryStatus = 'retry' | 'needs-review';

export interface ConflictRetryEntry {
  /** Absolute path to the conflict file (identity key, paired with hash). */
  conflictPath: string;
  /**
   * sha256 hex of the conflict file at the time of the last attempt.
   * Used as the secondary identity key so a replaced conflict file starts
   * a fresh retry cycle (auto-expire on hash mismatch).
   */
  conflictHash: string;
  /** Number of consecutive proposeMerge failures for this (path, hash). */
  attempts: number;
  /** Epoch ms of the most recent attempt. */
  lastAttemptAt: number;
  /** Epoch ms of the earliest time this entry is eligible for retry. */
  nextEligibleAt: number;
  /** Last error message captured (truncated to a reasonable size). */
  lastError: string | null;
  /** `'retry'` while still eligible; `'needs-review'` after circuit-break. */
  status: RetryStatus;
}

export interface RetryState {
  schemaVersion: typeof RETRY_STATE_SCHEMA_VERSION;
  updatedAt: number;
  entries: ConflictRetryEntry[];
}

export interface RetryStateLoadResult {
  state: RetryState;
  mutable: boolean;
}

export function createEmptyRetryState(): RetryState {
  return {
    schemaVersion: RETRY_STATE_SCHEMA_VERSION,
    updatedAt: Date.now(),
    entries: [],
  };
}

function isValidEntry(value: unknown): value is ConflictRetryEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.conflictPath === 'string' &&
    typeof e.conflictHash === 'string' &&
    typeof e.attempts === 'number' &&
    typeof e.lastAttemptAt === 'number' &&
    typeof e.nextEligibleAt === 'number' &&
    (e.lastError === null || typeof e.lastError === 'string') &&
    (e.status === 'retry' || e.status === 'needs-review')
  );
}

export interface RetryStateFs {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
}

const defaultFs: RetryStateFs = {
  readFile: (p) => fs.readFile(p, 'utf8'),
  writeFile: (p, d) => fs.writeFile(p, d, 'utf8'),
  mkdir: (p, opts) => fs.mkdir(p, opts).then(() => undefined),
  rename: (from, to) => fs.rename(from, to),
  unlink: (p) => fs.unlink(p),
};

export class SpaceMaintenanceRetryStore {
  private readonly filePath: string;
  private readonly fsOps: RetryStateFs;

  constructor(userDataDir: string, fsOps: RetryStateFs = defaultFs) {
    this.filePath = path.join(userDataDir, RETRY_STATE_FILE_NAME);
    this.fsOps = fsOps;
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<RetryStateLoadResult> {
    let raw: string;
    try {
      raw = await this.fsOps.readFile(this.filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn({ err: toErrMessage(err), path: this.filePath }, 'Failed to read retry-state file');
      }
      return { state: createEmptyRetryState(), mutable: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn(
        { err: toErrMessage(err), path: this.filePath },
        'Retry-state file is not valid JSON; starting fresh',
      );
      return { state: createEmptyRetryState(), mutable: true };
    }

    if (!parsed || typeof parsed !== 'object') {
      log.warn({ path: this.filePath }, 'Retry-state root is not an object; starting fresh');
      return { state: createEmptyRetryState(), mutable: true };
    }

    const candidate = parsed as Record<string, unknown>;
    if (candidate.schemaVersion !== RETRY_STATE_SCHEMA_VERSION) {
      log.warn(
        {
          path: this.filePath,
          foundVersion: candidate.schemaVersion,
          expectedVersion: RETRY_STATE_SCHEMA_VERSION,
        },
        'Retry-state schemaVersion mismatch; skipping (mutable=false)',
      );
      return { state: createEmptyRetryState(), mutable: false };
    }

    const rawEntries = Array.isArray(candidate.entries) ? candidate.entries : [];
    const entries = rawEntries.filter(isValidEntry);
    if (entries.length !== rawEntries.length) {
      log.warn(
        { dropped: rawEntries.length - entries.length, kept: entries.length },
        'Retry-state had malformed entries; dropping them',
      );
    }

    return {
      state: {
        schemaVersion: RETRY_STATE_SCHEMA_VERSION,
        updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
        entries,
      },
      mutable: true,
    };
  }

  async save(state: RetryState): Promise<void> {
    const payload: RetryState = {
      schemaVersion: RETRY_STATE_SCHEMA_VERSION,
      updatedAt: Date.now(),
      entries: state.entries,
    };

    await this.fsOps.mkdir(path.dirname(this.filePath), { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    try {
      await this.fsOps.writeFile(tmpPath, JSON.stringify(payload, null, 2));
      await this.fsOps.rename(tmpPath, this.filePath);
    } catch (err) {
      try { await this.fsOps.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}

/**
 * Look up a retry entry by conflict path. Returns `null` when no entry
 * exists or when the stored `conflictHash` no longer matches the current
 * file hash (stale-entry auto-expire).
 *
 * Callers should pass the freshly computed hash of the on-disk conflict
 * file. When this returns `null`, it's safe to proceed with a new attempt.
 */
export function findEligibleEntry(
  entries: ConflictRetryEntry[],
  conflictPath: string,
  currentConflictHash: string,
): ConflictRetryEntry | null {
  for (const entry of entries) {
    if (entry.conflictPath !== conflictPath) continue;
    if (entry.conflictHash !== currentConflictHash) {
      // Stale entry — upstream file was replaced. Caller should drop it
      // (pruneStaleEntries below) and treat this run as a fresh attempt.
      return null;
    }
    return entry;
  }
  return null;
}

/**
 * Remove entries whose `conflictHash` no longer matches the current hash.
 * Called after the merge pass so a replaced conflict file gets a fresh
 * retry cycle on the next run.
 */
export function pruneStaleEntries(
  entries: ConflictRetryEntry[],
  currentHashesByPath: Map<string, string | null>,
): { kept: ConflictRetryEntry[]; droppedStale: number } {
  let dropped = 0;
  const kept = entries.filter((entry) => {
    const current = currentHashesByPath.get(entry.conflictPath);
    // If we didn't scan the path this run, preserve the entry (orphan-safe).
    if (current === undefined) return true;
    // If the file is gone, drop the entry (no conflict to retry).
    if (current === null) {
      dropped++;
      return false;
    }
    if (current !== entry.conflictHash) {
      dropped++;
      return false;
    }
    return true;
  });
  return { kept, droppedStale: dropped };
}

/**
 * Record a failed attempt. Returns the updated entry (caller merges into
 * state.entries). Handles both the first-failure case (no prior entry)
 * and subsequent failures (exponential backoff + circuit-break at 3).
 *
 * Retry schedule:
 *   attempts=1 (first failure) -> nextEligibleAt = now + 1d, status='retry'
 *   attempts=2                  -> nextEligibleAt = now + 3d, status='retry'
 *   attempts=3                  -> status='needs-review' (circuit-break)
 */
export function recordFailure(
  prior: ConflictRetryEntry | null,
  conflictPath: string,
  conflictHash: string,
  error: string,
  nowMs: number,
): ConflictRetryEntry {
  const attempts = (prior?.attempts ?? 0) + 1;
  const truncatedError = error.length > 500 ? `${error.slice(0, 500)}...` : error;

  if (attempts >= RETRY_CIRCUIT_BREAKER_THRESHOLD) {
    return {
      conflictPath,
      conflictHash,
      attempts,
      lastAttemptAt: nowMs,
      // nextEligibleAt irrelevant once we're in needs-review; set to a large
      // sentinel so an accidental path that skips the status check still
      // treats the entry as ineligible.
      nextEligibleAt: nowMs + RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1],
      lastError: truncatedError,
      status: 'needs-review',
    };
  }

  const backoffIndex = Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1);
  return {
    conflictPath,
    conflictHash,
    attempts,
    lastAttemptAt: nowMs,
    nextEligibleAt: nowMs + RETRY_BACKOFF_MS[backoffIndex],
    lastError: truncatedError,
    status: 'retry',
  };
}

/**
 * Merge an updated entry into the state.entries list, replacing any
 * existing entry with the same `conflictPath`. Used after recordFailure()
 * or when dropping an entry on successful merge.
 */
export function upsertEntry(
  entries: ConflictRetryEntry[],
  updated: ConflictRetryEntry,
): ConflictRetryEntry[] {
  const filtered = entries.filter((e) => e.conflictPath !== updated.conflictPath);
  return [...filtered, updated];
}

export function removeEntry(
  entries: ConflictRetryEntry[],
  conflictPath: string,
): ConflictRetryEntry[] {
  return entries.filter((e) => e.conflictPath !== conflictPath);
}

/**
 * Flip every `needs-review` entry back to `retry` with fresh counters.
 * Used by the manual `space-maintenance:reset-needs-review` IPC — lets a
 * user unstick merges that got circuit-broken during a multi-day BTS
 * outage without having to re-edit each conflict file to bump its hash
 * (which is the only automatic auto-expire path).
 *
 * Returns the new entry list AND the number of entries that were flipped,
 * so callers (the IPC handler) can surface the count to the UI.
 */
export function resetNeedsReview(
  entries: ConflictRetryEntry[],
): { entries: ConflictRetryEntry[]; resetCount: number } {
  let resetCount = 0;
  const next = entries.map((e) => {
    if (e.status !== 'needs-review') return e;
    resetCount++;
    return {
      ...e,
      attempts: 0,
      lastAttemptAt: 0,
      nextEligibleAt: 0,
      lastError: null,
      status: 'retry' as const,
    };
  });
  return { entries: next, resetCount };
}

function toErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
