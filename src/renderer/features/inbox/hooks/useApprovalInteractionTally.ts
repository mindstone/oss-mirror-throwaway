/**
 * useApprovalInteractionTally
 *
 * Module-level ledger of approval-card interactions keyed by a composite
 * approvalId (e.g. `tool:…`, `memory:…`, `staged-tool:…`, `staged-file:…`).
 *
 * Why module-level rather than React state:
 *   - Cards unmount/remount as the user collapses drawer groups
 *     (NotificationDrawer conditionally renders the list inside `{isExpanded && …}`)
 *     and React state would reset, double-counting `Approval Card Viewed` and
 *     losing `secondsSinceCardViewed`.
 *   - Same-id events are de-duped by `usePendingApprovals`, so an evaluator
 *     re-eval produces a new component instance with the same approvalId — we
 *     want `firstSeenAt` to persist across that.
 *
 * The record is cleared when the approval resolves (caller invokes
 * `consumeAndClear(approvalId)`) or when it stops appearing in the pending set
 * for long enough that stale entries would accumulate. Phase 1 only clears on
 * decision; a later phase may add a time-based sweep.
 *
 * Intentionally NOT a React hook — there is no subscription need. The store is
 * a plain module with imperative helpers consumed by components and hooks.
 *
 * See:
 *   - docs/plans/260419_approval_card_clarity_improvements.md § Analytics Instrumentation
 *   - docs/tutorials/260420b_approval_card_clarity_plan.html § 5 (Analytics)
 */

export type ApprovalInteractionRecord = {
  firstSeenAt: number;
  viewedConversation: boolean;
  expandedWhy: boolean;
  usedRedirect: boolean;
  previewed: boolean;
};

const tallies = new Map<string, ApprovalInteractionRecord>();

/**
 * Idempotent: records the first-seen timestamp for an approvalId. Returns true
 * if this call created a new entry (so the caller can fire `Approval Card
 * Viewed` once per approvalId rather than once per mount).
 */
export function recordFirstSeen(approvalId: string): boolean {
  if (!approvalId) return false;
  if (tallies.has(approvalId)) return false;
  tallies.set(approvalId, {
    firstSeenAt: Date.now(),
    viewedConversation: false,
    expandedWhy: false,
    usedRedirect: false,
    previewed: false,
  });
  return true;
}

export function markViewedConversation(approvalId: string): void {
  const record = tallies.get(approvalId);
  if (record) record.viewedConversation = true;
}

/**
 * Returns true if this call flipped the flag (i.e. first expansion for this
 * approvalId). Callers gate `Approval Why Expanded` emission on this so
 * StrictMode double-invocation and expand → collapse → expand cycles produce
 * exactly one event per approvalId.
 */
export function markExpandedWhy(approvalId: string): boolean {
  const record = tallies.get(approvalId);
  if (!record) return false;
  if (record.expandedWhy) return false;
  record.expandedWhy = true;
  return true;
}

export function markUsedRedirect(approvalId: string): void {
  const record = tallies.get(approvalId);
  if (record) record.usedRedirect = true;
}

export function markPreviewed(approvalId: string): void {
  const record = tallies.get(approvalId);
  if (record) record.previewed = true;
}

export function getSecondsSinceFirstSeen(approvalId: string): number | undefined {
  if (!approvalId) return undefined;
  const record = tallies.get(approvalId);
  if (!record) return undefined;
  return Math.round((Date.now() - record.firstSeenAt) / 1000);
}

/**
 * Returns the current record without clearing it. Useful when firing an
 * interim event (e.g. `Approval View Conversation Clicked`) where we want the
 * record to persist for the eventual decision event.
 */
export function peekRecord(approvalId: string): ApprovalInteractionRecord | undefined {
  if (!approvalId) return undefined;
  return tallies.get(approvalId);
}

/**
 * Returns the record and removes it from the map. Call on decision events
 * (approve / deny / redirect completion) so stale entries don't accumulate.
 */
export function consumeAndClear(approvalId: string): ApprovalInteractionRecord | undefined {
  if (!approvalId) return undefined;
  const record = tallies.get(approvalId);
  if (record) tallies.delete(approvalId);
  return record;
}

/**
 * Test-only: wipe the tally store. Used by unit tests that exercise
 * multiple approvalIds in the same test run.
 */
export function _resetForTests(): void {
  tallies.clear();
}
