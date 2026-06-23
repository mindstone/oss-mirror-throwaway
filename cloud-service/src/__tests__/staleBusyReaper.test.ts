import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import type { StaleBusyReaperEngineDeps } from '@core/services/continuity/staleBusyReaperEngine';

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockBroadcast = vi.fn<(channel: string, payload: unknown) => void>();

vi.mock('../cloudEventBroadcaster', () => ({
  cloudEventBroadcaster: {
    broadcast: (channel: string, payload: unknown) => mockBroadcast(channel, payload),
  },
}));

const mockSweep = vi.fn<(deps: StaleBusyReaperEngineDeps) => Promise<string[]>>(async () => []);

vi.mock('@core/services/continuity/staleBusyReaperEngine', () => ({
  sweepStaleBusySessions: (deps: StaleBusyReaperEngineDeps) => mockSweep(deps),
  STALE_BUSY_GRACE_PERIOD_MS: 120_000,
}));

import { startStaleBusyReaper, stopStaleBusyReaper } from '../services/staleBusyReaper';

function makeDeps() {
  return {
    listSessions: vi.fn(() => []),
    getSession: vi.fn(async () => null as AgentSession | null),
    upsertSession: vi.fn<(session: AgentSession) => Promise<void>>(async () => {}),
    getActiveTurnController: vi.fn(() => undefined),
  };
}

describe('staleBusyReaper cloud wrapper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-16T12:00:00.000Z'));
    vi.clearAllMocks();
    mockSweep.mockReset();
    mockSweep.mockResolvedValue([]);
  });

  afterEach(() => {
    stopStaleBusyReaper();
    vi.useRealTimers();
  });

  it('broadcasts cloud:session-changed for each corrected session ID returned by the engine', async () => {
    mockSweep.mockResolvedValueOnce(['session-A', 'session-B']);

    startStaleBusyReaper(makeDeps());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockBroadcast).toHaveBeenCalledTimes(2);
    expect(mockBroadcast).toHaveBeenNthCalledWith(1, 'cloud:session-changed', {
      sessionId: 'session-A',
      action: 'upserted',
    });
    expect(mockBroadcast).toHaveBeenNthCalledWith(2, 'cloud:session-changed', {
      sessionId: 'session-B',
      action: 'upserted',
    });
  });

  it('does not broadcast when the engine returns no corrected IDs', async () => {
    mockSweep.mockResolvedValueOnce([]);

    startStaleBusyReaper(makeDeps());
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockSweep).toHaveBeenCalledTimes(1);
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('skips concurrent invocations while previous sweep is running', async () => {
    let resolveSweep: ((ids: string[]) => void) | undefined;
    const pendingSweep = new Promise<string[]>((resolve) => {
      resolveSweep = resolve;
    });
    mockSweep.mockReturnValueOnce(pendingSweep);

    startStaleBusyReaper(makeDeps());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSweep).toHaveBeenCalledTimes(1);

    resolveSweep?.([]);
    await vi.advanceTimersByTimeAsync(0);
  });

  it('passes deps unchanged to the engine on each sweep', async () => {
    const deps = makeDeps();

    startStaleBusyReaper(deps);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockSweep).toHaveBeenCalledTimes(2);
    expect(mockSweep).toHaveBeenNthCalledWith(1, deps);
    expect(mockSweep).toHaveBeenNthCalledWith(2, deps);
  });

  it('is a no-op when start is called twice', async () => {
    startStaleBusyReaper(makeDeps());
    startStaleBusyReaper(makeDeps());

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockSweep).toHaveBeenCalledTimes(1);
  });
});
