// Stage 2 — renderer defense-in-depth (REBEL-6C0 / REBEL-6BZ).
//
// `ingestExternalSessions` wholesale-replaces the ACTIVE session's live
// in-memory messages/events from a disk/external snapshot. If that snapshot is
// content-poorer than what is live (e.g. a stale disk read that lost a
// just-finished turn's final answer), the replace silently regresses the
// visible transcript. Stage 1 makes the disk monotonic for cloud pulls; this
// guard makes "an external ingest shrank the active transcript" unrepresentable
// regardless of how the snapshot got poorer.
//
// CRITICAL (lesson from Stage 1 review): the regression is COUNT-STABLE.
// `mergeResultMessage` promotes an assistant message to `result` IN-PLACE (same
// id, same count) and appends a higher-seq terminal event. A count-only guard
// misses it; the robust signal is per-turn max valid event seq (+ non-user
// message count as defense-in-depth).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession, AgentTurnMessage } from '@shared/types';

const { recordRendererBreadcrumb } = vi.hoisted(() => ({
  recordRendererBreadcrumb: vi.fn(),
}));

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb,
  captureRendererMessage: vi.fn(),
  captureRendererException: vi.fn(),
}));

import {
  createSessionStore,
  setCurrentSessionEvents,
  clearCurrentSessionEvents,
  getCurrentSessionEventsForTurn,
  flushPendingEventsVersionNotification,
} from '../sessionStore';

const SESSION_ID = 'active-session-1';

const makeMessage = (overrides: Partial<AgentTurnMessage> = {}): AgentTurnMessage =>
  ({
    id: 'm1',
    turnId: 'turn-T',
    role: 'assistant',
    text: 'text',
    createdAt: 1_000,
    ...overrides,
  }) as AgentTurnMessage;

const resultEvent = (seq: number): AgentEvent =>
  ({ type: 'result', text: 'final answer', timestamp: seq, seq }) as AgentEvent;

const statusEvent = (seq: number, message = 'stale'): AgentEvent =>
  ({ type: 'status', message, timestamp: seq, seq }) as AgentEvent;

const makeSession = (overrides: Partial<AgentSession> = {}): AgentSession =>
  ({
    id: SESSION_ID,
    title: 'Active',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    ...overrides,
  }) as AgentSession;

/** Seed the store as the active session with live messages + live events. */
function seedActiveSession(
  store: ReturnType<typeof createSessionStore>,
  messages: AgentTurnMessage[],
  eventsByTurn: Record<string, AgentEvent[]>,
): void {
  store.setState({ currentSessionId: SESSION_ID, messages });
  setCurrentSessionEvents(eventsByTurn);
  flushPendingEventsVersionNotification();
}

beforeEach(() => {
  recordRendererBreadcrumb.mockClear();
  clearCurrentSessionEvents();
  flushPendingEventsVersionNotification();
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ success: true }),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: { stopTurn: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  clearCurrentSessionEvents();
  flushPendingEventsVersionNotification();
});

describe('sessionStore.ingestExternalSessions — active-session regression guard (REBEL-6C0/6BZ Stage 2)', () => {
  it('count-stable regression: refuses a content-poorer snapshot for the current session (final answer + max seq retained, breadcrumb fired)', () => {
    const store = createSessionStore();

    // Live: the completed turn — result message promoted in-place (role 'result')
    // + a terminal result event with a high seq.
    const liveMessages = [
      makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'question', createdAt: 100 }),
      makeMessage({ id: 'm-answer', turnId: 'turn-T', role: 'result', text: 'the big final answer', createdAt: 200 }),
    ];
    seedActiveSession(store, liveMessages, { 'turn-T': [resultEvent(5)] });

    // Incoming snapshot: SAME turn, count-stable (same non-user message count = 1,
    // same event-array length = 1) but content-poorer — the result reverted to a
    // stale preamble and the event has a LOWER seq.
    const poorerSnapshot = makeSession({
      messages: [
        makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'question', createdAt: 100 }),
        makeMessage({ id: 'm-answer', turnId: 'turn-T', role: 'assistant', text: 'stale preamble', createdAt: 200 }),
      ],
      eventsByTurn: { 'turn-T': [statusEvent(2)] },
      updatedAt: 9_999,
    });

    store.getState().ingestExternalSessions([poorerSnapshot]);

    // The live final answer must survive (not regressed to the stale preamble).
    const answer = store.getState().messages.find((m) => m.id === 'm-answer');
    expect(answer?.text).toBe('the big final answer');
    expect(answer?.role).toBe('result');

    // The live high-seq result event must survive in the events map.
    const turnEvents = getCurrentSessionEventsForTurn('turn-T');
    expect(turnEvents.some((e) => e.type === 'result' && e.seq === 5)).toBe(true);
    expect(turnEvents.some((e) => e.type === 'status' && e.seq === 2)).toBe(false);

    // Observable: a "refused regressing ingest" breadcrumb must have fired.
    expect(recordRendererBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({
        category: expect.stringContaining('ingest'),
        level: 'warning',
      }),
    );

    // GPT F2 — privacy contract: the breadcrumb data must carry ONLY HASHED ids,
    // never raw session/turn ids (locks the privacy contract for this surface).
    const call = recordRendererBreadcrumb.mock.calls.find(
      ([crumb]) => (crumb as { category?: string }).category?.includes('ingest'),
    );
    expect(call).toBeDefined();
    const data = (call![0] as { data: Record<string, unknown> }).data;
    // Hashed fields are present and are 8-hex-char hashes (not raw ids).
    expect(typeof data.sessionIdHash).toBe('string');
    expect(data.sessionIdHash).toMatch(/^[0-9a-f]{8}$/);
    expect(Array.isArray(data.refusedTurnIdHashes)).toBe(true);
    for (const h of data.refusedTurnIdHashes as string[]) {
      expect(h).toMatch(/^[0-9a-f]{8}$/);
    }
    // The raw session id and raw turn id must NOT appear anywhere in the payload.
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(SESSION_ID);
    expect(serialized).not.toContain('turn-T');
    // No un-hashed `sessionId` / `turnId` keys leaked.
    expect(data).not.toHaveProperty('sessionId');
    expect(data).not.toHaveProperty('turnId');
    expect(data).not.toHaveProperty('refusedTurnIds');
  });

  // Claude F1 — mid-turn streaming: an ingest arriving while the active turn is
  // still busy (isBusy=true) must NOT regress the richer live transcript. This is
  // close to the real bug scenario (the cloud-sync loop fires ~60+/min, including
  // mid-turn), so it is worth pinning.
  it('mid-turn streaming (isBusy active turn): the guard still protects the richer live transcript', () => {
    const store = createSessionStore();
    // Live: a turn in progress — user msg + an in-flight assistant message, with a
    // higher-seq streaming event. isBusy=true, activeTurnId set.
    const liveMessages = [
      makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'question', createdAt: 100 }),
      makeMessage({ id: 'm-stream', turnId: 'turn-T', role: 'assistant', text: 'partial streamed answer so far…', createdAt: 200 }),
    ];
    seedActiveSession(store, liveMessages, { 'turn-T': [statusEvent(3, 'streaming'), statusEvent(6, 'streaming-more')] });
    store.setState({ isBusy: true, activeTurnId: 'turn-T' });

    // A cloud-sync ingest arrives mid-turn with a STALER snapshot of turn-T
    // (lost the latest streamed message; lower max seq). Count-stable on messages
    // is not even required here — the seq regression is the signal.
    const stalerSnapshot = makeSession({
      messages: [
        makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'question', createdAt: 100 }),
      ],
      eventsByTurn: { 'turn-T': [statusEvent(3, 'streaming')] },
      activeTurnId: 'turn-T',
      isBusy: true,
      updatedAt: 9_999,
    });

    store.getState().ingestExternalSessions([stalerSnapshot]);

    // The live richer transcript must be preserved mid-turn.
    expect(store.getState().messages.find((m) => m.id === 'm-stream')?.text)
      .toBe('partial streamed answer so far…');
    const turnEvents = getCurrentSessionEventsForTurn('turn-T');
    expect(turnEvents.some((e) => e.seq === 6)).toBe(true);
    // A refusal breadcrumb fired.
    expect(recordRendererBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ category: expect.stringContaining('ingest'), level: 'warning' }),
    );
  });

  it('superset incoming snapshot applies normally (no refusal, no breadcrumb)', () => {
    const store = createSessionStore();
    const liveMessages = [
      makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'q', createdAt: 100 }),
      makeMessage({ id: 'm-pre', turnId: 'turn-T', role: 'assistant', text: 'preamble', createdAt: 150 }),
    ];
    seedActiveSession(store, liveMessages, { 'turn-T': [statusEvent(2, 'thinking')] });

    // Incoming has MORE: the final answer + a higher-seq terminal event (legit update).
    const richerSnapshot = makeSession({
      messages: [
        makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'q', createdAt: 100 }),
        makeMessage({ id: 'm-pre', turnId: 'turn-T', role: 'assistant', text: 'preamble', createdAt: 150 }),
        makeMessage({ id: 'm-answer', turnId: 'turn-T', role: 'result', text: 'the answer', createdAt: 200 }),
      ],
      eventsByTurn: { 'turn-T': [statusEvent(2, 'thinking'), resultEvent(5)] },
      updatedAt: 9_999,
    });

    store.getState().ingestExternalSessions([richerSnapshot]);

    // The richer snapshot is applied.
    expect(store.getState().messages.find((m) => m.id === 'm-answer')?.text).toBe('the answer');
    expect(getCurrentSessionEventsForTurn('turn-T').some((e) => e.type === 'result' && e.seq === 5)).toBe(true);
    expect(recordRendererBreadcrumb).not.toHaveBeenCalled();
  });

  it('cloud-only NEW turn is adopted even while a shared turn is refused (additive, not all-or-nothing)', () => {
    const store = createSessionStore();
    const liveMessages = [
      makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'q', createdAt: 100 }),
      makeMessage({ id: 'm-answer', turnId: 'turn-T', role: 'result', text: 'live final answer', createdAt: 200 }),
    ];
    seedActiveSession(store, liveMessages, { 'turn-T': [resultEvent(5)] });

    const snapshot = makeSession({
      messages: [
        makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'q', createdAt: 100 }),
        // turn-T poorer (count-stable, lower seq)
        makeMessage({ id: 'm-answer', turnId: 'turn-T', role: 'assistant', text: 'stale', createdAt: 200 }),
        // a brand-new cloud turn
        makeMessage({ id: 'm-new', turnId: 'turn-B', role: 'result', text: 'cloud new turn', createdAt: 300 }),
      ],
      eventsByTurn: { 'turn-T': [statusEvent(2)], 'turn-B': [resultEvent(7)] },
      updatedAt: 9_999,
    });

    store.getState().ingestExternalSessions([snapshot]);

    // Shared turn-T live answer retained...
    expect(store.getState().messages.find((m) => m.id === 'm-answer')?.text).toBe('live final answer');
    // ...AND the new cloud turn-B is adopted.
    expect(store.getState().messages.find((m) => m.id === 'm-new')?.text).toBe('cloud new turn');
    expect(getCurrentSessionEventsForTurn('turn-B').some((e) => e.seq === 7)).toBe(true);
  });

  it('first-load (empty live → populated snapshot) applies fully (no false refusal)', () => {
    const store = createSessionStore();
    // currentSessionId set but no live messages/events.
    store.setState({ currentSessionId: SESSION_ID, messages: [] });
    clearCurrentSessionEvents();
    flushPendingEventsVersionNotification();

    const snapshot = makeSession({
      messages: [
        makeMessage({ id: 'm-user', turnId: 'turn-T', role: 'user', text: 'q', createdAt: 100 }),
        makeMessage({ id: 'm-answer', turnId: 'turn-T', role: 'result', text: 'cloud answer', createdAt: 200 }),
      ],
      eventsByTurn: { 'turn-T': [resultEvent(5)] },
      updatedAt: 9_999,
    });

    store.getState().ingestExternalSessions([snapshot]);

    expect(store.getState().messages.find((m) => m.id === 'm-answer')?.text).toBe('cloud answer');
    expect(getCurrentSessionEventsForTurn('turn-T').some((e) => e.seq === 5)).toBe(true);
    expect(recordRendererBreadcrumb).not.toHaveBeenCalled();
  });

  it('non-current-session (history) snapshot is unaffected by the guard', () => {
    const store = createSessionStore();
    // Active session is a DIFFERENT id; the incoming snapshot is for a history session.
    seedActiveSession(store, [makeMessage({ id: 'm-live', turnId: 'turn-X', role: 'result', text: 'live', createdAt: 1 })], {
      'turn-X': [resultEvent(9)],
    });
    store.setState({ currentSessionId: 'some-other-active' });

    const historySnapshot = makeSession({ id: 'history-session', updatedAt: 9_999 });

    // Should not throw, should not regress the active session, should not fire the guard.
    expect(() => store.getState().ingestExternalSessions([historySnapshot])).not.toThrow();
    expect(recordRendererBreadcrumb).not.toHaveBeenCalled();
  });
});
