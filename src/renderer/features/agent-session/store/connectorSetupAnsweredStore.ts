/**
 * Session-scoped registry of connector-setup suggestions the user has
 * already acted on.
 *
 * Why this store exists
 * ---------------------
 * The `suggest_connector_setup` footer card previously relied on two
 * per-component mechanisms to stay hidden after the user answered it:
 *   1. `dismissedConnectorSetupQuestionId` — ephemeral local `useState`
 *      in `SessionSurfaceContent` (lost on unmount, e.g. tab switch).
 *   2. `savedTurnIds` in `useConnectorSetupSuggestions` — keyed by
 *      `turnId` (bypassed when a later turn re-emits the same signal).
 *
 * Neither survived both failure modes, so a card the user had already
 * answered could reappear. This registry lives above the component
 * lifetime and keys by stable connector identity, so suppression
 * survives remounts AND cross-turn re-emission.
 *
 * Two states per `(sessionId, key)`
 * ---------------------------------
 * - `pending`  — the user clicked "Set up now" but the continuation
 *                prompt has not yet successfully entered the queue.
 *                Suppresses the card immediately to prevent re-click
 *                races while `prepareMentionAttachments` + enqueue run.
 * - `answered` — the continuation prompt has been enqueued (set-up-now
 *                succeeded) OR the user chose "Save for later".
 *                Suppresses the card.
 *
 * `clearPending(sessionId, key)` is called on enqueue failure so the
 * card becomes visible again for retry — suppression must not become
 * a silent dead-end.
 *
 * Persistence: in-memory only. Resets on app reload. This is fine —
 * connector-setup suggestions are turn-scoped signals, not durable
 * user data, and surviving app restart is out of scope for the bug.
 *
 * Reactivity: every write returns a new outer `Map` AND a new inner
 * `Set` so zustand's default reference equality notices the change.
 * Consumers should subscribe to the outer maps directly and evaluate
 * the predicate in the consumer hook — computing `isSuppressed(...)`
 * inside a selector returns a primitive that doesn't change identity
 * even when the underlying sets do, which would starve re-renders.
 *
 * @see docs-private/investigations/260416_duplicate_connector_setup_card.md
 */
import { create } from 'zustand';

interface ConnectorSetupAnsweredState {
  /** sessionId -> set of suppression keys that are fully answered. */
  answered: Map<string, Set<string>>;
  /** sessionId -> set of suppression keys that are mid-flight (set-up-now pending enqueue). */
  pending: Map<string, Set<string>>;

  markAnswered: (sessionId: string, key: string) => void;
  markPending: (sessionId: string, key: string) => void;
  clearPending: (sessionId: string, key: string) => void;
  isSuppressed: (sessionId: string, key: string) => boolean;

  /** Test-only reset. Not intended for production call sites. */
  _reset: () => void;
}

export const useConnectorSetupAnsweredStore = create<ConnectorSetupAnsweredState>((set, get) => ({
  answered: new Map(),
  pending: new Map(),

  markAnswered: (sessionId, key) =>
    set((s) => ({
      answered: addToMapSet(s.answered, sessionId, key),
      pending: removeFromMapSet(s.pending, sessionId, key),
    })),

  markPending: (sessionId, key) =>
    set((s) => ({
      pending: addToMapSet(s.pending, sessionId, key),
    })),

  clearPending: (sessionId, key) =>
    set((s) => ({
      pending: removeFromMapSet(s.pending, sessionId, key),
    })),

  isSuppressed: (sessionId, key) => {
    const a = get().answered.get(sessionId);
    if (a?.has(key)) return true;
    const p = get().pending.get(sessionId);
    return p?.has(key) ?? false;
  },

  _reset: () => set({ answered: new Map(), pending: new Map() }),
}));

// ---------------------------------------------------------------------------
// Immutable Map<string, Set<string>> helpers
// ---------------------------------------------------------------------------
// These always return a new outer Map AND a new inner Set when the contents
// change, so zustand selectors subscribed to the outer map see new references
// and re-render. No-op paths return the original map to avoid spurious renders.

function addToMapSet(
  map: Map<string, Set<string>>,
  outer: string,
  inner: string,
): Map<string, Set<string>> {
  const existing = map.get(outer);
  if (existing?.has(inner)) return map;
  const next = new Map(map);
  const nextSet = existing ? new Set(existing) : new Set<string>();
  nextSet.add(inner);
  next.set(outer, nextSet);
  return next;
}

function removeFromMapSet(
  map: Map<string, Set<string>>,
  outer: string,
  inner: string,
): Map<string, Set<string>> {
  const existing = map.get(outer);
  if (!existing || !existing.has(inner)) return map;
  const next = new Map(map);
  const nextSet = new Set(existing);
  nextSet.delete(inner);
  if (nextSet.size === 0) {
    next.delete(outer);
  } else {
    next.set(outer, nextSet);
  }
  return next;
}
