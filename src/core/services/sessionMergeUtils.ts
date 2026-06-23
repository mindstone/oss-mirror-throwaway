/**
 * Shared session merge primitives used by both the desktop-pull merge
 * (cloudRouter.ts → mergeSessionTurns) and the cloud-push merge
 * (sessions.ts → mergeDesktopPushIntoCloud).
 *
 * These primitives extract duplicated logic while preserving the direction-specific
 * semantics of each merge function. The merge functions themselves remain in their
 * respective files — this module provides only the shared building blocks.
 *
 * @see docs/plans/260405_core_centralization_cloud_desktop.md (Stage 4)
 * @see docs/plans/260315_cloud_continuity_overwrite_protection.md (merge design rationale)
 */

import { createScopedLogger } from '@core/logger';
import type { AgentEvent, AgentSession, MemoryUpdateStatus } from '@shared/types';
import {
  dropContentEquivalentRestamps,
  getEventIdentity,
  isValidSeq,
  type EventIdentity,
} from '@shared/utils/eventIdentity';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { fnvHashBase36 } from '@rebel/shared';

const sessionMergeUtilsLog = createScopedLogger({ service: 'sessionMergeUtils' });

type EventValueSummary = {
  type: string;
  hash: string;
  length: number;
};

export type EventOverwriteDiffEntry = {
  field: string;
  existing: EventValueSummary;
  incoming: EventValueSummary;
};

export type EventOverwritePreventedDetails = {
  sessionIdHash?: string;
  turnId: string;
  identity: EventIdentity;
  diff: EventOverwriteDiffEntry[];
  existingSeq?: number | null;
  incomingSeq?: number | null;
};

export type MergeEventsForCloudPushOptions = {
  sessionIdHash?: string;
  onEventOverwritePrevented?: (details: EventOverwritePreventedDetails) => void;
};

/**
 * Extract all known turn IDs from a session (from messages + eventsByTurn keys).
 * Both sources are checked for resilience against partial persistence or
 * migration edge cases where one source has turns the other doesn't.
 */
export function getKnownTurnIds(session: AgentSession): Set<string> {
  const turnIds = new Set<string>();
  if (session.eventsByTurn) {
    for (const turnId of Object.keys(session.eventsByTurn)) turnIds.add(turnId);
  }
  if (session.messages) {
    for (const msg of session.messages) turnIds.add(msg.turnId);
  }
  return turnIds;
}

/**
 * Check if any events in the array are terminal (type 'result' or 'error').
 * Terminal events indicate that a turn has completed execution.
 *
 * Strict variant — operates on typed AgentEvent[]. Use for in-memory merge
 * paths where events are already validated.
 */
export function hasTerminalEvent(events: AgentEvent[] | undefined): boolean {
  return (events ?? []).some((e) => e.type === 'result' || e.type === 'error');
}

/**
 * Corruption-tolerant variant — looks up a turn's events in an eventsByTurn map
 * and checks for terminal events with structural validation.
 *
 * Use for persisted data paths (session loading, startup correction, stale-busy
 * reaping) where eventsByTurn entries may be malformed from partial writes or
 * migration edge cases.
 *
 * Handles: undefined eventsByTurn, missing turnId key, non-array values,
 * non-object entries, entries missing 'type' field.
 */
export function hasTerminalEventInTurn(
  eventsByTurn: Record<string, unknown[]> | undefined,
  turnId: string,
): boolean {
  const events = eventsByTurn?.[turnId];
  if (!Array.isArray(events)) return false;
  return events.some(
    (e) => typeof e === 'object' && e !== null && 'type' in e && ((e as { type: string }).type === 'result' || (e as { type: string }).type === 'error'),
  );
}

/**
 * Merge per-turn Record maps. Primary side wins for shared turns,
 * secondary fills gaps for turns only it knows about.
 *
 * Consistent null handling: if secondary is undefined, return primary.
 * If primary is undefined, return secondary.
 *
 * @param primary — map from the authoritative side
 * @param secondary — map from the non-authoritative side
 * @param primaryTurnIds — turn IDs known to the primary side
 */
export function mergePerTurnMap<T>(
  primary: Record<string, T> | undefined,
  secondary: Record<string, T> | undefined,
  primaryTurnIds: Set<string>,
): Record<string, T> | undefined {
  if (!secondary) return primary;
  if (!primary) return secondary;
  const merged = { ...primary };
  for (const [turnId, value] of Object.entries(secondary)) {
    if (!primaryTurnIds.has(turnId) && !(turnId in merged)) {
      merged[turnId] = value;
    }
  }
  return merged;
}

/**
 * Union-by-key merge for ASYNC / SPARSE per-turn maps (e.g. AI activity
 * summaries). A turn's value survives if EITHER side has it; when both sides
 * carry a value for the same turn, primary wins.
 *
 * Why this differs from {@link mergePerTurnMap}: that helper treats the primary
 * side as authoritative for every turn it *knows about* — so for a SHARED turn
 * where primary lacks the key but secondary has it, the secondary value is
 * dropped. That is correct for a map the primary owns synchronously
 * (`timeSavedStatusByTurn` — produced only on the desktop surface; see
 * src/main/index.ts broadcastTimeSavedStatus and its not-cloud-pushed note), but
 * wrong for asynchronously generated, sparse artifacts: "primary knows the turn
 * but lacks this key" means "value not generated/seen on this side YET", not "no
 * value". Because renderer snapshots always include `activitySummaryByTurn:
 * { ... }`, that missing-key-on-a-shared-turn shape is the COMMON one, so the
 * authoritative-absence semantic causes real data loss on sync (Failure Mode F2,
 * 260618 show-more-activity). `memoryUpdateStatusByTurn` joined the async/sparse
 * camp (260619): it is produced on cloud-executed turns too, so it must survive
 * the catch-up pull — but its values are STATEFUL objects, so it uses
 * {@link mergeMemoryStatusByTurn} (union + terminal-beats-running), NOT this
 * stable-string union.
 *
 * Conflict policy: summaries are generated once and stable, so cross-side
 * conflict for the same turn is rare and either choice is fine — primary-wins is
 * simplest and deterministic.
 *
 * @param primary — map from the side that wins same-turn conflicts
 * @param secondary — map whose unique keys are unioned in
 */
export function unionPerTurnMap<T>(
  primary: Record<string, T> | undefined,
  secondary: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!secondary) return primary;
  if (!primary) return secondary;
  const merged = { ...secondary, ...primary };
  return merged;
}

/**
 * Union-by-key merge like {@link unionPerTurnMap}, but the SAME-turn conflict
 * winner is chosen by `resolveConflict(primaryValue, secondaryValue)` instead of
 * always taking primary. Needed for per-turn maps whose values are STATEFUL (a
 * lifecycle object), not stable strings — where "primary wins" can wrongly let an
 * older state shadow a newer one.
 *
 * @param primary — map whose value wins a same-turn conflict BY DEFAULT (via the resolver)
 * @param secondary — map whose unique keys are unioned in
 * @param resolveConflict — picks the winner for a turn present on BOTH sides
 */
export function unionPerTurnMapWith<T>(
  primary: Record<string, T> | undefined,
  secondary: Record<string, T> | undefined,
  resolveConflict: (primaryValue: T, secondaryValue: T) => T,
): Record<string, T> | undefined {
  if (!secondary) return primary;
  if (!primary) return secondary;
  const merged: Record<string, T> = { ...secondary, ...primary };
  for (const [turnId, secondaryValue] of Object.entries(secondary)) {
    const primaryValue = primary[turnId];
    if (primaryValue !== undefined) {
      merged[turnId] = resolveConflict(primaryValue, secondaryValue);
    }
  }
  return merged;
}

/**
 * Same-turn conflict resolver for `memoryUpdateStatusByTurn`. A TERMINAL status
 * (anything other than the transient `running` — i.e. `success`/`error`) beats a
 * stale `running`, regardless of which side is primary; otherwise primary wins.
 *
 * Why: memory status is a lifecycle object (`running` → `success`/`error`), and
 * after 260619 the executing surface persists only the terminal state while
 * `running` is live-broadcast-only. Without terminal-beats-running, a side that
 * happened to persist `running` (e.g. a legacy entry, or a transient write) could
 * shadow the other side's `success` forever under a plain primary-wins union. The
 * existing stale-`running` hydration cleanup (incrementalSessionStore) is the
 * other half of the same intent.
 *
 * Both-terminal or both-`running` → primary wins (deterministic; one terminal
 * outcome per turn is the norm, so genuine terminal/terminal conflicts are rare).
 */
export function resolveMemoryStatusConflict(
  primary: MemoryUpdateStatus,
  secondary: MemoryUpdateStatus,
): MemoryUpdateStatus {
  const primaryIsRunning = primary.status === 'running';
  const secondaryIsRunning = secondary.status === 'running';
  if (primaryIsRunning === secondaryIsRunning) return primary;
  return primaryIsRunning ? secondary : primary;
}

/**
 * Merge `memoryUpdateStatusByTurn` across surfaces: union missing keys (so a
 * cloud-produced status survives the desktop catch-up pull, and vice versa) and
 * resolve same-turn conflicts with {@link resolveMemoryStatusConflict}.
 */
export function mergeMemoryStatusByTurn(
  primary: Record<string, MemoryUpdateStatus> | undefined,
  secondary: Record<string, MemoryUpdateStatus> | undefined,
): Record<string, MemoryUpdateStatus> | undefined {
  return unionPerTurnMapWith(primary, secondary, resolveMemoryStatusConflict);
}

/**
 * Deduplicate messages by ID, sort by createdAt.
 *
 * @param authoritative — messages from the authoritative side (loaded first)
 * @param secondary — messages from the non-authoritative side
 * @param mode — collision resolution strategy:
 *   - `'authoritative-wins'`: skip secondary if ID already exists in authoritative
 *     (used by desktop-pull: local messages take priority)
 *   - `'secondary-wins'`: secondary overwrites authoritative on collision
 *     (used by cloud-push: incoming desktop messages overwrite existing cloud copies)
 */
export function deduplicateMessages(
  authoritative: AgentSession['messages'][number][],
  secondary: AgentSession['messages'][number][],
  mode: 'authoritative-wins' | 'secondary-wins',
): AgentSession['messages'][number][] {
  const messageMap = new Map<string, AgentSession['messages'][number]>();

  for (const msg of authoritative) {
    messageMap.set(msg.id, msg);
  }

  for (const msg of secondary) {
    if (mode === 'authoritative-wins') {
      if (!messageMap.has(msg.id)) {
        messageMap.set(msg.id, msg);
      }
    } else {
      // secondary-wins: always set (overwrite authoritative on collision)
      messageMap.set(msg.id, msg);
    }
  }

  return Array.from(messageMap.values()).sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Merge eventsByTurn for the desktop-pull direction.
 *
 * Local (desktop) is authoritative for shared turns. Cloud events are adopted
 * only for cloud-only turns and for the terminal-upgrade case (cloud completed
 * a turn that local didn't).
 *
 * DELIBERATE ASYMMETRY (do NOT "harmonize" into a symmetric union):
 * For any shared turn that local already completed (has a terminal event), the
 * local event array wins WHOLESALE — cloud events for that turn are dropped.
 * This is intentional: the local final answer must be preserved, not replaced
 * by a cloud snapshot that may be semantically older (e.g. cloud's updatedAt
 * was bumped by a memory/activity push after the turn completed, making it
 * chronologically newer but missing the final answer). Symmetrizing this merge
 * would re-open REBEL-6C0 / REBEL-6BZ (cloud-poorer event array clobbers the
 * local answer). The inverse edge — cloud terminal supersedes local
 * non-terminal — is intentional and is bounded by tests in
 * cloudSessionMerge.test.ts (Completeness F2). See
 * docs/plans/260622_fix-message-render-drop/PLAN.md DA F1.
 */
export function mergeEventsForDesktopPull(
  localEvents: Record<string, AgentEvent[]>,
  cloudEvents: Record<string, AgentEvent[]>,
): { merged: Record<string, AgentEvent[]>; hasNewEvents: boolean } {
  let hasNewEvents = false;
  const merged: Record<string, AgentEvent[]> = { ...localEvents };

  for (const turnId of Object.keys(cloudEvents)) {
    if (!localEvents[turnId]) {
      merged[turnId] = cloudEvents[turnId];
      hasNewEvents = true;
    } else if (!hasTerminalEvent(localEvents[turnId]) && hasTerminalEvent(cloudEvents[turnId])) {
      // Inverse edge (Completeness F2): cloud has terminal, local doesn't →
      // cloud supersedes (local non-terminal streaming events are dropped).
      // INTENTIONAL — see JSDoc above.
      merged[turnId] = cloudEvents[turnId];
      hasNewEvents = true;
    }
    // else: local already has a terminal event → local wins wholesale (DELIBERATE ASYMMETRY above)
  }

  return { merged, hasNewEvents };
}

// The active-session ingest regression guard (REBEL-6C0 / REBEL-6BZ Stage 2)
// lives in the PURE, renderer-safe module ./sessionIngestGuard so the renderer
// can import it without dragging `@core/logger` (and its Node built-ins) into the
// renderer bundle. Re-exported here for non-renderer consumers / continuity.
export {
  maxValidSeqForTurn,
  guardActiveIngestRegression,
  type ActiveIngestRegressionGuardResult,
} from './sessionIngestGuard';

/**
 * Merge eventsByTurn for the cloud-push (desktop -> cloud) direction.
 *
 * Events are append-only: existing cloud events win identity collisions,
 * incoming-only events are appended, and cloud-only turns are preserved.
 */
export function mergeEventsForCloudPush(
  existingEvents: Record<string, AgentEvent[]>,
  incomingEvents: Record<string, AgentEvent[]>,
  options: MergeEventsForCloudPushOptions = {},
): Record<string, AgentEvent[]> {
  const merged: Record<string, AgentEvent[]> = {};
  const turnIds = new Set([...Object.keys(existingEvents), ...Object.keys(incomingEvents)]);

  for (const turnId of turnIds) {
    merged[turnId] = mergeEventArrayDedupe(
      turnId,
      existingEvents[turnId] ?? [],
      incomingEvents[turnId] ?? [],
      options,
    );
  }

  return merged;
}

function mergeEventArrayDedupe(
  turnId: string,
  existing: AgentEvent[],
  incoming: AgentEvent[],
  options: MergeEventsForCloudPushOptions,
): AgentEvent[] {
  const eventByIdentity = new Map<EventIdentity, AgentEvent>();
  const merged: AgentEvent[] = [];

  for (const event of existing) {
    for (const identity of getExistingEventIdentitiesForMerge(turnId, event)) {
      if (!eventByIdentity.has(identity)) {
        eventByIdentity.set(identity, event);
      }
    }
    merged.push(event);
  }

  for (const event of incoming) {
    const identity = getMergeEventIdentity(turnId, event);
    const existingEvent = eventByIdentity.get(identity);
    if (existingEvent) {
      const diff = diffEvents(existingEvent, event);
      const details: EventOverwritePreventedDetails = {
        sessionIdHash: options.sessionIdHash,
        turnId,
        identity,
        diff,
        existingSeq: normalizeSeq(existingEvent.seq),
        incomingSeq: normalizeSeq(event.seq),
      };
      sessionMergeUtilsLog.warn(
        {
          sessionIdHash: options.sessionIdHash,
          turnId,
          identity,
          diff,
          existingSeq: details.existingSeq,
          incomingSeq: details.incomingSeq,
        },
        'Prevented incoming event from overwriting existing cloud event during session merge',
      );
      options.onEventOverwritePrevented?.(details);
      continue;
    }

    eventByIdentity.set(identity, event);
    merged.push(event);
  }

  const sorted = merged.sort(compareEventsBySeqThenTimestamp);
  return dropContentEquivalentRestamps(turnId, sorted, {
    onContentEquivalentRestampCollapsed: ({ droppedSeq, retainedSeq }) => {
      sessionMergeUtilsLog.warn(
        {
          sessionIdHash: options.sessionIdHash,
          turnIdHash: hashSessionIdForBreadcrumb(turnId),
          droppedSeq,
          retainedSeq,
        },
        'Collapsed content-equivalent restamped event during cloud-push merge',
      );
    },
  });
}

function getExistingEventIdentitiesForMerge(turnId: string, event: AgentEvent): EventIdentity[] {
  const primary = getMergeEventIdentity(turnId, event);
  const fallback = getFallbackEventIdentity(turnId, event);
  return fallback === primary ? [primary] : [primary, fallback];
}

function getMergeEventIdentity(turnId: string, event: AgentEvent): EventIdentity {
  const identity = getEventIdentity(turnId, event);
  const clientOrdinal = getClientOrdinal(event);
  if (!isValidSeq(event.seq) && clientOrdinal !== null) {
    return `${identity}:ord:${clientOrdinal}`;
  }
  return identity;
}

function getFallbackEventIdentity(turnId: string, event: AgentEvent): EventIdentity {
  const timestamp = event.timestamp ?? '';
  const clientOrdinal = getClientOrdinal(event);
  const base = `${turnId}:type:${event.type}:ts:${timestamp}`;
  return clientOrdinal === null ? base : `${base}:ord:${clientOrdinal}`;
}

function getClientOrdinal(event: AgentEvent): number | null {
  const clientOrdinal = (event as AgentEvent & { clientOrdinal?: unknown }).clientOrdinal;
  return typeof clientOrdinal === 'number' && Number.isInteger(clientOrdinal) && clientOrdinal >= 0
    ? clientOrdinal
    : null;
}

function normalizeSeq(seq: AgentEvent['seq']): number | null {
  return isValidSeq(seq) ? seq : null;
}

function compareEventsBySeqThenTimestamp(left: AgentEvent, right: AgentEvent): number {
  const leftSeq = isValidSeq(left.seq) ? left.seq : Number.MAX_SAFE_INTEGER;
  const rightSeq = isValidSeq(right.seq) ? right.seq : Number.MAX_SAFE_INTEGER;
  if (leftSeq !== rightSeq) return leftSeq - rightSeq;

  const leftTimestamp = typeof left.timestamp === 'number' ? left.timestamp : Number.MAX_SAFE_INTEGER;
  const rightTimestamp = typeof right.timestamp === 'number' ? right.timestamp : Number.MAX_SAFE_INTEGER;
  return leftTimestamp - rightTimestamp;
}

function diffEvents(existing: AgentEvent, incoming: AgentEvent): EventOverwriteDiffEntry[] {
  const existingRecord = existing as Record<string, unknown>;
  const incomingRecord = incoming as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(existingRecord), ...Object.keys(incomingRecord)])).sort();
  return keys.flatMap((field) => {
    const existingValue = summarizeValue(existingRecord[field]);
    const incomingValue = summarizeValue(incomingRecord[field]);
    if (
      existingValue.hash === incomingValue.hash
      && existingValue.type === incomingValue.type
      && existingValue.length === incomingValue.length
    ) {
      return [];
    }
    return [{ field, existing: existingValue, incoming: incomingValue }];
  });
}

function summarizeValue(value: unknown): EventValueSummary {
  const serialized = stringifyForHash(value);
  return {
    type: Array.isArray(value) ? 'array' : typeof value,
    hash: fnvHashBase36(serialized),
    length: serialized.length,
  };
}

function stringifyForHash(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    return '[unserializable]';
  }
}
