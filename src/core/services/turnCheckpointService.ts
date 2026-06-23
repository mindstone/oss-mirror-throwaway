/**
 * Turn Checkpoint Service
 *
 * Main-process-side persistence of agent turn events and messages directly
 * into the session file during the turn — independent of the renderer's
 * `requestIdleCallback`-driven save path. This eliminates the renderer as a
 * single point of failure for turn data: if the renderer is CPU-starved or
 * crashes mid-turn, accumulated events still reach disk.
 *
 * Two write triggers:
 *   1. Periodic (default 15s): While a turn is active, snapshot the
 *      accumulator and merge into the session file. Self-rescheduling
 *      `setTimeout` (not `setInterval`) so a slow write can never overlap.
 *   2. Terminal (result/error): Caller captures the accumulator's shape
 *      synchronously (before cleanup deletes the accumulator) and hands it
 *      to `checkpointTerminal()`, which writes asynchronously.
 *
 * Concurrency safety: writes go through `updateSessionWithReload`, which
 * acquires the per-session lock, acquires the index lock, reads the current
 * session from disk, merges, and writes via the reload-aware upsert path.
 *
 * Cross-surface: lives in `src/core/services/` and has zero Electron imports.
 *
 * @see docs/plans/260426_main_process_turn_checkpointing.md
 */

import type { AgentSession } from '@shared/types';
import type { ConversationStateShape } from '@shared/utils/conversationState';
import { replaceTurnEventsFromSuperset } from '@shared/utils/eventIdentity';
import { getMaxSeqFromSession } from './sessionSeqIndex';
import { classifySessionKind, defaultTitleForKind } from '@shared/sessionKind';
import type { LazyContextAccumulator } from './lazyContextAccumulator';
import { createScopedLogger } from '@core/logger';
import { updateSessionWithReload } from './lockedSessionPersistence';
import type { SessionsSyncUpsertOutcome } from './incrementalSessionStore';
import type { OwnerKind } from './superMcpOwnerRegistry';
import type { SessionLockManager } from '@core/utils/sessionFileLock';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'turnCheckpointService' });

const DEFAULT_CHECKPOINT_INTERVAL_MS = 15_000;

/** Reason a checkpoint was written, surfaced to `onCheckpointComplete`. */
export type TurnCheckpointReason = 'periodic' | 'terminal';

/**
 * Subset of `IncrementalSessionStore` the checkpoint manager actually uses.
 *
 * Defined as a structural type so tests can inject a fake store without
 * pulling in the full Electron-bound store implementation.
 */
export interface TurnCheckpointStore {
  getSession(sessionId: string): Promise<AgentSession | null>;
  upsertSessionsSyncWithReload(sessions: AgentSession[]): SessionsSyncUpsertOutcome;
}

export interface TurnCheckpointDeps {
  store: TurnCheckpointStore;
  lockManager: SessionLockManager;
  ownerKind: OwnerKind;
  /** Returns the accumulator for `turnId`, or `undefined` if the turn has ended. */
  getAccumulator: (turnId: string) => LazyContextAccumulator | undefined;
  /**
   * Optional notification fired after a successful checkpoint write. The
   * `reason` lets consumers (e.g. cloud sync) skip notifications they don't
   * care about — in particular, periodic checkpoints typically should NOT
   * trigger cloud pushes to avoid traffic amplification.
   */
  onCheckpointComplete?: (session: AgentSession, reason: TurnCheckpointReason) => void;
  /** Periodic checkpoint interval in milliseconds. Defaults to 15s. */
  intervalMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Per-turn state tracked by the manager. */
interface TurnCheckpointState {
  sessionId: string;
  /** Pending periodic timer; `null` while a checkpoint is in flight or stopped. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Event count at the time of the last successful checkpoint. */
  lastCheckpointEventCount: number;
  /** True while a periodic checkpoint write is in flight (defensive — the
   *  self-rescheduling timer should already prevent overlap). */
  inFlight: boolean;
}

/**
 * Pure merge: combine an accumulated turn shape with the existing on-disk
 * session into a new `AgentSession` snapshot.
 *
 * Merge rules (see planning doc § Merge Strategy):
 *   - Events: REPLACE `eventsByTurn[turnId]` with the accumulated events
 *     (the accumulator is the source of truth for this turn — its events are
 *     always a superset of anything previously persisted for the same turn).
 *   - Messages: KEEP every existing message. Add accumulator messages that
 *     don't already exist. Match on `turnId + role + createdAt` (NOT id —
 *     the renderer and main-process accumulator generate independent IDs).
 *   - Turn state: when `isTerminal`, force `activeTurnId: null` and
 *     `isBusy: false`. Otherwise mirror the accumulator's shape.
 *   - Metadata: every other field on `existing` is preserved verbatim
 *     (title, doneAt, draft, origin, resolvedAt, setupContext, etc.).
 *   - `updatedAt`: always set to `Date.now()`.
 *   - When `existing` is `null` (first-write case), a minimal session is
 *     created with a kind-aware default title (`defaultTitleForKind`: a fixed
 *     descriptive title for known background kinds, else 'New Agent Run') and
 *     `origin: 'manual'`.
 */
export function mergeTurnIntoSession(
  existing: AgentSession | null,
  turnShape: ConversationStateShape,
  sessionId: string,
  turnId: string,
  isTerminal: boolean,
): AgentSession {
  const now = Date.now();
  const turnEvents = turnShape.eventsByTurn[turnId] ?? [];

  // Turn-lifecycle fields. Terminal checkpoints always clear the busy flags
  // regardless of what the shape says (defensive — the shape may not yet
  // reflect the terminal event if capture happened just before dispatch).
  const nextActiveTurnId = isTerminal ? null : turnShape.activeTurnId;
  const nextIsBusy = isTerminal ? false : turnShape.isBusy;

  // First-write case: no existing session on disk. Create a minimal record
  // with just the turn data. The renderer will eventually save its richer
  // version (title, draft, etc.); subsequent merges preserve those fields.
  if (!existing) {
    const firstWriteEventsByTurn = turnEvents.length > 0
      ? { [turnId]: replaceTurnEventsFromSuperset(turnId, turnEvents) }
      : {};
    const firstWriteMaxSeq = getMaxSeqFromSession({
      eventsByTurn: firstWriteEventsByTurn,
      maxSeq: undefined,
    });
    return {
      id: sessionId,
      // Kind-aware default: known background kinds (e.g. use-case-discovery) get
      // a fixed descriptive title; everything else gets the 'New Agent Run'
      // placeholder and stays eligible for content-based auto-titling.
      title: defaultTitleForKind(classifySessionKind(sessionId)),
      createdAt: now,
      updatedAt: now,
      messages: [...turnShape.messages],
      eventsByTurn: firstWriteEventsByTurn,
      // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Checkpoint merge mirrors captured turn shape (or terminal clear) before updateSessionWithReload persists through the IncrementalSessionStore liveness stamp.
      activeTurnId: nextActiveTurnId,
      // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Terminal checkpoint explicitly clears busy; non-terminal mirrors captured shape and persistence re-stamps busy scalars on disk write.
      isBusy: nextIsBusy,
      lastError: turnShape.lastError ?? null,
      resolvedAt: null,
      origin: 'manual',
      ...(firstWriteMaxSeq > 0 ? { maxSeq: firstWriteMaxSeq } : {}),
    };
  }

  // Replace the entry for THIS turn; preserve all other turns verbatim.
  const mergedEventsByTurn: Record<string, typeof turnEvents> = {
    ...existing.eventsByTurn,
    [turnId]: replaceTurnEventsFromSuperset(turnId, turnEvents),
  };
  const mergedMaxSeq = getMaxSeqFromSession({
    eventsByTurn: mergedEventsByTurn,
    maxSeq: existing.maxSeq,
  });

  // Message merge strategy:
  //   1. Keep ALL existing messages from OTHER turns (untouched).
  //   2. Keep user messages from THIS turn (they're renderer-created and
  //      may not exist in the accumulator).
  //   3. REPLACE non-user messages for THIS turn with the accumulator's
  //      version (it's always a superset). This avoids duplicate assistant
  //      messages when the accumulator's text/timestamp evolves across
  //      periodic checkpoints.
  const existingMessages = existing.messages ?? [];
  const otherTurnMessages = existingMessages.filter((m) => m.turnId !== turnId);
  const currentTurnUserMessages = existingMessages.filter(
    (m) => m.turnId === turnId && m.role === 'user',
  );
  const accumulatorMessages = turnShape.messages;

  const mergedMessages = [
    ...otherTurnMessages,
    ...currentTurnUserMessages,
    ...accumulatorMessages,
  ].sort((a, b) => a.createdAt - b.createdAt);

  // Spread `existing` first so all metadata fields (title, doneAt,
  // starredAt, deletedAt, draft, privateMode, origin, resolvedAt,
  // setupContext, meetingCompanion, memoryUpdateStatusByTurn,
  // timeSavedStatusByTurn, compactionBoundaries, automationId,
  // automationRunId, cloudUpdatedAt, maxSeq, sessionWorking*, etc.) are
  // preserved verbatim. Then override only the turn-related fields.
  return {
    ...existing,
    messages: mergedMessages,
    eventsByTurn: mergedEventsByTurn,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Turn-checkpoint merge projects active turn from the accumulator snapshot; updateSessionWithReload then persists through the IncrementalSessionStore liveness stamp.
    activeTurnId: nextActiveTurnId,
    // eslint-disable-next-line rebel-liveness-scalars/no-raw-turn-liveness-scalars -- Merge performs terminal-derived clear (or shape mirror) and persisted write is corrected by the store stamp.
    isBusy: nextIsBusy,
    lastError: turnShape.lastError ?? null,
    updatedAt: now,
    ...(mergedMaxSeq > 0 ? { maxSeq: mergedMaxSeq } : {}),
  };
}

/**
 * Manages periodic + terminal checkpoint writes for active turns.
 *
 * Lifecycle:
 *   - `startCheckpointing(turnId, sessionId)` — begins periodic checkpoints.
 *     Idempotent: a second call for the same `turnId` is a no-op.
 *   - `stopCheckpointing(turnId)` — clears the timer and forgets the turn.
 *     Idempotent: calling for an unknown turn is a no-op.
 *   - `checkpointTerminal(turnId, sessionId, capturedShape)` — writes the
 *     final checkpoint using a pre-captured shape (the caller MUST capture
 *     synchronously before the accumulator is cleaned up). Also stops the
 *     timer for that turn.
 *   - `shutdown()` — clears every timer (graceful shutdown).
 */
export class TurnCheckpointManager {
  private readonly store: TurnCheckpointStore;
  private readonly lockManager: SessionLockManager;
  private readonly ownerKind: OwnerKind;
  private readonly getAccumulator: (turnId: string) => LazyContextAccumulator | undefined;
  private readonly onCheckpointComplete?: (
    session: AgentSession,
    reason: TurnCheckpointReason,
  ) => void;
  private readonly intervalMs: number;
  private readonly now: () => number;

  private readonly states = new Map<string, TurnCheckpointState>();

  constructor(deps: TurnCheckpointDeps) {
    this.store = deps.store;
    this.lockManager = deps.lockManager;
    this.ownerKind = deps.ownerKind;
    this.getAccumulator = deps.getAccumulator;
    this.onCheckpointComplete = deps.onCheckpointComplete;
    this.intervalMs = deps.intervalMs ?? DEFAULT_CHECKPOINT_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
  }

  /**
   * Begin periodic checkpoints for `turnId`. The first tick fires after
   * `intervalMs`. Calling again for the same `turnId` is a no-op so callers
   * don't have to track which turns are already armed.
   */
  startCheckpointing(turnId: string, sessionId: string): void {
    if (this.states.has(turnId)) {
      log.debug({ turnId, sessionId }, 'startCheckpointing: already running, no-op');
      return;
    }

    const state: TurnCheckpointState = {
      sessionId,
      timer: null,
      lastCheckpointEventCount: 0,
      inFlight: false,
    };
    this.states.set(turnId, state);
    this.scheduleNextTick(turnId, state);

    log.debug(
      { turnId, sessionId, intervalMs: this.intervalMs },
      'Started periodic turn checkpointing',
    );
  }

  /**
   * Stop periodic checkpoints for `turnId`. Cancels the pending timer (if
   * any) and forgets the turn. Idempotent.
   */
  stopCheckpointing(turnId: string): void {
    const state = this.states.get(turnId);
    if (!state) return;

    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.states.delete(turnId);

    log.debug({ turnId, sessionId: state.sessionId }, 'Stopped periodic turn checkpointing');
  }

  /**
   * Write a terminal checkpoint using a pre-captured shape.
   *
   * The shape MUST be captured synchronously by the caller before any
   * cleanup runs that could delete the accumulator (see planning doc
   * § Failure Mode Matrix → "Accumulator deleted before final checkpoint").
   *
   * This method also clears the periodic timer for `turnId` (idempotent).
   * Errors are caught and logged — they never propagate, so callers can
   * fire-and-forget without an outer try/catch.
   */
  async checkpointTerminal(
    turnId: string,
    sessionId: string,
    capturedShape: ConversationStateShape,
  ): Promise<void> {
    // Always tear down the periodic state first so a slow terminal write
    // can't race with another scheduled tick.
    const existing = this.states.get(turnId);
    if (existing?.timer) {
      clearTimeout(existing.timer);
      existing.timer = null;
    }
    this.states.delete(turnId);

    const eventCount = capturedShape.eventsByTurn[turnId]?.length ?? 0;
    const messageCount = capturedShape.messages.length;
    const startedAt = this.now();

    log.info(
      { turnId, sessionId, eventCount, messageCount },
      'Terminal checkpoint starting',
    );

    let writtenSession: AgentSession | null = null;

    try {
      const result = await updateSessionWithReload({
        sessionId,
        store: this.store,
        lockManager: this.lockManager,
        ownerKind: this.ownerKind,
        update: (current) => {
          const merged = mergeTurnIntoSession(current, capturedShape, sessionId, turnId, true);
          writtenSession = merged;
          return merged;
        },
      });

      if (result.updated) {
        if (writtenSession && this.onCheckpointComplete) {
          try {
            this.onCheckpointComplete(writtenSession, 'terminal');
          } catch (cbErr) {
            log.warn(
              { err: cbErr, turnId, sessionId },
              'Terminal checkpoint onCheckpointComplete callback threw',
            );
          }
        }

        log.info(
          {
            turnId,
            sessionId,
            eventCount,
            messageCount,
            durationMs: this.now() - startedAt,
          },
          'Terminal checkpoint complete',
        );
      } else {
        log.error(
          { turnId, sessionId, eventCount, messageCount, durationMs: this.now() - startedAt },
          'Terminal checkpoint write did not succeed — session may be incomplete on disk',
        );
      }
    } catch (err) {
      log.error({ err, turnId, sessionId }, 'Terminal checkpoint write failed');
    }
  }

  /**
   * Cancel every armed timer. For graceful shutdown. After this call, the
   * manager has no scheduled work; callers may call `startCheckpointing`
   * again later if needed.
   */
  shutdown(): void {
    if (this.states.size === 0) return;

    for (const [turnId, state] of this.states) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      log.debug({ turnId, sessionId: state.sessionId }, 'Cleared checkpoint timer at shutdown');
    }
    this.states.clear();
  }

  /** Arm the next periodic tick for this turn. */
  private scheduleNextTick(turnId: string, state: TurnCheckpointState): void {
    state.timer = setTimeout(() => {
      fireAndForget(this.doPeriodicCheckpoint(turnId), 'turnCheckpointService.doPeriodicCheckpoint');
    }, this.intervalMs);
  }

  /**
   * Periodic checkpoint body. Self-reschedules on completion (success or
   * failure) so a slow disk write delays the next tick rather than queuing
   * up a backlog. Skips when nothing changed since the last write.
   */
  private async doPeriodicCheckpoint(turnId: string): Promise<void> {
    const state = this.states.get(turnId);
    if (!state) {
      // stopCheckpointing() was called between schedule and fire — nothing to do.
      return;
    }
    state.timer = null;

    if (state.inFlight) {
      // Self-rescheduling timer should prevent this; defensive guard only.
      log.warn({ turnId, sessionId: state.sessionId }, 'Periodic checkpoint reentry detected');
      this.scheduleNextTick(turnId, state);
      return;
    }

    const accumulator = this.getAccumulator(turnId);
    if (!accumulator) {
      // The turn ended without `stopCheckpointing` being called. Tear down
      // our state so we don't keep ticking against a dead turn.
      log.debug(
        { turnId, sessionId: state.sessionId },
        'Periodic checkpoint: accumulator missing — turn ended; stopping',
      );
      this.states.delete(turnId);
      return;
    }

    const eventCount = accumulator.getEventCount();
    if (eventCount === state.lastCheckpointEventCount) {
      log.debug(
        { turnId, sessionId: state.sessionId, eventCount },
        'Periodic checkpoint: no new events since last write, skipping',
      );
      this.scheduleNextTick(turnId, state);
      return;
    }

    const sessionId = state.sessionId;
    const startedAt = this.now();
    const shape = accumulator.getConversationShape();
    state.inFlight = true;

    log.info(
      { turnId, sessionId, eventCount, messageCount: shape.messages.length },
      'Periodic checkpoint starting',
    );

    let writtenSession: AgentSession | null = null;

    try {
      const result = await updateSessionWithReload({
        sessionId,
        store: this.store,
        lockManager: this.lockManager,
        ownerKind: this.ownerKind,
        update: (current) => {
          const merged = mergeTurnIntoSession(current, shape, sessionId, turnId, false);
          writtenSession = merged;
          return merged;
        },
      });

      if (result.updated) {
        state.lastCheckpointEventCount = eventCount;

        if (writtenSession && this.onCheckpointComplete) {
          try {
            this.onCheckpointComplete(writtenSession, 'periodic');
          } catch (cbErr) {
            log.warn(
              { err: cbErr, turnId, sessionId },
              'Periodic checkpoint onCheckpointComplete callback threw',
            );
          }
        }

        log.info(
          { turnId, sessionId, eventCount, durationMs: this.now() - startedAt },
          'Periodic checkpoint complete',
        );
      } else {
        log.warn(
          { turnId, sessionId, eventCount, durationMs: this.now() - startedAt },
          'Periodic checkpoint write did not succeed — will retry next tick',
        );
      }
    } catch (err) {
      log.error({ err, turnId, sessionId }, 'Periodic checkpoint write failed');
    } finally {
      state.inFlight = false;
      // Reschedule only if we're still tracking this turn (someone may have
      // called stopCheckpointing while the write was in flight).
      if (this.states.has(turnId)) {
        this.scheduleNextTick(turnId, state);
      }
    }
  }
}

// ─── Module-level singleton ─────────────────────────────────────────────────
// Bootstrap (`src/main/bootstrap.ts` / `cloud-service/src/bootstrap.ts`) calls
// `initTurnCheckpointManager(deps)` once with the surface-specific store +
// accumulator getter. Consumers (event dispatcher, turn cleanup) reach the
// manager via `getTurnCheckpointManager()` and gracefully no-op when init
// hasn't happened yet (tests, cloud surfaces opting out, etc.) — see Stage 2
// of docs/plans/260426_main_process_turn_checkpointing.md.

let _instance: TurnCheckpointManager | null = null;

/**
 * Initialise the singleton turn checkpoint manager. Idempotent in the sense
 * that re-calling replaces the previous instance — but the previous instance
 * is NOT shut down here, because production bootstrap only calls this once.
 */
export function initTurnCheckpointManager(
  deps: TurnCheckpointDeps,
): TurnCheckpointManager {
  _instance = new TurnCheckpointManager(deps);
  return _instance;
}

/**
 * Return the singleton turn checkpoint manager, or `null` if it hasn't been
 * initialised yet. Callers should treat `null` as "checkpointing disabled" and
 * carry on (it's safe — the renderer save path is still active).
 */
export function getTurnCheckpointManager(): TurnCheckpointManager | null {
  return _instance;
}
