/**
 * Plugin Event Bus
 *
 * Module-level singleton that dispatches lifecycle events to plugin subscribers.
 * Pure renderer-side — no IPC channels needed.
 *
 * Events are sourced from existing session store subscriptions and agent event
 * processing in App.tsx. Plugins subscribe via the `useRebelEvent` hook.
 *
 * Privacy guard: `turn:*` and `conversation:*` events are suppressed during
 * private-mode sessions. Navigation and memory events are always dispatched.
 *
 * Initialization guard: No events are dispatched until `initialize()` is called
 * (after plugin loading is complete), preventing spurious events during startup.
 *
 * @see src/renderer/features/plugins/api/useRebelEvent.ts — React hook for subscribing
 * @see src/renderer/App.tsx — wiring that calls emit()
 */

import { getSessionStoreState } from '@renderer/features/agent-session/store/sessionStore';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { isSessionPrivate } from './sessionPrivacyGuard';
import type { RebelEventType } from './types';

type EventListener = (payload: unknown) => void;

type BufferedEvent = {
  seq: number;
  eventType: RebelEventType;
  payload: unknown;
  replaySessionId?: string;
};

// Keeps replay memory bounded to the last 200 renderer plugin events.
const EVENT_BUFFER_CAPACITY = 200;

/** Events that must NOT fire during private-mode sessions */
const PRIVACY_GUARDED_EVENTS: ReadonlySet<RebelEventType> = new Set([
  'turn:started',
  'turn:completed',
  'turn:error',
  'conversation:created',
  'conversation:updated',
  'conversation:deleted',
  'conversation:restored',
]);

const listeners = new Map<RebelEventType, Set<EventListener>>();
const eventBuffer: BufferedEvent[] = [];
const replayCursors = new Map<string, number>();
let initialized = false;
let nextSeq = 1;

function isPrivateSession(): boolean {
  try {
    return getSessionStoreState().privateMode;
  } catch {
    // Store not ready yet — treat as private (safe default)
    return true;
  }
}

function extractPayloadSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const sessionId = (payload as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

function shouldDispatch(eventType: RebelEventType, targetSessionId?: string): boolean {
  if (!PRIVACY_GUARDED_EVENTS.has(eventType)) return true;
  return targetSessionId ? !isSessionPrivate(targetSessionId) : !isPrivateSession();
}

function shouldReplay(event: BufferedEvent): boolean {
  if (!PRIVACY_GUARDED_EVENTS.has(event.eventType)) return true;
  return event.replaySessionId ? !isSessionPrivate(event.replaySessionId) : !isPrivateSession();
}

function getCursorKey(scopeId: string, eventType: RebelEventType): string {
  return `${scopeId}\u0000${eventType}`;
}

function getLatestSeq(eventType: RebelEventType): number {
  for (let index = eventBuffer.length - 1; index >= 0; index -= 1) {
    const event = eventBuffer[index];
    if (event.eventType === eventType) return event.seq;
  }
  return nextSeq - 1;
}

function appendBufferedEvent(eventType: RebelEventType, payload: unknown, targetSessionId?: string): BufferedEvent {
  const event: BufferedEvent = {
    seq: nextSeq++,
    eventType,
    payload,
    replaySessionId: targetSessionId ?? extractPayloadSessionId(payload),
  };
  eventBuffer.push(event);
  if (eventBuffer.length > EVENT_BUFFER_CAPACITY) {
    eventBuffer.shift();
  }
  return event;
}

/**
 * Subscribe to a specific event type.
 * Returns an unsubscribe function for cleanup.
 */
function subscribe(eventType: RebelEventType, listener: EventListener): () => void {
  let set = listeners.get(eventType);
  if (!set) {
    set = new Set();
    listeners.set(eventType, set);
  }
  set.add(listener);

  const capturedSet = set;
  return () => {
    capturedSet.delete(listener);
    if (capturedSet.size === 0) {
      listeners.delete(eventType);
    }
  };
}

/**
 * Subscribe with replay support for React plugin hooks ("catch up on reopen").
 *
 * Replay cursors are scoped by the hook's stable subscription key (per plugin /
 * event / subscription slot). We distinguish the FIRST-EVER subscription for a
 * key from a REMOUNT of a previously-torn-down subscription:
 *
 * - First-ever subscription: the cursor key does not yet exist. We seed it at
 *   the current high water and replay NOTHING, so a freshly-mounted plugin does
 *   not receive an arbitrary old backlog.
 * - Remount: the cursor key already exists (a prior subscription for this slot
 *   was torn down — `release()` does not clear the cursor). The fresh component
 *   has lost any event-derived React state, so we RECONSTRUCT it by replaying
 *   every buffered event of this type from the buffer start (privacy-rechecked
 *   via `shouldReplay`, in seq order). The global buffer keeps only the last
 *   EVENT_BUFFER_CAPACITY events, so memory stays bounded.
 *
 * A continuously-mounted component never re-subscribes, so it only ever receives
 * events via live dispatch — replay cannot double-fire an event it already got.
 */
function subscribeWithReplay(
  replayCursorKey: string,
  eventType: RebelEventType,
  listener: EventListener,
): () => void {
  const cursorKey = getCursorKey(replayCursorKey, eventType);
  const isRemount = replayCursors.has(cursorKey);
  if (!isRemount) {
    replayCursors.set(cursorKey, getLatestSeq(eventType));
  }

  const trackedListener = (payload: unknown) => {
    replayCursors.set(cursorKey, nextSeq - 1);
    listener(payload);
  };
  const unsubscribe = subscribe(eventType, trackedListener);

  // Only remounts catch up. On a remount we replay the full buffered history of
  // this event type (not just seq > cursor) so the fresh component rebuilds its
  // event-derived view even for events it consumed during a prior mount.
  if (isRemount) {
    for (const event of eventBuffer) {
      if (event.eventType !== eventType) continue;
      replayCursors.set(cursorKey, event.seq);
      if (!shouldReplay(event)) continue;
      try {
        listener(event.payload);
      } catch (error) {
        // Mirror live dispatch error isolation for replay, but record the swallow
        // for observability (a replayed plugin listener threw).
        ignoreBestEffortCleanup(error, {
          operation: 'pluginEventBus.replay',
          reason: 'a replayed plugin listener threw; isolate it like live dispatch',
        });
      }
    }
  }

  return unsubscribe;
}

/**
 * Emit an event to all subscribers of the given type.
 * No-ops if not yet initialized or if privacy guard blocks the event.
 *
 * When `targetSessionId` is provided, privacy is checked against that specific
 * session (for cross-session events like lifecycle events). Otherwise, falls back
 * to checking the current session's `privateMode` (existing behavior).
 */
function emit(eventType: RebelEventType, payload: unknown, targetSessionId?: string): void {
  if (!initialized) return;
  if (!shouldDispatch(eventType, targetSessionId)) return;

  appendBufferedEvent(eventType, payload, targetSessionId);

  const set = listeners.get(eventType);
  if (!set || set.size === 0) return;

  for (const listener of set) {
    try {
      listener(payload);
    } catch {
      // Best-effort: don't let a bad plugin listener break other listeners
    }
  }
}

/**
 * Mark the event bus as ready to dispatch events.
 * Call once after plugin loading is complete.
 */
function initialize(): void {
  initialized = true;
}

/**
 * Reset the event bus (for testing). Clears all listeners and resets initialization.
 */
function reset(): void {
  listeners.clear();
  eventBuffer.length = 0;
  replayCursors.clear();
  initialized = false;
  nextSeq = 1;
}

/** Check whether the bus has been initialized (for testing) */
function isInitialized(): boolean {
  return initialized;
}

export const pluginEventBus = {
  subscribe,
  subscribeWithReplay,
  emit,
  initialize,
  reset,
  isInitialized,
} as const;
