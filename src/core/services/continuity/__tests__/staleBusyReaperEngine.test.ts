import { afterEach, beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import type { AgentSession } from '@shared/types';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockMarkSessionTurnsAsCompleted = vi.fn((session: AgentSession): AgentSession => ({
  ...session,
  activeTurnId: null,
  isBusy: false,
}));

vi.mock('@core/services/inboxStore', () => ({
  markSessionTurnsAsCompleted: (session: AgentSession) => mockMarkSessionTurnsAsCompleted(session),
}));

import { sweepStaleBusySessions, type StaleBusyReaperEngineDeps } from '../staleBusyReaperEngine';

type SessionSummaryLike = {
  id: string;
  isBusy: boolean;
  activeTurnId: string | null;
  updatedAt: number;
};

function makeSummary(overrides: Partial<SessionSummaryLike> = {}): SessionSummaryLike {
  return {
    id: 'session-1',
    isBusy: true,
    activeTurnId: 'turn-1',
    updatedAt: Date.now() - 3 * 60_000,
    ...overrides,
  };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 'session-1',
    title: 'Session',
    createdAt: 1,
    updatedAt: Date.now() - 3 * 60_000,
    messages: [],
    eventsByTurn: {
      'turn-1': [{ type: 'status', status: 'Thinking', timestamp: 10 } as never],
    },
    activeTurnId: 'turn-1',
    isBusy: true,
    lastError: null,
    resolvedAt: null,
    origin: 'manual',
    ...overrides,
  } as AgentSession;
}

type MockedDeps = {
  [K in keyof StaleBusyReaperEngineDeps]: MockedFunction<StaleBusyReaperEngineDeps[K]>;
};

function makeDeps(overrides: Partial<MockedDeps> = {}): MockedDeps {
  return {
    listSessions: vi.fn<StaleBusyReaperEngineDeps['listSessions']>(() => []),
    getSession: vi.fn<StaleBusyReaperEngineDeps['getSession']>(async () => null),
    upsertSession: vi.fn<StaleBusyReaperEngineDeps['upsertSession']>(async () => {}),
    getActiveTurnController: vi.fn<StaleBusyReaperEngineDeps['getActiveTurnController']>(
      () => undefined,
    ),
    ...overrides,
  };
}

describe('staleBusyReaperEngine.sweepStaleBusySessions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T12:00:00.000Z'));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the corrected session ID for an orphaned busy session', async () => {
    const summary = makeSummary();
    const session = makeSession({ id: summary.id });
    const mockDeps = makeDeps({
      listSessions: vi.fn(() => [summary]),
      getSession: vi.fn(async () => session),
    });

    const correctedIds = await sweepStaleBusySessions(mockDeps);

    expect(mockDeps.getSession).toHaveBeenCalledWith(summary.id);
    expect(mockMarkSessionTurnsAsCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ id: summary.id, interruptedTurnId: 'turn-1' }),
    );
    expect(mockDeps.upsertSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: summary.id,
        isBusy: false,
        activeTurnId: null,
        interruptedTurnId: 'turn-1',
      }),
    );
    expect(correctedIds).toEqual([summary.id]);
  });

  it('preserves active session when controller exists in registry', async () => {
    const summary = makeSummary();
    const mockDeps = makeDeps({
      listSessions: vi.fn(() => [summary]),
      getActiveTurnController: vi.fn(() => new AbortController()),
    });

    const correctedIds = await sweepStaleBusySessions(mockDeps);

    expect(mockDeps.getSession).not.toHaveBeenCalled();
    expect(mockMarkSessionTurnsAsCompleted).not.toHaveBeenCalled();
    expect(mockDeps.upsertSession).not.toHaveBeenCalled();
    expect(correctedIds).toEqual([]);
  });

  it('preserves recent session within grace period', async () => {
    const summary = makeSummary({ updatedAt: Date.now() - 30_000 });
    const mockDeps = makeDeps({
      listSessions: vi.fn(() => [summary]),
    });

    const correctedIds = await sweepStaleBusySessions(mockDeps);

    expect(mockDeps.getActiveTurnController).not.toHaveBeenCalled();
    expect(mockDeps.getSession).not.toHaveBeenCalled();
    expect(mockDeps.upsertSession).not.toHaveBeenCalled();
    expect(correctedIds).toEqual([]);
  });

  it('handles empty session list', async () => {
    const mockDeps = makeDeps({
      listSessions: vi.fn(() => []),
    });

    const correctedIds = await sweepStaleBusySessions(mockDeps);

    expect(mockDeps.listSessions).toHaveBeenCalledTimes(1);
    expect(mockDeps.getSession).not.toHaveBeenCalled();
    expect(mockDeps.upsertSession).not.toHaveBeenCalled();
    expect(correctedIds).toEqual([]);
  });

  it('handles non-array listSessions response gracefully', async () => {
    const mockDeps = makeDeps({
      listSessions: vi.fn(() => null as unknown as []),
    });

    const correctedIds = await sweepStaleBusySessions(mockDeps);

    expect(mockDeps.listSessions).toHaveBeenCalledTimes(1);
    expect(mockDeps.getSession).not.toHaveBeenCalled();
    expect(correctedIds).toEqual([]);
  });

  it('sets interruptedTurnId before cleanup when no terminal event exists', async () => {
    const summary = makeSummary();
    const session = makeSession({
      id: summary.id,
      activeTurnId: 'turn-1',
      eventsByTurn: {
        'turn-1': [{ type: 'status', status: 'Still working', timestamp: 25 } as never],
      },
    });
    const mockDeps = makeDeps({
      listSessions: vi.fn(() => [summary]),
      getSession: vi.fn(async () => session),
    });

    await sweepStaleBusySessions(mockDeps);

    expect(mockMarkSessionTurnsAsCompleted).toHaveBeenCalledTimes(1);
    const markedInput = mockMarkSessionTurnsAsCompleted.mock.calls[0]?.[0] as AgentSession;
    expect(markedInput.interruptedTurnId).toBe('turn-1');
  });

  it('does not set interruptedTurnId when turn already has terminal event', async () => {
    const summary = makeSummary();
    const session = makeSession({
      id: summary.id,
      activeTurnId: 'turn-1',
      eventsByTurn: {
        'turn-1': [
          { type: 'status', status: 'Thinking', timestamp: 10 } as never,
          { type: 'result', result: 'done', timestamp: 20 } as never,
        ],
      },
    });
    const mockDeps = makeDeps({
      listSessions: vi.fn(() => [summary]),
      getSession: vi.fn(async () => session),
    });

    await sweepStaleBusySessions(mockDeps);

    expect(mockMarkSessionTurnsAsCompleted).toHaveBeenCalledTimes(1);
    const markedInput = mockMarkSessionTurnsAsCompleted.mock.calls[0]?.[0] as AgentSession;
    expect(markedInput.interruptedTurnId).toBeUndefined();
  });

  it('re-checks session state after load and skips cleanup when active turn changed', async () => {
    const summary = makeSummary({ activeTurnId: 'turn-1' });
    const session = makeSession({
      id: summary.id,
      activeTurnId: 'turn-2',
      eventsByTurn: {
        'turn-1': [{ type: 'status', status: 'Old turn', timestamp: 1 } as never],
        'turn-2': [{ type: 'status', status: 'New turn', timestamp: 2 } as never],
      },
    });
    const mockDeps = makeDeps({
      listSessions: vi.fn(() => [summary]),
      getSession: vi.fn(async () => session),
      getActiveTurnController: vi.fn(() => undefined),
    });

    const correctedIds = await sweepStaleBusySessions(mockDeps);

    expect(mockDeps.getSession).toHaveBeenCalledTimes(1);
    expect(mockMarkSessionTurnsAsCompleted).not.toHaveBeenCalled();
    expect(mockDeps.upsertSession).not.toHaveBeenCalled();
    expect(correctedIds).toEqual([]);
  });
});
