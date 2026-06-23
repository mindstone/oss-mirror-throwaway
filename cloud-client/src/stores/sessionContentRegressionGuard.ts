/**
 * Pure content-regression guard for the mobile/web cloud client's `fetchSession`
 * (REBEL-6C0 / REBEL-6BZ mobile parity).
 *
 * Mirrors the *philosophy* of the desktop `@core/services/sessionIngestGuard` but
 * is intentionally self-contained: the desktop guard operates on per-turn
 * `eventsByTurn: Record<string, AgentEvent[]>`, while the mobile `FullSession`
 * carries only the lossy `toolEventsByTurn` plus a session-level `maxSeq` and the
 * store-level `appliedSeq[id]`. Per-turn event-seq comparison isn't cleanly
 * available here, so this guard works at the session level. Do NOT import the
 * desktop guard (different package boundary + needs `eventsByTurn`).
 *
 * The race this defends (found by cross-family review of the mobile parity
 * question): reconnect catch-up applies `messageDelta` directly into the live
 * `currentSession.messages` (EventBridge `applyCatchUpMessageDelta`), enriching
 * the visible transcript. The catch-up then forces a coalesced `fetchSession`
 * for the active session. `fetchSession`'s cache-hydrate branch can replace the
 * just-enriched transcript with an OLDER per-conversation cache (validated only
 * for `id`+`messages`, never against richness/seq); if the subsequent REST
 * `getSession` then fails transiently, the poorer cached snapshot survives and
 * the enriched content is lost (and `appliedSeq` stays ahead, so re-applying the
 * dropped events is suppressed).
 *
 * Design intent — refuse ONLY a clear strict same-session shrink:
 *   - The cloud server is authoritative and seq-monotonic, so a richer or equal
 *     server snapshot must ALWAYS win. Getting stuck on a stale view is as bad as
 *     the drop. When unsure, ERR TOWARD APPLYING.
 *   - The guard exists to stop a *poorer* snapshot (especially the local cache)
 *     from clobbering a transcript the user already saw.
 *
 * Pure: returns a decision the caller logs; this module does no logging.
 */

/** Minimal shape the guard needs from a transcript snapshot. */
export interface RegressionGuardSnapshot {
  id: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'result' | (string & {});
    /**
     * Per-turn grouping key (the real `SessionMessage`/`CloudSessionMessage`
     * carries it). Lets the cache branch catch COUNT-STABLE regressions where a
     * turn's `result` was demoted back to an `assistant` preamble (the desktop
     * REBEL-6C0 in-place-promotion shape).
     */
    turnId?: string;
    /**
     * The guard reads ONLY `role` and `turnId`. These remaining fields are
     * declared so a realistic `SessionMessage`/`CloudSessionMessage` object
     * LITERAL (as in the tests) satisfies the element type — production callers
     * already pass full message objects via variable assignment, which permits
     * excess properties.
     */
    id?: string;
    text?: string;
    createdAt?: number;
  }>;
  /** Session-level max applied event seq, when the snapshot carries one. */
  maxSeq?: number;
}

export type RegressionGuardRefusalReason =
  | 'seq-shrink'
  | 'message-count-shrink'
  /**
   * Cache branch only: a same-session cached snapshot is not a per-turn
   * role-richness superset/equal of the live transcript — e.g. it has the SAME
   * non-user count but a turn's `result` regressed to an `assistant` preamble
   * (count-stable). The REST branch never raises this (it stays seq-only).
   */
  | 'content-regression';

export interface RegressionGuardDecision {
  /** True iff the incoming snapshot must be refused (keep live, drop incoming). */
  refuse: boolean;
  /** Why it was refused (undefined when not refused). */
  reason?: RegressionGuardRefusalReason;
  /** Observability detail — counts/seq for the breadcrumb the caller emits. */
  liveNonUserCount: number;
  incomingNonUserCount: number;
  appliedSeq: number;
  incomingMaxSeq?: number;
}

function countNonUserMessages(messages: RegressionGuardSnapshot['messages']): number {
  let count = 0;
  for (const msg of messages) {
    if (msg && msg.role !== 'user') count += 1;
  }
  return count;
}

// Sentinel turn-key for non-user messages that carry no turnId. Plain ASCII —
// must not contain control chars (a NUL here made git treat the file as binary).
const NO_TURN_KEY = '__no-turn__';

/** Per-turn non-user role tally used to detect a role-richness regression. */
interface TurnRoleTally {
  /** Count of non-user messages (any non-`user` role) for the turn. */
  nonUserCount: number;
  /** Count of `role: 'result'` messages for the turn (strictly richer than `assistant`). */
  resultCount: number;
}

/**
 * Group a transcript's non-user messages by `turnId`, tallying total non-user
 * messages and `result` messages per turn. Messages without a `turnId` are
 * grouped under a single sentinel bucket so they still participate in the
 * count signal (but can never be falsely matched to a real turn).
 */
function tallyNonUserByTurn(messages: RegressionGuardSnapshot['messages']): Map<string, TurnRoleTally> {
  const byTurn = new Map<string, TurnRoleTally>();
  for (const msg of messages) {
    if (!msg || msg.role === 'user') continue;
    const key = typeof msg.turnId === 'string' && msg.turnId.length > 0 ? msg.turnId : NO_TURN_KEY;
    const tally = byTurn.get(key) ?? { nonUserCount: 0, resultCount: 0 };
    tally.nonUserCount += 1;
    if (msg.role === 'result') tally.resultCount += 1;
    byTurn.set(key, tally);
  }
  return byTurn;
}

/**
 * True iff `incoming` is NOT a per-turn role-richness superset/equal of `live`:
 * for some turn present in BOTH transcripts the incoming has FEWER non-user
 * messages, or FEWER `result` messages (a turn whose final answer regressed from
 * `result` back to an `assistant` preamble — the count-stable REBEL-6C0 shape).
 *
 * Only compares SHARED turns: a turn the incoming hasn't loaded yet is not a
 * regression of an existing turn (the count signal still guards whole-turn
 * disappearance), and a turn only the incoming has is pure enrichment.
 */
function isPerTurnContentRegression(
  live: RegressionGuardSnapshot['messages'],
  incoming: RegressionGuardSnapshot['messages'],
): boolean {
  const liveByTurn = tallyNonUserByTurn(live);
  const incomingByTurn = tallyNonUserByTurn(incoming);
  for (const [turnId, liveTally] of liveByTurn) {
    const incomingTally = incomingByTurn.get(turnId);
    if (!incomingTally) continue; // turn not in incoming → not a shared-turn regression
    if (
      incomingTally.nonUserCount < liveTally.nonUserCount
      || incomingTally.resultCount < liveTally.resultCount
    ) {
      return true;
    }
  }
  return false;
}

function isPositiveIntegerSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

const APPLY: RegressionGuardDecision = {
  refuse: false,
  liveNonUserCount: 0,
  incomingNonUserCount: 0,
  appliedSeq: 0,
};

export interface RegressionGuardOptions {
  /**
   * Whether the non-user-message-count shrink signal is allowed to refuse.
   *
   * Enable for the LOCAL CACHE branch: a cached snapshot is validated for
   * `id`+`messages` only and may lack `maxSeq`, so the count is the only
   * defense against a stale cache clobbering an enriched transcript.
   *
   * Disable for the authoritative REST branch: the server is the source of
   * truth, so we must NOT refuse a fresh server snapshot purely because it has
   * fewer messages (e.g. a legitimately-emptied or reset transcript that
   * carries no/equal seq). The REST branch refuses only on the robust seq
   * signal (`maxSeq < appliedSeq`). This keeps the guard from getting stuck on
   * a stale view — over-aggression is as bad as the drop.
   *
   * @default true
   */
  useMessageCountSignal?: boolean;
}

/**
 * Decide whether an incoming `currentSession` replace would content-REGRESS the
 * live transcript for the SAME session, and so must be refused.
 *
 * Engages only when:
 *   - `live` exists AND `live.id === incoming.id` (same session — a switch /
 *     first load / different session always applies), AND
 *   - the live transcript is non-empty (empty → populated always applies).
 *
 * Refuses (keep live, drop incoming) ONLY on a STRICT shrink of the same session:
 *   - incoming `maxSeq` is present and `< appliedSeq` (the robust, monotonic
 *     signal — both branches), OR
 *   - incoming has FEWER non-user messages (`role !== 'user'`) than the live
 *     transcript — only when `useMessageCountSignal` (the cache branch, whose
 *     cached snapshot may lack `maxSeq`). The authoritative REST branch does NOT
 *     refuse on count alone, OR
 *   - incoming is not a per-turn role-richness superset/equal of live (a shared
 *     turn has fewer non-user or fewer `result` messages — the COUNT-STABLE
 *     regression) — again only when `useMessageCountSignal` (cache branch). This
 *     catches the desktop in-place `result`→`assistant` shape the count signal
 *     misses. The REST branch stays seq-only.
 *
 * Superset / equal incoming → apply. When unsure → apply.
 */
export function decideSessionContentRegression(
  live: RegressionGuardSnapshot | null | undefined,
  incoming: RegressionGuardSnapshot,
  appliedSeq: number,
  options?: RegressionGuardOptions,
): RegressionGuardDecision {
  const useMessageCountSignal = options?.useMessageCountSignal ?? true;
  // No live session, or a different session → always adopt the incoming.
  if (!live || live.id !== incoming.id) return APPLY;

  const liveMessages = live.messages ?? [];
  const liveNonUserCount = countNonUserMessages(liveMessages);
  // Empty live transcript → always adopt (empty → populated is never a regression).
  if (liveNonUserCount === 0 && liveMessages.length === 0) return APPLY;

  const incomingMessages = incoming.messages ?? [];
  const incomingNonUserCount = countNonUserMessages(incomingMessages);
  const incomingMaxSeq = isPositiveIntegerSeq(incoming.maxSeq) ? incoming.maxSeq : undefined;

  // Robust signal: a same-session snapshot whose maxSeq is BELOW what the live
  // event stream has already applied is strictly stale. Only fires when the
  // snapshot actually carries a maxSeq (the cache branch's snapshot may not).
  if (incomingMaxSeq !== undefined && appliedSeq > 0 && incomingMaxSeq < appliedSeq) {
    return {
      refuse: true,
      reason: 'seq-shrink',
      liveNonUserCount,
      incomingNonUserCount,
      appliedSeq,
      incomingMaxSeq,
    };
  }

  // Defense-in-depth (cache branch only): a same-session snapshot with strictly
  // fewer non-user messages than the live transcript is a visible shrink.
  // Equal/superset counts apply normally (so a richer/equal snapshot always
  // wins). Disabled for the authoritative REST branch to avoid over-aggression.
  if (useMessageCountSignal && incomingNonUserCount < liveNonUserCount) {
    return {
      refuse: true,
      reason: 'message-count-shrink',
      liveNonUserCount,
      incomingNonUserCount,
      appliedSeq,
      ...(incomingMaxSeq !== undefined ? { incomingMaxSeq } : {}),
    };
  }

  // Count-stable defense (cache branch only): the cached snapshot may have the
  // SAME non-user count as the live transcript yet still regress a turn — the
  // desktop REBEL-6C0 bug promotes an assistant preamble to a `result` IN-PLACE
  // (same id, same count). A stale cache where a turn's final answer is still
  // the short `assistant` preamble while the live transcript holds the promoted
  // `result` has equal counts but is content-poorer. Refuse any cache that is
  // not a per-turn role-richness superset/equal of the live transcript. Scoped
  // to the cache branch (`useMessageCountSignal`): the cache is never
  // authoritative and the REST snapshot follows immediately, so refusing a
  // non-enriching cache only defers to REST (no stuck-on-stale risk). The REST
  // branch stays seq-only so a legitimately-fewer server snapshot still wins.
  if (useMessageCountSignal && isPerTurnContentRegression(liveMessages, incomingMessages)) {
    return {
      refuse: true,
      reason: 'content-regression',
      liveNonUserCount,
      incomingNonUserCount,
      appliedSeq,
      ...(incomingMaxSeq !== undefined ? { incomingMaxSeq } : {}),
    };
  }

  return {
    refuse: false,
    liveNonUserCount,
    incomingNonUserCount,
    appliedSeq,
    ...(incomingMaxSeq !== undefined ? { incomingMaxSeq } : {}),
  };
}
