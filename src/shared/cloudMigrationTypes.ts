/**
 * Canonical Cloud Migration Types
 *
 * Single source of truth for the `MigrationStep` / `CloudMigrationProgress`
 * shape. Previously duplicated across:
 *   - src/main/services/cloud/cloudMigrationService.ts (producer)
 *   - src/preload/index.ts (IPC bridge)
 *   - src/renderer/features/settings/hooks/useCloudSync.ts (consumer)
 *
 * Consolidated here so changes to the progress event shape cannot silently
 * drift between producer, IPC boundary, and consumer. Cross-surface (desktop,
 * cloud-service, mobile) consumers import from this module.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Stage 1 — Shared Utilities; Review-Driven Amendments → Stage 1)
 */

/**
 * Known migration phases.
 *
 * Phases map into percentage sub-ranges defined in `cloudMigrationPhases.ts`.
 * `extract` is a new (Stage 6) phase for cloud-side extraction progress.
 */
export type MigrationPhaseId =
  | 'settings'
  | 'mcp-config'
  | 'workspace'
  | 'extract'
  | 'app-data'
  | 'sessions'
  | 'complete';

/**
 * A single progress event emitted during cloud migration.
 *
 * Fields added in Stage 1 for consumption by later stages:
 *   - `bytesTotal`: populated during upload (Stage 5) and extract (Stage 6) so the
 *     renderer can compute honest percentages and ETAs. Optional because
 *     earlier phases (settings, mcp-config, sessions) don't have a byte count.
 *   - `live`: producer-set flag indicating that `message` contains dynamic
 *     upload/extract detail (e.g. "240/900 MB"). Stage 7 renderer switches
 *     from substring-match on message text to this structured flag.
 *   - `runId`: stable UUID per migration run. Stage 7 renderer keys the
 *     ThroughputEstimator on this so repeated runs don't share samples.
 */
export interface MigrationStep {
  phase: MigrationPhaseId;
  message: string;
  /** 0–100 */
  progress: number;
  /** Number of items (or bytes) processed so far. Paired with `total`. */
  current?: number;
  /** Total items (or bytes) to process. Paired with `current`. */
  total?: number;
  /**
   * Total bytes to process for the phase. Non-authoritative hint — consumers
   * should still prefer `current`/`total` for ratio calculations. Populated
   * for uniformity with `current` when the producer has a byte count.
   */
  bytesTotal?: number;
  /**
   * `true` when `message` contains dynamic live detail (e.g. live upload/extract
   * progress text). The renderer uses this to decide whether to show the
   * producer's message verbatim vs. fall back to static phase copy.
   */
  live?: boolean;
  /**
   * Stable identifier for this migration run. Lets consumers keyed caches
   * (e.g. a ThroughputEstimator) on the current run without accidentally
   * carrying samples across retries.
   */
  runId?: string;
}

/**
 * Alias retained for renderer ergonomics. Historically the renderer used the
 * name `CloudMigrationProgress`; now it's just the canonical `MigrationStep`.
 */
export type CloudMigrationProgress = MigrationStep;

/**
 * Why the scan could not produce a reliable total.
 */
export type FootprintPartialReason =
  | 'timeout'
  | 'permission'
  | 'mount_error'
  | 'symlink_cycle';

export type FootprintOutcome =
  | {
      kind: 'measured_zero';
      totalBytes: 0;
      workspaceBytes: 0;
      appDataBytes: number;
    }
  | {
      kind: 'measured_nonzero';
      totalBytes: number;
      /** Omitted when `coreDirectory` was not provided. */
      workspaceBytes?: number;
      appDataBytes: number;
    }
  | {
      kind: 'unknown_partial';
      /** Bytes counted before we gave up. Non-authoritative. */
      partialBytes: number;
      reason: FootprintPartialReason;
    };
