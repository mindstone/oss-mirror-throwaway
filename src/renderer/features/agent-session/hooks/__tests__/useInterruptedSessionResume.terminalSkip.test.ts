// @vitest-environment happy-dom
/**
 * Producer × consumer matrix — terminal lifecycle events × resume skip
 * (docs/plans/260611_recs-round4 Stage 3, rec 4fb8e113b07cda68; REPEAT of
 * 260531 prevention #1 — the introducing commit 1af020f0d was itself a fix
 * for "ghost resume turns from useInterruptedSessionResume firing on busy
 * sessions", and nothing pinned that consumer contract since).
 *
 * Consumer contract (useInterruptedSessionResume): a session flagged with
 * `interruptedTurnId` is OFFERED for resume only when its turn actually
 * ENDED — a snapshot that is still busy / carries an activeTurnId (the turn
 * restarted, or a superseding turn took over) must be SKIPPED, otherwise the
 * resume modal double-submits into a live turn.
 *
 * Producer side: the offered-session snapshots are built by driving REAL
 * terminal events through sessionStore.processHistoryEvent's loaded-session
 * flush (the same code path that persists the post-terminal snapshot the
 * main process hands back on next launch), not hand-rolled idle fixtures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession, AgentSessionSummary } from '@shared/types';

import { renderHook, act } from '@renderer/test-utils';
import { createSessionStore } from '../../store/sessionStore';
import { useInterruptedSessionResume } from '../useInterruptedSessionResume';

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: vi.fn(),
  captureRendererMessage: vi.fn(),
}));

const TURN_ID = 'turn-interrupted';

type SessionsApiMock = {
  get: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  applyTurnEventUnion: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

let sessionsApi: SessionsApiMock;

beforeEach(() => {
  vi.useFakeTimers();
  sessionsApi = {
    get: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({ success: true }),
    applyTurnEventUnion: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
  };
  vi.stubGlobal('sessionsApi', sessionsApi);
});

afterEach(() => {
  vi.useRealTimers();
});

const makeDiskSession = (
  sessionId: string,
  overrides: Partial<AgentSession> = {},
): AgentSession =>
  ({
    id: sessionId,
    title: 'Interrupted session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    messages: [
      { id: 'msg-1', role: 'user', text: 'please do the thing', turnId: TURN_ID, timestamp: 900 },
    ],
    eventsByTurn: { [TURN_ID]: [{ type: 'turn_started', timestamp: 1_000, seq: 1 } as AgentEvent] },
    activeTurnId: TURN_ID,
    isBusy: true,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
    interruptedTurnId: TURN_ID,
    ...overrides,
  }) as AgentSession;

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/**
 * Drive a terminal event through the REAL store flush for a loaded busy
 * session and return the post-terminal snapshot + its rebuilt summary —
 * the producer side of the matrix.
 */
async function producePostTerminalSnapshot(
  sessionId: string,
  terminalEvent: AgentEvent,
): Promise<{ snapshot: AgentSession; summary: AgentSessionSummary }> {
  const store = createSessionStore();
  store.getState().createBackgroundSession(sessionId, 'manual');
  store
    .getState()
    .processHistoryEvent(sessionId, TURN_ID, {
      type: 'turn_started',
      timestamp: 1_000,
      seq: 1,
    } as AgentEvent);

  sessionsApi.get.mockResolvedValueOnce(makeDiskSession(sessionId));
  store.getState().processHistoryEvent(sessionId, TURN_ID, terminalEvent);
  await flushMicrotasks();

  const snapshot = store.getState().loadedSessions.get(sessionId);
  const summary = store.getState().sessionSummaries.find((s) => s.id === sessionId);
  if (!snapshot || !summary) throw new Error('producer flush did not rebuild the session');
  // Sanity: the producer really ended the turn.
  expect(snapshot.isBusy).toBe(false);
  expect(snapshot.activeTurnId).toBeNull();
  expect(summary.interruptedTurnId).toBe(TURN_ID);
  return { snapshot: snapshot as AgentSession, summary };
}

async function renderResumeHook(summaries: AgentSessionSummary[]) {
  const resumeTurn = vi.fn().mockResolvedValue(undefined);
  const harness = renderHook(() =>
    useInterruptedSessionResume({
      sessionSummaries: summaries,
      navigateToSession: vi.fn(),
      resumeTurn,
    }),
  );
  // The scan runs RESUME_CHECK_DELAY_MS (1s) after mount, then awaits
  // sessionsApi.get per candidate.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_100);
  });
  return { ...harness, resumeTurn };
}

const TERMINAL_PRODUCERS: Array<{ label: string; event: AgentEvent }> = [
  {
    label: "result (turnEndReason: 'completed')",
    event: { type: 'result', text: 'done', timestamp: 2_000, seq: 2, turnEndReason: 'completed' } as AgentEvent,
  },
  {
    label: "result (turnEndReason: 'user_stopped')",
    event: { type: 'result', text: '', timestamp: 2_000, seq: 2, turnEndReason: 'user_stopped' } as AgentEvent,
  },
  {
    label: 'error',
    event: { type: 'error', error: 'provider exploded', timestamp: 2_000, seq: 2 } as AgentEvent,
  },
];

describe('terminal events × resume skip', () => {
  it.each(TERMINAL_PRODUCERS)(
    '$label ends the turn → the interrupted session IS offered for resume',
    async ({ event }) => {
      const sessionId = 'resume-offer-session';
      const { snapshot, summary } = await producePostTerminalSnapshot(sessionId, event);

      sessionsApi.get.mockResolvedValue(snapshot);
      const { result, unmount } = await renderResumeHook([summary]);

      expect(result.current.interruptedSessions.map((s) => s.sessionId)).toEqual([sessionId]);
      expect(result.current.shouldShowModal).toBe(true);
      unmount();
    },
  );

  it('SKIP: a snapshot still busy on its turn (no terminal event yet) is not offered', async () => {
    const sessionId = 'resume-skip-busy';
    const busySnapshot = makeDiskSession(sessionId); // isBusy: true, activeTurnId set
    const summary = makeStaleInterruptedSummary(sessionId);

    sessionsApi.get.mockResolvedValue(busySnapshot);
    const { result, unmount } = await renderResumeHook([summary]);

    expect(result.current.interruptedSessions).toEqual([]);
    expect(result.current.shouldShowModal).toBe(false);
    unmount();
  });

  it('SKIP: a superseded hand-over (new activeTurnId, still busy) is not offered — supersession is not an interruption', async () => {
    const sessionId = 'resume-skip-superseded';
    const supersededSnapshot = makeDiskSession(sessionId, {
      activeTurnId: 'turn-new',
      isBusy: true,
    });
    const summary = makeStaleInterruptedSummary(sessionId);

    sessionsApi.get.mockResolvedValue(supersededSnapshot);
    const { result, unmount } = await renderResumeHook([summary]);

    expect(result.current.interruptedSessions).toEqual([]);
    expect(result.current.shouldShowModal).toBe(false);
    unmount();
  });

  it('SKIP: a snapshot whose interrupted flag was already cleared is not offered', async () => {
    const sessionId = 'resume-skip-cleared';
    const clearedSnapshot = makeDiskSession(sessionId, {
      isBusy: false,
      activeTurnId: null,
      interruptedTurnId: null,
    });
    // Summary is stale (still flags the turn); the full-session snapshot is
    // the authoritative read.
    const summary = makeStaleInterruptedSummary(sessionId);

    sessionsApi.get.mockResolvedValue(clearedSnapshot);
    const { result, unmount } = await renderResumeHook([summary]);

    expect(result.current.interruptedSessions).toEqual([]);
    expect(result.current.shouldShowModal).toBe(false);
    unmount();
  });
});

/**
 * Minimal interrupted-flagged summary for the SKIP cases (candidate-filter
 * input only — the hook's authoritative read is the full-session snapshot
 * from sessionsApi.get, which IS the producer-relevant surface there).
 */
function makeStaleInterruptedSummary(sessionId: string): AgentSessionSummary {
  return {
    id: sessionId,
    title: 'Interrupted session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    isCorrupted: false,
    interruptedTurnId: TURN_ID,
    preview: 'please do the thing',
    messageCount: 1,
    hasDraft: false,
    draftPreview: null,
    draftUpdatedAt: null,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 1 },
    activeTurnId: null,
    isBusy: false,
    lastActivityAt: 1_700_000_000_001,
    lastError: null,
  };
}
