import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createSessionStore,
  buildRuntimeFromSnapshot,
  clearCurrentSessionEvents,
  getCurrentSessionProjectedLiveness,
} from '../sessionStore';
import { assertNoStuckBusy } from '@shared/utils/assertNoStuckBusy';
import type { AgentEvent } from '@shared/types';

const STALE_TURN_THRESHOLD_MS = 5 * 60_000;

/**
 * Unit tests for the dual turn ID model and stop-turn correctness.
 *
 * Under C-lite, the store has explicit processing-vs-focus semantics:
 * - state.activeTurnId: the "processing" turn (shared reducer contract)
 * - state.focusedTurnId: the "focus" turn (changes on user click)
 * - state.runtime.activeTurnId: transitional processing shadow (set by event flow)
 *
 * stopActiveTurn must use runtime.activeTurnId to stop the correct turn.
 */

beforeEach(() => {
  clearCurrentSessionEvents();
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

afterEach(() => {
  vi.useRealTimers();
});

describe('dual turn ID: processing vs focus', () => {
  it('assignTurnToMessage sets activeTurnId, focusedTurnId, and runtime.activeTurnId', () => {
    const store = createSessionStore();

    store.getState().addUserMessage('Hello');
    const messageId = store.getState().messages[0].id;
    const turnId = 'turn-1';
    store.getState().assignTurnToMessage(messageId, turnId, Date.now());

    expect(store.getState().activeTurnId).toBe(turnId);
    expect(store.getState().focusedTurnId).toBe(turnId);
    expect(store.getState().runtime.activeTurnId).toBe(turnId);
    expect(store.getState().isBusy).toBe(true);
  });

  it('processEvent(assistant) keeps runtime.activeTurnId set', () => {
    const store = createSessionStore();

    store.getState().addUserMessage('Hello');
    const messageId = store.getState().messages[0].id;
    const turnId = 'turn-1';
    store.getState().assignTurnToMessage(messageId, turnId, Date.now());

    store.getState().processEvent(turnId, {
      type: 'assistant',
      text: 'Working on it...',
      timestamp: Date.now()
    });

    expect(store.getState().runtime.activeTurnId).toBe(turnId);
    expect(store.getState().isBusy).toBe(true);
  });

  it('processEvent(result) clears both activeTurnId and runtime.activeTurnId', () => {
    const store = createSessionStore();

    store.getState().addUserMessage('Hello');
    const messageId = store.getState().messages[0].id;
    const turnId = 'turn-1';
    store.getState().assignTurnToMessage(messageId, turnId, Date.now());

    store.getState().processEvent(turnId, {
      type: 'result',
      text: 'Done.',
      timestamp: Date.now()
    });

    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().runtime.activeTurnId).toBeNull();
    expect(store.getState().isBusy).toBe(false);
  });

  it('runtime.activeTurnId stays correct when focusedTurnId diverges from processing', () => {
    const store = createSessionStore();

    // Turn 1: completed
    store.getState().addUserMessage('First message');
    const msg1Id = store.getState().messages[0].id;
    store.getState().assignTurnToMessage(msg1Id, 'turn-1', Date.now());
    store.getState().processEvent('turn-1', {
      type: 'result',
      text: 'First result.',
      timestamp: Date.now()
    });

    // Turn 2: in progress
    store.getState().addUserMessage('Second message');
    const msg2 = store.getState().messages.find(m => m.text === 'Second message');
    expect(msg2).toBeDefined();
    const msg2Id = msg2?.id ?? '';
    store.getState().assignTurnToMessage(msg2Id, 'turn-2', Date.now());
    store.getState().processEvent('turn-2', {
      type: 'assistant',
      text: 'Streaming...',
      timestamp: Date.now()
    });

    // Both IDs should be turn-2
    expect(store.getState().activeTurnId).toBe('turn-2');
    expect(store.getState().focusedTurnId).toBe('turn-2');
    expect(store.getState().runtime.activeTurnId).toBe('turn-2');
    expect(store.getState().isBusy).toBe(true);

    // Simulate user clicking on a previous message (focus changes focusedTurnId)
    store.getState().setFocusedTurnId('turn-1');

    // focusedTurnId changed to focus turn, active/runtime still track processing turn
    expect(store.getState().activeTurnId).toBe('turn-2');
    expect(store.getState().focusedTurnId).toBe('turn-1');
    expect(store.getState().runtime.activeTurnId).toBe('turn-2');
    expect(store.getState().isBusy).toBe(true);
  });

  it('stopActiveTurn should resolve processing turn even when focus diverges', () => {
    const store = createSessionStore();

    // Set up a running turn
    store.getState().addUserMessage('Message');
    const msgId = store.getState().messages[0].id;
    store.getState().assignTurnToMessage(msgId, 'running-turn', Date.now());
    store.getState().processEvent('running-turn', {
      type: 'assistant',
      text: 'Working...',
      timestamp: Date.now()
    });

    // Simulate user clicking a different message (focus change)
    store.getState().setFocusedTurnId('old-completed-turn');

    const state = store.getState();

    // Under C-lite, both state.activeTurnId and runtime.activeTurnId converge on the
    // processing turn; runtime is preferred only as transitional defense-in-depth
    // (I1 follow-up will remove).
    const processingTurnId = state.runtime.activeTurnId ?? state.activeTurnId;
    expect(processingTurnId).toBe('running-turn');

    // Focus can diverge without affecting processing-turn resolution.
    expect(state.activeTurnId).toBe('running-turn');
    expect(state.focusedTurnId).toBe('old-completed-turn');
  });

  it('clearBusy resets runtime but does not write busy scalar', () => {
    const store = createSessionStore();

    store.getState().addUserMessage('Hello');
    const messageId = store.getState().messages[0].id;
    store.getState().assignTurnToMessage(messageId, 'turn-1', Date.now());

    expect(store.getState().runtime.activeTurnId).toBe('turn-1');

    store.getState().clearBusy();

    expect(store.getState().runtime.activeTurnId).toBeNull();
    expect(store.getState().isBusy).toBe(true);
    expect(store.getState().activeTurnId).toBe('turn-1');
    expect(getCurrentSessionProjectedLiveness(store.getState().activeTurnId).status).toBe('idle');
    expect(store.getState().focusedTurnId).toBe('turn-1');
  });
});

describe('buildRuntimeFromSnapshot: stale activeTurnId resolution', () => {
  const now = Date.now();

  const makeToolEvent = (ts: number): AgentEvent => ({
    type: 'tool',
    toolName: 'Bash',
    toolUseId: 'tool-1',
    parentToolUseId: null,
    detail: '',
    stage: 'start',
    timestamp: ts,
  });

  const makeResultEvent = (ts: number): AgentEvent => ({
    type: 'result',
    text: 'Done.',
    timestamp: ts,
  });

  const assertRuntimeSnapshotKeepsBusyInvariant = (
    eventsByTurn: Record<string, AgentEvent[]>,
    runtime: ReturnType<typeof buildRuntimeFromSnapshot>,
  ): void => {
    assertNoStuckBusy({
      isBusy: runtime.activeTurnId !== null,
      activeTurnId: runtime.activeTurnId,
      eventsByTurn,
    });
  };

  it('resolves to the declared activeTurnId when it has no terminal event', () => {
    const events: Record<string, AgentEvent[]> = {
      'turn-1': [makeToolEvent(now)],
    };
    const runtime = buildRuntimeFromSnapshot('turn-1', events);
    expect(runtime.activeTurnId).toBe('turn-1');
    expect(runtime.startedAt).not.toBeNull();
  });

  it('recovers the single live turn when declared activeTurnId points to a completed turn', () => {
    const events: Record<string, AgentEvent[]> = {
      'turn-completed': [
        makeToolEvent(now),
        makeResultEvent(now + 1000),
      ],
      'turn-active': [
        makeToolEvent(now + 2000),
      ],
    };
    // Legacy/stale snapshot case: activeTurnId points to an already-completed turn.
    const runtime = buildRuntimeFromSnapshot('turn-completed', events);
    expect(runtime.activeTurnId).toBe('turn-active');
    expect(runtime.startedAt).not.toBeNull();
  });

  it('preserves old recovery scan when declared activeTurnId is stale and another turn is live', () => {
    const events: Record<string, AgentEvent[]> = {
      'declared-but-complete': [
        makeToolEvent(now),
        makeResultEvent(now + 1000),
      ],
      'older-live': [
        makeToolEvent(now + 1500),
      ],
      'newer-live': [
        makeToolEvent(now + 2500),
      ],
    };

    // The legacy recovery scan ignored the stale declared active turn and picked
    // the live turn with the highest lastActivityAt.
    const runtime = buildRuntimeFromSnapshot('declared-but-complete', events);
    expect(runtime.activeTurnId).toBe('newer-live');
    expect(runtime.startedAt).toBe(now + 2500);
    expect(runtime.lastActivityAt).toBe(now + 2500);
    assertRuntimeSnapshotKeepsBusyInvariant(events, runtime);
  });

  it('returns idle runtime when all turns are completed', () => {
    const events: Record<string, AgentEvent[]> = {
      'turn-1': [makeToolEvent(now), makeResultEvent(now + 1000)],
      'turn-2': [makeToolEvent(now + 2000), makeResultEvent(now + 3000)],
    };
    const runtime = buildRuntimeFromSnapshot('turn-1', events);
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.startedAt).toBeNull();
  });

  it('returns idle only for terminal snapshots; stale recovered snapshots stay active at runtime layer', () => {
    const terminalEvents: Record<string, AgentEvent[]> = {
      'turn-terminal': [makeToolEvent(now), makeResultEvent(now + 1000)],
    };

    const terminalRuntime = buildRuntimeFromSnapshot('turn-terminal', terminalEvents);
    expect(terminalRuntime.activeTurnId).toBeNull();
    expect(terminalRuntime.startedAt).toBeNull();
    assertRuntimeSnapshotKeepsBusyInvariant(terminalEvents, terminalRuntime);

    const fixedNow = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const staleEvents: Record<string, AgentEvent[]> = {
      'turn-stale': [
        makeToolEvent(fixedNow - STALE_TURN_THRESHOLD_MS - 1),
      ],
    };

    // A stale liveness projection is "interrupted". At this layer, snapshot
    // runtime mapping keeps interrupted turns active; openHistorySession /
    // ingestExternalSessions apply the staleness clear via isTurnStale.
    const staleRuntime = buildRuntimeFromSnapshot('turn-stale', staleEvents);
    assertRuntimeSnapshotKeepsBusyInvariant(staleEvents, staleRuntime);
    expect(staleRuntime.activeTurnId).toBe('turn-stale');
    expect(staleRuntime.startedAt).toBe(fixedNow - STALE_TURN_THRESHOLD_MS - 1);
    expect(staleRuntime.lastActivityAt).toBe(fixedNow - STALE_TURN_THRESHOLD_MS - 1);
  });

  it('returns idle runtime when eventsByTurn is undefined', () => {
    const runtime = buildRuntimeFromSnapshot('turn-1', undefined);
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.startedAt).toBeNull();
  });

  it('returns idle runtime when activeTurnId is null and no active turns exist', () => {
    const events: Record<string, AgentEvent[]> = {
      'turn-1': [makeToolEvent(now), makeResultEvent(now + 1000)],
    };
    const runtime = buildRuntimeFromSnapshot(null, events);
    expect(runtime.activeTurnId).toBeNull();
    expect(runtime.startedAt).toBeNull();
  });

  it('finds active turn even when activeTurnId is null', () => {
    const events: Record<string, AgentEvent[]> = {
      'turn-completed': [makeToolEvent(now), makeResultEvent(now + 1000)],
      'turn-active': [makeToolEvent(now + 2000)],
    };
    const runtime = buildRuntimeFromSnapshot(null, events);
    expect(runtime.activeTurnId).toBe('turn-active');
    expect(runtime.startedAt).not.toBeNull();
  });

  it('selects the first-admitted turn when two snapshot turns appear concurrently running (F2-intended)', () => {
    const events: Record<string, AgentEvent[]> = {
      'turn-first': [makeToolEvent(now + 1000)],
      'turn-second': [makeToolEvent(now + 3000)],
    };

    // F2-intended behavior: the global ordered fold keeps the first-admitted
    // turn active when two turns appear concurrently running in one snapshot.
    // Production should prevent true concurrency (`useMessageQueue` +
    // `agentTurnRegistry` enforce one active turn), but this deterministic
    // fallback is now intentional.
    const runtime = buildRuntimeFromSnapshot(null, events);
    assertRuntimeSnapshotKeepsBusyInvariant(events, runtime);
    expect(runtime.activeTurnId).toBe('turn-first');
    expect(runtime.startedAt).toBe(now + 1000);
    expect(runtime.lastActivityAt).toBe(now + 3000);
  });
});

describe('caller-layer stale clearing', () => {
  it('openHistorySession clears stale active turn even when snapshot runtime rebuild is active', () => {
    const fixedNow = 1_700_000_000_000;
    const staleStartedAt = fixedNow - STALE_TURN_THRESHOLD_MS - 1;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const store = createSessionStore();
    const sessionId = store.getState().currentSessionId;
    store.getState().addUserMessage('stale history snapshot');
    const messageId = store.getState().messages[0].id;
    const turnId = 'stale-history-turn';
    store.getState().assignTurnToMessage(messageId, turnId, staleStartedAt);
    store.getState().processEvent(turnId, {
      type: 'tool',
      toolName: 'Bash',
      toolUseId: 'tool-stale-history',
      parentToolUseId: null,
      detail: '',
      stage: 'start',
      timestamp: staleStartedAt,
    });
    const snapshot = store.getState().snapshotCurrentSession();
    if (!snapshot) throw new Error('Expected stale snapshot');
    expect(snapshot.activeTurnId).toBe(turnId);

    const staleRuntime = buildRuntimeFromSnapshot(
      snapshot.activeTurnId ?? null,
      snapshot.eventsByTurn,
    );
    expect(staleRuntime.activeTurnId).toBe(turnId);
    expect(staleRuntime.startedAt).toBe(staleStartedAt);

    store.getState().addOrUpdateHistorySession(snapshot);
    store.getState().resetSession();
    expect(store.getState().currentSessionId).not.toBe(sessionId);

    const reopened = store.getState().openHistorySession(snapshot.id, snapshot.eventsByTurn);
    expect(reopened).not.toBeNull();
    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().runtime.activeTurnId).toBeNull();
    expect(store.getState().isBusy).toBe(false);
  });

  it('ingestExternalSessions clears stale active turn on active snapshot path', () => {
    const fixedNow = 1_700_000_000_000;
    const staleStartedAt = fixedNow - STALE_TURN_THRESHOLD_MS - 1;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);

    const store = createSessionStore();
    store.getState().addUserMessage('stale ingest snapshot');
    const messageId = store.getState().messages[0].id;
    const turnId = 'stale-ingest-turn';
    store.getState().assignTurnToMessage(messageId, turnId, staleStartedAt);
    store.getState().processEvent(turnId, {
      type: 'tool',
      toolName: 'Bash',
      toolUseId: 'tool-stale-ingest',
      parentToolUseId: null,
      detail: '',
      stage: 'start',
      timestamp: staleStartedAt,
    });
    const snapshot = store.getState().snapshotCurrentSession();
    if (!snapshot) throw new Error('Expected active snapshot');

    const staleRuntime = buildRuntimeFromSnapshot(
      snapshot.activeTurnId ?? null,
      snapshot.eventsByTurn,
    );
    expect(staleRuntime.activeTurnId).toBe(turnId);
    expect(staleRuntime.startedAt).toBe(staleStartedAt);
    expect(store.getState().activeTurnId).toBe(turnId);
    expect(store.getState().isBusy).toBe(true);

    const adopted = store.getState().ingestExternalSessions([snapshot]);
    expect(adopted).not.toBeNull();
    expect(store.getState().activeTurnId).toBeNull();
    expect(store.getState().runtime.activeTurnId).toBeNull();
    expect(store.getState().isBusy).toBe(false);
  });
});
