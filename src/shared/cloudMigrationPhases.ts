/**
 * Cloud Migration Phase Ranges
 *
 * Single source of truth for the percentage sub-range each migration phase
 * occupies in the overall 0–100% progress bar. Centralising this eliminates
 * the drift risk that arose when Stage 5 reshuffled workspace to 10–22 and
 * added a dedicated 22–30 extract phase.
 *
 * See planning doc:
 *   docs/plans/260419_cloud_setup_adaptive_sizing_and_honest_progress.md
 *   (Review-Driven Amendments → Cross-cutting: Progress Range Constants)
 */

import type { MigrationPhaseId } from './cloudMigrationTypes';

/**
 * Each phase's min/max percentage bounds. Progress must be monotonic across
 * phases: a run emitting `workspace(22) → extract(22) → extract(30)` is
 * non-decreasing, which is the invariant Stage 8's monotonicity test checks.
 */
export const MIGRATION_PHASE_RANGES = {
  settings:  { min:  0, max:  5 },
  mcp:       { min:  5, max: 10 },
  workspace: { min: 10, max: 22 }, // upload only (was 10–30 pre-Stage 5)
  extract:   { min: 22, max: 30 }, // cloud-side extract (new in Stage 6)
  appdata:   { min: 30, max: 45 },
  sessions:  { min: 45, max: 95 },
  complete:  { min: 95, max: 100 },
} as const;

/**
 * Phase keys used as keys of `MIGRATION_PHASE_RANGES`.
 *
 * NOTE: These phase-range keys do not 1:1 match `MigrationPhaseId` from
 * `cloudMigrationTypes.ts`. Specifically, the `mcp-config` event phase maps
 * to the `mcp` range, and the `app-data` event phase maps to the `appdata`
 * range. Use `phaseIdToRangeKey()` to bridge the two when needed.
 */
export type MigrationPhase = keyof typeof MIGRATION_PHASE_RANGES;

/**
 * Map the event-level `MigrationPhaseId` union to the range-key used by
 * `MIGRATION_PHASE_RANGES`. Keeps the two spelling conventions decoupled so
 * we don't have to churn all consumers of the event phase ids.
 */
export function phaseIdToRangeKey(phase: MigrationPhaseId): MigrationPhase {
  switch (phase) {
    case 'mcp-config':
      return 'mcp';
    case 'app-data':
      return 'appdata';
    default:
      return phase;
  }
}

/**
 * Map a 0–1 ratio within a phase into the absolute 0–100 progress value.
 *
 * Clamps the ratio to [0, 1] so upstream arithmetic that drifts slightly
 * above 1 (e.g. compressed > uncompressed) does not overshoot the phase's
 * allocated band. A non-finite ratio is treated as 0.
 */
export function mapToPhaseRange(phase: MigrationPhase, ratio01: number): number {
  const range = MIGRATION_PHASE_RANGES[phase];
  const safeRatio = Number.isFinite(ratio01)
    ? Math.min(1, Math.max(0, ratio01))
    : 0;
  return range.min + safeRatio * (range.max - range.min);
}
