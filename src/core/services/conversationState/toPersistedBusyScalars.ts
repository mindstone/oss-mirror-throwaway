import type { DerivedLiveness } from './turnLiveness';

export type PersistedBusyScalars = {
  isBusy: boolean;
  activeTurnId: string | null;
};

/**
 * Canonical projection-owned mapping from `DerivedLiveness` to persisted
 * `isBusy`/`activeTurnId` scalars for read/load/index surfaces.
 *
 * This is intentionally paired with
 * `incrementalSessionStore.toPersistedBusyScalarsForWrite`: both functions are
 * one policy decision with a single deliberate divergence where write-time
 * `interrupted` preserves busy until the next load/projection pass.
 * See docs/plans/260530_turn_liveness_projection.md (Phase 7, P7-3).
 */
export function toPersistedBusyScalars(derived: DerivedLiveness): PersistedBusyScalars {
  switch (derived.status) {
    case 'running':
      return {
        isBusy: true,
        activeTurnId: derived.activeTurnId,
      };
    case 'terminal':
    case 'interrupted':
    case 'idle':
      return {
        isBusy: false,
        activeTurnId: null,
      };
  }
}
