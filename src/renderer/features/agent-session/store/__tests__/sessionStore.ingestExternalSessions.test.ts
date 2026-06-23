import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentSessionSummary, AgentTurnMessage } from '@shared/types';
import { createSessionStore } from '../sessionStore';

beforeEach(() => {
  vi.stubGlobal('window', {
    sessionsApi: {
      get: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({ success: true }),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    },
    agentApi: {
      stopTurn: vi.fn().mockResolvedValue(undefined),
    },
  });
});

const makeSummary = (overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 'automation-session-1',
  title: 'Automation',
  createdAt: 1_000,
  updatedAt: 5_000,
  resolvedAt: null,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'automation',
  isCorrupted: false,
  preview: '',
  messageCount: 0,
  hasDraft: false,
  draftPreview: null,
  draftUpdatedAt: null,
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
  activeTurnId: 'turn-1',
  isBusy: true,
  lastError: null,
  ...overrides,
});

const makeMessage = (overrides: Partial<AgentTurnMessage> = {}): AgentTurnMessage => ({
  id: 'message-1',
  turnId: 'turn-1',
  role: 'assistant',
  text: 'Automation finished with the report.',
  createdAt: 2_000,
  ...overrides,
} as AgentTurnMessage);

const makeSession = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 'automation-session-1',
  title: 'Automation',
  createdAt: 1_000,
  updatedAt: 2_000,
  messages: [makeMessage()],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: 4_000,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'automation',
  ...overrides,
});

describe('sessionStore.ingestExternalSessions', () => {
  it('merges terminal automation snapshots even when their updatedAt is older than the existing summary', () => {
    const store = createSessionStore();
    store.getState().setSessionSummaries([
      makeSummary({
        updatedAt: 5_000,
        isBusy: true,
        activeTurnId: 'turn-1',
        resolvedAt: null,
        doneAt: null,
        messageCount: 0,
        preview: '',
      }),
    ]);

    store.getState().ingestExternalSessions([makeSession()]);

    const summary = store.getState().sessionSummaries.find((entry) => entry.id === 'automation-session-1');
    expect(summary).toMatchObject({
      updatedAt: 5_000,
      isBusy: false,
      activeTurnId: null,
      resolvedAt: 4_000,
      doneAt: null,
      messageCount: 1,
      preview: 'Automation finished with the report.',
    });
  });

  it('preserves user-owned metadata while merging an older terminal automation snapshot', () => {
    const store = createSessionStore();
    store.getState().setSessionSummaries([
      makeSummary({
        title: 'User renamed automation',
        updatedAt: 5_000,
        starredAt: 4_500,
        deletedAt: 4_800,
        isBusy: true,
        activeTurnId: 'turn-1',
        resolvedAt: null,
      }),
    ]);

    store.getState().ingestExternalSessions([
      makeSession({
        title: 'Original automation title',
        updatedAt: 2_000,
        starredAt: null,
        deletedAt: null,
      }),
    ]);

    const summary = store.getState().sessionSummaries.find((entry) => entry.id === 'automation-session-1');
    expect(summary).toMatchObject({
      title: 'User renamed automation',
      starredAt: 4_500,
      deletedAt: 4_800,
      updatedAt: 5_000,
      isBusy: false,
      activeTurnId: null,
      resolvedAt: 4_000,
      messageCount: 1,
    });
  });

  it('hydrates activitySummaryByTurn into top-level state when ingesting the current session snapshot (260618 show-more-activity)', () => {
    const store = createSessionStore();
    // The snapshot only hydrates into top-level state when it IS the current
    // session; otherwise it lands as a history summary (no per-turn maps).
    store.setState({ currentSessionId: 'automation-session-1' });

    store.getState().ingestExternalSessions([
      makeSession({
        activitySummaryByTurn: { 'turn-1': 'Generated the report and shared it.' },
      }),
    ]);

    expect(store.getState().activitySummaryByTurn['turn-1']).toBe('Generated the report and shared it.');
  });

  it('defaults activitySummaryByTurn to {} when the current session snapshot omits it', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: 'automation-session-1',
      activitySummaryByTurn: { 'stale-turn': 'stale' },
    });

    store.getState().ingestExternalSessions([makeSession()]);

    // Hydration replaces the map (snapshot has none → {}), so a stale entry
    // from a different session doesn't bleed through.
    expect(store.getState().activitySummaryByTurn).toEqual({});
  });
});
