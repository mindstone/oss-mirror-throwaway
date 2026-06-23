/**
 * Space Maintenance IPC Handlers
 *
 * Manual-trigger / CLI entry points for the daily maintenance pipeline.
 * Scheduled runs fire via `automationScheduler` and never go through
 * these handlers.
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 2)
 */
import path from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import { createScopedLogger } from '@core/logger';
import type { AppSettings } from '@shared/types';
import type {
  CleanupExecuteResult,
  CleanupPlanSummary,
  ResetNeedsReviewResult,
  SpaceMaintenanceResult,
} from '@shared/ipc/channels/spaceMaintenance';
import { registerHandler } from './utils/registerHandler';
import {
  detectConflictCopyCleanupAllSpacesFromMain,
  executeConflictCopyCleanupFromMain,
  resetNeedsReviewFromMain,
  runDailyMaintenanceFromMain,
} from '../services/spaceMaintenanceAdapter';
import { scanSpaces } from '../services/spaceService';

const log = createScopedLogger({ service: 'spaceMaintenanceHandlers' });

export interface SpaceMaintenanceHandlerDeps {
  getSettings: () => AppSettings;
}

function emptyResult(): SpaceMaintenanceResult {
  return {
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
}

export function registerSpaceMaintenanceHandlers(deps: SpaceMaintenanceHandlerDeps): void {
  const { getSettings } = deps;

  registerHandler(
    'space-maintenance:dry-run',
    async (_event: IpcMainInvokeEvent): Promise<SpaceMaintenanceResult> => {
      try {
        const settings = getSettings();
        if (!settings.coreDirectory) {
          return {
            ...emptyResult(),
            errors: ['No core directory configured'],
          };
        }

        log.info({ dryRun: true }, 'Running space maintenance dry-run');
        const result = await runDailyMaintenanceFromMain(
          settings.coreDirectory,
          settings,
          { dryRun: true },
        );
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message }, 'space-maintenance:dry-run threw unexpectedly');
        return {
          ...emptyResult(),
          errors: [message],
        };
      }
    },
  );

  registerHandler(
    'space-maintenance:reset-needs-review',
    async (_event: IpcMainInvokeEvent): Promise<ResetNeedsReviewResult> => {
      try {
        const result = await resetNeedsReviewFromMain();
        log.info({ resetCount: result.resetCount }, 'Reset needs-review retry entries');
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err: message },
          'space-maintenance:reset-needs-review threw unexpectedly',
        );
        // Fail soft: the handler surface returns a count so the UI can
        // display something; the error is already logged for diagnostics.
        return { resetCount: 0 };
      }
    },
  );

  // ── REBEL-62A one-off conflict-copy cleanup (Stage 3) ──
  // Detect = read-only bulk scan across all spaces (on-demand / re-scan path).
  // The startup path broadcasts directly; this IPC is the renderer-initiated
  // equivalent. Returns the stored plan summary per affected space.
  registerHandler(
    'space-maintenance:cleanup-detect',
    async (_event: IpcMainInvokeEvent): Promise<CleanupPlanSummary[]> => {
      try {
        const settings = getSettings();
        if (!settings.coreDirectory) {
          return [];
        }
        return await detectConflictCopyCleanupAllSpacesFromMain(settings.coreDirectory);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message }, 'space-maintenance:cleanup-detect threw unexpectedly');
        // Fail soft — an empty array means "nothing to surface" (affected-only).
        return [];
      }
    },
  );

  // Execute = the ONLY destructive path (move-to-quarantine). Reachable only
  // via the explicit toast confirm. Thin pass-through: the core reloads +
  // re-validates the trusted manifest by runId (renderer supplies no plan).
  registerHandler(
    'space-maintenance:cleanup-execute',
    async (
      _event: IpcMainInvokeEvent,
      request: { runId: string; spaceRootAbsPath: string },
    ): Promise<CleanupExecuteResult> => {
      // Everything that could throw on a malformed request (destructure,
      // shape-validation, root-membership check) lives INSIDE the try so a
      // hostile/buggy request can never escape the fail-soft block below.
      try {
        const runId = request?.runId;
        const spaceRootAbsPath = request?.spaceRootAbsPath;
        if (typeof runId !== 'string' || runId.length === 0) {
          throw new Error('cleanup-execute: missing or invalid runId');
        }
        if (typeof spaceRootAbsPath !== 'string' || spaceRootAbsPath.length === 0) {
          throw new Error('cleanup-execute: missing or invalid spaceRootAbsPath');
        }

        const settings = getSettings();
        if (!settings.coreDirectory) {
          throw new Error('cleanup-execute: no core directory configured');
        }

        // SECURITY (F1): the renderer supplies `spaceRootAbsPath` and it is
        // passed straight into the destructive engine. The trusted manifest
        // records relPaths only — not the root — so the core cannot cross-check
        // it. Prove the root is a CURRENTLY KNOWN space by exact-match against
        // the live scan before doing anything destructive. This makes
        // "move at an unintended path" impossible by construction, on top of the
        // engine's manifest-reload + relPath-revalidation + rehash guards.
        const requestedRoot = path.resolve(spaceRootAbsPath);
        const spaces = await scanSpaces(settings.coreDirectory, { skipAutoFix: true });
        const isKnownSpace = spaces.some(
          (space) => path.resolve(space.absolutePath) === requestedRoot,
        );
        if (!isKnownSpace) {
          log.warn(
            { runId, spaceRootAbsPath: requestedRoot },
            'cleanup-execute: rejected — spaceRootAbsPath is not a known space root (no move)',
          );
          return {
            quarantined: 0,
            skipped: 0,
            errors: ['cleanup-execute: spaceRootAbsPath is not a known space root'],
            leaseContended: false,
            quarantineRootAbsPath: '',
          };
        }

        log.info({ runId, spaceRootAbsPath: requestedRoot }, 'Executing conflict-copy cleanup (explicit confirm)');
        const result = await executeConflictCopyCleanupFromMain(requestedRoot, runId);
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err: message, runId: request?.runId },
          'space-maintenance:cleanup-execute threw unexpectedly',
        );
        return {
          quarantined: 0,
          skipped: 0,
          errors: [message],
          leaseContended: false,
          quarantineRootAbsPath: '',
        };
      }
    },
  );
}
