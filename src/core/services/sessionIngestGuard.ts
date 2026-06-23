/**
 * Pure, RENDERER-SAFE session-ingest regression guard (REBEL-6C0 / REBEL-6BZ Stage 2).
 *
 * Extracted from sessionMergeUtils.ts so the renderer (`sessionStore.ts`) can
 * import the guard WITHOUT transitively pulling in `@core/logger` — which
 * statically imports Node built-ins (`node:path`, `node:fs`, `node:fs/promises`,
 * `node:module`, `node:async_hooks`) and instantiates a logger at module load.
 * Importing the guard from sessionMergeUtils would drag all of that into the
 * renderer bundle (the recurring `renderer_node_core_import_leak` class — tsc
 * passes but the renderer BUILD breaks).
 *
 * This module imports ONLY types + `isValidSeq` (renderer-safe) — no `@core/logger`,
 * no Node built-ins, nothing transitively pulling them. The guard is PURE: it
 * returns a result the caller logs; the guard itself does no logging. Observability
 * (Sentry breadcrumb + console.warn) lives on the renderer side where the
 * renderer-safe breadcrumb util already lives.
 *
 * @see docs/plans/260622_fix-message-render-drop/PLAN.md Stage 2
 */

import type { AgentEvent, AgentSession } from '@shared/types';
import { isValidSeq } from '@shared/utils/eventIdentity';

/** Highest valid (positive integer) event seq within a single turn's event array, or 0. */
export function maxValidSeqForTurn(events: AgentEvent[] | undefined): number {
  let max = 0;
  for (const event of events ?? []) {
    if (isValidSeq(event.seq) && event.seq > max) {
      max = event.seq;
    }
  }
  return max;
}

/** Count non-user messages (role !== 'user') for a single turn. */
function countNonUserMessagesForTurn(
  messages: AgentSession['messages'] | undefined,
  turnId: string,
): number {
  let count = 0;
  for (const msg of messages ?? []) {
    if (msg.turnId === turnId && msg.role !== 'user') count += 1;
  }
  return count;
}

export type ActiveIngestRegressionGuardResult = {
  /** Messages to apply (live content substituted for any shrinking shared turn). */
  messages: AgentSession['messages'];
  /** Events to apply (live content substituted for any shrinking shared turn). */
  eventsByTurn: Record<string, AgentEvent[]>;
  /** Turn IDs whose live content was kept because the incoming snapshot would have shrunk them. */
  refusedTurnIds: string[];
  /** Whether the incoming snapshot was modified (any turn refused). */
  refused: boolean;
};

/**
 * Renderer defense-in-depth (REBEL-6C0 / REBEL-6BZ Stage 2): guard an active-session
 * ingest against a content-REGRESSING snapshot.
 *
 * An external ingest of the active session (cloud refresh, automation, inbound
 * trigger) wholesale-replaces the live in-memory transcript from a disk/external
 * snapshot. If that snapshot is content-poorer than what is currently live (e.g.
 * a stale disk read that lost a just-finished turn's final answer), the replace
 * silently regresses the visible transcript. This guard makes "an external ingest
 * shrank the active transcript" unrepresentable regardless of how the snapshot got
 * poorer.
 *
 * A shared turn is REGRESSING (and its live content is kept) when the incoming
 * snapshot has, for that turn:
 *   - FEWER non-user messages (role !== 'user'), OR
 *   - a LOWER max valid event seq.
 *
 * CRITICAL — must NOT be count-only: `mergeResultMessage` promotes an assistant
 * message to `result` IN-PLACE (same id, same count). So a count-stable regression
 * (the final answer reverted to the preamble, with a lower-seq event) is invisible
 * to a message-count comparison alone. Max valid event seq is the robust signal
 * (monotonic per session); the non-user-message-count check is defense-in-depth.
 *
 * Only STRICT shrink is refused — superset/equal incoming content applies normally
 * (legitimate cross-surface updates, session-switch, first-load, empty→populated
 * are unaffected). Cloud-only / new turns in the snapshot are always adopted.
 *
 * Pure: takes live + incoming, returns the guarded result + the refused turn IDs
 * (the caller emits the observable breadcrumb). Does not touch the visibility layer.
 * On the common NON-refused (hot) path it returns the incoming arrays BY REFERENCE
 * (no clone) — the active sync loop runs ~60+/min.
 */
export function guardActiveIngestRegression(
  live: { messages: AgentSession['messages'] | undefined; eventsByTurn: Record<string, AgentEvent[]> | undefined },
  incoming: { messages: AgentSession['messages'] | undefined; eventsByTurn: Record<string, AgentEvent[]> | undefined },
): ActiveIngestRegressionGuardResult {
  const liveMessages = live.messages ?? [];
  const liveEvents = live.eventsByTurn ?? {};
  const incomingMessages = incoming.messages ?? [];
  const incomingEvents = incoming.eventsByTurn ?? {};

  // Determine which shared turns the incoming snapshot would shrink.
  const liveTurnIds = new Set<string>();
  for (const msg of liveMessages) liveTurnIds.add(msg.turnId);
  for (const turnId of Object.keys(liveEvents)) liveTurnIds.add(turnId);

  const incomingTurnIds = new Set<string>();
  for (const msg of incomingMessages) incomingTurnIds.add(msg.turnId);
  for (const turnId of Object.keys(incomingEvents)) incomingTurnIds.add(turnId);

  const refusedTurnIds: string[] = [];
  for (const turnId of liveTurnIds) {
    if (!incomingTurnIds.has(turnId)) {
      // Turn present live but absent from the incoming snapshot → keeping it is a
      // shrink-refusal too (the snapshot would drop the whole turn).
      refusedTurnIds.push(turnId);
      continue;
    }
    const liveNonUser = countNonUserMessagesForTurn(liveMessages, turnId);
    const incomingNonUser = countNonUserMessagesForTurn(incomingMessages, turnId);
    const liveMaxSeq = maxValidSeqForTurn(liveEvents[turnId]);
    const incomingMaxSeq = maxValidSeqForTurn(incomingEvents[turnId]);
    if (incomingNonUser < liveNonUser || incomingMaxSeq < liveMaxSeq) {
      refusedTurnIds.push(turnId);
    }
  }

  if (refusedTurnIds.length === 0) {
    // Hot-path fast return: the incoming snapshot is not regressing, so apply it
    // BY REFERENCE (no clone). The active cloud-sync loop runs ~60+/min.
    return {
      messages: incomingMessages,
      eventsByTurn: incomingEvents,
      refusedTurnIds: [],
      refused: false,
    };
  }

  const refusedSet = new Set(refusedTurnIds);

  // Keep live messages for refused turns; adopt incoming messages for the rest.
  // (Incoming messages for refused turns are dropped — the live transcript wins.)
  const guardedMessages: AgentSession['messages'] = [
    ...incomingMessages.filter((m) => !refusedSet.has(m.turnId)),
    ...liveMessages.filter((m) => refusedSet.has(m.turnId)),
  ].sort((a, b) => a.createdAt - b.createdAt);

  // Keep live events for refused turns; adopt incoming events for the rest.
  const guardedEvents: Record<string, AgentEvent[]> = { ...incomingEvents };
  for (const turnId of refusedTurnIds) {
    const kept = liveEvents[turnId];
    if (kept !== undefined) {
      guardedEvents[turnId] = kept;
    } else {
      // Live had the turn via messages but no events entry — drop the incoming
      // (poorer) events for the refused turn rather than regress.
      delete guardedEvents[turnId];
    }
  }

  return {
    messages: guardedMessages,
    eventsByTurn: guardedEvents,
    refusedTurnIds,
    refused: true,
  };
}
