import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types';
import type { AgentSessionWithRuntime } from '../../types';
import type { BufferedEvent } from '../../store/sessionStore';
import {
  applySessionSwitchBufferedUnion,
  persistSessionSwitchBufferedUnion,
} from '../useAgentSessionEngine';

type SessionsApiMock = {
  applyTurnEventUnion: ReturnType<typeof vi.fn>;
};

const makeStatusEvent = (seq: number, timestamp: number): AgentEvent => ({
  type: 'status',
  message: `[status-${seq}]`,
  timestamp,
  seq,
});

const makeSession = (
  sessionId: string,
  turnId: string,
  events: AgentEvent[],
): AgentSessionWithRuntime => ({
  id: sessionId,
  title: 'Session',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  messages: [],
  eventsByTurn: { [turnId]: events },
  activeTurnId: turnId,
  isBusy: true,
  lastError: null,
  resolvedAt: null,
  doneAt: null,
  origin: 'manual',
  runtime: {
    startedAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_000_001,
    activeTurnId: turnId,
    terminated: false,
  },
});

describe('useAgentSessionEngine buffered event union helpers', () => {
  let sessionsApi: SessionsApiMock;

  beforeEach(() => {
    sessionsApi = {
      applyTurnEventUnion: vi.fn().mockResolvedValue({ success: true }),
    };

    vi.stubGlobal('window', {
      sessionsApi,
      agentApi: {
        stopTurn: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('session-switch flush applies buffered events via union and persists turn-local batch', () => {
    const sessionId = 'session-switch-a';
    const turnId = 'turn-switch-a';
    const existing = makeStatusEvent(1, 1_000);
    const duplicate = makeStatusEvent(1, 1_000);
    const novel = makeStatusEvent(2, 1_100);
    const buffered: BufferedEvent[] = [
      { turnId, event: duplicate },
      { turnId, event: novel },
    ];

    const merged = applySessionSwitchBufferedUnion(
      makeSession(sessionId, turnId, [existing]),
      buffered,
    );
    persistSessionSwitchBufferedUnion(sessionId, buffered);

    expect(merged.eventsByTurn[turnId]).toHaveLength(2);
    expect(new Set(merged.eventsByTurn[turnId].map((event) => event.seq)).size).toBe(2);
    expect(sessionsApi.applyTurnEventUnion).toHaveBeenCalledWith({
      sessionId,
      turnId,
      events: [duplicate, novel],
    });
  });

  it('late-load flush applies buffered events via union with no duplication', () => {
    const sessionId = 'session-late-load-a';
    const turnId = 'turn-late-load-a';
    const e1 = makeStatusEvent(1, 2_000);
    const e2 = makeStatusEvent(2, 2_100);
    const duplicate = makeStatusEvent(2, 2_100);
    const e3 = makeStatusEvent(3, 2_200);
    const buffered: BufferedEvent[] = [
      { turnId, event: duplicate },
      { turnId, event: e3 },
    ];

    const merged = applySessionSwitchBufferedUnion(
      makeSession(sessionId, turnId, [e1, e2]),
      buffered,
    );
    persistSessionSwitchBufferedUnion(sessionId, buffered);

    expect(merged.eventsByTurn[turnId]).toHaveLength(3);
    expect(new Set(merged.eventsByTurn[turnId].map((event) => event.seq)).size).toBe(3);
    expect(merged.eventsByTurn[turnId].map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(sessionsApi.applyTurnEventUnion).toHaveBeenCalledWith({
      sessionId,
      turnId,
      events: [duplicate, e3],
    });
  });
});
