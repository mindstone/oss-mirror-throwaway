/**
 * Space Maintenance Adapter (Electron-backed)
 *
 * Desktop adapter that wires the core space-maintenance service with its
 * Electron-specific dependency — OS-trash quarantine via `shell.trashItem`.
 * Kept in `src/main/` so `src/core/spaceMaintenanceService.ts` stays free of
 * Electron imports (verified via `rg "from 'electron'" src/core/`).
 *
 * Stage 2 additions:
 *   - `createDesktopDailyMaintenanceDeps()` returns the dep bundle needed
 *     by `runDailyMaintenance`: the same `moveToTrash` as Stage 1 plus a
 *     telemetry emitter wired to `trackMainEvent`.
 *   - `runDailyMaintenanceFromMain(coreDir, settings)` is the scheduler-
 *     facing entry point that constructs the journal + retry store and
 *     drives the pipeline.
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stages 1 & 2)
 */
import { app, shell } from 'electron';
import path from 'node:path';
import type {
  DailyMaintenanceDeps,
  MaintenanceDeps,
  MaintenanceResult,
} from '@core/services/spaceMaintenanceService';
import { runDailyMaintenance } from '@core/services/spaceMaintenanceService';
import {
  detectConflictCopyCleanup,
  executeConflictCopyCleanup,
  type DetectConflictCopyCleanupResult,
  type ExecuteConflictCopyCleanupResult,
} from '@core/services/spaceMaintenanceService';
import {
  acquireLease as acquireSharedSpaceLease,
  releaseLease,
} from '@core/services/spaceMaintenanceLease';
import type {
  DriveHistoryMigrationDeps,
  DriveHistoryMigrationResult,
} from '@core/services/driveHistoryMigration';
import { runDriveHistoryMigration } from '@core/services/driveHistoryMigration';
import { SpaceMaintenanceJournal } from '@core/services/spaceMaintenanceJournal';
import {
  RETRY_STATE_SCHEMA_VERSION,
  resetNeedsReview,
  SpaceMaintenanceRetryStore,
} from '@core/services/spaceMaintenanceRetryState';
import {
  isConflictCleanupSurfaced,
  isConflictCleanupCompleted,
  markConflictCleanupSurfaced,
  markConflictCleanupCompleted,
} from '@core/services/conflictCopyCleanupMigration';
import { createScopedLogger } from '@core/logger';
import type { AppSettings } from '@shared/types';
import { trackMainEvent, getOrGenerateAnonymousId } from '../analytics';
import { scanSpaces } from './spaceService';
import { detectCloudStorage } from '../utils/cloudStorageUtils';
import { broadcastToAllWindows } from '../utils/broadcastHelpers';

const log = createScopedLogger({ service: 'spaceMaintenanceAdapter' });

/**
 * Build the dep bundle for the core maintenance service. The `moveToTrash`
 * implementation resolves `shell.trashItem` lazily per call so Electron is
 * only touched when there's actually a file to quarantine — keeps startup
 * import cost unchanged on surfaces that never fire.
 */
export function createDesktopMaintenanceDeps(): MaintenanceDeps {
  return {
    moveToTrash: async (absolutePath: string) => {
      log.debug({ path: absolutePath }, 'Sending conflict copy to OS trash');
      await shell.trashItem(absolutePath);
    },
  };
}

/**
 * Daily-maintenance deps extend the startup deps with telemetry. The
 * emitter is routed through the main-process `trackMainEvent` so Stage 2
 * can ship analytics outcome counters without threading telemetry through
 * the core service.
 */
export function createDesktopDailyMaintenanceDeps(): DailyMaintenanceDeps {
  return {
    ...createDesktopMaintenanceDeps(),
    emitTelemetry: (event, properties) => {
      try {
        // RudderStack's `apiObject` type is stricter than `Record<string, unknown>`
        // but accepts primitives + nested objects; the keys we emit here are
        // all primitives so a cast at the boundary is safe.
        trackMainEvent({
          anonymousId: getOrGenerateAnonymousId(),
          event,
          properties: properties as Record<string, string | number | boolean | null>,
        });
      } catch (err) {
        // Never let telemetry wedge the automation. Log and continue.
        log.warn({ err, event }, 'trackMainEvent failed for space maintenance');
      }
    },
    // acquireLease left undefined — core defaults to a no-op success.
    // Stage 5 will wire the shared-space dotfile lease here.
  };
}

/**
 * Build deps for the one-shot Drive history migration. Space discovery stays in
 * main (uses scanSpaces), while trash + telemetry follow the same adapters used
 * by space maintenance.
 */
export function createDesktopDriveHistoryMigrationDeps(): DriveHistoryMigrationDeps {
  return {
    listSharedSpaceRoots: async (coreDirectory: string) => {
      const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
      return spaces
        .filter((space) => {
          if (!space.sharing || space.sharing === 'private') {
            return false;
          }
          const provider = detectCloudStorage(space.sourcePath ?? space.absolutePath).provider;
          return provider === 'google_drive';
        })
        .map((space) => path.resolve(space.absolutePath));
    },
    moveToTrash: createDesktopMaintenanceDeps().moveToTrash,
    emitTelemetry: (event, properties) => {
      try {
        trackMainEvent({
          anonymousId: getOrGenerateAnonymousId(),
          event,
          properties: properties as Record<string, string | number | boolean | null>,
        });
      } catch (err) {
        log.warn({ err, event }, 'trackMainEvent failed for drive-history migration');
      }
    },
  };
}

/**
 * Construct the singleton journal bound to the desktop's userData directory.
 * Exposed as a factory to keep callers from caching the instance at module
 * load (which would make tests harder to isolate).
 */
export function createDesktopMaintenanceJournal(userDataDir: string): SpaceMaintenanceJournal {
  return new SpaceMaintenanceJournal(userDataDir);
}

export function createDesktopMaintenanceRetryStore(
  userDataDir: string,
): SpaceMaintenanceRetryStore {
  return new SpaceMaintenanceRetryStore(userDataDir);
}

/**
 * Scheduler-facing entry point. Resolves userData lazily (via Electron's
 * `app.getPath`) so tests that don't touch Electron never have to stub it.
 *
 * @see runDailyMaintenance in @core/services/spaceMaintenanceService
 */
export async function runDailyMaintenanceFromMain(
  coreDirectory: string,
  settings: AppSettings,
  options: { dryRun?: boolean } = {},
): Promise<MaintenanceResult> {
  const userDataDir = app.getPath('userData');
  const journal = createDesktopMaintenanceJournal(userDataDir);
  const retryStore = createDesktopMaintenanceRetryStore(userDataDir);
  const deps = createDesktopDailyMaintenanceDeps();

  return runDailyMaintenance(coreDirectory, settings, journal, retryStore, deps, {
    dryRun: options.dryRun,
  });
}

export async function runDriveHistoryMigrationFromMain(
  coreDirectory: string,
  options?: { signal?: AbortSignal },
): Promise<DriveHistoryMigrationResult> {
  const deps = createDesktopDriveHistoryMigrationDeps();
  return runDriveHistoryMigration(coreDirectory, deps, options);
}

/**
 * Manual recovery entry point (S2-F3). Loads the retry-state file, flips
 * every `needs-review` entry back to `retry` with fresh counters, and
 * writes the result. Returns the number of entries that were flipped.
 *
 * Safe to call even when the retry-state file doesn't exist yet (returns
 * `{ resetCount: 0 }`) or has an unknown schemaVersion (same — we honour
 * the forward-compat safe-skip contract and leave the file untouched).
 */
export async function resetNeedsReviewFromMain(): Promise<{ resetCount: number }> {
  const userDataDir = app.getPath('userData');
  const retryStore = createDesktopMaintenanceRetryStore(userDataDir);

  const { state, mutable } = await retryStore.load();
  if (!mutable) {
    log.warn(
      { path: retryStore.getFilePath() },
      'reset-needs-review: retry-state has unknown schemaVersion; leaving untouched',
    );
    return { resetCount: 0 };
  }

  const { entries: nextEntries, resetCount } = resetNeedsReview(state.entries);
  if (resetCount === 0) {
    log.info('reset-needs-review: nothing to reset');
    return { resetCount: 0 };
  }

  await retryStore.save({
    schemaVersion: RETRY_STATE_SCHEMA_VERSION,
    updatedAt: Date.now(),
    entries: nextEntries,
  });
  log.info({ resetCount }, 'reset-needs-review: flipped entries back to retry');
  return { resetCount };
}

/**
 * REBEL-62A one-off conflict-copy cleanup — desktop entry points (Stage 2).
 * Resolve userData for the per-run manifest dir lazily; the journal is the
 * desktop maintenance journal. Stage 3 wires these to startup detection +
 * an explicit-confirm IPC handler.
 */
export async function detectConflictCopyCleanupFromMain(
  spaceRootAbsPath: string,
): Promise<DetectConflictCopyCleanupResult> {
  const userDataDir = app.getPath('userData');
  return detectConflictCopyCleanup(spaceRootAbsPath, { manifestDir: userDataDir });
}

/**
 * Summary of one affected space's cleanup plan, ready to cross the IPC
 * boundary or to populate the `conflict-cleanup:available` toast. Kept in
 * lock-step with the `CleanupPlanSummarySchema` Zod schema (Stage 3 IPC).
 */
export interface ConflictCleanupPlanSummary {
  runId: string;
  spaceRootAbsPath: string;
  spaceName: string;
  quarantineCount: number;
  needsReviewCount: number;
  /** First few relPaths from `toQuarantine` (for the toast description). */
  sample: string[];
}

/**
 * List the local desktop space roots eligible for the one-off conflict-copy
 * cleanup scan. Unlike the drive-history migration (Google-Drive only), the
 * backlog can live in ANY synced space, so we scan every materialised space
 * root (private spaces included — `detectConflictCopyCleanup` is read-only and
 * a no-op when there are no conflict copies).
 */
async function listConflictCleanupSpaceRoots(coreDirectory: string): Promise<
  Array<{ absolutePath: string; name: string }>
> {
  const spaces = await scanSpaces(coreDirectory, { skipAutoFix: true });
  return spaces.map((space) => ({
    absolutePath: path.resolve(space.absolutePath),
    name: space.displayName ?? space.name,
  }));
}

/**
 * Read-only detect across ALL local spaces (Stage-3 on-demand IPC path). Runs
 * `detectConflictCopyCleanup` per space and returns ONE summary per affected
 * space (empty plans are omitted — affected-only). Moves nothing.
 */
export async function detectConflictCopyCleanupAllSpacesFromMain(
  coreDirectory: string,
): Promise<ConflictCleanupPlanSummary[]> {
  const roots = await listConflictCleanupSpaceRoots(coreDirectory);
  const summaries: ConflictCleanupPlanSummary[] = [];
  for (const root of roots) {
    try {
      const { runId, plan } = await detectConflictCopyCleanupFromMain(root.absolutePath);
      if (plan.toQuarantine.length === 0 && plan.needsReview.length === 0) {
        continue;
      }
      summaries.push({
        runId,
        spaceRootAbsPath: root.absolutePath,
        spaceName: root.name,
        quarantineCount: plan.toQuarantine.length,
        needsReviewCount: plan.needsReview.length,
        sample: plan.toQuarantine.slice(0, 3).map((q) => q.relPath),
      });
    } catch (err) {
      log.warn(
        { spaceRoot: root.absolutePath, err },
        'conflict-copy cleanup: per-space detect threw (skipping space)',
      );
    }
  }
  return summaries;
}

/**
 * BACKGROUND startup detection (Stage 3, coreStartup step 14). Strictly
 * read-only. Implements the Safety-Contract run-once behaviour:
 *
 *   - SCANNING is gated by `completed` only (NOT `surfaced`): we re-detect on
 *     every launch until the backlog is gone, so a partially-cleaned or
 *     deferred user keeps being re-detected across launches.
 *   - After a detect:
 *       • EMPTY plan across all scanned spaces → mark `completed` (nothing left
 *         to clean → stop future startup scans). No broadcast.
 *       • NON-EMPTY and `!surfaced` → broadcast `conflict-cleanup:available`
 *         for the first affected space and flip `surfaced=true` (toast ONCE).
 *       • NON-EMPTY and already `surfaced` → scan only, do NOT re-broadcast.
 *
 * Affected-only: empty plans never broadcast, so unaffected users never see a
 * toast. NEVER awaited under the 5s startup FS timeout; the caller
 * `void`-dispatches it so an uncapped scan can run in the background.
 *
 * NOTE (F4 — accepted v1 tradeoff): when the plan is non-empty we surface only
 * the FIRST affected space (`summaries[0]`). Multi-space fan-out (surfacing one
 * toast per affected space) is a deliberate follow-up, not implemented here.
 */
export async function scheduleConflictCopyCleanupDetection(
  coreDirectory: string,
): Promise<void> {
  // Scanning is gated by `completed` only: once the backlog is fully drained we
  // stop re-detecting. While `!completed` we keep scanning on every launch.
  if (isConflictCleanupCompleted()) {
    return;
  }

  const summaries = await detectConflictCopyCleanupAllSpacesFromMain(coreDirectory);
  const firstAffected = summaries[0];

  if (!firstAffected) {
    // Empty plan across every scanned space → nothing left to clean. Mark
    // completed so future launches skip the scan entirely (affected-only:
    // no broadcast, no toast).
    markConflictCleanupCompleted(Date.now());
    log.info(
      'conflict-copy cleanup: no backlog found across all spaces; marked completed',
    );
    return;
  }

  // Non-empty plan. Surface the toast at most once per install: if we've
  // already surfaced, keep scanning (above) but do NOT re-broadcast. The
  // re-check happens AFTER the (potentially long) scan, which also guards
  // against a double-surface race with a concurrent on-demand detect.
  if (isConflictCleanupSurfaced()) {
    log.info(
      { affectedSpaces: summaries.length },
      'conflict-copy cleanup: backlog still present but already surfaced; not re-broadcasting',
    );
    return;
  }

  markConflictCleanupSurfaced(firstAffected.runId, Date.now());
  broadcastToAllWindows('conflict-cleanup:available', firstAffected);
  log.info(
    {
      runId: firstAffected.runId,
      spaceName: firstAffected.spaceName,
      quarantineCount: firstAffected.quarantineCount,
      needsReviewCount: firstAffected.needsReviewCount,
      affectedSpaces: summaries.length,
    },
    'conflict-copy cleanup: surfaced available-cleanup toast',
  );
}

/**
 * Production-facing execute entry point (F4/F5/M2). Takes a `runId` (NOT a
 * renderer-supplied plan): the core RELOADS + re-validates the plan from the
 * trusted detect manifest under userData. Wires the REAL shared-space dotfile
 * lease for `spaceRootAbsPath` (M2/F4) so the destructive move never runs
 * concurrently with another desktop's maintenance on the same Drive volume.
 */
export async function executeConflictCopyCleanupFromMain(
  spaceRootAbsPath: string,
  runId: string,
): Promise<ExecuteConflictCopyCleanupResult> {
  const userDataDir = app.getPath('userData');
  const journal = createDesktopMaintenanceJournal(userDataDir);
  return executeConflictCopyCleanup(
    spaceRootAbsPath,
    runId,
    {
      journal,
      manifestDir: userDataDir,
      // Real file-based lease on the target space root. Mirrors the daily
      // path's `acquireDefaultLeases` (single space here). Contention or a
      // filesystem error => `acquired: false` and the core skips without
      // moving anything.
      acquireLease: async () => {
        let res: Awaited<ReturnType<typeof acquireSharedSpaceLease>>;
        try {
          res = await acquireSharedSpaceLease(spaceRootAbsPath);
        } catch (err) {
          log.warn(
            { spacePath: spaceRootAbsPath, err },
            'conflict-copy cleanup: lease acquire threw; treating as contended',
          );
          return { acquired: false, release: async () => {} };
        }
        if (!res.acquired) {
          return { acquired: false, release: async () => {} };
        }
        const lease = res.lease;
        return {
          acquired: true,
          release: async () => {
            try {
              await releaseLease(lease);
            } catch (err) {
              log.warn(
                { leasePath: lease.leasePath, err },
                'conflict-copy cleanup: lease release failed (will expire naturally)',
              );
            }
          },
        };
      },
    },
  );
}
