import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentSession } from '@shared/types';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import {
  createSessionStore,
  getCurrentSessionEventsForTurn,
} from '../sessionStore';

const breadcrumbMock = vi.hoisted(() => vi.fn());

vi.mock('@renderer/src/sentry', () => ({
  recordRendererBreadcrumb: (...args: unknown[]) => breadcrumbMock(...args),
  // Stage 19a Fix 2: the cross-session drop guard now also escalates to a
  // standalone Sentry message (once per tuple). Mock it so the drop path here
  // does not blow up on a missing export.
  captureRendererMessage: vi.fn(),
}));

type SessionsApiMock = {
  get: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  applyTurnEventUnion: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
};

const makeStatusEvent = (seq: number | undefined, timestamp: number): AgentEvent => ({
  type: 'status',
  message: `[status-${seq ?? 'legacy'}]`,
  timestamp,
  ...(seq === undefined ? {} : { seq }),
});

const makeResultEvent = (seq: number, timestamp: number): AgentEvent => ({
  type: 'result',
  text: '[REDACTED]',
  timestamp,
  seq,
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

describe('sessionStore terminal replay — UNION-by-identity', () => {
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

  it('applies buffered events when terminal arrives before checkpoint catches up', async () => {
    const store = createSessionStore();
    const sessionId = 'bg-before-checkpoint';
    const turnId = 'turn-before-checkpoint';
    const status1 = makeStatusEvent(1, 1_000);
    const status2 = makeStatusEvent(2, 1_100);
    const result = makeResultEvent(3, 1_200);

    store.getState().createBackgroundSession(sessionId, 'manual');
    store.getState().processHistoryEvent(sessionId, turnId, status1);
    store.getState().processHistoryEvent(sessionId, turnId, status2);

    sessionsApi.get.mockResolvedValueOnce(
      makeDiskSession(sessionId, turnId, [status1]),
    );

    store.getState().processHistoryEvent(sessionId, turnId, result);
    await flushAsync();

    expect(sessionsApi.applyTurnEventUnion).toHaveBeenCalledWith({
      sessionId,
      turnId,
      events: [status1, status2, result],
    });

    const updated = store.getState().loadedSessions.get(sessionId);
    // LRU cache compacts completed turns to terminal summaries; persistence payload
    // above is the source of truth for full replay union.
    expect(updated?.eventsByTurn[turnId]).toHaveLength(1);
    expect(updated?.eventsByTurn[turnId][0]?.type).toBe('result');
  });

  it('dedups overlap when terminal arrives after checkpoint and emits hashed breadcrumb only', async () => {
    const store = createSessionStore();
    const sessionId = 'bg-after-checkpoint';
    const turnId = 'turn-after-checkpoint';
    const status1 = makeStatusEvent(1, 2_000);
    const status2 = makeStatusEvent(2, 2_100);
    const result = makeResultEvent(3, 2_200);

    store.getState().createBackgroundSession(sessionId, 'manual');
    store.getState().processHistoryEvent(sessionId, turnId, status1);
    store.getState().processHistoryEvent(sessionId, turnId, status2);

    sessionsApi.get.mockResolvedValueOnce(
      makeDiskSession(sessionId, turnId, [status1, status2, result]),
    );

    store.getState().processHistoryEvent(sessionId, turnId, result);
    await flushAsync();

    const updated = store.getState().loadedSessions.get(sessionId);
    expect(updated?.eventsByTurn[turnId]).toHaveLength(3);
    expect(new Set((updated?.eventsByTurn[turnId] ?? []).map((event) => event.seq)).size).toBe(3);

    expect(breadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'event-dedup-activated',
        data: expect.objectContaining({
          turnId: hashSessionIdForBreadcrumb(turnId),
          dedupedCount: 3,
        }),
      }),
    );

    const leakedRawTurnId = breadcrumbMock.mock.calls.some((call) => {
      const payload = call[0] as { data?: { turnId?: string } };
      return payload?.data?.turnId === turnId;
    });
    expect(leakedRawTurnId).toBe(false);
  });

  it('handles interleaved checkpoint visibility with deterministic promise gating', async () => {
    const store = createSessionStore();
    const sessionId = 'bg-interleaved';
    const turnId = 'turn-interleaved';
    const status1 = makeStatusEvent(1, 3_000);
    const status2 = makeStatusEvent(2, 3_100);
    const result = makeResultEvent(3, 3_200);

    store.getState().createBackgroundSession(sessionId, 'manual');
    store.getState().processHistoryEvent(sessionId, turnId, status1);
    store.getState().processHistoryEvent(sessionId, turnId, status2);

    let resolveDisk!: (session: AgentSession | null) => void;
    const diskLoad = new Promise<AgentSession | null>((resolve) => {
      resolveDisk = resolve;
    });
    sessionsApi.get.mockReturnValueOnce(diskLoad);

    store.getState().processHistoryEvent(sessionId, turnId, result);
    expect(sessionsApi.applyTurnEventUnion).not.toHaveBeenCalled();

    resolveDisk(makeDiskSession(sessionId, turnId, [status1, result]));
    await flushAsync();

    const updated = store.getState().loadedSessions.get(sessionId);
    expect(updated?.eventsByTurn[turnId]).toHaveLength(3);
    expect(new Set((updated?.eventsByTurn[turnId] ?? []).map((event) => event.seq)).size).toBe(3);
  });

  it('emits legacy-fallback breadcrumb when replay union sees seq-less events', async () => {
    const store = createSessionStore();
    const sessionId = 'bg-legacy-fallback';
    const turnId = 'turn-legacy-fallback';
    const persistedStatus = makeStatusEvent(1, 5_000);
    const legacyBuffered = makeStatusEvent(undefined, 5_100);
    const result = makeResultEvent(2, 5_200);

    store.getState().createBackgroundSession(sessionId, 'manual');
    store.getState().processHistoryEvent(sessionId, turnId, legacyBuffered);

    sessionsApi.get.mockResolvedValueOnce(
      makeDiskSession(sessionId, turnId, [persistedStatus]),
    );

    store.getState().processHistoryEvent(sessionId, turnId, result);
    await flushAsync();

    expect(breadcrumbMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'event-identity-legacy-fallback',
        data: expect.objectContaining({
          turnIdHash: hashSessionIdForBreadcrumb(turnId),
          legacyEventCount: 1,
        }),
      }),
    );

    const leakedRawTurnId = breadcrumbMock.mock.calls.some((call) => {
      const payload = call[0] as { data?: { turnIdHash?: string } };
      return payload?.data?.turnIdHash === turnId;
    });
    expect(leakedRawTurnId).toBe(false);
  });

  it('keeps live append-event path after compaction (UNION is replay-only)', () => {
    const store = createSessionStore();
    const turnId = 'turn-live-after-compaction';

    store.getState().processEvent(turnId, makeStatusEvent(1, 4_000));
    store.getState().performCompaction('summary', 0);
    expect(getCurrentSessionEventsForTurn(turnId)).toEqual([]);

    sessionsApi.applyTurnEventUnion.mockClear();
    store.getState().processEvent(turnId, makeStatusEvent(2, 4_100));

    expect(getCurrentSessionEventsForTurn(turnId)).toHaveLength(1);
    expect(getCurrentSessionEventsForTurn(turnId)[0].seq).toBe(2);
    expect(sessionsApi.applyTurnEventUnion).not.toHaveBeenCalled();
  });
});
