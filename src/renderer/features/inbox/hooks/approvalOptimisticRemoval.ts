/**
 * approvalOptimisticRemoval
 *
 * Module-level pub/sub bookkeeping for "the user just acted on this approval,
 * please hide it before the IPC broadcast lands". Used by:
 *   - usePendingApprovals (reads for mapper suppression + removes on IPC)
 *   - usePendingApprovalCount (reads tombstone snapshot + listens for the
 *     dispatched CustomEvent's `detail.id` to remove from its ID-keyed state)
 *   - useStagedFiles          (writes `staged-file:*` IDs on publish / keep-private)
 *   - useAutomationApprovals  (writes on automation approve/deny)
 *
 * Extracted from `usePendingApprovals.ts` (F3-1) to break the circular
 * dependency between usePendingApprovals ↔ useStagedFiles.
 *   - Supported ID prefixes: `tool:`, `memory:`, `staged-tool:`, `staged-file:`
 *   - TTL cleanup: 60 seconds from `notifyOptimisticRemoval`. The tombstone
 *     window must outlive the slowest IPC round-trip so stale broadcasts
 *     (or focus-driven full refreshes) cannot resurrect items the user has
 *     already actioned.
 *   - Broadcast: synthetic `CustomEvent<{ id }>` on `window` so sibling hooks
 *     react. Listeners that don't read `detail` keep working — adding the
 *     payload is purely additive.
 *
 * See: docs/plans/260416_centralize_approval_and_diff_viewing_ux.md §Stage 3.
 */

const optimisticallyRemovedIds = new Set<string>();

/** Time-to-live for each tracked ID — matches legacy usePendingApprovals. */
export const OPTIMISTIC_ID_CLEANUP_MS = 60_000;

/** Window event dispatched whenever a new ID is tracked. */
export const OPTIMISTIC_REMOVAL_EVENT = 'pending-approval-optimistic-removal';

/**
 * CustomEvent payload for {@link OPTIMISTIC_REMOVAL_EVENT}. Hooks that
 * maintain ID-keyed state (e.g. `usePendingApprovalCount`) read the `id`
 * to drop the right entry; hooks that just need a re-render tick can
 * ignore the detail.
 */
export interface OptimisticRemovalEventDetail {
  id: string;
}

/**
 * Register an optimistic removal for a composite approval ID. Safe to call
 * from any hook; consumers of `usePendingApprovals` / `usePendingApprovalCount`
 * will re-render as a result.
 */
export function notifyOptimisticRemoval(id: string): void {
  optimisticallyRemovedIds.add(id);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent<OptimisticRemovalEventDetail>(OPTIMISTIC_REMOVAL_EVENT, {
        detail: { id },
      }),
    );
  }
  setTimeout(() => optimisticallyRemovedIds.delete(id), OPTIMISTIC_ID_CLEANUP_MS);
}

/**
 * Consume (pop) an optimistic-removal ID. Returns true and removes from the
 * set if present, false otherwise. Used by usePendingApprovalCount so the
 * subsequent IPC broadcast doesn't double-decrement.
 */
export function consumeOptimisticRemoval(id: string): boolean {
  if (optimisticallyRemovedIds.has(id)) {
    optimisticallyRemovedIds.delete(id);
    return true;
  }
  return false;
}

/**
 * Read-only snapshot of the optimistic-removal set. Returned as a cloned Set
 * to prevent external mutation. Used by the shared mapper so currently-tracked
 * IDs get suppressed pre-broadcast.
 */
export function snapshotOptimisticRemovals(): ReadonlySet<string> {
  return new Set(optimisticallyRemovedIds);
}
