import {
  appendRendererOptimisticTurnStartedEvent,
  clearCurrentSessionEvents,
  createSessionStore,
  getCurrentSessionEventsVersion,
  getCurrentSessionProjectedLiveness,
  selectCurrentSessionIsBusy,
  selectHasAnyActiveTurn,
} from '../sessionStore';
import type { AgentSessionSummary } from '@shared/types';

const STALE_TURN_THRESHOLD_MS = 5 * 60 * 1000;

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
  messageCount: overrides.messageCount ?? 0,
  hasDraft: overrides.hasDraft ?? false,
  draftPreview: overrides.draftPreview ?? null,
  draftUpdatedAt: overrides.draftUpdatedAt ?? null,
  usage: overrides.usage ?? {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turnCount: 0,
  },
  activeTurnId: overrides.activeTurnId ?? null,
  isBusy: overrides.isBusy ?? false,
  lastError: overrides.lastError ?? null,
});

describe('selectHasAnyActiveTurn (anywhere lens, Stage 6)', () => {
  beforeEach(() => {
    clearCurrentSessionEvents();
  });

  it('returns false when no session is busy', () => {
    const store = createSessionStore();
    expect(selectHasAnyActiveTurn(store.getState())).toBe(false);
  });

  it('returns true when current session is busy (projection from events)', () => {
    const store = createSessionStore();
    appendRendererOptimisticTurnStartedEvent('selectors-any-active-current');
    store.setState({ activeTurnId: 'selectors-any-active-current' });
    expect(selectHasAnyActiveTurn(store.getState())).toBe(true);
  });

  it('returns true when ANY background session summary is busy', () => {
    const store = createSessionStore();
    store.setState({
      isBusy: false,
      sessionSummaries: [
        makeSummary({ id: 'bg-A', isBusy: true, activeTurnId: 'turn-a' }),
        makeSummary({ id: 'bg-B', isBusy: false }),
      ],
    });
    expect(selectHasAnyActiveTurn(store.getState())).toBe(true);
  });

  it('returns false when all sessions report idle', () => {
    const store = createSessionStore();
    store.setState({
      isBusy: false,
      sessionSummaries: [
        makeSummary({ id: 'bg-A', isBusy: false }),
        makeSummary({ id: 'bg-B', isBusy: false }),
      ],
    });
    expect(selectHasAnyActiveTurn(store.getState())).toBe(false);
  });
});

describe('selectCurrentSessionIsBusy (foreground-only lens, R2-2)', () => {
  beforeEach(() => {
    clearCurrentSessionEvents();
  });

  it('returns false when no session is busy', () => {
    const store = createSessionStore();
    expect(selectCurrentSessionIsBusy(store.getState())).toBe(false);
  });

  it('returns true when foreground session is busy via projection events', () => {
    const store = createSessionStore();
    appendRendererOptimisticTurnStartedEvent('selectors-current-busy');
    store.setState({ activeTurnId: 'selectors-current-busy' });
    expect(selectCurrentSessionIsBusy(store.getState())).toBe(true);
  });

  it('re-evaluates foreground liveness across stale threshold without an event-version bump', () => {
    vi.useFakeTimers();
    try {
      const startedAt = 1_700_000_000_000;
      const turnId = 'selectors-current-stale-threshold';
      vi.setSystemTime(startedAt);

      const store = createSessionStore();
      appendRendererOptimisticTurnStartedEvent(turnId, startedAt);
      store.setState({ activeTurnId: turnId });

      const versionBeforeStale = getCurrentSessionEventsVersion();
      expect(getCurrentSessionProjectedLiveness(turnId).status).toBe('running');
      expect(selectCurrentSessionIsBusy(store.getState())).toBe(true);
      expect(selectHasAnyActiveTurn(store.getState())).toBe(true);

      vi.setSystemTime(startedAt + STALE_TURN_THRESHOLD_MS + 1);
      expect(getCurrentSessionEventsVersion()).toBe(versionBeforeStale);

      expect(getCurrentSessionProjectedLiveness(turnId).status).toBe('interrupted');
      expect(selectCurrentSessionIsBusy(store.getState())).toBe(false);
      expect(selectHasAnyActiveTurn(store.getState())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false when foreground summary is busy but projection is idle', () => {
    const store = createSessionStore();
    const fgId = store.getState().currentSessionId;
    store.setState({
      isBusy: false,
      sessionSummaries: [
        makeSummary({ id: fgId, isBusy: true, activeTurnId: 'turn-fg' }),
      ],
    });
    expect(selectCurrentSessionIsBusy(store.getState())).toBe(false);
  });

  it('returns false for idle foreground Conversation B even when background Conversation A is busy', () => {
    const store = createSessionStore();
    const fgId = store.getState().currentSessionId; // Conversation B (foreground/idle)
    store.setState({
      isBusy: false,
      sessionSummaries: [
        makeSummary({ id: 'conversation-A-bg', isBusy: true, activeTurnId: 'turn-bg-A' }),
        makeSummary({ id: fgId, isBusy: false }),
      ],
    });

    // Foreground-only lens: idle foreground stays idle even while background streams.
    expect(selectCurrentSessionIsBusy(store.getState())).toBe(false);

    // Anywhere lens: any session busy → true.
    expect(selectHasAnyActiveTurn(store.getState())).toBe(true);
  });

  // Phase 6 regression — gpt5.5-high finding: short-circuit on `state.isBusy`
  // must NOT bypass the `currentSessionId` truthiness guard. Otherwise the
  // body-level [data-active-work] would attach during a transient state where
  // currentSessionId has been cleared (e.g. session deletion in flight) but
  // the top-level isBusy flag still lags.
  it('returns false when currentSessionId is falsy even if state.isBusy is true', () => {
    const store = createSessionStore();
    store.setState({
      currentSessionId: '',
      isBusy: true,
      sessionSummaries: [],
    });
    expect(selectCurrentSessionIsBusy(store.getState())).toBe(false);
  });
});
