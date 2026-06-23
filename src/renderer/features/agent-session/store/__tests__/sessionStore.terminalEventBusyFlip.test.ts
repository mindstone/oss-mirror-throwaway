/**
 * Producer × consumer matrix — terminal lifecycle events × summary busy flip
 * (docs/plans/260611_recs-round4 Stage 3, rec 4fb8e113b07cda68; REPEAT of
 * 260531 prevention #1).
 *
 * Producers: every terminal-event shape the manifest allows — `result` with
 * each `turnEndReason` ('completed' | 'user_stopped' | 'superseded' |
 * 'awaiting_user' | 'error', plus reason-less legacy), and `error`.
 * Consumer contract: the session summary's busy scalars must flip
 * (isBusy → false, activeTurnId → null) on BOTH `processHistoryEvent` paths:
 * - NON-LOADED session (summary-only synchronous update);
 * - LOADED session (async disk flush + summary rebuild).
 * `error` must additionally stamp `lastError`.
 *
 * Negative contract: a `turn_superseded` notification is NOT a session-idle
 * signal — supersession means a NEW turn took over, so the summary must stay
 * busy (the wake-up for consumers comes from the new turn's own terminal
 * event). This is the store-side half of the contract whose absence let
 * incident f6b3e9b0's class hide.
 *
 * Deliberately NOT covered here (already pinned elsewhere): turn_superseded
 * cancel+dispatch (agentTurnService.supersedePolicy.test.ts), dispatcher
 * sentinel clearing (agentEventDispatcher.test.ts), eventsByTurn version
 * coalescing (sessionStore.eventsVersionCoalescing.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession, AgentSessionSummary } from '@shared/types';

import { createSessionStore } from '../sessionStore';

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: vi.fn(),
  captureRendererMessage: vi.fn(),
}));

type SessionsApiMock = {
  get: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  applyTurnEventUnion: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

let sessionsApi: SessionsApiMock;

beforeEach(() => {
  vi.clearAllMocks();
  sessionsApi = {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ success: true }),
    applyTurnEventUnion: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
  vi.stubGlobal('window', {
    sessionsApi,
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

const makeSummary = (overrides: Partial<AgentSessionSummary>): AgentSessionSummary => ({
  id: overrides.id ?? 'session-x',
  title: overrides.title ?? 'Test session',
  createdAt: overrides.createdAt ?? Date.now(),
  updatedAt: overrides.updatedAt ?? Date.now(),
  resolvedAt: overrides.resolvedAt ?? null,
  doneAt: overrides.doneAt ?? null,
  starredAt: overrides.starredAt ?? null,
  deletedAt: overrides.deletedAt ?? null,
  origin: overrides.origin ?? 'manual',
  isCorrupted: overrides.isCorrupted ?? false,
  preview: overrides.preview ?? '',
  messageCount: overrides.messageCount ?? 1,
  hasDraft: overrides.hasDraft ?? false,
  draftPreview: overrides.draftPreview ?? null,
  draftUpdatedAt: overrides.draftUpdatedAt ?? null,
  usage: overrides.usage ?? { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 1 },
  activeTurnId: overrides.activeTurnId ?? null,
  isBusy: overrides.isBusy ?? false,
  lastActivityAt: overrides.lastActivityAt ?? Date.now(),
  lastError: overrides.lastError ?? null,
});

const makeDiskSession = (
  sessionId: string,
  turnId: string,
  events: AgentEvent[],
): AgentSession => ({
  id: sessionId,
  title: 'Background session',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  messages: [],
  eventsByTurn: { [turnId]: events },
  activeTurnId: turnId,
  isBusy: true,
  lastError: null,
  resolvedAt: null,
  origin: 'manual',
});

const flushAsync = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

type TerminalProducer = {
  label: string;
  event: AgentEvent;
  expectedLastError: string | null;
};

/** Every terminal producer shape: result × each manifest turnEndReason, and error. */
const TERMINAL_PRODUCERS: TerminalProducer[] = [
  {
    label: "result (turnEndReason: 'completed')",
    event: { type: 'result', text: 'done', timestamp: 2_000, seq: 2, turnEndReason: 'completed' } as AgentEvent,
    expectedLastError: null,
  },
  {
    label: "result (turnEndReason: 'user_stopped')",
    event: { type: 'result', text: '', timestamp: 2_000, seq: 2, turnEndReason: 'user_stopped' } as AgentEvent,
    expectedLastError: null,
  },
  {
    label: "result (turnEndReason: 'superseded' — synthetic superseded result)",
    event: { type: 'result', text: '', timestamp: 2_000, seq: 2, turnEndReason: 'superseded' } as AgentEvent,
    expectedLastError: null,
  },
  {
    label: "result (turnEndReason: 'awaiting_user')",
    event: { type: 'result', text: 'question pending', timestamp: 2_000, seq: 2, turnEndReason: 'awaiting_user' } as AgentEvent,
    expectedLastError: null,
  },
  {
    label: 'result (legacy, no turnEndReason)',
    event: { type: 'result', text: 'done', timestamp: 2_000, seq: 2 } as AgentEvent,
    expectedLastError: null,
  },
  {
    label: 'error',
    event: { type: 'error', error: 'provider exploded', timestamp: 2_000, seq: 2 } as AgentEvent,
    expectedLastError: 'provider exploded',
  },
];

const turnStarted = (timestamp: number): AgentEvent =>
  ({ type: 'turn_started', timestamp, seq: 1 }) as AgentEvent;

describe('terminal events × summary busy flip — NON-LOADED session path', () => {
  it.each(TERMINAL_PRODUCERS)(
    '$label flips isBusy → false and activeTurnId → null',
    ({ event, expectedLastError }) => {
      const store = createSessionStore();
      const sessionId = 'busy-flip-nonloaded';
      const turnId = 'turn-1';

      // Summary-only state: busy session that is NOT in loadedSessions
      // (e.g. evicted from the LRU cache while a background turn runs).
      store.getState().setSessionSummaries([
        makeSummary({ id: sessionId, isBusy: true, activeTurnId: turnId }),
      ]);
      expect(store.getState().loadedSessions.has(sessionId)).toBe(false);

      store.getState().processHistoryEvent(sessionId, turnId, event);

      const summary = store.getState().sessionSummaries.find((s) => s.id === sessionId);
      expect(summary?.isBusy).toBe(false);
      expect(summary?.activeTurnId).toBeNull();
      if (expectedLastError !== null) {
        expect(summary?.lastError).toBe(expectedLastError);
      }
    },
  );

  it('NEGATIVE: turn_superseded does NOT flip the summary idle (supersession is a hand-over, not an end)', () => {
    const store = createSessionStore();
    const sessionId = 'superseded-nonloaded';
    const turnId = 'turn-old';

    store.getState().setSessionSummaries([
      makeSummary({ id: sessionId, isBusy: true, activeTurnId: turnId }),
    ]);

    store.getState().processHistoryEvent(sessionId, turnId, {
      type: 'turn_superseded',
      newTurnId: 'turn-new',
      timestamp: 2_000,
    } as AgentEvent);

    const summary = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(summary?.isBusy).toBe(true);
    expect(summary?.activeTurnId).toBe(turnId);
  });
});

describe('terminal events × summary busy flip — LOADED session path (async disk flush)', () => {
  it.each(TERMINAL_PRODUCERS)(
    '$label flips the rebuilt summary and cached session idle',
    async ({ event, expectedLastError }) => {
      const store = createSessionStore();
      const sessionId = 'busy-flip-loaded';
      const turnId = 'turn-1';

      store.getState().createBackgroundSession(sessionId, 'manual');
      store.getState().processHistoryEvent(sessionId, turnId, turnStarted(1_000));
      expect(
        store.getState().sessionSummaries.find((s) => s.id === sessionId)?.isBusy,
      ).toBe(true);

      sessionsApi.get.mockResolvedValueOnce(
        makeDiskSession(sessionId, turnId, [turnStarted(1_000)]),
      );
      store.getState().processHistoryEvent(sessionId, turnId, event);
      await flushAsync();

      const summary = store.getState().sessionSummaries.find((s) => s.id === sessionId);
      expect(summary?.isBusy).toBe(false);
      expect(summary?.activeTurnId).toBeNull();
      if (expectedLastError !== null) {
        expect(summary?.lastError).toBe(expectedLastError);
      }

      const cached = store.getState().loadedSessions.get(sessionId);
      expect(cached?.isBusy).toBe(false);
      expect(cached?.activeTurnId).toBeNull();
    },
  );
});
