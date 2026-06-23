/**
 * Session delete-authority — the single seam through which every
 * `sessionSummaries` write path must classify its mutation intent BEFORE
 * mutating state.
 *
 * Origin: postmortem 260607_tombstone_ledger_f1_f2_block_renderer_4e909ad.
 * The renderer summary tier treated late async summary writes as ordinary
 * updates even after a user cleared/deleted/trashed a session, so a deleted id
 * could re-enter the sidebar (resurrection) or a trashed row could be silently
 * un-deleted. The tombstone ledger (formerly module-private to sessionStore.ts)
 * fixed that at each acceptance chokepoint; this module promotes it to a typed
 * authority contract so a NEW producer cannot land a stale write by simply not
 * knowing the ledger exists:
 *
 *   - Producer paths (anything that can CREATE or replace a summary row) call
 *     `classifySessionSummaryWrite()` and must reject the
 *     `stale-write-after-delete` leg before mutating.
 *   - Removal paths declare their intent via `recordSessionRemoval()` /
 *     `declareSoftDelete()`; restore declares via `declareSessionRestore()`.
 *   - Raw ledger membership is intentionally NOT exported — the discriminated
 *     classification is the only way to consult delete authority, so the
 *     "is it deleted?" question cannot be answered without also classifying
 *     the write.
 *
 * Enforcement: `__tests__/sessionStore.deleteAuthority.harness.test.ts`
 * enumerates every `sessionSummaries:` write site in sessionStore.ts (plus
 * renderer-wide direct-setState writers) and fails if a site is missing a
 * `delete-authority:` classification marker or bypasses this module.
 *
 * LEDGER SEMANTICS (unchanged from the original in-store ledger):
 *   - The ledger records ids that were ACTUALLY removed (hard delete, soft
 *     delete, empty trash, E2E clear). Every summary-acceptance path consults
 *     it and refuses to CREATE or UN-DELETE a tombstoned id, regardless of
 *     which async path lands late (stale persistence save, disk→store
 *     reconcile, cloud/automation ingest, approval-receipt write).
 *   - It is precise: only removed ids are blocked; a genuinely-new background
 *     session is never affected, and `declareSessionRestore()` clears the
 *     tombstone so an explicit un-trash works again.
 *   - The ledger is MODULE-scoped (shared across createSessionStore()
 *     instances) and RENDERER-ONLY. It does not stop an already-started
 *     `sessions:upsert` from writing an old session back to DISK after a real
 *     delete — main-side delete-wins remains a tracked follow-up (see the
 *     postmortem's Evidence Gaps).
 *   - Map values keep the removal timestamp + intent for diagnostics and
 *     future TTL eviction; correctness only needs membership.
 */

import type { AgentSessionSummary } from "@shared/types";

/** Why a set of session ids is being removed from the summary tier. */
export type SessionRemovalIntent =
  | "hard-delete"
  | "empty-trash"
  | "e2e-clear";

/**
 * Discriminated classification of a session-summary write, decided BEFORE the
 * mutation runs. The five legs are the postmortem's delete-authority contract:
 * create / update / soft-delete / restore / stale-write-after-delete.
 */
export type SessionSummaryWriteClassification =
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "soft-delete" }
  | { kind: "restore" }
  | { kind: "stale-write-after-delete"; removedAt: number };

type TombstoneEntry = {
  removedAt: number;
  intent: SessionRemovalIntent | "soft-delete";
};

// Module-scoped on purpose: shared across createSessionStore() instances so a
// store re-creation (tests, hot reload) cannot forget prior removals.
const sessionTombstones = new Map<string, TombstoneEntry>();

/**
 * Classify an incoming summary write for `sessionId`. Producer paths must call
 * this before mutating and treat `stale-write-after-delete` as a refusal: the
 * id was removed by an authoritative delete and only an explicit restore may
 * re-admit it.
 *
 * Delete authority has TWO inputs, both consulted here (review F1, round 2):
 *   1. The module-scoped ledger — deletions observed in THIS renderer
 *      lifetime (recorded by recordSessionRemoval / declareSoftDelete).
 *   2. The existing state row's `deletedAt` — a soft-deleted row PERSISTED to
 *      disk and loaded after a renderer restart has `deletedAt != null` but no
 *      ledger entry; without this input a stale live producer would classify
 *      as 'update' and silently un-delete it across restarts. Callers pass the
 *      current row's `deletedAt` so a write over an existing Trash row is
 *      rejected unless restoreSession() (declareSessionRestore + its live row
 *      write) ran first.
 *
 * The stale leg's contract is: the write may neither CREATE the id nor CLEAR
 * the existing row's `deletedAt`. Most producers treat it as a full refusal
 * (their writes are replace-shaped). One sanctioned exception:
 * ingestExternalSessions' terminal-subset merge spreads onto the EXISTING row
 * and preserves `deletedAt` by construction, so it may run on the stale leg —
 * see the call site comment (shipped 4c7db336a busy-flip contract).
 */
export function classifySessionSummaryWrite(args: {
  sessionId: string;
  /** Whether a row for this id currently exists in `sessionSummaries`. */
  hasExistingRow: boolean;
  /**
   * The existing state row's `deletedAt` (null/undefined when absent or
   * live). Required input for restart soundness — see doc comment above.
   */
  existingRowDeletedAt?: number | null;
}): Extract<
  SessionSummaryWriteClassification,
  { kind: "create" | "update" | "stale-write-after-delete" }
> {
  const tombstone = sessionTombstones.get(args.sessionId);
  if (tombstone !== undefined) {
    return { kind: "stale-write-after-delete", removedAt: tombstone.removedAt };
  }
  if (args.existingRowDeletedAt != null) {
    return {
      kind: "stale-write-after-delete",
      removedAt: args.existingRowDeletedAt,
    };
  }
  return args.hasExistingRow ? { kind: "update" } : { kind: "create" };
}

/**
 * Declare an authoritative removal (the row leaves the summary list entirely,
 * or — for e2e-clear — the whole list is replaced). Tombstones every id so no
 * summary-insertion path may re-create it.
 */
export function recordSessionRemoval(
  intent: SessionRemovalIntent,
  sessionIds: Iterable<string>,
): void {
  const now = Date.now();
  for (const id of sessionIds) {
    if (id) sessionTombstones.set(id, { removedAt: now, intent });
  }
}

/**
 * Declare a soft delete (trash): the row stays PRESENT in summaries with
 * `deletedAt` set, but no acceptance path may clear its `deletedAt` or
 * re-create it. Returns the typed classification for the caller's own write.
 */
export function declareSoftDelete(
  sessionId: string,
): Extract<SessionSummaryWriteClassification, { kind: "soft-delete" }> {
  if (sessionId) {
    sessionTombstones.set(sessionId, {
      removedAt: Date.now(),
      intent: "soft-delete",
    });
  }
  return { kind: "soft-delete" };
}

/**
 * Declare an explicit restore (un-trash): clears the tombstone so the session
 * may legitimately re-appear as live and accept summary writes again. Returns
 * the typed classification for the caller's own write.
 */
export function declareSessionRestore(
  sessionId: string,
): Extract<SessionSummaryWriteClassification, { kind: "restore" }> {
  sessionTombstones.delete(sessionId);
  return { kind: "restore" };
}

/**
 * A soft-deleted (trashed) row legitimately stays present in summaries with
 * `deletedAt` set. Wholesale disk→store replaces filter the incoming copy out
 * (stale-write-after-delete), so the reattach path keeps the EXISTING trashed
 * row — this predicate identifies exactly those rows.
 *
 * Deliberately does NOT require ledger membership (review F1, round 2): a
 * Trash row loaded from disk after a renderer restart has no ledger entry,
 * yet its reload copies are now state-derived-filtered by
 * classifySessionSummaryWrite — without reattach the row would be LOST from
 * the Trash view on the next reload. Any existing deletedAt-bearing row is
 * authoritative Trash state; only restoreSession() may turn it live.
 */
export function isReattachableTrashRow(
  summary: Pick<AgentSessionSummary, "id" | "deletedAt">,
): boolean {
  return summary.deletedAt != null;
}
