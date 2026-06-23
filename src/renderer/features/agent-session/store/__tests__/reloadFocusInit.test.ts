import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../sessionStore';

/**
 * Regression coverage for the post-C-lite reload focus initialization
 * contract.
 *
 * Under C-lite (see docs/plans/260430_isbusy_stale_active_turn_id_root_cause_fix.md),
 * `state.focusedTurnId` is renderer-only ephemeral and stripped on persist.
 * On reload we initialize it from the persisted `activeTurnId` so the user's
 * focus naturally lands on the most recent processing turn (or null if no
 * turn was active at persist time, in which case `useTurnData.visibleTurnId`
 * falls through to the latest turn).
 *
 * Touched in two reload paths:
 *   - `openHistorySession` (sessionStore.ts:~2596) — manual user open
 *   - `ingestExternalSessions` (sessionStore.ts:~2703) — cloud-pushed adoption
 *
 * The risk this test guards against: a future refactor that splits
 * processing-only and focus-only handlers (e.g. as part of I1 — runtime
 * shadow removal narrowing) could miss one of the two reload paths and
 * leave `focusedTurnId` null even when `activeTurnId` was persisted as
 * non-null. The user-visible regression would be silent — focus reverts to
 * latest-turn instead of the persisted processing turn — so this is not
 * caught by stuck-busy tests. Belt-and-braces.
 */

beforeEach(() => {
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

function seedHistorySession(opts: { withTerminal: boolean }) {
  const store = createSessionStore();
  const sessionId = store.getState().currentSessionId;

  store.getState().renameSession(sessionId, 'Reload focus init session');
  store.getState().addUserMessage('Original prompt');

  const messageId = store.getState().messages[0].id;
  const turnId = 'history-turn-focus-init';
  // Use realistic timestamps so the in-flight case is not auto-self-healed
  // by isTurnStale (5-minute staleness threshold). Past-the-threshold
  // timestamps would cause openHistorySession to clear activeTurnId on load.
  const now = Date.now();
  store.getState().assignTurnToMessage(messageId, turnId, now);
  store.getState().processEvent(turnId, {
    type: 'status',
    message: 'Thinking',
    timestamp: now + 10,
  });
  if (opts.withTerminal) {
    store.getState().processEvent(turnId, {
      type: 'result',
      text: 'Done',
      timestamp: now + 20,
    });
  }

  const snapshot = store.getState().snapshotCurrentSession();
  if (!snapshot) {
    throw new Error('Expected seeded session snapshot to exist');
  }

  store.getState().addOrUpdateHistorySession(snapshot);
  store.getState().resetSession();

  return { store, snapshot, turnId };
}

describe('reload focus initialization (C-lite contract)', () => {
  it('openHistorySession seeds focusedTurnId from persisted activeTurnId', () => {
    // Persist a session that was busy at persist time — activeTurnId
    // is non-null, so focusedTurnId should land on the same turn.
    const { store, snapshot, turnId } = seedHistorySession({ withTerminal: false });

    // Pre-condition: persisted snapshot has activeTurnId set; focusedTurnId
    // is stripped (renderer-only ephemeral). After reload, both should
    // converge on the persisted processing turn.
    expect(snapshot.activeTurnId).toBe(turnId);

    store.getState().openHistorySession(snapshot.id, snapshot.eventsByTurn);

    expect(store.getState().activeTurnId).toBe(turnId);
    expect(store.getState().focusedTurnId).toBe(turnId);
  });

  it('openHistorySession seeds focusedTurnId to null when persisted activeTurnId is null (terminated)', () => {
    // Persist a session whose only turn already terminated — activeTurnId
    // is null on disk, focus should land null too (not "latest turn"; the
    // useTurnData fallback handles that).
    const { store, snapshot } = seedHistorySession({ withTerminal: true });

    expect(snapshot.activeTurnId).toBeNull();

    store.getState().openHistorySession(snapshot.id, snapshot.eventsByTurn);

    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().focusedTurnId).toBeNull();
  });

  it('ingestExternalSessions seeds focusedTurnId from the adopted activeTurnId on the active snapshot path', () => {
    // Cloud-pushed adoption path — `ingestExternalSessions` only updates
    // the live store when `session.id === state.currentSessionId` (the
    // "active snapshot" path); other sessions go to history-summary.
    // Setup: seed without resetSession so the session is still current,
    // then mutate focusedTurnId locally (simulating focus divergence) and
    // verify ingest re-seeds it from the snapshot's activeTurnId.
    const store = createSessionStore();
    const sessionId = store.getState().currentSessionId;
    store.getState().renameSession(sessionId, 'External adoption session');
    store.getState().addUserMessage('Cloud push test');

    const messageId = store.getState().messages[0].id;
    const turnId = 'external-turn-focus-init';
    const now = Date.now();
    store.getState().assignTurnToMessage(messageId, turnId, now);
    store.getState().processEvent(turnId, {
      type: 'status',
      message: 'Thinking',
      timestamp: now + 10,
    });

    const snapshot = store.getState().snapshotCurrentSession();
    if (!snapshot) throw new Error('Expected snapshot');
    expect(snapshot.id).toBe(sessionId);
    expect(snapshot.activeTurnId).toBe(turnId);

    // Simulate local focus divergence after the snapshot was taken.
    store.getState().setFocusedTurnId(null);
    expect(store.getState().focusedTurnId).toBeNull();

    const adopted = store.getState().ingestExternalSessions([snapshot]);

    expect(adopted).not.toBeNull();
    expect(adopted!.id).toBe(sessionId);
    expect(store.getState().activeTurnId).toBe(turnId);
    expect(store.getState().focusedTurnId).toBe(turnId);
  });
});
