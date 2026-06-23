/**
 * Space Maintenance Service (core, Electron-free)
 *
 * Scanning, classification, startup-cleanup, AND daily-merge orchestration
 * for the shared-space maintenance pipeline
 * (docs/plans/260411_shared_space_maintenance.md).
 *
 * Stage 1 scope:
 *   - Walk non-private shared spaces inside the core directory.
 *   - Match filenames against the shared conflict-pattern catalogue.
 *   - For `.conflict-cloud` entries: classify against the probable original
 *     as identical / differing / orphaned (pending-review until the stability
 *     gate passes) / binary.
 *   - Quarantine (to OS trash, via injected dep) only byte-identical conflicts
 *     whose original still exists. Orphans stay `pending-review` until the
 *     sync-stability gate fires (>= 3 scans and >= 48h since first sighting).
 *   - Respect a wall-clock time budget; bail with partial results on overrun.
 *
 * Stage 2 scope (added here):
 *   - `runDailyMaintenance`: scheduled daily pipeline that resumes any
 *     leftover rename-pending / quarantine-pending journal entries, runs a
 *     time-unbounded startup-cleanup pass, then LLM-merges each remaining
 *     `differing` `.conflict-cloud` via `proposeMerge`. Every merge goes
 *     through the atomic tmp+fsync+guards+rename+quarantine sequence with
 *     the journal as the only pointer to the in-flight tmp file.
 *   - Retry-backoff state (1d/3d/7d) + circuit-break at 3 failures via
 *     `SpaceMaintenanceRetryStore`. Auto-expire on hash change so a
 *     replaced conflict file starts a fresh retry cycle.
 *   - Size-delta + markdown-anchor guards reject LLM truncation or
 *     section-drop before the atomic rename.
 *
 * Architectural invariants:
 *   - No Electron imports under src/core (enforced by de-electronification tutorial).
 *   - All destructive ops go through `deps.moveToTrash` — never `fs.unlink`.
 *   - `proposeMerge` is invoked with `{ category: 'system' }` — the
 *     `TrackingOptions` shape does NOT support `subcategory`; use
 *     telemetry event properties to disambiguate spend per automation.
 *   - Scope in Stage 2 is strictly `.conflict-cloud`. Numbered copies are
 *     Stage 4's job and are deliberately skipped here.
 *   - The journal is the only source of truth for cross-run stability state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import fm from 'front-matter';
import type { AppSettings, SpaceConfig } from '@shared/types';
import { LEGACY_DUPLICATE_THRESHOLD_MS } from '@core/constants';
import { createScopedLogger } from '@core/logger';
import {
  BINARY_SNIFF_BYTES,
  CONFLICT_PATTERNS,
  type ConflictLabel,
  type ConflictProvider,
  deriveOriginalPath,
  sniffIsBinary,
} from '@shared/conflictPatterns';
import { callWithModelAuthAware } from '@core/services/behindTheScenesClient';
import {
  atomicWriteWithReValidate,
  compareFrontmatterFidelity,
  reassembleFile,
  splitFrontmatter,
  tryMechanicalFrontmatterRepair,
} from './frontmatterRepair';
import {
  acquireLease as acquireSharedSpaceLease,
  releaseLease,
  type Lease,
} from './spaceMaintenanceLease';
import { proposeMerge } from './workspaceConflictResolver';
import {
  JOURNAL_SCHEMA_VERSION,
  type CleanupMovePendingEntry,
  type JournalEntry,
  type JournalState,
  type LegacyDuplicateEntry,
  type NumberedCopyOrphanEntry,
  type OrphanCandidateEntry,
  type QuarantinePendingEntry,
  type RenamePendingEntry,
  type ResolutionCounterEntry,
  type ResolutionLogEntry,
  SpaceMaintenanceJournal,
} from './spaceMaintenanceJournal';
import {
  findEligibleEntry,
  pruneStaleEntries,
  recordFailure,
  removeEntry,
  upsertEntry,
  type ConflictRetryEntry,
  RETRY_STATE_SCHEMA_VERSION,
  SpaceMaintenanceRetryStore,
} from './spaceMaintenanceRetryState';
import { resolveCodexConnectivity } from '@core/rebelCore/codexConnectivity';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { ALWAYS_SKIP_DIRS } from '@shared/workspaceConstants';
import { safeWalkDirectory } from '@core/utils/safeWalkDirectory';
import {
  planConflictCopyCleanup,
  type CleanupPlan,
  type ConflictSnapshotEntry,
  type QuarantineCandidate,
} from './conflictCopyCleanup';

const log = createScopedLogger({ service: 'spaceMaintenanceService' });

export const MAX_DEPTH = 4;
export const MAX_ENTRIES_PER_DIR = 500;
export const DEFAULT_STARTUP_TIME_BUDGET_MS = 2000;

/**
 * Sync-stability gate thresholds (Failure Mode Matrix F-provider).
 * Orphaned conflicts stay `pending-review` until BOTH conditions hold —
 * defends against OneDrive / Drive File Stream cases where the base file
 * hasn't materialised yet and a naive single-scan orphan classification
 * would quarantine still-legitimate conflicts.
 */
export const ORPHAN_STABILITY_MIN_SCANS = 3;
export const ORPHAN_STABILITY_MIN_AGE_MS = 48 * 60 * 60 * 1000;

export type ConflictStatus = 'identical' | 'differing' | 'orphaned' | 'pending-review' | 'binary';

export interface ConflictFile {
  absolutePath: string;
  relativePath: string;
  label: ConflictLabel;
  provider: ConflictProvider;
  /** Resolved path to the probable original, or null when derivation was ambiguous. */
  originalPath: string | null;
  status: ConflictStatus;
  firstSeenAt: number;
  stableScanCount: number;
  /**
   * sha256 hex of the conflict file at classification time. Captured when
   * classification was `'identical'` so the pre-quarantine re-hash (F7) can
   * detect mid-flight writes from `cloudWorkspaceSync` and abort the move.
   */
  conflictHash?: string;
  /** sha256 hex of the original file at classification time (identical only). */
  originalHash?: string;
}

/**
 * Result of `classifyConflictCloud`. Hashes are included when status is
 * `'identical'` so callers can re-verify immediately before destructive
 * operations (F7: detect mid-flight writes between classify and quarantine).
 */
export interface ClassifyResult {
  status: ConflictStatus;
  conflictHash?: string;
  originalHash?: string;
}

export interface StartupCleanupResult {
  quarantinedIdentical: number;
  /** Orphan (or binary / differing) entries that were flagged pending-review or deferred. */
  orphansDeferred: number;
  /** Count of differing / binary / pending-review conflicts still on disk at end-of-run. */
  remainingConflicts: number;
  elapsedMs: number;
  timeBudgetExceeded: boolean;
  errors: string[];
}

export interface ScanOptions {
  timeBudgetMs?: number;
  /**
   * Clock override for deterministic testing of the stability gate.
   * Defaults to `Date.now()`.
   */
  now?: () => number;
  signal?: AbortSignal;
  /**
   * Per-directory entry cap. Defaults to `MAX_ENTRIES_PER_DIR` (500) which
   * keeps the steady-state daily/startup walk bounded. The one-off
   * conflict-copy cleanup passes `null` to disable the cap so a large
   * backlog (e.g. ~1,300 numbered copies in one folder) is fully
   * enumerated. The daily/startup callers leave this UNSET — their
   * behaviour is unchanged.
   */
  maxEntriesPerDir?: number | null;
  /**
   * When true, directory entries are walked in deterministic (sorted)
   * order. The daily/startup path leaves this unset (filesystem order is
   * fine for a bounded sample); the one-off cleanup sets it so a
   * deterministic snapshot/manifest is produced regardless of FS ordering.
   */
  sortEntries?: boolean;
}

export interface StartupCleanupOptions extends ScanOptions {
  dryRun?: boolean;
}

export interface MaintenanceDeps {
  /**
   * Move a file to OS-level trash (desktop adapter wraps `shell.trashItem`).
   * On non-desktop surfaces the implementation should throw — callers rely
   * on a thrown rejection to record an error rather than silently unlink.
   */
  moveToTrash: (absolutePath: string) => Promise<void>;
}

/**
 * Outcome of a full daily-maintenance run. Counter names mirror Stage 2 of
 * the plan so the scheduler can surface them verbatim in telemetry.
 */
export interface MaintenanceResult {
  scanned: number;
  /** Identical-conflict quarantines (from the embedded `runStartupCleanup` pass). */
  quarantinedIdentical: number;
  mergedSuccessfully: number;
  mergeFailed: number;
  /** Skipped because `nextEligibleAt > now`. */
  mergeSkippedBackoff: number;
  /** Skipped because the retry entry's `status === 'needs-review'`. */
  mergeSkippedCircuitBreaker: number;
  mergeSkippedBinary: number;
  /** Skipped because conflict or original exceeded `proposeMerge`'s 100KB cap. */
  mergeSkippedTooLarge: number;
  /** Aborted because the original's hash changed during `proposeMerge` latency. */
  mergeAbortedRace: number;
  /** Output of Stage 3 frontmatter repair. 0 until Stage 3 lands. */
  frontmatterRepaired: number;
  // --- Stage 4: numbered-copy outcomes -------------------------------------
  /** Numbered-copy files sent to trash because their content matched the base file. */
  numberedCopyQuarantinedIdentical: number;
  /** Numbered-copy files successfully merged into the base via the LLM pipeline. */
  numberedCopyMerged: number;
  /** Numbered-copy files skipped because their mtime crossed the legacy threshold. */
  numberedCopyLegacySkipped: number;
  /** Numbered-copy files whose base is missing and haven't cleared the sync-stability gate. */
  numberedCopyPendingStability: number;
  /** Numbered-copy files whose base is missing AND have cleared the sync-stability gate. */
  numberedCopyPendingUserReview: number;
  /** Numbered-copy files skipped because either side was binary. */
  numberedCopySkippedBinary: number;
  /** Numbered-copy files skipped because either side exceeded the 100KB merge cap. */
  numberedCopySkippedTooLarge: number;
  errors: string[];
  elapsedMs: number;
  /** Propagated from the embedded `runStartupCleanup`. */
  timeBudgetExceeded?: boolean;
}

/**
 * Daily-maintenance deps. Extends `MaintenanceDeps` with the injected
 * capabilities the daily pipeline needs that the startup pass doesn't.
 */
export interface DailyMaintenanceDeps extends MaintenanceDeps {
  /**
   * Fire a structured telemetry event. Desktop wires this to `trackMainEvent`
   * in the adapter. Dry-run runs pass `dryRun: true` in the properties so
   * downstream cost dashboards can filter.
   */
  emitTelemetry?: (event: string, properties: Record<string, unknown>) => void;

  /**
   * Acquire the multi-desktop lease for the run. When NOT provided (normal
   * production path) `runDailyMaintenance` calls the Stage 5 helper
   * `acquireLease` in `spaceMaintenanceLease.ts` against every non-private
   * shared space in `settings.spaces`, returning a compound release that
   * unlinks each lease on completion.
   *
   * Tests that want deterministic lease behaviour (force contention, inject
   * a mock clock without modifying the shared-space filesystem) can override
   * this; see `spaceMaintenanceLease.test.ts` for the lease primitive's own
   * tests, and `spaceMaintenance.integration.test.ts` for the end-to-end
   * contention scenario that goes through this hook.
   *
   * If the lease is already held by another desktop, return
   * `{ acquired: false }` — `runDailyMaintenance` will log an info message
   * and return a clean success result (no failure counter increment).
   */
  acquireLease?: () => Promise<{ acquired: boolean; release: () => Promise<void> }>;
}

export interface DailyMaintenanceOptions {
  dryRun?: boolean;
  /** Clock override for deterministic testing. Defaults to `Date.now`. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Walk non-private shared spaces under `coreDirectory` and return every file
 * whose basename matches a conflict pattern. Classification is NOT performed
 * here (the caller may batch / filter before paying per-file I/O) — callers
 * should invoke `classifyConflictCloud` on the entries they care about.
 *
 * The journal is passed in so scanning can attach persisted stability state
 * (`firstSeenAt`, `stableScanCount`) to each orphan candidate without a
 * second round-trip.
 */
export async function scanConflicts(
  coreDirectory: string,
  settings: AppSettings,
  journal: JournalState,
  options: ScanOptions = {},
): Promise<ConflictFile[]> {
  const timeBudgetMs = options.timeBudgetMs ?? Number.POSITIVE_INFINITY;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const deadline = now() + timeBudgetMs;
  const maxEntriesPerDir =
    options.maxEntriesPerDir === undefined ? MAX_ENTRIES_PER_DIR : options.maxEntriesPerDir;
  const sortEntries = options.sortEntries === true;

  const searchRoots = resolveSearchRoots(coreDirectory, settings);
  const orphanIndex = buildOrphanIndex(journal);
  const results: ConflictFile[] = [];

  for (const root of searchRoots) {
    if (signal?.aborted) break;
    if (now() >= deadline) break;
    await walkForConflicts(root, root, 0, results, orphanIndex, deadline, now, {
      maxEntriesPerDir,
      sortEntries,
      signal,
    });
  }

  return results;
}

/**
 * Classify a `.conflict-cloud` file against its candidate original.
 *   - `binary`: either file's sniff returns true
 *   - `orphaned`: original doesn't exist on disk
 *   - `identical`: byte-level hashes match
 *   - `differing`: hashes don't match
 *
 * When status is `'identical'` the result also carries the `conflictHash`
 * and `originalHash` so callers can re-verify immediately before running a
 * destructive operation (F7 — detect mid-flight writes between classify
 * and quarantine).
 *
 * On I/O errors we return `'differing'` conservatively — the caller will
 * defer destructive handling and the daily automation (Stage 2) can retry.
 */
export async function classifyConflictCloud(
  conflictPath: string,
  originalPath: string | null,
  signal?: AbortSignal,
): Promise<ClassifyResult> {
  if (signal?.aborted) return { status: 'differing' };
  if (!originalPath) return { status: 'orphaned' };

  try {
    if (signal?.aborted) return { status: 'differing' };
    const conflictHead = await readHead(conflictPath, BINARY_SNIFF_BYTES);
    if (signal?.aborted) return { status: 'differing' };
    if (sniffIsBinary(conflictHead)) return { status: 'binary' };
  } catch (err) {
    if (signal?.aborted) return { status: 'differing' };
    log.warn({ path: conflictPath, err: toErrMsg(err) }, 'Failed to sniff conflict file');
    return { status: 'differing' };
  }

  try {
    if (signal?.aborted) return { status: 'differing' };
    await fs.access(originalPath);
  } catch {
    if (signal?.aborted) return { status: 'differing' };
    return { status: 'orphaned' };
  }

  try {
    if (signal?.aborted) return { status: 'differing' };
    const originalHead = await readHead(originalPath, BINARY_SNIFF_BYTES);
    if (signal?.aborted) return { status: 'differing' };
    if (sniffIsBinary(originalHead)) return { status: 'binary' };
  } catch (err) {
    if (signal?.aborted) return { status: 'differing' };
    log.warn({ path: originalPath, err: toErrMsg(err) }, 'Failed to sniff original file');
    return { status: 'differing' };
  }

  try {
    if (signal?.aborted) return { status: 'differing' };
    const conflictHash = await hashFile(conflictPath);
    if (signal?.aborted) return { status: 'differing' };
    const originalHash = await hashFile(originalPath);
    if (signal?.aborted) return { status: 'differing' };
    if (conflictHash === originalHash) {
      return { status: 'identical', conflictHash, originalHash };
    }
    return { status: 'differing' };
  } catch (err) {
    if (signal?.aborted) return { status: 'differing' };
    log.warn({ err: toErrMsg(err), conflictPath, originalPath }, 'Hash comparison failed');
    return { status: 'differing' };
  }
}

/**
 * Non-LLM startup path. Quarantines byte-identical `.conflict-cloud` files
 * and updates the stability journal for orphans. Orphans themselves are
 * NEVER quarantined here (sync-stability gate requires >= 3 scans / >= 48h).
 *
 * Journal safety contract:
 *   - A quarantine-pending entry is written BEFORE `moveToTrash` and
 *     cleared on success. Crash-in-between is resumed on next startup.
 *   - If the on-disk journal had an unknown `schemaVersion`, `load()`
 *     returns `mutable: false` and ALL journal writes in this run are
 *     skipped (forward-compat safe-skip — never overwrite a future
 *     version's data).
 *
 * Dry-run contract: zero `moveToTrash` calls, zero journal writes, zero
 * error entries recorded. Logs are emitted at debug level with `[dry-run]`
 * prefix so the caller's normal logging surface stays unchanged. The
 * returned counters reflect "what would have happened" so dry-run previews
 * are meaningful (`quarantinedIdentical` is incremented even though no
 * move actually ran).
 */
export async function runStartupCleanup(
  coreDirectory: string,
  settings: AppSettings,
  journal: SpaceMaintenanceJournal,
  deps: MaintenanceDeps,
  options: StartupCleanupOptions = {},
): Promise<StartupCleanupResult> {
  const dryRun = options.dryRun === true;
  const timeBudgetMs = options.timeBudgetMs ?? DEFAULT_STARTUP_TIME_BUDGET_MS;
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const startedAt = now();
  const deadline = startedAt + timeBudgetMs;

  const result: StartupCleanupResult = {
    quarantinedIdentical: 0,
    orphansDeferred: 0,
    remainingConflicts: 0,
    elapsedMs: 0,
    timeBudgetExceeded: false,
    errors: [],
  };

  const pushError = (msg: string) => {
    if (dryRun) {
      log.debug({ msg }, '[dry-run] suppressed error');
      return;
    }
    result.errors.push(msg);
  };

  let timeBudgetExceeded = false;

  // Load journal once per run. `mutable: false` means the on-disk file
  // had an unknown schemaVersion — we MUST NOT save, or we'd clobber
  // whatever a future version wrote there.
  const { state: initialJournal, mutable: journalMutable } = await journal.load();
  const orphanIndex = buildOrphanIndex(initialJournal);

  // Working set of journal entries. Mutated as we go, persisted at
  // appropriate checkpoints (and at end-of-run) unless we're in dry-run
  // or the journal is not mutable.
  let workingEntries: JournalEntry[] = [...initialJournal.entries];

  const saveWorkingEntries = async (): Promise<boolean> => {
    if (dryRun || !journalMutable) return true;
    try {
      await journal.save(
        {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          updatedAt: now(),
          entries: workingEntries,
        },
        { nowMs: now() },
      );
      return true;
    } catch (err) {
      pushError(`journal save failed: ${toErrMsg(err)}`);
      return false;
    }
  };

  // --- Resume any pre-existing quarantine-pending entries (F8) ----------
  // These are crash-recovery markers from a previous run that died between
  // writing the entry and clearing it on success.
  const pendingQuarantines = workingEntries.filter(
    (e): e is QuarantinePendingEntry => e.type === 'quarantine-pending',
  );
  if (signal?.aborted) {
    timeBudgetExceeded = true;
  } else if (pendingQuarantines.length > 0) {
    for (const pending of pendingQuarantines) {
      if (signal?.aborted) {
        timeBudgetExceeded = true;
        break;
      }
      if (now() >= deadline) break;
      const resolved = await resumePendingQuarantine(pending, deps, dryRun, pushError, signal);
      if (resolved) {
        workingEntries = workingEntries.filter((e) => e !== pending);
      }
    }
    // Persist any clears from the resume pass before starting the scan.
    await saveWorkingEntries();
  }

  // --- Resume any pre-existing rename-pending entries (S2-F5) -----------
  // Previously this lived only in `runDailyMaintenance`. Moved here so a
  // user who restarts after a crash at 06:00 gets the stale tmp + journal
  // resolved on the very next launch rather than waiting for the next
  // 06:00 catch-up. Widening the fix reduces the data-loss window that
  // S2-F1's pre-rename guard plugs (which only fires when we reach this
  // resume path). Surface-gating is already enforced by the caller
  // (`coreStartup.ts` step 12 is desktop-only).
  const pendingRenames = workingEntries.filter(
    (e): e is RenamePendingEntry => e.type === 'rename-pending',
  );
  if (signal?.aborted) {
    timeBudgetExceeded = true;
  } else if (pendingRenames.length > 0) {
    for (const pending of pendingRenames) {
      if (signal?.aborted) {
        timeBudgetExceeded = true;
        break;
      }
      if (now() >= deadline) break;
      const resolved = await resumePendingRename(pending, deps, dryRun, pushError, signal);
      if (resolved) {
        workingEntries = workingEntries.filter((e) => e !== pending);
      }
    }
    await saveWorkingEntries();
  }

  // --- Resume any pre-existing cleanup-move-pending entries (F1) ---------
  // REBEL-62A one-off cleanup crash markers. DISTINCT from quarantine-pending:
  // the daily/startup path must NEVER OS-trash a cleanup source (Safety
  // Contract §3). `resumeCleanupMovePending` only ever completes the SAME
  // in-workspace move (never `moveToTrash`, never `fs.unlink`). Filtering by
  // the distinct `type` is what makes the OS-trash path unreachable for these.
  const pendingCleanupMoves = workingEntries.filter(
    (e): e is CleanupMovePendingEntry => e.type === 'cleanup-move-pending',
  );
  if (signal?.aborted) {
    timeBudgetExceeded = true;
  } else if (pendingCleanupMoves.length > 0) {
    for (const pending of pendingCleanupMoves) {
      if (signal?.aborted) {
        timeBudgetExceeded = true;
        break;
      }
      if (now() >= deadline) break;
      const resolved = await resumeCleanupMovePending(pending, dryRun, pushError, signal);
      if (resolved) {
        workingEntries = workingEntries.filter((e) => e !== pending);
      }
    }
    await saveWorkingEntries();
  }

  const searchRoots = resolveSearchRoots(coreDirectory, settings);
  const scanned: ConflictFile[] = [];

  for (const root of searchRoots) {
    if (signal?.aborted) {
      timeBudgetExceeded = true;
      break;
    }
    if (now() >= deadline) {
      timeBudgetExceeded = true;
      break;
    }
    try {
      await walkForConflicts(root, root, 0, scanned, orphanIndex, deadline, now, {
        maxEntriesPerDir: MAX_ENTRIES_PER_DIR,
        sortEntries: false,
        signal,
      });
    } catch (err) {
      pushError(`scan failed under ${root}: ${toErrMsg(err)}`);
    }
    if (signal?.aborted) {
      timeBudgetExceeded = true;
      break;
    }
    if (now() >= deadline) {
      timeBudgetExceeded = true;
      break;
    }
  }

  // Track which conflicts we actually got to classify this run. Anything
  // not in this set must not have its orphan-candidate entry dropped, or
  // we'd reset the sync-stability counter on users with slow filesystems
  // (OneDrive Files-On-Demand, Drive File Stream) whose scans blow past
  // the time budget before reaching the orphan's directory (F2).
  const classifiedPaths = new Set<string>();
  const nextOrphans: OrphanCandidateEntry[] = [];

  for (const conflict of scanned) {
    if (signal?.aborted) {
      timeBudgetExceeded = true;
      break;
    }
    if (now() >= deadline) {
      timeBudgetExceeded = true;
      break;
    }

    // Only the rebel-cloud pattern is actioned in Stage 1. Other providers
    // (numbered-copy, dropbox-conflict, etc.) are surfaced via the health
    // check and handled in later stages.
    if (conflict.label !== 'rebel-cloud-conflict') {
      result.remainingConflicts++;
      continue;
    }

    classifiedPaths.add(conflict.absolutePath);

    const classification = await classifyConflictCloud(
      conflict.absolutePath,
      conflict.originalPath,
      signal,
    );
    conflict.status = classification.status;
    conflict.conflictHash = classification.conflictHash;
    conflict.originalHash = classification.originalHash;

    if (classification.status === 'identical' && conflict.originalPath && classification.conflictHash) {
      const outcome = await quarantineIdentical(
        conflict.absolutePath,
        conflict.originalPath,
        classification.conflictHash,
        classification.originalHash,
        deps,
        dryRun,
        pushError,
        now,
        async (entry) => {
          workingEntries.push(entry);
          return saveWorkingEntries();
        },
        async (entryRef) => {
          workingEntries = workingEntries.filter((e) => e !== entryRef);
          return saveWorkingEntries();
        },
        signal,
      );
      if (outcome === 'quarantined') {
        result.quarantinedIdentical++;
      } else {
        result.remainingConflicts++;
      }
      continue;
    }

    if (classification.status === 'orphaned') {
      const entry = advanceOrphanState(conflict.absolutePath, orphanIndex, now());
      const ageMs = now() - entry.firstSeenAt;
      const stable =
        entry.stableScanCount >= ORPHAN_STABILITY_MIN_SCANS && ageMs >= ORPHAN_STABILITY_MIN_AGE_MS;

      // Stage 1 deliberately does NOT auto-quarantine even when the gate
      // passes — the plan (§Stage 1 quarantine semantics) reserves orphan
      // quarantine to the daily automation so users always have a chance
      // to intervene between passes.
      conflict.firstSeenAt = entry.firstSeenAt;
      conflict.stableScanCount = entry.stableScanCount;
      conflict.status = stable ? 'orphaned' : 'pending-review';
      nextOrphans.push(entry);
      result.orphansDeferred++;
      result.remainingConflicts++;
      continue;
    }

    // differing / binary / pending-review: not quarantined in Stage 1.
    result.remainingConflicts++;
  }

  // Build the final orphan-candidate set:
  //   - classified this run + still orphan  -> nextOrphans
  //   - NOT classified this run (time-budget bail, scan error, etc.)
  //     -> preserve the prior entry unchanged so its counter and firstSeenAt
  //        survive. Without this, a slow-FS user could loop forever without
  //        ever clearing the stability gate (F2).
  //   - classified this run but no longer orphan -> dropped (base reappeared
  //     or conflict was quarantined).
  const preservedOrphans = initialJournal.entries.filter(
    (e): e is OrphanCandidateEntry =>
      e.type === 'orphan-candidate' && !classifiedPaths.has(e.conflictPath),
  );

  // Replace orphan entries in working set with the merged preservation+next
  // list. Non-orphan entries (rename-pending, any leftover quarantine-pending)
  // stay as-is.
  workingEntries = [
    ...workingEntries.filter((e) => e.type !== 'orphan-candidate'),
    ...preservedOrphans,
    ...nextOrphans,
  ];

  // Stage 4: log identical-quarantine resolutions so the health check can
  // surface resolvedLast24h / resolvedTotal. Must NOT run in dry-run or
  // when the journal isn't mutable (otherwise we'd either skew the
  // preview counters or trample forward-compat data).
  if (!dryRun && journalMutable && result.quarantinedIdentical > 0) {
    workingEntries = appendResolutionLog(
      workingEntries,
      result.quarantinedIdentical,
      'conflict-cloud-identical',
      now(),
    );
  }

  if (dryRun) {
    log.debug(
      { orphans: nextOrphans.length, scanned: scanned.length },
      '[dry-run] skipped journal save',
    );
  } else if (!journalMutable) {
    log.debug(
      { scanned: scanned.length },
      'journal is not mutable (unknown schemaVersion); skipped save',
    );
  } else {
    await saveWorkingEntries();
  }

  result.timeBudgetExceeded = timeBudgetExceeded || now() >= deadline || signal?.aborted === true;
  result.elapsedMs = now() - startedAt;

  log[dryRun ? 'debug' : 'info'](
    {
      scanned: scanned.length,
      quarantinedIdentical: result.quarantinedIdentical,
      orphansDeferred: result.orphansDeferred,
      remainingConflicts: result.remainingConflicts,
      elapsedMs: result.elapsedMs,
      timeBudgetExceeded: result.timeBudgetExceeded,
      dryRun,
    },
    dryRun ? '[dry-run] startup cleanup' : 'startup cleanup complete',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Stage 2: Daily Maintenance (`.conflict-cloud` LLM merge)
// ---------------------------------------------------------------------------

/**
 * Absolute-floor size-delta guard threshold (bytes). Plan §Principles #3:
 * files smaller than 1KB can grow by at most +1KB to avoid false-rejecting
 * frontmatter expansion on tiny files.
 */
export const SIZE_GUARD_ABSOLUTE_FLOOR_BYTES = 1024;
/** Relative ceiling fraction: merged size within +/- 50% of `max(local, cloud)`. */
export const SIZE_GUARD_RELATIVE_CEILING = 0.5;
/** Minimum fraction of `min(local, cloud)` the merged size must reach. */
export const SIZE_GUARD_MIN_SHRINK_FRACTION = 0.7;

/**
 * Markdown ATX heading extractor — pulls `#` and `##` headings only.
 * Stricter than the plan's pseudocode so setext headings and deeper
 * levels don't inflate the invariant set.
 */
function extractMarkdownAnchors(content: string): string[] {
  const anchors: string[] = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^(#{1,2})\s+(.+?)\s*#*\s*$/);
    if (m) {
      anchors.push(`${m[1]} ${m[2].trim()}`);
    }
  }
  return anchors;
}

export interface MergeGuardOutcome {
  passed: boolean;
  /** Short, machine-stable reason when `passed: false`. */
  reason?:
    | 'size-delta-absolute'
    | 'size-delta-relative'
    | 'size-delta-shrink'
    | 'missing-heading';
  detail?: string;
}

/**
 * Size-delta + markdown-anchor guard. Called after `proposeMerge` succeeds
 * and before the atomic rename. Any guard failure is treated as a merge
 * failure (caller pushes to retry-backoff).
 *
 * Exported so Stage 2's test suite can exercise the edge cases directly.
 */
export function evaluateMergeGuards(
  localContent: string,
  cloudContent: string,
  mergedContent: string,
): MergeGuardOutcome {
  const localBytes = Buffer.byteLength(localContent, 'utf8');
  const cloudBytes = Buffer.byteLength(cloudContent, 'utf8');
  const mergedBytes = Buffer.byteLength(mergedContent, 'utf8');

  const minInput = Math.min(localBytes, cloudBytes);
  const maxInput = Math.max(localBytes, cloudBytes);

  if (minInput < SIZE_GUARD_ABSOLUTE_FLOOR_BYTES) {
    // Small-file regime: allow merged to grow by up to +1KB over max(inputs)
    // but not to shrink below zero. We still enforce the hard upper bound so
    // a runaway LLM response can't balloon a tiny file.
    const maxAllowed = maxInput + SIZE_GUARD_ABSOLUTE_FLOOR_BYTES;
    if (mergedBytes > maxAllowed) {
      return {
        passed: false,
        reason: 'size-delta-absolute',
        detail: `merged=${mergedBytes}B exceeds small-file ceiling of ${maxAllowed}B (max-input=${maxInput}B)`,
      };
    }
    return evaluateAnchors(localContent, cloudContent, mergedContent);
  }

  // Normal regime: |merged - max(inputs)| <= 50% * max(inputs)
  if (Math.abs(mergedBytes - maxInput) > SIZE_GUARD_RELATIVE_CEILING * maxInput) {
    return {
      passed: false,
      reason: 'size-delta-relative',
      detail: `merged=${mergedBytes}B deviates from max-input=${maxInput}B by more than ${SIZE_GUARD_RELATIVE_CEILING * 100}%`,
    };
  }

  // Shrink floor: merged >= 70% of min(inputs) (defends the classic "LLM
  // dropped the second half" truncation).
  if (mergedBytes < SIZE_GUARD_MIN_SHRINK_FRACTION * minInput) {
    return {
      passed: false,
      reason: 'size-delta-shrink',
      detail: `merged=${mergedBytes}B is below ${SIZE_GUARD_MIN_SHRINK_FRACTION * 100}% of min-input=${minInput}B`,
    };
  }

  return evaluateAnchors(localContent, cloudContent, mergedContent);
}

function evaluateAnchors(
  localContent: string,
  cloudContent: string,
  mergedContent: string,
): MergeGuardOutcome {
  const localAnchors = new Set(extractMarkdownAnchors(localContent));
  const cloudAnchors = new Set(extractMarkdownAnchors(cloudContent));
  if (localAnchors.size === 0 && cloudAnchors.size === 0) {
    return { passed: true };
  }
  const mergedAnchors = new Set(extractMarkdownAnchors(mergedContent));

  // Intersection = headings present in BOTH inputs. These MUST survive.
  const required: string[] = [];
  for (const a of localAnchors) {
    if (cloudAnchors.has(a)) required.push(a);
  }

  for (const anchor of required) {
    if (!mergedAnchors.has(anchor)) {
      return {
        passed: false,
        reason: 'missing-heading',
        detail: `merged output dropped required heading: "${anchor}"`,
      };
    }
  }
  return { passed: true };
}

/**
 * Full daily pipeline: resume pending rename/quarantine entries, run the
 * time-unbounded startup-cleanup pass, then process both `.conflict-cloud`
 * and numbered-copy conflicts through the Stage 2/4 atomic paths.
 *
 * All destructive ops go through `deps.moveToTrash`.
 *
 * Telemetry: fires `space_maintenance_run` with outcome counters and the
 * `dryRun` flag when an emitter is provided.
 */
export async function runDailyMaintenance(
  coreDirectory: string,
  settings: AppSettings,
  journal: SpaceMaintenanceJournal,
  retryStore: SpaceMaintenanceRetryStore,
  deps: DailyMaintenanceDeps,
  options: DailyMaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now;
  const startedAt = now();

  const result: MaintenanceResult = {
    scanned: 0,
    quarantinedIdentical: 0,
    mergedSuccessfully: 0,
    mergeFailed: 0,
    mergeSkippedBackoff: 0,
    mergeSkippedCircuitBreaker: 0,
    mergeSkippedBinary: 0,
    mergeSkippedTooLarge: 0,
    mergeAbortedRace: 0,
    frontmatterRepaired: 0,
    numberedCopyQuarantinedIdentical: 0,
    numberedCopyMerged: 0,
    numberedCopyLegacySkipped: 0,
    numberedCopyPendingStability: 0,
    numberedCopyPendingUserReview: 0,
    numberedCopySkippedBinary: 0,
    numberedCopySkippedTooLarge: 0,
    errors: [],
    elapsedMs: 0,
  };

  const pushError = (msg: string) => {
    if (dryRun) {
      log.debug({ msg }, '[dry-run] suppressed error');
      return;
    }
    result.errors.push(msg);
  };

  // ── Multi-desktop lease (Stage 5) ──
  // Acquire the shared-space lease BEFORE any destructive action so a
  // second desktop firing the same 06:00 automation on the same Drive
  // sees our lease and cleanly skips. Contention is NOT an error: return
  // success early, don't touch failure counters.
  //
  // The lease is best-effort (Drive sync is eventually consistent) — the
  // atomic-write + retry-backoff layers already handle any residual
  // concurrent-merge safety. The TTL (LEASE_TTL_MS, 10 min) makes an
  // abandoned lease from a crashed desktop auto-overridable on the next
  // scheduled run.
  const lease = dryRun
    ? {
        acquired: true,
        release: async () => {
          /* dry-run must not create/update/delete lease files */
        },
      }
    : await (deps.acquireLease ??
      (() => acquireDefaultLeases(coreDirectory, settings, now)))();
  if (!lease.acquired) {
    log.info({}, 'space-maintenance: lease held by another desktop, skipping run');
    result.elapsedMs = now() - startedAt;
    return result;
  }

  try {
    // ── Startup-cleanup pass (no time budget) ──
    // Runs the identical-quarantine + orphan stability gate AND resumes
    // any crash-recovery journal entries (rename-pending + quarantine-
    // pending) via the shared Stage 1 path. The daily no longer has its
    // own resume block — `runStartupCleanup` owns all crash-recovery
    // bookkeeping so both the 06:00 schedule AND the app-start path get
    // equivalent coverage (S2-F5).
    const cleanup = await runStartupCleanup(
      coreDirectory,
      settings,
      journal,
      deps,
      { timeBudgetMs: Number.POSITIVE_INFINITY, dryRun, now },
    );
    result.quarantinedIdentical = cleanup.quarantinedIdentical;
    result.timeBudgetExceeded = cleanup.timeBudgetExceeded;
    for (const err of cleanup.errors) {
      pushError(`[startup-cleanup] ${err}`);
    }

    // ── Re-scan for `differing` `.conflict-cloud` entries ──
    const { state: postCleanupJournal } = await journal.load();
    const scanned = await scanConflicts(coreDirectory, settings, postCleanupJournal, { now });
    result.scanned = scanned.length;

    // Stage 2 scope: `.conflict-cloud` only.
    const conflictClouds = scanned.filter((c) => c.label === 'rebel-cloud-conflict');

    // ── Load retry-backoff state (safe-skip on unknown schemaVersion) ──
    const { state: retryStateInitial, mutable: retryMutable } = await retryStore.load();
    let retryEntries: ConflictRetryEntry[] = [...retryStateInitial.entries];

    // Track hashes we observe during this run so the pruning step can
    // auto-expire stale entries (upstream content changed).
    const observedHashesByPath = new Map<string, string | null>();

    for (const conflict of conflictClouds) {
      const outcome = await processDifferingConflict(
        conflict,
        settings,
        journal,
        retryEntries,
        deps,
        dryRun,
        pushError,
        now,
        observedHashesByPath,
      );

      switch (outcome.kind) {
        case 'not-differing':
          break;
        case 'skipped-backoff':
          result.mergeSkippedBackoff++;
          break;
        case 'skipped-circuit-breaker':
          result.mergeSkippedCircuitBreaker++;
          break;
        case 'skipped-binary':
          result.mergeSkippedBinary++;
          break;
        case 'skipped-too-large':
          result.mergeSkippedTooLarge++;
          break;
        case 'aborted-race':
          result.mergeAbortedRace++;
          break;
        case 'failed':
          result.mergeFailed++;
          break;
        case 'merged-with-cleanup-error':
          // Rename committed — count as a success. The `error` carries
          // the cleanup detail and is pushed into `result.errors` below
          // via `outcome.error`. Retry counter is untouched (S2-F2).
          result.mergedSuccessfully++;
          break;
        case 'merged':
          result.mergedSuccessfully++;
          break;
      }

      // The helper returns the mutated retryEntries list (after any
      // upsert from recordFailure or success-clear). We reassign rather
      // than mutating in place so the next iteration sees the update.
      retryEntries = outcome.nextRetryEntries;

      if (outcome.error) {
        pushError(outcome.error);
      }
    }

    // Auto-expire entries whose hash no longer matches (or whose file is gone).
    const { kept, droppedStale } = pruneStaleEntries(retryEntries, observedHashesByPath);
    if (droppedStale > 0) {
      log.info({ droppedStale }, 'Auto-expired stale retry-backoff entries');
    }
    retryEntries = kept;

    if (!dryRun && retryMutable) {
      try {
        await retryStore.save({
          schemaVersion: RETRY_STATE_SCHEMA_VERSION,
          updatedAt: now(),
          entries: retryEntries,
        });
      } catch (err) {
        pushError(`retry-state save failed: ${toErrMsg(err)}`);
      }
    } else if (!retryMutable) {
      log.debug({}, 'retry-state is not mutable (unknown schemaVersion); skipped save');
    }

    // ── Stage 4: numbered-copy resolution ─────────────────────────────────
    // Runs AFTER the .conflict-cloud merge loop and BEFORE frontmatter
    // repair so Stage 3 can still pick up any frontmatter breakage
    // introduced by the merge path. Uses the same atomic primitives as
    // Stage 2 (merge via processDifferingConflict -> applyAtomicMerge;
    // identical quarantine via a dedicated numbered-copy helper) with
    // additional safety rails:
    //   - Legacy gate: mtime > LEGACY_DUPLICATE_THRESHOLD_MS → skip
    //     with persistent LegacyDuplicateEntry so we never re-classify.
    //   - Base missing: NEVER auto-rename. Advance sync-stability gate
    //     via NumberedCopyOrphanEntry; surface as `pending-user-review`
    //     once ≥3 scans over ≥48h.
    //   - Identical bytes: quarantine the numbered copy only.
    //   - Differing bytes + not legacy: route through the same
    //     proposeMerge + atomic rename + retry-backoff pipeline.
    const numberedCopies = scanned.filter((c) => c.label === 'numbered-copy');
    if (numberedCopies.length > 0) {
      const numberedRetryEntries = await processNumberedCopyConflicts(
        numberedCopies,
        settings,
        journal,
        retryEntries,
        deps,
        dryRun,
        result,
        pushError,
        now,
        observedHashesByPath,
      );
      retryEntries = numberedRetryEntries;

      // Persist retry-state changes introduced by numbered-copy merges
      // (new failures, circuit-breaker transitions, or cleared entries
      // on success). Same mutability + dry-run contract as above.
      if (!dryRun && retryMutable) {
        try {
          await retryStore.save({
            schemaVersion: RETRY_STATE_SCHEMA_VERSION,
            updatedAt: now(),
            entries: retryEntries,
          });
        } catch (err) {
          pushError(`retry-state save failed after numbered-copy pass: ${toErrMsg(err)}`);
        }
      }
    }

    // ── Resolution log (Stage 4) ──
    // One final journal load/mutate/save adds resolution-log entries for
    // every merge-style resolution observed during this run, plus bumps
    // the lifetime counter. runStartupCleanup already logged identical
    // quarantines it performed, so those are NOT double-counted here.
    const mergeResolutions =
      result.mergedSuccessfully + result.numberedCopyMerged + result.numberedCopyQuarantinedIdentical;
    if (!dryRun && mergeResolutions > 0) {
      try {
        const { state: logJournal, mutable: logMutable } = await journal.load();
        if (logMutable) {
          let withLogs: JournalEntry[] = logJournal.entries;
          // Split the tally by kind so the journal preserves resolution
          // provenance — useful for future analytics without re-deriving.
          withLogs = appendResolutionLog(
            withLogs,
            result.mergedSuccessfully,
            'conflict-cloud-merged',
            now(),
          );
          withLogs = appendResolutionLog(
            withLogs,
            result.numberedCopyMerged,
            'numbered-copy-merged',
            now(),
          );
          withLogs = appendResolutionLog(
            withLogs,
            result.numberedCopyQuarantinedIdentical,
            'numbered-copy-identical',
            now(),
          );
          await journal.save(
            {
              schemaVersion: JOURNAL_SCHEMA_VERSION,
              updatedAt: now(),
              entries: withLogs,
            },
            { nowMs: now() },
          );
        }
      } catch (err) {
        pushError(`resolution-log save failed: ${toErrMsg(err)}`);
      }
    }

    // ── Stage 3: frontmatter repair ──
    // Mechanical repair first (missing `---`, duplicate keys, mixed
    // indentation). LLM fallback strictly gated to cases where YAML
    // fails to parse — never on schema-missing-field complaints.
    // Body bytes are preserved byte-exactly across the entire path.
    try {
      const repair = await repairBrokenFrontmatter(
        coreDirectory,
        settings,
        journal,
        { dryRun, now },
      );
      result.frontmatterRepaired = repair.repairedMechanical + repair.repairedLLM;
      for (const err of repair.errors) {
        pushError(`[frontmatter-repair] ${err}`);
      }
    } catch (err) {
      pushError(`frontmatter repair step threw: ${toErrMsg(err)}`);
    }
  } finally {
    try {
      await lease.release();
    } catch (err) {
      pushError(`lease release failed: ${toErrMsg(err)}`);
    }
  }

  result.elapsedMs = now() - startedAt;

  // ── Telemetry ──
  if (deps.emitTelemetry) {
    try {
      deps.emitTelemetry('space_maintenance_run', {
        dryRun,
        scanned: result.scanned,
        quarantinedIdentical: result.quarantinedIdentical,
        mergedSuccessfully: result.mergedSuccessfully,
        mergeFailed: result.mergeFailed,
        mergeSkippedBackoff: result.mergeSkippedBackoff,
        mergeSkippedCircuitBreaker: result.mergeSkippedCircuitBreaker,
        mergeSkippedBinary: result.mergeSkippedBinary,
        mergeSkippedTooLarge: result.mergeSkippedTooLarge,
        mergeAbortedRace: result.mergeAbortedRace,
        frontmatterRepaired: result.frontmatterRepaired,
        errorCount: result.errors.length,
        elapsedMs: result.elapsedMs,
        timeBudgetExceeded: result.timeBudgetExceeded ?? false,
      });
    } catch (err) {
      // Never let telemetry failures poison the run result.
      log.warn({ err: toErrMsg(err) }, 'space_maintenance_run telemetry emit failed');
    }
  }

  log[dryRun ? 'debug' : 'info'](
    {
      scanned: result.scanned,
      mergedSuccessfully: result.mergedSuccessfully,
      mergeFailed: result.mergeFailed,
      quarantinedIdentical: result.quarantinedIdentical,
      elapsedMs: result.elapsedMs,
    },
    dryRun ? '[dry-run] daily maintenance complete' : 'daily maintenance complete',
  );

  return result;
}

// ---------------------------------------------------------------------------
// Stage 2 internals
// ---------------------------------------------------------------------------

type DifferingConflictOutcomeKind =
  | 'not-differing'
  | 'skipped-backoff'
  | 'skipped-circuit-breaker'
  | 'skipped-binary'
  | 'skipped-too-large'
  | 'aborted-race'
  | 'failed'
  /**
   * The atomic rename succeeded (original now holds merged bytes) but a
   * downstream cleanup step failed — typically the journal flip from
   * `rename-pending` to `quarantine-pending`, or the `moveToTrash` call.
   * The merge itself counts as a success; we MUST NOT poll this into
   * `recordFailure` or three transient cleanup errors would circuit-break
   * a file that's been merged correctly every time (S2-F2).
   */
  | 'merged-with-cleanup-error'
  | 'merged';

interface DifferingConflictOutcome {
  kind: DifferingConflictOutcomeKind;
  nextRetryEntries: ConflictRetryEntry[];
  error?: string;
}

/**
 * Process a single `.conflict-cloud` entry through the Stage 2 merge pipeline.
 *
 * Guard sequence (all must pass or we bail early with the appropriate outcome):
 *   1. Re-read + re-hash both files. If the original hash already differs
 *      from what the scan captured, we defer as `aborted-race`.
 *   2. Binary-sniff both files (skip if either is binary).
 *   3. Pre-flight size check against `MAX_FILE_SIZE_BYTES` (avoid an LLM
 *      call that would just fail; counts as `skipped-too-large`).
 *   4. Check retry-backoff state — back off if the entry hasn't expired
 *      yet, or return `skipped-circuit-breaker` if we're in `needs-review`.
 *   5. `proposeMerge` (BTS call). On failure, record in retry-state.
 *   6. Size-delta + anchor guards. On failure, record as merge failure.
 *   7. Atomic write sequence (journal → tmp → fsync → hash-verify →
 *      re-hash-original → rename → quarantine-pending → trash → clear).
 */
async function processDifferingConflict(
  conflict: ConflictFile,
  settings: AppSettings,
  journal: SpaceMaintenanceJournal,
  retryEntries: ConflictRetryEntry[],
  deps: DailyMaintenanceDeps,
  dryRun: boolean,
  pushError: (msg: string) => void,
  now: () => number,
  observedHashesByPath: Map<string, string | null>,
): Promise<DifferingConflictOutcome> {
  if (!conflict.originalPath) {
    // Orphan — Stage 1's sync-stability gate handles these. Stage 2 has
    // nothing to do.
    return { kind: 'not-differing', nextRetryEntries: retryEntries };
  }

  // (1) Re-read + re-hash BOTH files. If conflict is gone, skip cleanly.
  let conflictBytes: Buffer;
  let originalBytes: Buffer;
  try {
    [conflictBytes, originalBytes] = await Promise.all([
      fs.readFile(conflict.absolutePath),
      fs.readFile(conflict.originalPath),
    ]);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.debug(
        { conflictPath: conflict.absolutePath },
        'Conflict or original disappeared before merge attempt; skipping',
      );
      observedHashesByPath.set(conflict.absolutePath, null);
      return { kind: 'not-differing', nextRetryEntries: retryEntries };
    }
    return {
      kind: 'failed',
      nextRetryEntries: retryEntries,
      error: `read failed for ${conflict.absolutePath}: ${toErrMsg(err)}`,
    };
  }

  const conflictHash = hashBytes(conflictBytes);
  const scanTimeOriginalHash = hashBytes(originalBytes);
  observedHashesByPath.set(conflict.absolutePath, conflictHash);

  if (conflictHash === scanTimeOriginalHash) {
    // No longer differing (post-scan write converged them). The startup
    // cleanup pass will have already quarantined; nothing to do here.
    return { kind: 'not-differing', nextRetryEntries: retryEntries };
  }

  // (2) Binary-sniff both files.
  if (
    sniffIsBinary(conflictBytes.subarray(0, BINARY_SNIFF_BYTES)) ||
    sniffIsBinary(originalBytes.subarray(0, BINARY_SNIFF_BYTES))
  ) {
    return { kind: 'skipped-binary', nextRetryEntries: retryEntries };
  }

  // (3) Pre-flight size check (matches `workspaceConflictResolver`'s 100KB cap).
  const MAX_FILE_SIZE_BYTES = 100 * 1024;
  if (
    conflictBytes.byteLength > MAX_FILE_SIZE_BYTES ||
    originalBytes.byteLength > MAX_FILE_SIZE_BYTES
  ) {
    return { kind: 'skipped-too-large', nextRetryEntries: retryEntries };
  }

  // (4) Retry-backoff gate.
  const priorEntry = findEligibleEntry(retryEntries, conflict.absolutePath, conflictHash);
  if (priorEntry) {
    if (priorEntry.status === 'needs-review') {
      return { kind: 'skipped-circuit-breaker', nextRetryEntries: retryEntries };
    }
    if (priorEntry.nextEligibleAt > now()) {
      return { kind: 'skipped-backoff', nextRetryEntries: retryEntries };
    }
  }

  if (dryRun) {
    // Dry-run never touches BTS, fs, or state. We've already charged this
    // as a "would attempt" via the caller's outcome dispatch. Return
    // `merged` so preview counts reflect "Rebel would try to merge this".
    log.debug(
      { conflictPath: conflict.absolutePath },
      '[dry-run] would attempt proposeMerge',
    );
    return { kind: 'merged', nextRetryEntries: retryEntries };
  }

  // (5) LLM merge. `proposeMerge` uses `{ category: 'system' }`; telemetry
  // disambiguates this specific automation via the event we emit.
  // local = original (user's current authoritative content)
  // cloud = conflict file (the divergent sync copy)
  const localContent = originalBytes.toString('utf8');
  const cloudContent = conflictBytes.toString('utf8');

  let mergeResult: Awaited<ReturnType<typeof proposeMerge>>;
  try {
    mergeResult = await proposeMerge(
      settings,
      localContent,
      cloudContent,
      conflict.originalPath,
    );
  } catch (err) {
    const failureMsg = `proposeMerge threw for ${conflict.absolutePath}: ${toErrMsg(err)}`;
    const updated = recordFailure(priorEntry, conflict.absolutePath, conflictHash, failureMsg, now());
    return {
      kind: 'failed',
      nextRetryEntries: upsertEntry(retryEntries, updated),
      error: failureMsg,
    };
  }

  if (!mergeResult.success) {
    const failureMsg = `proposeMerge failed for ${conflict.absolutePath}: ${mergeResult.error}`;
    const updated = recordFailure(priorEntry, conflict.absolutePath, conflictHash, mergeResult.error, now());
    return {
      kind: 'failed',
      nextRetryEntries: upsertEntry(retryEntries, updated),
      error: failureMsg,
    };
  }

  const mergedContent = mergeResult.mergedContent;

  // (6) Size-delta + anchor guards.
  const guard = evaluateMergeGuards(localContent, cloudContent, mergedContent);
  if (!guard.passed) {
    const failureMsg = `merge guard failed (${guard.reason}) for ${conflict.absolutePath}: ${guard.detail ?? ''}`;
    const updated = recordFailure(priorEntry, conflict.absolutePath, conflictHash, failureMsg, now());
    return {
      kind: 'failed',
      nextRetryEntries: upsertEntry(retryEntries, updated),
      error: failureMsg,
    };
  }

  // (7) Atomic write sequence. `conflictHash` is the scan-time conflict
  // hash — we just computed it above after reading the bytes, so it
  // doubles as both "what we expect the conflict to still be" and
  // "scan-time hash" for the journal guard.
  const atomic = await applyAtomicMerge(
    conflict.absolutePath,
    conflict.originalPath,
    conflictHash,
    scanTimeOriginalHash,
    mergedContent,
    journal,
    deps,
    pushError,
    now,
  );

  switch (atomic.outcome) {
    case 'raced':
      return {
        kind: 'aborted-race',
        nextRetryEntries: retryEntries,
        error: atomic.error,
      };
    case 'failed': {
      const updated = recordFailure(
        priorEntry,
        conflict.absolutePath,
        conflictHash,
        atomic.error ?? 'atomic write failed',
        now(),
      );
      return {
        kind: 'failed',
        nextRetryEntries: upsertEntry(retryEntries, updated),
        error: atomic.error,
      };
    }
    case 'merged-with-cleanup-error':
      // The rename succeeded — the file has been merged. Only downstream
      // bookkeeping (journal flip / moveToTrash) failed. Do NOT feed this
      // back into recordFailure: three transient cleanup errors would
      // circuit-break a file that's been merged correctly every time
      // (S2-F2). Clear any prior retry entry and surface the cleanup
      // error on the result.
      return {
        kind: 'merged-with-cleanup-error',
        nextRetryEntries: removeEntry(retryEntries, conflict.absolutePath),
        error: atomic.error,
      };
    case 'merged':
      // Clear the prior retry entry on success — exponential backoff
      // counters should only track consecutive failures.
      return {
        kind: 'merged',
        nextRetryEntries: removeEntry(retryEntries, conflict.absolutePath),
      };
  }
}

interface AtomicMergeOutcome {
  /**
   *   - `merged`                    : happy path — rename + quarantine both clean.
   *   - `merged-with-cleanup-error` : rename committed but a bookkeeping
   *                                   step (journal flip, moveToTrash)
   *                                   failed. Caller treats as success for
   *                                   retry-counter purposes (S2-F2).
   *   - `failed`                    : rename never happened; safe to retry.
   *   - `raced`                     : pre-rename guard caught a writer —
   *                                   aborted without touching original.
   */
  outcome: 'merged' | 'merged-with-cleanup-error' | 'failed' | 'raced';
  error?: string;
}

/**
 * The atomic tmp-write + rename + quarantine sequence. See plan §Stage 2
 * atomic write sequence for the exact step ordering. Journal transitions
 * live BEFORE each filesystem mutation — the journal entry is the only
 * pointer to the in-flight tmp file across crashes.
 */
async function applyAtomicMerge(
  conflictPath: string,
  originalPath: string,
  scanTimeConflictHash: string,
  scanTimeOriginalHash: string,
  mergedContent: string,
  journal: SpaceMaintenanceJournal,
  deps: MaintenanceDeps,
  pushError: (msg: string) => void,
  now: () => number,
): Promise<AtomicMergeOutcome> {
  const tmpPath = `${originalPath}.rebel-merge-tmp`;
  const mergedBuffer = Buffer.from(mergedContent, 'utf8');
  const intendedMergedHash = hashBytes(mergedBuffer);

  // (0) Load journal. If not mutable, abort — we can't durably track state.
  const { state: preJournal, mutable } = await journal.load();
  if (!mutable) {
    return {
      outcome: 'failed',
      error: `journal not mutable (unknown schemaVersion); skipping merge for ${conflictPath}`,
    };
  }
  let workingEntries: JournalEntry[] = [...preJournal.entries];

  const saveJournal = async (): Promise<boolean> => {
    try {
      await journal.save(
        {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          updatedAt: now(),
          entries: workingEntries,
        },
        { nowMs: now() },
      );
      return true;
    } catch (err) {
      pushError(`journal save failed during merge: ${toErrMsg(err)}`);
      return false;
    }
  };

  // (1) Journal rename-pending `pre-tmp` BEFORE writing tmp. All three
  // hashes MUST be persisted — the resume path needs scanTimeOriginalHash
  // to prevent clobbering post-crash writer edits (S2-F1), and
  // scanTimeConflictHash to avoid quarantining a post-crash replacement
  // from cloudWorkspaceSync.
  const journalEntry: RenamePendingEntry = {
    type: 'rename-pending',
    conflictPath,
    originalPath,
    mergedHash: intendedMergedHash,
    scanTimeOriginalHash,
    scanTimeConflictHash,
    stage: 'rename-pending',
    startedAt: now(),
  };
  workingEntries.push(journalEntry);
  if (!(await saveJournal())) {
    workingEntries = workingEntries.filter((e) => e !== journalEntry);
    return { outcome: 'failed', error: 'failed to write rename-pending journal entry' };
  }

  // Helper to drop our entry and persist on any bail-out path.
  const discardEntryAndBail = async (): Promise<void> => {
    workingEntries = workingEntries.filter((e) => e !== journalEntry);
    await saveJournal();
  };

  // (2) Write + fsync tmp.
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(tmpPath, 'w');
    await handle.writeFile(mergedBuffer);
    await handle.sync();
  } catch (err) {
    const msg = `tmp write failed for ${tmpPath}: ${toErrMsg(err)}`;
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    await discardEntryAndBail();
    return { outcome: 'failed', error: msg };
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* ignore */ }
    }
  }

  // (3) Re-read tmp and hash-verify.
  try {
    const tmpBytes = await fs.readFile(tmpPath);
    if (hashBytes(tmpBytes) !== intendedMergedHash) {
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      await discardEntryAndBail();
      return {
        outcome: 'failed',
        error: `tmp hash mismatch after write for ${tmpPath}`,
      };
    }
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    await discardEntryAndBail();
    return { outcome: 'failed', error: `tmp re-read failed: ${toErrMsg(err)}` };
  }

  // (5) Immediately before rename: re-hash the ORIGINAL file. If hash
  // differs from scanTimeOriginalHash, someone raced us — discard tmp.
  try {
    const currentOriginalBytes = await fs.readFile(originalPath);
    if (hashBytes(currentOriginalBytes) !== scanTimeOriginalHash) {
      try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      await discardEntryAndBail();
      return {
        outcome: 'raced',
        error: `original raced for ${originalPath} — hash changed between scan and rename`,
      };
    }
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    await discardEntryAndBail();
    return {
      outcome: 'failed',
      error: `pre-rename re-hash failed for ${originalPath}: ${toErrMsg(err)}`,
    };
  }

  // (6) Journal stage is already `rename-pending`; no-op.
  // (7) Rename — atomic on POSIX and Windows.
  try {
    await fs.rename(tmpPath, originalPath);
  } catch (err) {
    try { await fs.unlink(tmpPath); } catch { /* ignore */ }
    await discardEntryAndBail();
    return { outcome: 'failed', error: `rename failed for ${originalPath}: ${toErrMsg(err)}` };
  }

  // (8) Flip journal to quarantine-pending.
  const quarantineEntry: QuarantinePendingEntry = {
    type: 'quarantine-pending',
    conflictPath,
    expectedHash: scanTimeConflictHash,
    attemptedAt: now(),
  };
  workingEntries = workingEntries.filter((e) => e !== journalEntry);
  workingEntries.push(quarantineEntry);
  if (!(await saveJournal())) {
    // The rename already happened. We can't safely undo it. The merge
    // itself is a success — do NOT count this as a merge failure or three
    // transient journal-save errors would circuit-break a working file
    // (S2-F2). The next run's scan will detect the now-merged-redundant
    // conflict and handle cleanup via the journal resume path.
    return {
      outcome: 'merged-with-cleanup-error',
      error: `journal flip to quarantine-pending failed for ${conflictPath} (rename already applied)`,
    };
  }

  // (9) Belt-and-suspenders: re-hash the renamed file to confirm it
  // matches intendedMergedHash.
  try {
    const postRenameBytes = await fs.readFile(originalPath);
    if (hashBytes(postRenameBytes) !== intendedMergedHash) {
      pushError(
        `post-rename hash drift for ${originalPath} (unexpected — filesystem tampered?)`,
      );
      // Still attempt quarantine — we've merged, leaving the pending
      // entry would only risk repeating on next run.
    }
  } catch (err) {
    pushError(`post-rename re-hash failed for ${originalPath}: ${toErrMsg(err)}`);
  }

  // (10) Immediately before quarantine: re-hash the conflict file. If it
  // changed since scan-time, a writer replaced it during merge latency and
  // we must NOT trash the new bytes.
  try {
    const currentConflictBytes = await fs.readFile(conflictPath);
    if (hashBytes(currentConflictBytes) !== scanTimeConflictHash) {
      workingEntries = workingEntries.filter((e) => e !== quarantineEntry);
      if (!(await saveJournal())) {
        pushError(`journal clear failed after conflict-race guard for ${conflictPath}`);
      }
      return {
        outcome: 'merged-with-cleanup-error',
        error:
          `conflict raced for ${conflictPath} after merge; left on disk for re-classification`,
      };
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Another actor already removed/quarantined the conflict. Treat as
      // success and clear our pending entry.
      workingEntries = workingEntries.filter((e) => e !== quarantineEntry);
      if (!(await saveJournal())) {
        pushError(`journal clear failed after conflict already removed for ${conflictPath}`);
      }
      return { outcome: 'merged' };
    }
    return {
      outcome: 'merged-with-cleanup-error',
      error: `pre-quarantine conflict re-hash failed for ${conflictPath}: ${toErrMsg(err)}`,
    };
  }

  // (11) Quarantine the conflict copy.
  try {
    await deps.moveToTrash(conflictPath);
  } catch (err) {
    // The merge succeeded but the quarantine didn't. Leave the
    // quarantine-pending entry so the next run / resume pass retries.
    // Surface as `merged-with-cleanup-error` so the merge counter
    // still increments (no recordFailure) — S2-F2.
    return {
      outcome: 'merged-with-cleanup-error',
      error: `moveToTrash failed for ${conflictPath} (will retry on next run): ${toErrMsg(err)}`,
    };
  }

  // (12) Clear the journal entry.
  workingEntries = workingEntries.filter((e) => e !== quarantineEntry);
  if (!(await saveJournal())) {
    // Non-fatal: the pending entry will be cleared by the next startup
    // quarantine-resume pass when the file is already gone.
    pushError(`journal clear failed after merge for ${conflictPath}`);
  }

  log.info(
    { conflictPath, originalPath },
    'Merged .conflict-cloud and quarantined the divergent copy',
  );
  return { outcome: 'merged' };
}

/**
 * Resume a `rename-pending` entry on startup.
 *
 * Safety envelope (S2-F1):
 *   - BEFORE completing the rename: re-hash the ORIGINAL file on disk.
 *     If its hash no longer matches `scanTimeOriginalHash`, a writer
 *     (user edit, cloudWorkspaceSync) touched it after the crash —
 *     completing the rename would destroy their bytes. Discard tmp,
 *     drop entry, let the next daily re-classify with a fresh baseline.
 *   - BEFORE quarantining the conflict: re-hash the CONFLICT file. If
 *     its hash no longer matches `scanTimeConflictHash`, cloudWorkspaceSync
 *     has replaced it with a new divergent version — leave it on disk and
 *     drop the stale entry. The next scan reclassifies the new bytes.
 *
 * Branch table:
 *   stage === 'rename-pending':
 *     - tmp gone               -> clear entry (rename already done OR never started)
 *     - tmp hash != mergedHash -> discard tmp, drop entry (crash during write)
 *     - tmp ok + original raced (post-crash write) -> discard tmp, drop entry
 *     - tmp ok + original pristine -> rename; then the conflict branch runs
 *   stage === 'quarantine-pending' (or post-rename quarantine branch):
 *     - conflict file gone                              -> clear entry
 *     - conflict hash matches `scanTimeConflictHash`    -> retry moveToTrash
 *     - conflict hash != `scanTimeConflictHash`         -> drop stale entry
 */
async function resumePendingRename(
  entry: RenamePendingEntry,
  deps: MaintenanceDeps,
  dryRun: boolean,
  pushError: (msg: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;

  const tmpPath = `${entry.originalPath}.rebel-merge-tmp`;

  if (entry.stage === 'rename-pending') {
    let tmpExists = true;
    let tmpBytes: Buffer | null = null;
    try {
      tmpBytes = await fs.readFile(tmpPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        tmpExists = false;
      } else {
        pushError(`resume tmp read failed for ${tmpPath}: ${toErrMsg(err)}`);
        return false;
      }
    }

    if (!tmpExists) {
      log.debug({ tmpPath }, 'Resumed rename-pending: tmp gone, clearing entry');
      return true;
    }

    if (!tmpBytes || hashBytes(tmpBytes) !== entry.mergedHash) {
      log.info(
        { tmpPath, expected: entry.mergedHash },
        'Dropping rename-pending: tmp hash mismatch',
      );
      if (!dryRun) {
        try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      }
      return true;
    }

    if (signal?.aborted) return false;

    // S2-F1 CRITICAL: re-hash the original file on disk before committing
    // the rename. A crash between `applyAtomicMerge`'s step 3 (tmp hash
    // verify) and step 5 (pre-rename re-hash) could leave us with a valid
    // journal entry + valid tmp but no guarantee the original is still
    // the one we merged against. Without this check, a user's post-crash
    // edit would be clobbered.
    try {
      const currentOriginalBytes = await fs.readFile(entry.originalPath);
      if (hashBytes(currentOriginalBytes) !== entry.scanTimeOriginalHash) {
        log.info(
          {
            path: entry.originalPath,
            expected: entry.scanTimeOriginalHash,
          },
          'original_raced_post_crash: dropping rename-pending (next daily re-merges)',
        );
        if (!dryRun) {
          try { await fs.unlink(tmpPath); } catch { /* ignore */ }
        }
        return true;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Original is gone — nothing to preserve, nothing to rename into.
        log.info(
          { path: entry.originalPath },
          'Resumed rename-pending: original missing, dropping entry',
        );
        if (!dryRun) {
          try { await fs.unlink(tmpPath); } catch { /* ignore */ }
        }
        return true;
      }
      pushError(`resume pre-rename hash failed for ${entry.originalPath}: ${toErrMsg(err)}`);
      return false;
    }

    if (dryRun) {
      log.debug({ tmpPath }, '[dry-run] would complete rename-pending');
      return true;
    }

    if (signal?.aborted) return false;

    try {
      await fs.rename(tmpPath, entry.originalPath);
      log.info({ path: entry.originalPath }, 'Resumed rename-pending: rename completed');
    } catch (err) {
      pushError(`resume rename failed for ${entry.originalPath}: ${toErrMsg(err)}`);
      return false;
    }

    if (signal?.aborted) return false;

    // Conflict-side guard BEFORE quarantine (S2-F1): if cloudWorkspaceSync
    // replaced the conflict file with new divergent bytes between the
    // crash and this resume, we must NOT send that replacement to trash —
    // it's fresh user-relevant content.
    try {
      const currentConflictBytes = await fs.readFile(entry.conflictPath);
      if (hashBytes(currentConflictBytes) !== entry.scanTimeConflictHash) {
        log.info(
          {
            path: entry.conflictPath,
            expected: entry.scanTimeConflictHash,
          },
          'Resumed rename-pending: conflict replaced post-crash, skipping quarantine',
        );
        return true;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.debug(
          { path: entry.conflictPath },
          'Resumed rename-pending: conflict already gone',
        );
        return true;
      }
      pushError(`resume conflict-hash read failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
      return true;
    }

    if (signal?.aborted) return false;

    try {
      await deps.moveToTrash(entry.conflictPath);
      log.info(
        { path: entry.conflictPath },
        'Resumed rename-pending: conflict quarantined post-rename',
      );
    } catch (err) {
      pushError(
        `resume quarantine failed for ${entry.conflictPath}: ${toErrMsg(err)}`,
      );
    }

    return true;
  }

  // stage === 'quarantine-pending' on a rename-pending entry: the rename
  // succeeded and we only need to finish the quarantine. Still guard
  // against the cloud-sync-replaced-conflict case.
  if (signal?.aborted) return false;

  try {
    const currentConflictBytes = await fs.readFile(entry.conflictPath);
    if (signal?.aborted) return false;
    if (hashBytes(currentConflictBytes) !== entry.scanTimeConflictHash) {
      log.info(
        { path: entry.conflictPath, expected: entry.scanTimeConflictHash },
        'Resumed quarantine-pending: conflict replaced post-crash, dropping stale entry',
      );
      return true;
    }
  } catch (err) {
    if (signal?.aborted) return false;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      log.debug({ path: entry.conflictPath }, 'Resumed rename-pending/quarantine: file gone, clearing');
      return true;
    }
    pushError(`resume conflict-hash read failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
    return true;
  }

  if (dryRun) {
    log.debug({ path: entry.conflictPath }, '[dry-run] would retry quarantine');
    return true;
  }

  if (signal?.aborted) return false;

  try {
    await deps.moveToTrash(entry.conflictPath);
    return true;
  } catch (err) {
    pushError(`resume quarantine failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
    return true;
  }
}

function hashBytes(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Stage 4: Numbered-copy resolution (Google Drive `File (1).md` etc.)
// ---------------------------------------------------------------------------

/**
 * Pre-flight size check shared by Stage-2 and Stage-4 merge paths. Matches
 * the 100KB cap in `workspaceConflictResolver.MAX_FILE_SIZE_BYTES` so we
 * classify oversized candidates before paying the BTS round-trip.
 */
const NUMBERED_COPY_MAX_FILE_SIZE_BYTES = 100 * 1024;

/**
 * Resolve numbered-copy conflicts with the Stage 4 safety rails:
 *   1. Legacy gate — skip files whose mtime is older than
 *      `LEGACY_DUPLICATE_THRESHOLD_MS`. Persisted as a
 *      `LegacyDuplicateEntry` so we never re-stat them on subsequent runs.
 *   2. Base missing — NEVER auto-rename (per plan §Stage 4 safety rail).
 *      Advance the sync-stability gate (≥3 scans over ≥48h) via a
 *      `NumberedCopyOrphanEntry`; surface as pending-user-review once
 *      the gate passes.
 *   3. Base exists + identical bytes — quarantine the numbered copy via
 *      the same journal-before-trash atomic pattern as Stage 1's
 *      identical-quarantine path.
 *   4. Base exists + differing bytes + not legacy — route through
 *      `processDifferingConflict` so numbered-copy LLM merges inherit
 *      the full Stage-2 atomic rename + retry-backoff + size-delta
 *      + markdown-anchor pipeline.
 *
 * Returns the mutated retry-entries list so the caller can persist it.
 * All counter updates land on `result`.
 */
async function processNumberedCopyConflicts(
  numberedCopies: ConflictFile[],
  settings: AppSettings,
  journal: SpaceMaintenanceJournal,
  retryEntries: ConflictRetryEntry[],
  deps: DailyMaintenanceDeps,
  dryRun: boolean,
  result: MaintenanceResult,
  pushError: (msg: string) => void,
  now: () => number,
  observedHashesByPath: Map<string, string | null>,
): Promise<ConflictRetryEntry[]> {
  const { state: preJournal, mutable: journalMutable } = await journal.load();

  const legacyIndex = new Map<string, LegacyDuplicateEntry>();
  const orphanIndex = new Map<string, NumberedCopyOrphanEntry>();
  for (const e of preJournal.entries) {
    if (e.type === 'legacy-duplicate') legacyIndex.set(e.conflictPath, e);
    if (e.type === 'numbered-copy-orphan') orphanIndex.set(e.conflictPath, e);
  }

  let workingEntries: JournalEntry[] = [...preJournal.entries];
  const classifiedPaths = new Set<string>();
  const nextOrphans: NumberedCopyOrphanEntry[] = [];
  const newLegacyEntries: LegacyDuplicateEntry[] = [];
  let nextRetryEntries = retryEntries;

  const saveJournal = async (): Promise<boolean> => {
    if (dryRun || !journalMutable) return true;
    try {
      await journal.save(
        {
          schemaVersion: JOURNAL_SCHEMA_VERSION,
          updatedAt: now(),
          entries: workingEntries,
        },
        { nowMs: now() },
      );
      return true;
    } catch (err) {
      pushError(`journal save failed during numbered-copy pass: ${toErrMsg(err)}`);
      return false;
    }
  };

  for (const conflict of numberedCopies) {
    classifiedPaths.add(conflict.absolutePath);

    // (1) Previously classified as legacy — skip without any IO beyond
    // the in-memory lookup. Preserves user intent across runs.
    if (legacyIndex.has(conflict.absolutePath)) {
      result.numberedCopyLegacySkipped++;
      continue;
    }

    // (2) Missing base — sync-stability gate. NEVER auto-rename.
    let baseExists = false;
    if (conflict.originalPath) {
      try {
        await fs.access(conflict.originalPath);
        baseExists = true;
      } catch {
        baseExists = false;
      }
    }

    if (!conflict.originalPath || !baseExists) {
      const priorOrphan = orphanIndex.get(conflict.absolutePath);
      const orphanEntry: NumberedCopyOrphanEntry = priorOrphan
        ? {
            ...priorOrphan,
            stableScanCount: priorOrphan.stableScanCount + 1,
            lastSeenAt: now(),
          }
        : {
            type: 'numbered-copy-orphan',
            conflictPath: conflict.absolutePath,
            firstSeenAt: now(),
            stableScanCount: 1,
            lastSeenAt: now(),
          };
      nextOrphans.push(orphanEntry);
      const gatePassed =
        orphanEntry.stableScanCount >= ORPHAN_STABILITY_MIN_SCANS
        && (now() - orphanEntry.firstSeenAt) >= ORPHAN_STABILITY_MIN_AGE_MS;
      if (gatePassed) {
        result.numberedCopyPendingUserReview++;
      } else {
        result.numberedCopyPendingStability++;
      }
      continue;
    }

    // (3) Stat the numbered copy for the legacy gate AND the size cap.
    let stat;
    try {
      stat = await fs.stat(conflict.absolutePath);
    } catch (err) {
      pushError(`numbered-copy stat failed for ${conflict.absolutePath}: ${toErrMsg(err)}`);
      continue;
    }

    const ageMs = now() - stat.mtimeMs;
    if (ageMs > LEGACY_DUPLICATE_THRESHOLD_MS) {
      result.numberedCopyLegacySkipped++;
      const entry: LegacyDuplicateEntry = {
        type: 'legacy-duplicate',
        conflictPath: conflict.absolutePath,
        fileMtimeMs: stat.mtimeMs,
        classifiedAt: now(),
      };
      newLegacyEntries.push(entry);
      log[dryRun ? 'debug' : 'info'](
        { path: conflict.absolutePath, mtimeMs: stat.mtimeMs, ageDays: Math.round(ageMs / (24 * 60 * 60 * 1000)) },
        dryRun ? '[dry-run] would classify numbered copy as legacy-duplicate' : 'Classified numbered copy as legacy-duplicate',
      );
      continue;
    }

    // (4) Binary + hash classification via the shared classifier.
    // Orphan branch is unreachable here (we already handled missing base).
    const classification = await classifyConflictCloud(conflict.absolutePath, conflict.originalPath);

    if (classification.status === 'binary') {
      result.numberedCopySkippedBinary++;
      continue;
    }

    if (
      classification.status === 'identical'
      && classification.conflictHash
    ) {
      // Pre-flight size cap before the destructive path runs.
      if (stat.size > NUMBERED_COPY_MAX_FILE_SIZE_BYTES) {
        // Identical-oversize is benign — we don't need an LLM to quarantine
        // a byte-identical copy — but we keep the counter accurate.
        // Quarantine still proceeds (no LLM call).
      }

      if (dryRun) {
        result.numberedCopyQuarantinedIdentical++;
        log.debug(
          { path: conflict.absolutePath },
          '[dry-run] would quarantine identical numbered copy',
        );
        continue;
      }

      const outcome = await quarantineIdentical(
        conflict.absolutePath,
        conflict.originalPath,
        classification.conflictHash,
        classification.originalHash,
        deps,
        dryRun,
        pushError,
        now,
        async (entry) => {
          workingEntries.push(entry);
          return saveJournal();
        },
        async (entryRef) => {
          workingEntries = workingEntries.filter((e) => e !== entryRef);
          return saveJournal();
        },
      );

      if (outcome === 'quarantined') {
        result.numberedCopyQuarantinedIdentical++;
      }
      continue;
    }

    if (classification.status === 'differing') {
      // Pre-flight size cap — keep counters honest even before
      // processDifferingConflict's own check runs.
      if (stat.size > NUMBERED_COPY_MAX_FILE_SIZE_BYTES) {
        result.numberedCopySkippedTooLarge++;
        continue;
      }
      try {
        const baseStat = await fs.stat(conflict.originalPath);
        if (baseStat.size > NUMBERED_COPY_MAX_FILE_SIZE_BYTES) {
          result.numberedCopySkippedTooLarge++;
          continue;
        }
      } catch (err) {
        pushError(`numbered-copy base stat failed for ${conflict.originalPath}: ${toErrMsg(err)}`);
        continue;
      }

      if (dryRun) {
        // Mirror Stage 2's dry-run preview contract: we would attempt
        // the merge, count it as a preview success without calling BTS.
        result.numberedCopyMerged++;
        log.debug(
          { path: conflict.absolutePath },
          '[dry-run] would attempt numbered-copy LLM merge',
        );
        continue;
      }

      const outcome = await processDifferingConflict(
        conflict,
        settings,
        journal,
        nextRetryEntries,
        deps,
        dryRun,
        pushError,
        now,
        observedHashesByPath,
      );

      nextRetryEntries = outcome.nextRetryEntries;
      if (outcome.error) pushError(outcome.error);

      switch (outcome.kind) {
        case 'merged':
        case 'merged-with-cleanup-error':
          result.numberedCopyMerged++;
          break;
        case 'skipped-binary':
          result.numberedCopySkippedBinary++;
          break;
        case 'skipped-too-large':
          result.numberedCopySkippedTooLarge++;
          break;
        case 'skipped-backoff':
          result.mergeSkippedBackoff++;
          break;
        case 'skipped-circuit-breaker':
          result.mergeSkippedCircuitBreaker++;
          break;
        case 'aborted-race':
          result.mergeAbortedRace++;
          break;
        case 'failed':
          result.mergeFailed++;
          break;
        case 'not-differing':
          // Post-scan convergence — nothing to count.
          break;
      }
      continue;
    }
    // Unreachable: all classification statuses handled above.
  }

  // Build the final journal state. Legacy entries are purely additive;
  // numbered-copy orphan entries use the same preserve-or-replace pattern
  // as Stage 1 orphan-candidates so a slow-FS time-budget bail in a
  // future scan doesn't reset counters for paths we did NOT classify.
  const preservedOrphans = preJournal.entries.filter(
    (e): e is NumberedCopyOrphanEntry =>
      e.type === 'numbered-copy-orphan' && !classifiedPaths.has(e.conflictPath),
  );

  workingEntries = [
    ...workingEntries.filter(
      (e) => e.type !== 'numbered-copy-orphan' && e.type !== 'legacy-duplicate',
    ),
    // Preserve legacy entries already on disk + merge with newly classified ones.
    ...preJournal.entries.filter((e): e is LegacyDuplicateEntry => e.type === 'legacy-duplicate'),
    ...newLegacyEntries,
    ...preservedOrphans,
    ...nextOrphans,
  ];

  if (!dryRun && journalMutable) {
    await saveJournal();
  }

  return nextRetryEntries;
}

// ---------------------------------------------------------------------------

/**
 * Append `count` resolution-log entries AND bump the singleton
 * resolution-counter entry. Returns the mutated list; callers persist
 * via their usual `journal.save()` path. The caller is responsible for
 * honouring dry-run + journal-mutability invariants — this function
 * MUST NOT be called in dry-run mode or when the journal isn't mutable.
 *
 * Prune-on-save in the journal takes care of the 24h sliding window, so
 * we can blindly append here.
 */
function appendResolutionLog(
  entries: JournalEntry[],
  count: number,
  kind: ResolutionLogEntry['kind'],
  nowMs: number,
): JournalEntry[] {
  if (count <= 0) return entries;

  const logs: ResolutionLogEntry[] = [];
  for (let i = 0; i < count; i++) {
    logs.push({ type: 'resolution-log', resolvedAt: nowMs, kind });
  }

  // Singleton ResolutionCounterEntry — atomic replace-or-create.
  let existingTotal = 0;
  const withoutCounter = entries.filter((e) => {
    if (e.type === 'resolution-counter') {
      existingTotal = e.total;
      return false;
    }
    return true;
  });

  const counter: ResolutionCounterEntry = {
    type: 'resolution-counter',
    total: existingTotal + count,
    updatedAt: nowMs,
  };

  return [...withoutCounter, ...logs, counter];
}

// ---------------------------------------------------------------------------
// Stage 3: Frontmatter Repair
// ---------------------------------------------------------------------------

/**
 * Outcome counters for `repairBrokenFrontmatter`. `checked` counts only
 * files that actually had a YAML parse error at the start of the run —
 * healthy files don't pay anything here.
 */
export interface FrontmatterRepairResult {
  /** Files identified with a YAML parse error. Healthy files are not counted. */
  checked: number;
  /** Files fixed via the deterministic mechanical layer (no LLM call). */
  repairedMechanical: number;
  /** Files fixed via the LLM fallback after the mechanical layer came up short. */
  repairedLLM: number;
  /** Files that could not be repaired by either layer. */
  unrepairable: number;
  errors: string[];
}

export interface FrontmatterRepairOptions {
  dryRun?: boolean;
  now?: () => number;
}

/** Max size of a README.md file we'll send any part of to the LLM. */
const FRONTMATTER_REPAIR_MAX_FILE_BYTES = 100 * 1024;
const FRONTMATTER_REPAIR_LLM_MAX_TOKENS = 2048;
const FRONTMATTER_REPAIR_LLM_TIMEOUT_MS = 30_000;

/**
 * Repair broken YAML frontmatter in non-private shared spaces.
 *
 * Strategy:
 *   1. Walk `settings.spaces` (non-private only) and locate each space's
 *      README.md (or legacy AGENTS.md). Private spaces are local-only
 *      and out of scope.
 *   2. Read raw bytes. Use the shared `fm` parser to detect YAML parse
 *      errors. Valid-YAML-but-schema-incomplete files are skipped —
 *      this repair layer is strictly for parser-level breakage.
 *   3. First try `tryMechanicalFrontmatterRepair`. Body bytes are
 *      preserved verbatim through `splitFrontmatter` + `reassembleFile`
 *      reconstruction (not re-emitted from a model).
 *   4. On mechanical miss, fall back to an LLM repair that receives
 *      ONLY the frontmatter text (never the body). The response is
 *      validated against the original via `compareFrontmatterFidelity`
 *      (key-set superset + deep-equal values modulo date/whitespace
 *      normalisation); reject on any regression.
 *   5. Write via tmp + fsync + hash-verify + rename. Re-validate the
 *      renamed file with `fm()`; rollback to the original bytes if the
 *      repair did not in fact parse on disk.
 *
 * Dry-run contract: zero LLM calls, zero fs writes, zero journal writes.
 * `checked` and the two repair counters still reflect the preview view
 * (they count "would have tried" and "would have succeeded" respectively).
 *
 * The `journal` parameter is accepted for API symmetry with Stages 1 & 2
 * but this stage does not currently persist journal entries — mechanical
 * repair is idempotent and the LLM path is either committed (atomic
 * rename) or rolled back in-process, so a mid-run crash leaves the file
 * recoverable by the next run.
 */
export async function repairBrokenFrontmatter(
  coreDirectory: string,
  settings: AppSettings,
  _journal: SpaceMaintenanceJournal,
  options: FrontmatterRepairOptions = {},
): Promise<FrontmatterRepairResult> {
  const dryRun = options.dryRun === true;
  const now = options.now ?? Date.now;
  const result: FrontmatterRepairResult = {
    checked: 0,
    repairedMechanical: 0,
    repairedLLM: 0,
    unrepairable: 0,
    errors: [],
  };

  const pushError = (msg: string) => {
    if (dryRun) {
      log.debug({ msg }, '[dry-run] suppressed frontmatter-repair error');
      return;
    }
    result.errors.push(msg);
  };

  const spaces: SpaceConfig[] = settings.spaces ?? [];
  const candidates = spaces
    .filter((s) => s.sharing && s.sharing !== 'private')
    .map((s) => {
      const abs = path.isAbsolute(s.path) ? s.path : path.join(path.resolve(coreDirectory), s.path);
      return path.resolve(abs);
    });

  if (candidates.length === 0) {
    log[dryRun ? 'debug' : 'info']({}, 'Frontmatter repair: no non-private shared spaces to scan');
    return result;
  }

  for (const spacePath of candidates) {
    const resolved = await findSpaceReadmeWithParseError(spacePath);
    if (!resolved) continue;

    result.checked++;
    const { filePath, bytes, parseError } = resolved;

    if (bytes.byteLength > FRONTMATTER_REPAIR_MAX_FILE_BYTES) {
      pushError(`${filePath}: file too large (${bytes.byteLength} bytes) for frontmatter repair`);
      result.unrepairable++;
      continue;
    }

    const originalContent = bytes.toString('utf8');

    // (1) Mechanical repair.
    let mechanical;
    try {
      mechanical = tryMechanicalFrontmatterRepair(originalContent);
    } catch (err) {
      pushError(`${filePath}: mechanical repair threw: ${toErrMsg(err)}`);
      result.unrepairable++;
      continue;
    }

    if (mechanical.repaired) {
      if (dryRun) {
        log.debug(
          { filePath, appliedFixes: mechanical.appliedFixes },
          '[dry-run] would apply mechanical frontmatter repair',
        );
        result.repairedMechanical++;
        continue;
      }

      const writeOk = await writeAndReValidate(filePath, bytes, mechanical.newContent, pushError);
      if (writeOk) {
        result.repairedMechanical++;
        log.info(
          { filePath, appliedFixes: mechanical.appliedFixes },
          'Mechanically repaired frontmatter',
        );
      } else {
        result.unrepairable++;
      }
      continue;
    }

    // (2) LLM fallback. Strict gate: the mechanical layer exhausted all
    // deterministic options and the file's YAML still fails to parse
    // (initial parse error was detected above and mechanical didn't
    // produce a parseable result).
    const split = splitFrontmatter(bytes);
    if (!split || !split.hasOpenDelimiter) {
      // No opening `---` — not our repair candidate. The schema path
      // (addDescriptionToFrontmatter) handles frontmatter insertion.
      log.debug({ filePath }, 'Skipping LLM repair: file has no frontmatter delimiters');
      result.unrepairable++;
      continue;
    }

    if (dryRun) {
      log.debug({ filePath, parseError }, '[dry-run] would invoke LLM frontmatter repair');
      // Preview-count as "would succeed" — callers reading the dry-run
      // result can differentiate via the explicit `dryRun` flag passed
      // in at the top-level maintenance call.
      result.repairedLLM++;
      continue;
    }

    const llm = await callLLMFrontmatterRepair(settings, split.frontmatterText, filePath, now());
    if (!llm.success) {
      pushError(`${filePath}: LLM repair failed: ${llm.error}`);
      result.unrepairable++;
      continue;
    }

    const fidelity = compareFrontmatterFidelity(split.frontmatterText, llm.fixedFrontmatterText);
    if (!fidelity.ok) {
      pushError(
        `${filePath}: LLM repair rejected (${fidelity.reason}): ${fidelity.detail ?? ''}`,
      );
      result.unrepairable++;
      continue;
    }

    // Rebuild the file with the LLM-fixed frontmatter + byte-exact body.
    const reassembled = reassembleFile(split, llm.fixedFrontmatterText);
    const writeOk = await writeAndReValidate(filePath, bytes, reassembled, pushError);
    if (writeOk) {
      result.repairedLLM++;
      log.info({ filePath }, 'Repaired frontmatter via LLM fallback');
    } else {
      result.unrepairable++;
    }
  }

  log[dryRun ? 'debug' : 'info'](
    { ...result, dryRun },
    dryRun ? '[dry-run] frontmatter repair pass' : 'Frontmatter repair pass complete',
  );
  return result;
}

/**
 * Look for a space's README.md (or legacy AGENTS.md) that has a YAML
 * parse error. Returns the bytes + the error message so the caller can
 * attempt repair without re-reading the file. Returns `null` when:
 *   - no config file exists;
 *   - the config file's frontmatter parses cleanly (no repair needed).
 */
async function findSpaceReadmeWithParseError(
  spacePath: string,
): Promise<{ filePath: string; bytes: Buffer; parseError: string } | null> {
  const candidates = [
    path.join(spacePath, 'README.md'),
    path.join(spacePath, 'AGENTS.md'),
  ];
  for (const filePath of candidates) {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(filePath);
    } catch {
      continue;
    }
    try {
      // `fm` throws on YAML parse errors; attributes === undefined when
      // there's no frontmatter at all (valid markdown doc, no delimiters)
      // — that's NOT a repair candidate (Stage 3 is for damaged-but-
      // present frontmatter only).
      const parsed = fm(bytes.toString('utf8'));
      if (!parsed.attributes || typeof parsed.attributes !== 'object') return null;
      return null;
    } catch (err) {
      return {
        filePath,
        bytes,
        parseError: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return null;
}

/**
 * Thin wrapper around the shared `atomicWriteWithReValidate` helper in
 * `frontmatterRepair.ts`. Centralising the tmp + fsync + rename + re-parse
 * sequence means both the scan-side auto-fix and the daily pipeline write
 * identical bytes through identical guards — no crash-recovery drift.
 *
 * `pushError` is routed to the helper's `onError` sink so the existing
 * `result.errors` surface is preserved byte-for-byte.
 */
async function writeAndReValidate(
  filePath: string,
  originalBytes: Buffer,
  newContent: Buffer | string,
  pushError: (msg: string) => void,
): Promise<boolean> {
  return atomicWriteWithReValidate(filePath, originalBytes, newContent, {
    onError: pushError,
  });
}

/**
 * LLM-backed YAML syntax repair. The model receives ONLY the frontmatter
 * text — never the body, never the file delimiters, never any other part
 * of the file. Enforced via the caller's `splitFrontmatter` result.
 *
 * Uses the auxiliary role (same as `proposeMerge`) and tracks cost under
 * `{ category: 'system' }`. The `TrackingOptions` type deliberately has
 * no `subcategory` field — telemetry properties disambiguate per-
 * automation spend downstream.
 */
async function callLLMFrontmatterRepair(
  settings: AppSettings,
  frontmatterText: string,
  filePath: string,
  _now: number,
): Promise<{ success: true; fixedFrontmatterText: string } | { success: false; error: string }> {
  const system = [
    'You are a strict YAML syntax repair utility.',
    'You will receive a broken YAML frontmatter fragment (no `---` delimiters).',
    'Your job: produce a minimal, syntactically valid YAML fragment that preserves',
    'every key and its value exactly as provided. Rules:',
    '- Do NOT add, rename, remove, or reorder keys.',
    '- Do NOT invent values or fill in missing data.',
    '- Do NOT include the `---` delimiters.',
    '- Do NOT wrap your output in code fences or prose.',
    'Return ONLY the repaired YAML inside <FIXED_YAML> and </FIXED_YAML> tags.',
  ].join('\n');

  const userPrompt = [
    `File path (context only; ignore for content): ${filePath}`,
    '',
    '<BROKEN_YAML>',
    frontmatterText,
    '</BROKEN_YAML>',
    '',
    'Return the fixed YAML inside <FIXED_YAML> and </FIXED_YAML> tags.',
  ].join('\n');

  try {
    const response = await callWithModelAuthAware(
      settings,
      settings.modelRoles?.auxiliary,
      {
        codexConnectivity: resolveCodexConnectivity(),
        system,
        messages: [{ role: 'user', content: userPrompt }],
        maxTokens: FRONTMATTER_REPAIR_LLM_MAX_TOKENS,
        timeout: FRONTMATTER_REPAIR_LLM_TIMEOUT_MS,
      },
      { category: 'system' },
    );

    const text = response.content
      .filter((i) => i.type === 'text' && typeof i.text === 'string')
      .map((i) => i.text ?? '')
      .join('\n')
      .trim();

    if (!text) return { success: false, error: 'empty LLM response' };

    const extracted = extractTaggedText(text, 'FIXED_YAML');
    if (extracted === null) return { success: false, error: 'response missing <FIXED_YAML> tags' };
    if (extracted.length === 0) return { success: false, error: 'LLM returned empty fixed YAML' };

    return { success: true, fixedFrontmatterText: extracted };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function extractTaggedText(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi');
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = (m[1] ?? '').replace(/^\s*\n/, '').replace(/\n\s*$/, '');
  }
  return last;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Resolve absolute paths of every non-private shared space. Unlike
 * `resolveSearchRoots`, this does NOT fall back to the whole core
 * directory when no shared spaces are configured — the lease only
 * belongs in a space that's actually synced across desktops.
 */
function resolveNonPrivateSharedSpacePaths(
  coreDirectory: string,
  settings: AppSettings,
): string[] {
  const resolvedCore = path.resolve(coreDirectory);
  const spaces: SpaceConfig[] = settings.spaces ?? [];
  const nonPrivate = spaces.filter((space) => space.sharing && space.sharing !== 'private');
  const roots = new Set<string>();
  for (const space of nonPrivate) {
    const abs = path.isAbsolute(space.path) ? space.path : path.join(resolvedCore, space.path);
    roots.add(path.resolve(abs));
  }
  return Array.from(roots);
}

/**
 * Default lease acquisition for `runDailyMaintenance`. Acquires a lease
 * in every non-private shared space configured in `settings.spaces`. If
 * any space reports contention OR the filesystem rejects the write, we
 * release whatever we've already acquired and return `acquired: false`
 * so the run can short-circuit cleanly.
 *
 * When no shared spaces are configured (single-desktop / local-only
 * setup), we trivially succeed with a no-op release — the lease isn't
 * meaningful without a shared filesystem to coordinate over.
 */
async function acquireDefaultLeases(
  coreDirectory: string,
  settings: AppSettings,
  now: () => number,
): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  const sharedSpacePaths = resolveNonPrivateSharedSpacePaths(coreDirectory, settings);
  if (sharedSpacePaths.length === 0) {
    return { acquired: true, release: async () => { /* no shared space; nothing to release */ } };
  }

  const acquired: Lease[] = [];
  const releaseAll = async (): Promise<void> => {
    await Promise.all(
      acquired.map((lease) =>
        releaseLease(lease).catch((err) =>
          log.warn(
            { leasePath: lease.leasePath, err: toErrMsg(err) },
            'lease release failed (will expire naturally)',
          ),
        ),
      ),
    );
  };

  for (const spacePath of sharedSpacePaths) {
    let result: Awaited<ReturnType<typeof acquireSharedSpaceLease>>;
    try {
      result = await acquireSharedSpaceLease(spacePath, { now });
    } catch (err) {
      // Filesystem error (unmounted share, permission problem). Treat
      // as contended so we don't destructively mutate shared content we
      // can't even touch reliably. The next daily run will retry.
      log.warn(
        { spacePath, err: toErrMsg(err) },
        'space-maintenance: lease acquire threw; treating as contended and skipping run',
      );
      await releaseAll();
      return { acquired: false, release: async () => { /* nothing acquired */ } };
    }

    if (!result.acquired) {
      await releaseAll();
      return { acquired: false, release: async () => { /* nothing acquired */ } };
    }
    acquired.push(result.lease);
  }

  return {
    acquired: true,
    release: async () => {
      await releaseAll();
    },
  };
}

/**
 * Choose which roots to scan. When the user has configured non-private
 * shared spaces, scan each one. When no shared spaces are configured, fall
 * back to the whole core directory so the health-check parity is preserved
 * (the existing check walks the whole library). Private spaces are still
 * skipped — they're the user's local-only workspace and aren't at risk of
 * cloud-sync conflicts.
 */
function resolveSearchRoots(coreDirectory: string, settings: AppSettings): string[] {
  const resolvedCore = path.resolve(coreDirectory);
  const spaces: SpaceConfig[] = settings.spaces ?? [];

  const nonPrivate = spaces.filter((space) => space.sharing && space.sharing !== 'private');
  if (nonPrivate.length === 0) {
    return [resolvedCore];
  }

  const roots = new Set<string>();
  for (const space of nonPrivate) {
    const abs = path.isAbsolute(space.path) ? space.path : path.join(resolvedCore, space.path);
    roots.add(path.resolve(abs));
  }
  return Array.from(roots);
}

function buildOrphanIndex(state: JournalState): Map<string, OrphanCandidateEntry> {
  const index = new Map<string, OrphanCandidateEntry>();
  for (const entry of state.entries) {
    if (entry.type === 'orphan-candidate') {
      index.set(entry.conflictPath, entry);
    }
  }
  return index;
}

function advanceOrphanState(
  conflictPath: string,
  index: Map<string, OrphanCandidateEntry>,
  nowMs: number,
): OrphanCandidateEntry {
  const prior = index.get(conflictPath);
  if (!prior) {
    return {
      type: 'orphan-candidate',
      conflictPath,
      firstSeenAt: nowMs,
      stableScanCount: 1,
      lastSeenAt: nowMs,
    };
  }
  return {
    ...prior,
    stableScanCount: prior.stableScanCount + 1,
    lastSeenAt: nowMs,
  };
}

interface WalkForConflictsOptions {
  /** `null` disables the per-directory cap (one-off bulk cleanup). */
  maxEntriesPerDir: number | null;
  /** Walk entries in sorted order for a deterministic snapshot. */
  sortEntries: boolean;
  signal?: AbortSignal;
}

/**
 * Resolve a symlinked directory's real path and confirm it still resolves
 * INSIDE `rootPath` (Safety Contract §7 / DA D3). Returns `null` when the
 * link escapes the space root or cannot be resolved — the caller then skips
 * it. Mirrors the realpath/containment guard `cloudWorkspaceSync` uses, but
 * the containment target here is the space root (not the home-dir sensitive
 * list) because the bulk walk must never follow a link out of the space.
 */
async function resolveContainedSymlinkDir(
  absolutePath: string,
  rootPath: string,
): Promise<string | null> {
  try {
    const real = await fs.realpath(absolutePath);
    const realRoot = await fs.realpath(rootPath);
    if (real === realRoot || real.startsWith(realRoot + path.sep)) {
      return real;
    }
    log.debug({ path: absolutePath, target: real }, 'Skipping symlink escaping space root');
    return null;
  } catch {
    return null;
  }
}

// bounded-walker-pending: see docs/plans/260503_s9_bounded_walker_resource_budget.md
async function walkForConflicts(
  rootPath: string,
  currentPath: string,
  depth: number,
  out: ConflictFile[],
  orphanIndex: Map<string, OrphanCandidateEntry>,
  deadline: number,
  now: () => number,
  options: WalkForConflictsOptions,
): Promise<void> {
  const { maxEntriesPerDir, sortEntries, signal } = options;
  if (depth > MAX_DEPTH) return;
  if (signal?.aborted) return;
  if (now() >= deadline) return;

  let entries: Array<import('node:fs').Dirent>;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }
  if (signal?.aborted) return;

  if (sortEntries) {
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const capped = maxEntriesPerDir === null ? entries : entries.slice(0, maxEntriesPerDir);

  for (const entry of capped) {
    if (signal?.aborted) return;
    if (now() >= deadline) return;

    const name = entry.name;
    // F8: honor the shared sync-exclusion set (incl. `conflicts-cleanup`,
    // `tool-outputs`) in addition to dot-dirs, so the conflict scanner never
    // re-detects what cleanup quarantined even if the quarantine moves out of
    // a dot-dir in future.
    if (name.startsWith('.') || name === 'node_modules' || ALWAYS_SKIP_DIRS.has(name)) continue;

    const absolutePath = path.join(currentPath, name);

    if (entry.isDirectory() || entry.isSymbolicLink()) {
      // Symlink-escape guard (Safety Contract §7): never follow a directory
      // symlink that resolves outside the space root.
      if (entry.isSymbolicLink()) {
        const contained = await resolveContainedSymlinkDir(absolutePath, rootPath);
        if (contained === null) continue;
      }
      await walkForConflicts(
        rootPath,
        absolutePath,
        depth + 1,
        out,
        orphanIndex,
        deadline,
        now,
        options,
      );
      continue;
    }
    if (!entry.isFile()) continue;

    for (const pattern of CONFLICT_PATTERNS) {
      if (!pattern.regex.test(name)) continue;
      const originalPath = deriveOriginalPath(absolutePath, pattern.label);
      const priorOrphan = orphanIndex.get(absolutePath);
      out.push({
        absolutePath,
        relativePath: path.relative(rootPath, absolutePath),
        label: pattern.label,
        provider: pattern.provider,
        originalPath,
        status: 'pending-review',
        firstSeenAt: priorOrphan?.firstSeenAt ?? now(),
        stableScanCount: priorOrphan?.stableScanCount ?? 0,
      });
      break; // one match per file is enough
    }
  }
}

/**
 * Outcome of an identical-quarantine attempt:
 *   - `quarantined`: file was (or in dry-run: would be) moved to trash
 *   - `skipped`   : conflict file is gone (no-op soft success)
 *   - `aborted`   : mid-flight race, hash mismatch, or `moveToTrash` failed
 *                   (caller pushes to `remainingConflicts`)
 */
type QuarantineOutcome = 'quarantined' | 'skipped' | 'aborted';

/**
 * Attempt to quarantine a byte-identical `.conflict-cloud` file.
 *
 * Guard sequence:
 *   1. Existence probe (`fs.access`): if gone, return `skipped`.
 *   2. Re-hash BOTH conflict and original and compare to the
 *      classification-time hashes (F7 — detect mid-flight writes from
 *      `cloudWorkspaceSync`). Hash mismatch on either file -> abort.
 *   3. Journal a `quarantine-pending` entry (F8) so a crash between the
 *      move and the save is resumable. Skipped in dry-run / !mutable.
 *   4. `deps.moveToTrash` -> on success, clear the journal entry.
 *
 * `writePending` and `clearPending` are called with the journal entry (or
 * its identity reference) so the caller can mutate the journal working set
 * without this function needing to know about the outer state.
 */
async function quarantineIdentical(
  conflictPath: string,
  originalPath: string,
  expectedConflictHash: string,
  expectedOriginalHash: string | undefined,
  deps: MaintenanceDeps,
  dryRun: boolean,
  pushError: (msg: string) => void,
  now: () => number,
  writePending: (entry: QuarantinePendingEntry) => Promise<boolean>,
  clearPending: (entry: QuarantinePendingEntry) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<QuarantineOutcome> {
  if (signal?.aborted) return 'aborted';

  // (1) Existence check — the conflict may have been removed by another
  // writer (cloud sync, the user, a concurrent Rebel process) since the
  // scan picked it up.
  try {
    await fs.access(conflictPath);
  } catch {
    log.debug({ path: conflictPath }, 'Conflict file no longer present before quarantine');
    return 'skipped';
  }

  if (signal?.aborted) return 'aborted';

  // (2) Re-hash conflict + original before the destructive op. The
  // original must still match its classification-time hash so we can
  // trust it represents the user's authoritative content. The conflict
  // must still match so we know we're trashing bytes we already verified
  // as identical (F7).
  try {
    const currentConflictHash = await hashFile(conflictPath);
    if (signal?.aborted) return 'aborted';
    if (currentConflictHash !== expectedConflictHash) {
      pushError(
        `hash changed during quarantine window for ${conflictPath} (conflict side mutated)`,
      );
      log.warn(
        { path: conflictPath, expected: expectedConflictHash, actual: currentConflictHash },
        'Aborting quarantine: conflict file mutated between classify and quarantine',
      );
      return 'aborted';
    }
  } catch (err) {
    pushError(`pre-quarantine hash failed for ${conflictPath}: ${toErrMsg(err)}`);
    return 'aborted';
  }

  if (signal?.aborted) return 'aborted';

  if (expectedOriginalHash !== undefined) {
    try {
      const currentOriginalHash = await hashFile(originalPath);
      if (signal?.aborted) return 'aborted';
      if (currentOriginalHash !== expectedOriginalHash) {
        pushError(
          `hash changed during quarantine window for ${originalPath} (original side mutated)`,
        );
        log.warn(
          { path: originalPath, expected: expectedOriginalHash, actual: currentOriginalHash },
          'Aborting quarantine: original file mutated between classify and quarantine',
        );
        return 'aborted';
      }
    } catch (err) {
      pushError(`pre-quarantine hash failed for ${originalPath}: ${toErrMsg(err)}`);
      return 'aborted';
    }
  }

  if (signal?.aborted) return 'aborted';

  if (dryRun) {
    log.debug({ path: conflictPath }, '[dry-run] would quarantine identical conflict');
    return 'quarantined';
  }

  // (3) Journal the pending entry BEFORE the destructive op.
  const pending: QuarantinePendingEntry = {
    type: 'quarantine-pending',
    conflictPath,
    expectedHash: expectedConflictHash,
    attemptedAt: now(),
  };
  const pendingSaved = await writePending(pending);
  if (!pendingSaved) {
    // Journal save failed — don't proceed. `writePending` already pushed
    // the error via pushError.
    return 'aborted';
  }

  if (signal?.aborted) {
    await clearPending(pending);
    return 'aborted';
  }

  try {
    await deps.moveToTrash(conflictPath);
    log.info({ path: conflictPath }, 'Quarantined identical conflict to trash');
  } catch (err) {
    pushError(`moveToTrash failed for ${conflictPath}: ${toErrMsg(err)}`);
    // Clear the pending entry — the next run will re-scan and attempt
    // again on its own terms.
    await clearPending(pending);
    return 'aborted';
  }

  // (4) Clear the pending entry now that the file is safely in trash.
  await clearPending(pending);
  return 'quarantined';
}

/**
 * Resume-on-startup for a `quarantine-pending` entry that survived from a
 * previous crashed run. Returns `true` when the entry has been resolved
 * (caller should drop it from the journal), `false` when it should stay.
 *
 *   - File gone -> the previous run's `moveToTrash` succeeded; the crash
 *     was after the trash call but before the "clear entry" save. Drop.
 *   - File present, hash matches `expectedHash` -> retry the move.
 *     On success, drop. On failure, drop and let the next scan reclassify.
 *   - File present, hash differs -> `cloudWorkspaceSync` replaced the file
 *     mid-flight; drop the stale entry and let the next scan reclassify.
 */
async function resumePendingQuarantine(
  entry: QuarantinePendingEntry,
  deps: MaintenanceDeps,
  dryRun: boolean,
  pushError: (msg: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;

  try {
    await fs.access(entry.conflictPath);
  } catch {
    // File is gone — previous quarantine succeeded; the crash was after
    // the trash call. Safe to clear the entry.
    log.debug({ path: entry.conflictPath }, 'Resumed quarantine-pending entry: file gone, clearing');
    return true;
  }

  if (signal?.aborted) return false;

  // File still present — re-hash and see if it still matches.
  let currentHash: string;
  try {
    currentHash = await hashFile(entry.conflictPath);
  } catch (err) {
    pushError(`resume hash failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
    ignoreBestEffortCleanup(err, {
      operation: 'spaceMaintenance.resumePendingQuarantine.rehash',
      reason: 'conflict file unreadable during resume; leaving entry for the next run to retry',
    });
    // Leave the entry in place for the next run to retry.
    return false;
  }

  if (signal?.aborted) return false;

  if (currentHash !== entry.expectedHash) {
    // Something replaced the conflict file between the previous run's
    // write and now. The stale entry is no longer authoritative — drop
    // it and let the normal scan reclassify fresh content.
    log.info(
      { path: entry.conflictPath, expected: entry.expectedHash, actual: currentHash },
      'Dropping stale quarantine-pending entry: conflict file hash changed',
    );
    return true;
  }

  if (dryRun) {
    log.debug({ path: entry.conflictPath }, '[dry-run] would retry pending quarantine');
    // Treat as resolved in the in-memory sense so dry-run stays side-effect
    // free; nothing is actually persisted.
    return true;
  }

  if (signal?.aborted) return false;

  try {
    await deps.moveToTrash(entry.conflictPath);
    log.info({ path: entry.conflictPath }, 'Retried pending quarantine to trash');
    return true;
  } catch (err) {
    pushError(`resume moveToTrash failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
    // Drop the entry anyway — the next scan will reclassify and attempt
    // again with fresh hashes, avoiding a wedged entry.
    return true;
  }
}

/**
 * Resume a crashed REBEL-62A one-off cleanup MOVE (F1). This is the
 * kill-by-construction counterpart to `resumePendingQuarantine`: it NEVER
 * calls `moveToTrash` and NEVER `fs.unlink`s. The disposition is always
 * "complete the same in-workspace move into the quarantine folder", honouring
 * Safety Contract §3 even when the recovery runs from the daily/startup path.
 *
 *   - source gone   -> the move completed before the crash; drop the entry.
 *   - source present, hash matches `expectedHash` -> finish the no-overwrite
 *     move into `destPath`. On success, drop. On failure, leave the source in
 *     place + record + drop (next detect run re-plans with fresh hashes).
 *   - source present, hash differs -> a writer replaced it mid-flight; the
 *     stale entry is no longer authoritative. Drop + leave the file alone.
 *
 * Returns `true` when the entry has been resolved (caller drops it).
 */
async function resumeCleanupMovePending(
  entry: CleanupMovePendingEntry,
  dryRun: boolean,
  pushError: (msg: string) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;

  try {
    await fs.access(entry.conflictPath);
  } catch {
    log.debug({ path: entry.conflictPath }, 'Resumed cleanup-move-pending entry: source gone, clearing');
    return true;
  }

  if (signal?.aborted) return false;

  let currentHash: string;
  try {
    currentHash = await hashFile(entry.conflictPath);
  } catch (err) {
    pushError(`resume cleanup-move hash failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
    ignoreBestEffortCleanup(err, {
      operation: 'spaceMaintenance.resumeCleanupMovePending.rehash',
      reason: 'source file unreadable during resume; leaving entry for the next run to retry',
    });
    return false; // leave for the next run to retry
  }

  if (signal?.aborted) return false;

  if (currentHash !== entry.expectedHash) {
    log.info(
      { path: entry.conflictPath, expected: entry.expectedHash, actual: currentHash },
      'Dropping stale cleanup-move-pending entry: source hash changed',
    );
    return true;
  }

  if (dryRun) {
    log.debug({ path: entry.conflictPath }, '[dry-run] would resume cleanup move');
    return true;
  }

  if (signal?.aborted) return false;

  try {
    const movedTo = await safeMoveIntoQuarantine(entry.conflictPath, entry.destPath);
    log.info({ from: entry.conflictPath, to: movedTo }, 'Resumed cleanup move into quarantine');
    return true;
  } catch (err) {
    pushError(`resume cleanup move failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
    // Drop the entry; the source is left in place and the next detect run
    // will re-plan it. NEVER trashed, NEVER unlinked.
    return true;
  }
}

async function readHead(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function hashFile(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function toErrMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ===========================================================================
// REBEL-62A one-off conflict-copy cleanup (Stage 2 engine)
//
// A dedicated, identical-only, MOVE-to-in-workspace-quarantine path that is
// SEPARATE from the daily/startup LLM-merge pipeline above. It reuses the
// engine's machinery (file hashing, the journal `quarantine-pending` crash
// marker, the maintenance lease) but NEVER calls `moveToTrash`, `fs.unlink`,
// or `proposeMerge`. The destination is `.rebel/conflicts-cleanup/<date>/`.
//
// @see docs/plans/260601_rebel62a-conflict-cleanup-migration/PLAN.md
//      (Safety Contract §3-§9, Stage 2)
// ===========================================================================

/** In-workspace quarantine subtree (excluded from sync via ALWAYS_SKIP_DIRS). */
export const CONFLICT_CLEANUP_QUARANTINE_SEGMENTS = ['.rebel', 'conflicts-cleanup'] as const;
/** Subdirectory under userData that holds per-run JSONL manifests. */
export const CONFLICT_CLEANUP_RUNS_DIRNAME = 'conflict-copy-cleanup-runs';

/** Resolve the per-run manifest path under `manifestDir`. */
function cleanupManifestPath(manifestDir: string, runId: string): string {
  return path.join(manifestDir, CONFLICT_CLEANUP_RUNS_DIRNAME, `${runId}.jsonl`);
}

/**
 * Validate a manifest `relPath` before ANY hash/move (F4 — path-traversal +
 * untrusted-plan defence). The manifest is the trusted detect artifact, but
 * Stage 3 wires it across an IPC boundary, so we re-validate by construction:
 *   - non-empty, portable POSIX relative path (no backslashes);
 *   - not absolute (no leading '/', no Windows drive/UNC);
 *   - no `.` / `..` segments (no traversal, no current-dir noise);
 *   - the resolved source stays under `spaceRoot`;
 *   - the resolved destination stays under `quarantineRoot`.
 * Returns the validated source+dest absolute paths, or `null` (caller records
 * + skips). Nothing outside the roots can ever be touched.
 */
function validateCleanupRelPath(
  relPath: string,
  spaceRoot: string,
  quarantineRoot: string,
): { sourceAbs: string; destAbs: string } | null {
  if (typeof relPath !== 'string' || relPath.length === 0) return null;
  if (relPath.includes('\\')) return null; // not a portable posix rel path
  if (relPath.includes('\0')) return null;
  // Reject absolute (posix '/' or Windows 'C:' / '\\\\server').
  if (relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath) || relPath.startsWith('//')) {
    return null;
  }
  const segments = relPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;

  const sourceAbs = path.resolve(spaceRoot, ...segments);
  const destAbs = path.resolve(quarantineRoot, ...segments);
  if (!isPathInsideRoot(sourceAbs, spaceRoot)) return null;
  if (!isPathInsideRoot(destAbs, quarantineRoot)) return null;
  return { sourceAbs, destAbs };
}

/** True when `target` is `root` itself or strictly nested under it. */
function isPathInsideRoot(target: string, root: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(resolvedRoot + path.sep)
  );
}

export interface DetectConflictCopyCleanupOptions {
  /**
   * Directory (under userData) where the per-run JSONL manifest is written.
   * The desktop adapter resolves this from `app.getPath('userData')`; tests
   * pass a temp dir. Required so core stays Electron-free.
   */
  manifestDir: string;
  /** Clock override for deterministic testing. Defaults to `Date.now`. */
  now?: () => number;
  /** Run identifier override (else a UUID is generated). */
  runId?: string;
  signal?: AbortSignal;
}

export interface DetectConflictCopyCleanupResult {
  runId: string;
  plan: CleanupPlan;
  manifestPath: string;
}

/** One JSONL row in a cleanup run manifest. */
interface CleanupManifestRow {
  runId: string;
  timestamp: number;
  relPath: string;
  immediateParent: string | null;
  label: ConflictLabel;
  provider: ConflictProvider;
  /** sha256 of the conflict copy (null when unreadable/empty). */
  hash: string | null;
  /** 'quarantine' (plan) | 'review' (plan) | execute outcome verbs. */
  action: 'quarantine' | 'review' | 'quarantined' | 'skipped-rehash' | 'skipped-gone' | 'error';
  /** For review rows: the planner reason. For execute rows: detail. */
  reason: string;
}

/**
 * Read-only bulk scan of ONE space root. Builds a `{relPath, hash, size}`
 * snapshot over EVERY regular file (parents included — the planner needs
 * them to match a conflict copy against its immediate parent), feeds it to
 * the pure `planConflictCopyCleanup`, and writes a per-run JSONL manifest.
 *
 * Moves nothing. Uncapped + deterministic walk, symlink-escape guarded
 * (Safety Contract §7). The `.rebel/` quarantine subtree is skipped (the
 * walk skips dot-dirs) so a prior run's quarantine is never re-detected.
 */
export async function detectConflictCopyCleanup(
  spaceRootAbsPath: string,
  options: DetectConflictCopyCleanupOptions,
): Promise<DetectConflictCopyCleanupResult> {
  const now = options.now ?? Date.now;
  const runId = options.runId ?? crypto.randomUUID();
  const signal = options.signal;
  const root = path.resolve(spaceRootAbsPath);

  const snapshot: ConflictSnapshotEntry[] = [];
  await walkForSnapshot(root, snapshot, signal);

  const plan = planConflictCopyCleanup(snapshot);

  const manifestPath = cleanupManifestPath(options.manifestDir, runId);
  const rows: CleanupManifestRow[] = [];
  for (const item of plan.toQuarantine) {
    rows.push({
      runId,
      timestamp: now(),
      relPath: item.relPath,
      immediateParent: item.immediateParentRelPath,
      label: item.label,
      provider: item.provider,
      hash: item.hash,
      action: 'quarantine',
      reason: 'identical-to-immediate-parent',
    });
  }
  for (const item of plan.needsReview) {
    rows.push({
      runId,
      timestamp: now(),
      relPath: item.relPath,
      immediateParent: item.immediateParentRelPath,
      label: item.label,
      provider: item.provider,
      hash: null,
      action: 'review',
      reason: item.reason,
    });
  }

  // F7: don't create an empty JSONL for unaffected users. Only the FIRST
  // append (here, or per-item in execute) materialises the file.
  if (rows.length > 0) {
    await appendManifestRows(manifestPath, rows);
  }

  return { runId, plan, manifestPath };
}

export interface ExecuteConflictCopyCleanupDeps {
  journal: SpaceMaintenanceJournal;
  /**
   * Directory (under userData) where the per-run JSONL manifest lives. Execute
   * RELOADS the trusted detect manifest (`<manifestDir>/<runs>/<runId>.jsonl`)
   * keyed by `runId` — it does NOT trust a renderer-supplied plan (F4/F5).
   */
  manifestDir: string;
  /**
   * Acquire the maintenance lease around the move batch. When omitted, a
   * no-op success lease is used (single-desktop / test default). Mirrors
   * `DailyMaintenanceDeps.acquireLease`.
   */
  acquireLease?: () => Promise<{ acquired: boolean; release: () => Promise<void> }>;
}

export interface ExecuteConflictCopyCleanupOptions {
  /** Clock override. Defaults to `Date.now`. */
  now?: () => number;
  /** Date-folder name override (`YYYY-MM-DD`); else derived from `now()`. */
  dateDir?: string;
  signal?: AbortSignal;
}

export interface ExecuteConflictCopyCleanupResult {
  /** Files moved into the quarantine folder. */
  quarantined: number;
  /** Skipped because the file was gone or its hash changed (rehash-race). */
  skipped: number;
  /** Move failures recorded but not fatal. */
  errors: string[];
  /** True when the lease was held by another desktop (no moves attempted). */
  leaseContended: boolean;
  /** Absolute path of the `.rebel/conflicts-cleanup/<date>/` destination root. */
  quarantineRootAbsPath: string;
}

/**
 * MOVE every `toQuarantine` item into `<space>/.rebel/conflicts-cleanup/<date>/<relPath>`,
 * preserving relative structure. NEVER touches `needsReview`, NEVER trashes,
 * NEVER unlinks. Reuses the journal `quarantine-pending` crash marker and the
 * pre-move rehash guard (Safety Contract §4): if a file's bytes changed since
 * detect, it is skipped + recorded. The maintenance lease is held for the batch.
 */
export async function executeConflictCopyCleanup(
  spaceRootAbsPath: string,
  runId: string,
  deps: ExecuteConflictCopyCleanupDeps,
  options: ExecuteConflictCopyCleanupOptions = {},
): Promise<ExecuteConflictCopyCleanupResult> {
  const now = options.now ?? Date.now;
  const signal = options.signal;
  const root = path.resolve(spaceRootAbsPath);
  const dateDir = options.dateDir ?? formatDateDir(now());
  const quarantineRootAbsPath = path.join(root, ...CONFLICT_CLEANUP_QUARANTINE_SEGMENTS, dateDir);
  const manifestPath = cleanupManifestPath(deps.manifestDir, runId);

  const result: ExecuteConflictCopyCleanupResult = {
    quarantined: 0,
    skipped: 0,
    errors: [],
    leaseContended: false,
    quarantineRootAbsPath,
  };

  // F4/F5: RELOAD the plan from the trusted detect manifest keyed by runId.
  // Never trust a caller-supplied plan. Every candidate's relPath is
  // re-validated below before any hash/move.
  const candidates = await loadQuarantineCandidatesFromManifest(manifestPath, runId);

  const lease = await (deps.acquireLease ?? defaultNoopLease)();
  if (!lease.acquired) {
    log.info({}, 'conflict-copy cleanup: lease held by another desktop, skipping execute');
    result.leaseContended = true;
    return result;
  }

  const { state, mutable } = await deps.journal.load();
  const journalState = state;

  const writePending = async (entry: CleanupMovePendingEntry): Promise<boolean> => {
    if (!mutable) return true; // forward-compat safe-skip; proceed without journaling
    journalState.entries.push(entry);
    try {
      await deps.journal.save(journalState);
      return true;
    } catch (err) {
      result.errors.push(`journal write failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
      const idx = journalState.entries.indexOf(entry);
      if (idx >= 0) journalState.entries.splice(idx, 1);
      ignoreBestEffortCleanup(err, {
        operation: 'spaceMaintenance.cleanupExecute.writePending',
        reason: 'journal write failed; rolled back the in-memory entry and skipping this item',
      });
      return false;
    }
  };
  const clearPending = async (entry: CleanupMovePendingEntry): Promise<void> => {
    if (!mutable) return;
    const idx = journalState.entries.indexOf(entry);
    if (idx >= 0) journalState.entries.splice(idx, 1);
    try {
      await deps.journal.save(journalState);
    } catch (err) {
      result.errors.push(`journal clear failed for ${entry.conflictPath}: ${toErrMsg(err)}`);
    }
  };

  // F6: append a per-item outcome row as each item is processed (not only
  // after the batch) so a crash mid-batch still records what was moved.
  const appendOutcomeRow = async (
    item: QuarantineCandidate,
    action: CleanupManifestRow['action'],
    reason: string,
  ): Promise<void> => {
    try {
      await appendManifestRows(manifestPath, [
        {
          runId, // F6: carry the detect runId
          timestamp: now(),
          relPath: item.relPath,
          immediateParent: item.immediateParentRelPath,
          label: item.label,
          provider: item.provider,
          hash: item.hash,
          action,
          reason,
        },
      ]);
    } catch (err) {
      result.errors.push(`manifest append failed for ${item.relPath}: ${toErrMsg(err)}`);
    }
  };

  try {
    for (const item of candidates) {
      if (signal?.aborted) break;

      // F4: re-validate the relPath before ANY hash/move. Reject (record +
      // skip) anything that could escape the space root or quarantine root.
      const resolved = validateCleanupRelPath(item.relPath, root, quarantineRootAbsPath);
      if (!resolved) {
        result.skipped += 1;
        result.errors.push(`rejected unsafe relPath: ${item.relPath}`);
        await appendOutcomeRow(item, 'error', 'rejected-unsafe-path');
        continue;
      }

      const outcome = await moveToQuarantineFolder(
        resolved.sourceAbs,
        resolved.destAbs,
        item,
        writePending,
        clearPending,
        (msg) => result.errors.push(msg),
        now,
        signal,
      );
      if (outcome === 'quarantined') result.quarantined += 1;
      else result.skipped += 1;
      await appendOutcomeRow(
        item,
        outcome,
        outcome === 'quarantined' ? `moved to ${dateDir}` : outcome,
      );
    }
  } finally {
    await lease.release().catch((err) => {
      result.errors.push(`lease release failed: ${toErrMsg(err)}`);
    });
  }

  return result;
}

/**
 * Reload the trusted `toQuarantine` candidates from the detect manifest (F4).
 * Reads ONLY rows whose `action === 'quarantine'` and `runId` matches. Rows
 * with a missing hash are dropped (the move requires a hash to rehash-guard).
 * Returns an empty list when the manifest is absent (nothing was detected).
 */
async function loadQuarantineCandidatesFromManifest(
  manifestPath: string,
  runId: string,
): Promise<QuarantineCandidate[]> {
  let body: string;
  try {
    body = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const out: QuarantineCandidate[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let row: Partial<CleanupManifestRow>;
    try {
      row = JSON.parse(trimmed) as Partial<CleanupManifestRow>;
    } catch {
      continue; // skip a malformed line rather than fail the whole run
    }
    if (row.action !== 'quarantine') continue;
    if (row.runId !== runId) continue;
    if (typeof row.relPath !== 'string' || typeof row.hash !== 'string') continue;
    out.push({
      relPath: row.relPath,
      immediateParentRelPath: typeof row.immediateParent === 'string' ? row.immediateParent : '',
      label: row.label as QuarantineCandidate['label'],
      provider: row.provider as QuarantineCandidate['provider'],
      hash: row.hash,
    });
  }
  return out;
}

type CleanupMoveOutcome = 'quarantined' | 'skipped-gone' | 'skipped-rehash' | 'error';

/**
 * Pick a non-colliding destination under `quarantineRoot` for `relPath` and
 * perform a no-overwrite, no-unlink move of `sourceAbs` there (F2/F3).
 *
 * Invariants:
 *   - NEVER overwrites an existing file. The first attempt targets the exact
 *     `relPath`; on collision it appends ` (n)` before the extension and
 *     retries with exclusive semantics until a free slot is found (bounded).
 *   - EXDEV (cross-device) is treated as an UNEXPECTED unsafe condition: source
 *     and dest are inside the SAME workspace root, so a real EXDEV means we are
 *     about to copy-then-delete across devices — forbidden by the contract.
 *     We do NOT fall back to `copyFile + unlink`; the move is failed (source
 *     left in place) and the error is surfaced (F3).
 *   - Uses `fs.rename` (atomic same-volume move) guarded by a prior existence
 *     probe; the residual TOCTOU window is closed by the loop re-probing on the
 *     next candidate, so the worst case is a redundant retry, never an
 *     overwrite of a file we just observed.
 *
 * Returns the destination it moved to, or throws on hard failure.
 */
const MAX_QUARANTINE_COLLISION_SUFFIXES = 1000;

async function safeMoveIntoQuarantine(
  sourceAbs: string,
  destBaseAbs: string,
): Promise<string> {
  const dir = path.dirname(destBaseAbs);
  await fs.mkdir(dir, { recursive: true });

  const ext = path.extname(destBaseAbs);
  const stem = path.basename(destBaseAbs, ext);

  for (let n = 0; n <= MAX_QUARANTINE_COLLISION_SUFFIXES; n++) {
    const candidate =
      n === 0 ? destBaseAbs : path.join(dir, `${stem} (${n})${ext}`);

    // No-overwrite: skip any candidate that already exists.
    try {
      await fs.access(candidate);
      continue; // taken — try the next suffix
    } catch (err) {
      // access() throwing (likely ENOENT) is the expected "free slot" signal;
      // record the intentional swallow and fall through to attempt the move.
      ignoreBestEffortCleanup(err, {
        operation: 'spaceMaintenance.quarantineMove.probeFreeSlot',
        reason: 'access() rejection is the expected free-slot signal (likely ENOENT)',
      });
    }

    try {
      await fs.rename(sourceAbs, candidate);
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY') {
        // Lost a race to the slot between access() and rename(); try next.
        continue;
      }
      if (code === 'EXDEV') {
        // Cross-device move inside one workspace root should be impossible.
        // Refuse to copy+unlink (would delete the source). Fail closed.
        throw new Error(
          `unexpected cross-device (EXDEV) move; refusing to copy+unlink, source left in place`,
        );
      }
      throw err;
    }
  }
  throw new Error(`could not find a free quarantine slot for ${destBaseAbs}`);
}

/**
 * Move a single identical conflict copy into the quarantine folder. Guard
 * sequence:
 *   1. existence probe -> gone -> 'skipped-gone'.
 *   2. re-hash, compare to the plan's hash -> mismatch -> 'skipped-rehash'.
 *   3. journal `cleanup-move-pending` (records source + dest) BEFORE the move
 *      (crash-resumable to the SAME in-workspace move, never OS-trash).
 *   4. no-overwrite move into the quarantine folder. On success, clear entry.
 */
async function moveToQuarantineFolder(
  sourceAbs: string,
  destAbs: string,
  item: QuarantineCandidate,
  writePending: (entry: CleanupMovePendingEntry) => Promise<boolean>,
  clearPending: (entry: CleanupMovePendingEntry) => Promise<void>,
  pushError: (msg: string) => void,
  now: () => number,
  signal?: AbortSignal,
): Promise<CleanupMoveOutcome> {
  if (signal?.aborted) return 'error';

  // (1) Existence probe.
  try {
    await fs.access(sourceAbs);
  } catch {
    log.debug({ path: sourceAbs }, 'conflict-copy cleanup: source gone before move');
    return 'skipped-gone';
  }

  // (2) Rehash-race guard.
  let currentHash: string;
  try {
    currentHash = await hashFile(sourceAbs);
  } catch (err) {
    pushError(`rehash failed for ${item.relPath}: ${toErrMsg(err)}`);
    return 'error';
  }
  if (currentHash !== item.hash) {
    log.info(
      { path: sourceAbs, expected: item.hash, actual: currentHash },
      'conflict-copy cleanup: file changed since detect, skipping',
    );
    return 'skipped-rehash';
  }

  if (signal?.aborted) return 'error';

  // (3) Journal-before-move crash marker (distinct cleanup type — F1).
  const pending: CleanupMovePendingEntry = {
    type: 'cleanup-move-pending',
    conflictPath: sourceAbs,
    destPath: destAbs,
    expectedHash: item.hash,
    attemptedAt: now(),
  };
  if (!(await writePending(pending))) return 'error';

  // (4) No-overwrite move into the quarantine folder (F2/F3).
  try {
    const movedTo = await safeMoveIntoQuarantine(sourceAbs, destAbs);
    log.info({ from: sourceAbs, to: movedTo }, 'conflict-copy cleanup: quarantined identical copy');
  } catch (err) {
    pushError(`move failed for ${item.relPath}: ${toErrMsg(err)}`);
    await clearPending(pending);
    return 'error';
  }

  await clearPending(pending);
  return 'quarantined';
}

async function appendManifestRows(manifestPath: string, rows: CleanupManifestRow[]): Promise<void> {
  // F7: never materialise the file for an empty batch (no churn for
  // unaffected users; keeps the "file exists ⇒ at least one row" invariant).
  if (rows.length === 0) return;
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  await fs.appendFile(manifestPath, body + '\n', 'utf8');
}

function formatDateDir(epochMs: number): string {
  const d = new Date(epochMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function defaultNoopLease(): Promise<{ acquired: boolean; release: () => Promise<void> }> {
  return {
    acquired: true,
    release: async () => {
      /* no shared space; nothing to release */
    },
  };
}

/**
 * Full-file snapshot walk over ONE space root for the one-off cleanup.
 * Uncapped + deterministic; emits EVERY regular file as `{relPath, hash, size}`
 * (hash null when unreadable; size from stat). Skips dot-dirs (so `.rebel/`,
 * incl. the quarantine, is excluded) + `ALWAYS_SKIP_DIRS` + `node_modules`,
 * and SKIPS ALL symlinks (F8 alias-safety — never duplicate-walk the same
 * physical file via an alias; trivially also honours the §7 escape rule).
 *
 * Uses the sanctioned bounded `safeWalkDirectory`. To preserve the one-off's
 * UNCAPPED full-snapshot semantics we override the per-walk entries cap with
 * `Number.MAX_SAFE_INTEGER` and keep the local `MAX_DEPTH` (4) so depth
 * behaviour is identical to the previous raw walker. Symlinks are excluded in
 * the `onDirectory`/`onFile` callbacks rather than followed, so the planner
 * never sees the same physical file under two relPaths and an escaping
 * directory symlink is never traversed (§7).
 */
async function walkForSnapshot(
  rootPath: string,
  out: ConflictSnapshotEntry[],
  signal?: AbortSignal,
): Promise<void> {
  await safeWalkDirectory(rootPath, {
    signal,
    // Preserve raw-walker behaviour: local MAX_DEPTH (4), and UNCAPPED entries.
    maxDepth: MAX_DEPTH,
    maxEntries: Number.MAX_SAFE_INTEGER,
    onDirectory: ({ name, isSymbolicLink }) => {
      // Skip dot-dirs (excludes `.rebel/` incl. the quarantine), node_modules,
      // and ALWAYS_SKIP_DIRS — matching the prior walker's skip set.
      if (name.startsWith('.') || name === 'node_modules' || ALWAYS_SKIP_DIRS.has(name)) {
        return false;
      }
      // F8 alias-safety: never descend a symlinked directory. One that resolves
      // INSIDE the root would still be escape-safe, but following it would emit
      // duplicate relPaths for the SAME physical file. One that escapes the root
      // (§7) is likewise never traversed.
      if (isSymbolicLink) return false;
      return true;
    },
    onFile: async ({ name, absolutePath, viaSymlink }) => {
      if (name.startsWith('.') || name === 'node_modules' || ALWAYS_SKIP_DIRS.has(name)) return;
      // F8 alias-safety: skip file symlinks (we only ever move real regular files).
      if (viaSymlink) return;

      let size: number;
      try {
        const stat = await fs.stat(absolutePath);
        size = stat.size;
      } catch (err) {
        // File vanished mid-walk (benign race): contribute no snapshot entry.
        ignoreBestEffortCleanup(err, {
          operation: 'spaceMaintenance.walkForSnapshot.stat',
          reason: 'file unreadable/vanished during snapshot walk; skipping the entry',
        });
        return;
      }

      let hash: string | null = null;
      if (size > 0) {
        try {
          hash = await hashFile(absolutePath);
        } catch {
          hash = null; // unreadable / placeholder
        }
      }

      out.push({
        relPath: toPosixRel(rootPath, absolutePath),
        hash,
        size,
      });
    },
  });
}

function toPosixRel(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join('/');
}
