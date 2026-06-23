/**
 * Space Maintenance IPC channels
 *
 * Manual / CLI-reachable entry points for the daily maintenance pipeline.
 * The scheduled run fires via `automationScheduler` and never uses these
 * channels; they exist so internal tooling can probe the pipeline without
 * waiting for the 06:00 schedule.
 *
 * @see docs/plans/260411_shared_space_maintenance.md (Stage 2)
 */
import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * Response mirrors the `MaintenanceResult` type in
 * `@core/services/spaceMaintenanceService`. Kept as a Zod schema here so
 * the contract validates at the process boundary (validate:ipc), but the
 * field set MUST stay in lock-step with the core type.
 */
export const SpaceMaintenanceResultSchema = z.object({
  scanned: z.number(),
  quarantinedIdentical: z.number(),
  mergedSuccessfully: z.number(),
  mergeFailed: z.number(),
  mergeSkippedBackoff: z.number(),
  mergeSkippedCircuitBreaker: z.number(),
  mergeSkippedBinary: z.number(),
  mergeSkippedTooLarge: z.number(),
  mergeAbortedRace: z.number(),
  frontmatterRepaired: z.number(),
  numberedCopyQuarantinedIdentical: z.number(),
  numberedCopyMerged: z.number(),
  numberedCopyLegacySkipped: z.number(),
  numberedCopyPendingStability: z.number(),
  numberedCopyPendingUserReview: z.number(),
  numberedCopySkippedBinary: z.number(),
  numberedCopySkippedTooLarge: z.number(),
  errors: z.array(z.string()),
  elapsedMs: z.number(),
  timeBudgetExceeded: z.boolean().optional(),
});
export type SpaceMaintenanceResult = z.infer<typeof SpaceMaintenanceResultSchema>;

export const ResetNeedsReviewResultSchema = z.object({
  resetCount: z.number(),
});
export type ResetNeedsReviewResult = z.infer<typeof ResetNeedsReviewResultSchema>;

/**
 * One affected space's conflict-copy cleanup plan summary (REBEL-62A Stage 3).
 * Field set MUST stay in lock-step with `ConflictCleanupPlanSummary` in
 * `spaceMaintenanceAdapter.ts`.
 */
export const CleanupPlanSummarySchema = z.object({
  runId: z.string(),
  spaceRootAbsPath: z.string(),
  spaceName: z.string(),
  quarantineCount: z.number(),
  needsReviewCount: z.number(),
  sample: z.array(z.string()),
});
export type CleanupPlanSummary = z.infer<typeof CleanupPlanSummarySchema>;

/**
 * Result of the explicit-confirm cleanup execute. Field set MUST stay in
 * lock-step with `ExecuteConflictCopyCleanupResult` in the core service.
 */
export const CleanupExecuteResultSchema = z.object({
  quarantined: z.number(),
  skipped: z.number(),
  errors: z.array(z.string()),
  leaseContended: z.boolean(),
  quarantineRootAbsPath: z.string(),
});
export type CleanupExecuteResult = z.infer<typeof CleanupExecuteResultSchema>;

export const spaceMaintenanceChannels = {
  'space-maintenance:dry-run': defineInvokeChannel({
    channel: 'space-maintenance:dry-run',
    request: z.void(),
    response: SpaceMaintenanceResultSchema,
    description:
      'Run the daily space-maintenance pipeline in dry-run mode: no BTS calls, no writes, no telemetry events without the dryRun flag. Returns preview counts only.',
  }),
  'space-maintenance:reset-needs-review': defineInvokeChannel({
    channel: 'space-maintenance:reset-needs-review',
    request: z.void(),
    response: ResetNeedsReviewResultSchema,
    description:
      'Manual recovery: flip every retry-state entry in `needs-review` back to `retry` with fresh counters. Needed during multi-day BTS outages where the circuit breaker would otherwise wedge merges until the user re-edits each file (S2-F3).',
  }),
  'space-maintenance:cleanup-detect': defineInvokeChannel({
    channel: 'space-maintenance:cleanup-detect',
    request: z.void(),
    response: z.array(CleanupPlanSummarySchema),
    description:
      'Read-only bulk scan for backlog conflict-copy duplicates (REBEL-62A); returns one stored plan summary per affected space (moves nothing). Empty array = nothing to clean up.',
  }),
  'space-maintenance:cleanup-execute': defineInvokeChannel({
    channel: 'space-maintenance:cleanup-execute',
    request: z.object({ runId: z.string(), spaceRootAbsPath: z.string() }),
    response: CleanupExecuteResultSchema,
    description:
      'Explicit-confirm: reload the trusted detect plan by runId and MOVE the byte-identical set into .rebel/conflicts-cleanup/<date>/. Never deletes, never OS-trash.',
  }),
} as const;
