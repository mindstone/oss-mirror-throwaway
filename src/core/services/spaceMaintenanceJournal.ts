/**
 * Space Maintenance Journal
 *
 * Durable crash-consistency record for the space-maintenance pipeline.
 * Persisted as `<userData>/space-maintenance-journal.json` with `schemaVersion: 1`.
 *
 * Two entry shapes are recognised:
 *   - `orphan-candidate`: tracks `.conflict-cloud` files whose base has gone
 *      missing. Stage 1 uses these to drive the sync-stability gate (require
 *      3 consecutive scans over >= 48h before an orphan is quarantine-eligible).
 *   - `rename-pending`  : reserved for Stage 2's atomic merge sequence. Stage 1
 *      never writes these; it only preserves them round-trip so a Stage-2
 *      resume-on-startup path will still find them.
 *
 * Safety contract:
 *   - Atomic writes via `tmp + rename`. Readers always see a complete file
 *     or the previous complete version — never a half-written artifact.
 *   - Unknown `schemaVersion` -> safe-skip: the file is left untouched and
 *     an empty in-memory state is returned. Never rewrite a future-schema
 *     file (that would destroy forward-compat data).
 *   - Corrupt JSON or missing file -> return an empty fresh state. The next
 *     `save()` call will create a clean replacement.
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 1)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'spaceMaintenanceJournal' });

/**
 * Current journal schema version.
 *
 *   v1 (Stage 1): `rename-pending` entries carried only `expectedHash`
 *     (the merged tmp's hash). A crash between tmp-write and rename could
 *     leave a stale tmp that, on resume, the process would blindly promote
 *     to the original slot — clobbering any writer that touched the
 *     original in the interim.
 *
 *   v2 (Stage 2 refinement, S2-F1): `rename-pending` now carries three
 *     hashes:
 *       - `mergedHash`            (was `expectedHash`; the tmp's hash)
 *       - `scanTimeOriginalHash`  (required; guards data-loss on resume)
 *       - `scanTimeConflictHash`  (required; guards stale-quarantine)
 *     The v1→v2 migration drops any in-flight `rename-pending` entries
 *     (they're crash-recovery markers — safely discarded; the next daily
 *     run re-classifies and re-merges from scratch).
 *
 * Unknown versions (including future v3+) still trigger safe-skip.
 */
export const JOURNAL_SCHEMA_VERSION = 2 as const;
const JOURNAL_FILE_NAME = 'space-maintenance-journal.json';

/**
 * Tracks orphan `.conflict-cloud` files across scans so the sync-stability
 * gate can distinguish "sync just hasn't pulled the base file yet" from
 * "the base really is gone". See plan §Stage 1 sync-stability gate (F4).
 */
export interface OrphanCandidateEntry {
  type: 'orphan-candidate';
  /** Absolute path to the conflict file (identity key). */
  conflictPath: string;
  /** Epoch ms of the first scan that saw this orphan. */
  firstSeenAt: number;
  /** How many consecutive scans have observed this orphan without the base reappearing. */
  stableScanCount: number;
  /** Epoch ms of the most recent scan that confirmed this orphan. */
  lastSeenAt: number;
}

/**
 * In-flight marker for Stage 2's atomic merge sequence (rename tmp ->
 * original, then quarantine conflict). All three hashes are REQUIRED in
 * schemaVersion 2 so the resume path can:
 *   - detect a post-crash write to the original (prevents data-loss
 *     clobber on resume — see S2-F1 / `scanTimeOriginalHash`).
 *   - detect a post-crash replacement of the conflict file (prevents
 *     quarantining bytes that a later writer dropped in — see
 *     `scanTimeConflictHash`).
 */
export interface RenamePendingEntry {
  type: 'rename-pending';
  conflictPath: string;
  originalPath: string;
  /**
   * sha256 hex of the merged tmp file (bytes we intended to rename into
   * the original slot). Renamed from `expectedHash` in v2 for clarity.
   */
  mergedHash: string;
  /**
   * sha256 hex of the ORIGINAL file at scan time — BEFORE any merge
   * work began. On resume, the original MUST still hash to this value;
   * otherwise a writer (user edit, cloudWorkspaceSync) raced us and
   * completing the rename would destroy their bytes.
   */
  scanTimeOriginalHash: string;
  /**
   * sha256 hex of the CONFLICT file at scan time. On resume, before
   * quarantining the conflict copy, it must still hash to this value;
   * otherwise cloudWorkspaceSync has replaced the file with a new
   * divergent version and we must drop the stale entry (the next scan
   * will reclassify the new bytes).
   */
  scanTimeConflictHash: string;
  /** Which step of the atomic sequence was last recorded. */
  stage: 'rename-pending' | 'quarantine-pending';
  startedAt: number;
}

/**
 * Written immediately before the `moveToTrash` call in `runStartupCleanup`
 * (and the Stage-2 daily merge quarantine step). Captures the expected
 * hash so that a crash between "entry written" and "entry cleared" can
 * be safely resumed on the next startup:
 *   - file gone  -> quarantine succeeded; drop the entry.
 *   - file present and hash matches -> retry the quarantine.
 *   - file present and hash differs -> the writer (e.g. cloudWorkspaceSync)
 *     replaced it mid-flight; drop the entry and leave the file alone —
 *     the next scan will reclassify.
 *
 * Stage 1 writes these for identical-quarantine operations. Stage 2 will
 * also use this variant for post-merge conflict quarantine.
 */
export interface QuarantinePendingEntry {
  type: 'quarantine-pending';
  /** Absolute path to the conflict file about to be trashed (identity key). */
  conflictPath: string;
  /** sha256 hex hash of the conflict file recorded before `moveToTrash`. */
  expectedHash: string;
  /** Epoch ms of the write that created this entry. */
  attemptedAt: number;
}

/**
 * Stage 4: a numbered-copy conflict (e.g. `File (1).md`) whose base file
 * is missing on disk. Tracks the sync-stability gate counter so a missing
 * base doesn't trigger a pending-user-review surface until the cloud
 * provider has had ample time to materialise the base. NEVER
 * auto-quarantined, NEVER auto-renamed — the gate only flips the health
 * surface from `pendingSyncStability` to `pendingUserReview` when
 * `stableScanCount >= ORPHAN_STABILITY_MIN_SCANS` AND age >=
 * `ORPHAN_STABILITY_MIN_AGE_MS` (same thresholds as the Stage 1 orphan
 * path). Kept as a distinct variant so counts per provider stay clean.
 */
export interface NumberedCopyOrphanEntry {
  type: 'numbered-copy-orphan';
  /** Absolute path to the numbered-copy file (identity key). */
  conflictPath: string;
  firstSeenAt: number;
  stableScanCount: number;
  lastSeenAt: number;
}

/**
 * Stage 4: a numbered-copy conflict whose mtime is older than
 * `LEGACY_DUPLICATE_THRESHOLD_MS`. Classified once and persisted so the
 * next run doesn't re-stat + re-classify; surfaced in the health check as
 * a `legacyDuplicates` count awaiting a future bulk-dismiss UI.
 */
export interface LegacyDuplicateEntry {
  type: 'legacy-duplicate';
  /** Absolute path to the legacy numbered-copy file (identity key). */
  conflictPath: string;
  /** Epoch ms of the file's mtime at classification time. */
  fileMtimeMs: number;
  /** Epoch ms of the scan that classified this entry. */
  classifiedAt: number;
}

/**
 * Stage 4: recent-resolution log entry. One entry per successful
 * resolution (identical quarantine, merge, numbered-copy quarantine,
 * numbered-copy merge). Used by the health check to surface
 * `resolvedLast24h`. Pruned to a 24h sliding window on every journal
 * save so the file size stays bounded even for users with large
 * initial quarantine sweeps.
 */
export interface ResolutionLogEntry {
  type: 'resolution-log';
  /** Epoch ms at which the resolution completed. */
  resolvedAt: number;
  /** Kind of resolution — informational, not load-bearing. */
  kind:
    | 'conflict-cloud-identical'
    | 'conflict-cloud-merged'
    | 'numbered-copy-identical'
    | 'numbered-copy-merged';
}

/**
 * Stage 4: singleton monotonic counter of total resolutions observed by
 * this install. Separate from `resolution-log` because the log is
 * 24h-pruned; `total` must survive indefinitely to power the health
 * check's `resolvedTotal` surface.
 */
export interface ResolutionCounterEntry {
  type: 'resolution-counter';
  /** Total number of resolutions ever recorded on this install. */
  total: number;
  /** Epoch ms of the most recent increment. */
  updatedAt: number;
}

/**
 * REBEL-62A one-off cleanup: in-flight marker for the IN-WORKSPACE move of an
 * identical conflict copy into `.rebel/conflicts-cleanup/<date>/`.
 *
 * DISTINCT from `quarantine-pending` BY CONSTRUCTION (different `type`): the
 * daily/startup crash-recovery (`resumePendingQuarantine`) resumes a
 * `quarantine-pending` by calling `moveToTrash` — which would OS-TRASH the
 * source, violating the cleanup contract's "never OS-trash, only move-to-folder"
 * (Safety Contract §3). This entry is resumed by `resumeCleanupMovePending`,
 * which only ever completes the SAME in-workspace move (never trashes, never
 * unlinks). A crash mid-move therefore recovers to a quarantined file, never a
 * trashed one.
 *
 * Records both source and destination so the resume can complete the move
 * without re-deriving the destination (which depends on the run's date dir).
 */
export interface CleanupMovePendingEntry {
  type: 'cleanup-move-pending';
  /** Absolute path of the conflict copy being moved (identity key). */
  conflictPath: string;
  /** Absolute path of the in-workspace quarantine destination. */
  destPath: string;
  /** sha256 hex of the conflict copy recorded before the move. */
  expectedHash: string;
  /** Epoch ms of the write that created this entry. */
  attemptedAt: number;
}

export type JournalEntry =
  | OrphanCandidateEntry
  | RenamePendingEntry
  | QuarantinePendingEntry
  | CleanupMovePendingEntry
  | NumberedCopyOrphanEntry
  | LegacyDuplicateEntry
  | ResolutionLogEntry
  | ResolutionCounterEntry;

/**
 * Sliding window used by `save()` to prune resolution-log entries.
 * Exported so the health check can use the same constant without
 * re-declaring it.
 */
export const RESOLUTION_LOG_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface JournalState {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  updatedAt: number;
  entries: JournalEntry[];
}

export function createEmptyJournalState(): JournalState {
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    // Stage 4: use a sentinel 0 so health-check consumers can distinguish
    // "no daily run has ever completed" from "just loaded a missing file".
    // A `save()` call will overwrite with the real epoch ms on first run.
    updatedAt: 0,
    entries: [],
  };
}

/**
 * Return value from `SpaceMaintenanceJournal.load()`. The `mutable` flag
 * tells the caller whether it is safe to `save()` — it is `false` when the
 * on-disk file had an unknown `schemaVersion` (forward-compat safe-skip:
 * overwriting would destroy data a future version wrote).
 *
 * Callers MUST check `mutable` and skip `save()` when it's `false`.
 */
export interface JournalLoadResult {
  state: JournalState;
  mutable: boolean;
}

/** Returns `true` when the entry shape matches a known, well-formed variant. */
function isValidEntry(value: unknown): value is JournalEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  if (e.type === 'orphan-candidate') {
    return typeof e.conflictPath === 'string'
      && typeof e.firstSeenAt === 'number'
      && typeof e.stableScanCount === 'number'
      && typeof e.lastSeenAt === 'number';
  }
  if (e.type === 'rename-pending') {
    return typeof e.conflictPath === 'string'
      && typeof e.originalPath === 'string'
      && typeof e.mergedHash === 'string'
      && typeof e.scanTimeOriginalHash === 'string'
      && typeof e.scanTimeConflictHash === 'string'
      && (e.stage === 'rename-pending' || e.stage === 'quarantine-pending')
      && typeof e.startedAt === 'number';
  }
  if (e.type === 'quarantine-pending') {
    return typeof e.conflictPath === 'string'
      && typeof e.expectedHash === 'string'
      && typeof e.attemptedAt === 'number';
  }
  if (e.type === 'cleanup-move-pending') {
    return typeof e.conflictPath === 'string'
      && typeof e.destPath === 'string'
      && typeof e.expectedHash === 'string'
      && typeof e.attemptedAt === 'number';
  }
  if (e.type === 'numbered-copy-orphan') {
    return typeof e.conflictPath === 'string'
      && typeof e.firstSeenAt === 'number'
      && typeof e.stableScanCount === 'number'
      && typeof e.lastSeenAt === 'number';
  }
  if (e.type === 'legacy-duplicate') {
    return typeof e.conflictPath === 'string'
      && typeof e.fileMtimeMs === 'number'
      && typeof e.classifiedAt === 'number';
  }
  if (e.type === 'resolution-log') {
    return typeof e.resolvedAt === 'number'
      && (
        e.kind === 'conflict-cloud-identical'
        || e.kind === 'conflict-cloud-merged'
        || e.kind === 'numbered-copy-identical'
        || e.kind === 'numbered-copy-merged'
      );
  }
  if (e.type === 'resolution-counter') {
    return typeof e.total === 'number'
      && typeof e.updatedAt === 'number';
  }
  return false;
}

/**
 * Platform-agnostic filesystem capabilities the journal needs.
 * Declared explicitly so tests can mock without stubbing `node:fs/promises`.
 */
export interface JournalFs {
  readFile: (p: string) => Promise<string>;
  writeFile: (p: string, data: string) => Promise<void>;
  mkdir: (p: string, opts?: { recursive?: boolean }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (p: string) => Promise<void>;
}

const defaultFs: JournalFs = {
  readFile: (p) => fs.readFile(p, 'utf8'),
  writeFile: (p, d) => fs.writeFile(p, d, 'utf8'),
  mkdir: (p, opts) => fs.mkdir(p, opts).then(() => undefined),
  rename: (from, to) => fs.rename(from, to),
  unlink: (p) => fs.unlink(p),
};

export class SpaceMaintenanceJournal {
  private readonly filePath: string;
  private readonly fsOps: JournalFs;

  /**
   * @param userDataDir  Directory where the journal file lives. Caller is
   *                     responsible for choosing a surface-appropriate
   *                     location (typically `getPlatformConfig().userDataPath`).
   * @param fsOps        Optional filesystem overrides — primarily for tests.
   */
  constructor(userDataDir: string, fsOps: JournalFs = defaultFs) {
    this.filePath = path.join(userDataDir, JOURNAL_FILE_NAME);
    this.fsOps = fsOps;
  }

  getFilePath(): string {
    return this.filePath;
  }

  /**
   * Load the journal. Never throws — returns a fresh empty state on:
   *   - missing file (ENOENT)
   *   - malformed JSON
   *   - unknown `schemaVersion` (safe-skip contract; returns empty state AND
   *     leaves the on-disk file untouched so a future version can still read it)
   *
   * The returned `mutable` flag tells the caller whether it is safe to
   * `save()`. It's `false` ONLY when the on-disk file had an unknown
   * `schemaVersion` — overwriting in that case would destroy data a future
   * version wrote. Callers MUST honour `mutable: false` by skipping saves.
   */
  async load(): Promise<JournalLoadResult> {
    let raw: string;
    try {
      raw = await this.fsOps.readFile(this.filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        log.warn({ err: toErrMessage(err), path: this.filePath }, 'Failed to read journal file');
      }
      return { state: createEmptyJournalState(), mutable: true };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log.warn({ err: toErrMessage(err), path: this.filePath }, 'Journal file is not valid JSON; starting fresh');
      return { state: createEmptyJournalState(), mutable: true };
    }

    if (!parsed || typeof parsed !== 'object') {
      log.warn({ path: this.filePath }, 'Journal root is not an object; starting fresh');
      return { state: createEmptyJournalState(), mutable: true };
    }

    const candidate = parsed as Record<string, unknown>;

    // v1 -> v2 migration: rename-pending in v1 lacked the scan-time
    // original/conflict hashes that v2 requires to safely resume a merge.
    // Those entries are pure crash-recovery markers, so dropping them is
    // safe: the next daily run re-classifies + re-merges with fresh
    // baselines. orphan-candidate and quarantine-pending entries carry
    // over unchanged (their schema didn't change).
    if (candidate.schemaVersion === 1) {
      const rawEntries = Array.isArray(candidate.entries) ? candidate.entries : [];
      const carried: JournalEntry[] = [];
      let droppedRenamePending = 0;
      for (const raw of rawEntries) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        if (r.type === 'rename-pending') {
          droppedRenamePending++;
          continue;
        }
        if (isValidEntry(r)) carried.push(r);
      }
      log.info(
        { path: this.filePath, droppedRenamePending, carried: carried.length },
        'Migrated journal v1 -> v2 (dropped rename-pending; re-merge on next daily)',
      );
      return {
        state: {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
          entries: carried,
        },
        mutable: true,
      };
    }

    if (candidate.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
      // Safe-skip on unknown versions — do NOT overwrite forward-compat data.
      log.warn(
        { path: this.filePath, foundVersion: candidate.schemaVersion, expectedVersion: JOURNAL_SCHEMA_VERSION },
        'Journal schemaVersion mismatch; skipping (mutable=false)',
      );
      return { state: createEmptyJournalState(), mutable: false };
    }

    const rawEntries = Array.isArray(candidate.entries) ? candidate.entries : [];
    const entries = rawEntries.filter(isValidEntry);
    if (entries.length !== rawEntries.length) {
      log.warn(
        { dropped: rawEntries.length - entries.length, kept: entries.length },
        'Journal had malformed entries; dropping them',
      );
    }

    return {
      state: {
        schemaVersion: JOURNAL_SCHEMA_VERSION,
        updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
        entries,
      },
      mutable: true,
    };
  }

  /**
   * Persist a new state. Writes to a sibling tmp file then renames — atomic
   * on POSIX and Windows, so a reader concurrent with the write either sees
   * the previous full version or the new full version.
   */
  /**
   * Persist the current journal state.
   *
   * @param state    The in-memory working set to persist.
   * @param options  `nowMs` overrides the clock used for pruning
   *                 resolution-log entries AND for the `updatedAt` stamp.
   *                 Defaults to `Date.now()`. Tests using a mock clock
   *                 should thread their clock through so pruning semantics
   *                 match the rest of the pipeline.
   */
  async save(state: JournalState, options: { nowMs?: number } = {}): Promise<void> {
    // Stage 4: prune resolution-log entries outside the sliding window.
    // Keeps the journal size bounded even when a user has many resolutions
    // in a single run (first-run quarantine sweep, etc.). Non-log entries
    // are never pruned here.
    const nowMs = options.nowMs ?? Date.now();
    const cutoff = nowMs - RESOLUTION_LOG_WINDOW_MS;
    const entries = state.entries.filter(
      (e) => e.type !== 'resolution-log' || e.resolvedAt >= cutoff,
    );

    const payload: JournalState = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      updatedAt: nowMs,
      entries,
    };

    await this.fsOps.mkdir(path.dirname(this.filePath), { recursive: true });

    const tmpPath = `${this.filePath}.tmp`;
    try {
      await this.fsOps.writeFile(tmpPath, JSON.stringify(payload, null, 2));
      await this.fsOps.rename(tmpPath, this.filePath);
    } catch (err) {
      // Best-effort cleanup of the tmp file; swallow cleanup errors since
      // the primary failure is already being propagated to the caller.
      try { await this.fsOps.unlink(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}

function toErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
