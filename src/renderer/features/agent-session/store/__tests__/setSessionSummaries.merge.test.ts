import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@shared/types/agent';
import type { AgentSessionSummary } from '@shared/types';
import { buildRuntimeFromSnapshot, createSessionStore } from '../sessionStore';

const STALE_TURN_THRESHOLD_MS = 5 * 60_000;

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

afterEach(() => {
  vi.useRealTimers();
});

const summary = (overrides: Partial<AgentSessionSummary> = {}): AgentSessionSummary => ({
  id: 'sess-merge-test',
  title: 'merge test',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  resolvedAt: null,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'manual',
  isCorrupted: false,
  preview: '',
  messageCount: 0,
  hasDraft: false,
  draftPreview: null,
  draftUpdatedAt: null,
  usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
  activeTurnId: null,
  isBusy: false,
  lastActivityAt: null,
  lastError: null,
  ...overrides,
});

describe('setSessionSummaries — Layer A per-session merge', () => {
  it('ratchets updatedAt up — local newer wins on the sort key', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_010_000);

    const store = createSessionStore();
    const sessionId = 'sess-1';

    // Seed in-memory state with a "live" updatedAt that's ahead of disk.
    store.getState().setSessionSummaries([
      summary({ id: sessionId, updatedAt: 1_700_000_010_000, isBusy: true, activeTurnId: 'turn-A' }),
    ]);

    // Cloud-sync wholesale replace arrives carrying a stale-disk updatedAt.
    store.getState().setSessionSummaries([
      summary({ id: sessionId, updatedAt: 1_700_000_005_000, isBusy: true, activeTurnId: 'turn-A' }),
    ]);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.updatedAt).toBe(1_700_000_010_000);
  });

  it('ratchets updatedAt up — cloud newer wins on the sort key', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_010_000);

    const store = createSessionStore();
    const sessionId = 'sess-1';

    store.getState().setSessionSummaries([
      summary({ id: sessionId, updatedAt: 1_700_000_005_000 }),
    ]);

    store.getState().setSessionSummaries([
      summary({ id: sessionId, updatedAt: 1_700_000_010_000 }),
    ]);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.updatedAt).toBe(1_700_000_010_000);
  });

  it('clears stale busy summaries using lastActivityAt + shared stale threshold', () => {
    vi.useFakeTimers();
    const now = 1_700_000_010_000;
    vi.setSystemTime(now);

    const store = createSessionStore();
    const sessionId = 'sess-stale';

    store.getState().setSessionSummaries([
      summary({
        id: sessionId,
        updatedAt: now - 5_000,
        isBusy: true,
        activeTurnId: 'turn-stale',
        lastActivityAt: now - STALE_TURN_THRESHOLD_MS - 1,
      }),
    ]);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.isBusy).toBe(false);
    expect(after?.activeTurnId).toBeNull();
    expect(after?.lastActivityAt).toBe(now - STALE_TURN_THRESHOLD_MS - 1);
  });

  it('keeps busy summaries when lastActivityAt is fresh', () => {
    vi.useFakeTimers();
    const now = 1_700_000_010_000;
    vi.setSystemTime(now);

    const store = createSessionStore();
    const sessionId = 'sess-fresh-busy';

    store.getState().setSessionSummaries([
      summary({
        id: sessionId,
        isBusy: true,
        activeTurnId: 'turn-running',
        lastActivityAt: now - 1_000,
      }),
    ]);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.isBusy).toBe(true);
    expect(after?.activeTurnId).toBe('turn-running');
  });

  it('round-trips legacy summaries without lastActivityAt (additive field)', () => {
    const store = createSessionStore();
    const sessionId = 'sess-legacy-no-last-activity';
    // Simulate an older summary payload that predates lastActivityAt.
    const legacySummary = {
      ...summary({
        id: sessionId,
        isBusy: true,
        activeTurnId: 'turn-legacy',
      }),
    } as Record<string, unknown>;
    delete legacySummary.lastActivityAt;

    expect(() => {
      store.getState().setSessionSummaries([
        legacySummary as AgentSessionSummary,
      ]);
    }).not.toThrow();

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.isBusy).toBe(true);
    expect(after?.activeTurnId).toBe('turn-legacy');
    expect(after?.lastActivityAt ?? null).toBeNull();
  });

  it('loaded-session projection wins over incoming busy summary (never resurrect)', () => {
    const store = createSessionStore();
    const sessionId = 'sess-loaded';
    const turnId = 'turn-terminal';
    const eventsByTurn: Record<string, AgentEvent[]> = {
      [turnId]: [
        { type: 'turn_started', timestamp: 1000 },
        { type: 'result', text: 'done', timestamp: 1001 },
      ],
    };
    store.getState().cacheSession({
      id: sessionId,
      title: 'Loaded',
      createdAt: 1000,
      updatedAt: 1001,
      messages: [],
      eventsByTurn,
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      runtime: buildRuntimeFromSnapshot(null, eventsByTurn),
    });

    store.getState().setSessionSummaries([
      summary({
        id: sessionId,
        updatedAt: 2000,
        isBusy: true,
        activeTurnId: turnId,
        lastActivityAt: 2000,
      }),
    ]);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.isBusy).toBe(false);
    expect(after?.activeTurnId).toBeNull();
    expect(after?.lastActivityAt).toBe(1001);
  });

  it('keeps projection-confirmed running for loaded sessions even when incoming activity is older', () => {
    vi.useFakeTimers();
    const now = 1_700_000_010_000;
    vi.setSystemTime(now);

    const store = createSessionStore();
    const sessionId = 'sess-loaded-running';
    const turnId = 'turn-running';

    store.getState().setSessionSummaries([
      summary({
        id: sessionId,
        isBusy: false,
        activeTurnId: null,
        lastActivityAt: now,
      }),
    ]);

    const eventsByTurn: Record<string, AgentEvent[]> = {
      [turnId]: [{ type: 'turn_started', timestamp: now - 1_000 }],
    };
    store.getState().cacheSession({
      id: sessionId,
      title: 'Loaded running',
      createdAt: 1_000,
      updatedAt: now - 1_000,
      messages: [],
      eventsByTurn,
      activeTurnId: turnId,
      isBusy: true,
      lastError: null,
      resolvedAt: null,
      runtime: buildRuntimeFromSnapshot(turnId, eventsByTurn),
    });

    store.getState().setSessionSummaries([
      summary({
        id: sessionId,
        updatedAt: now + 1_000,
        isBusy: true,
        activeTurnId: turnId,
        lastActivityAt: now - 1_000,
      }),
    ]);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.isBusy).toBe(true);
    expect(after?.activeTurnId).toBe(turnId);
    expect(after?.lastActivityAt).toBe(now - 1_000);
  });

  it('does not resurrect idle when incoming busy lacks fresher activity evidence', () => {
    const store = createSessionStore();
    const sessionId = 'sess-no-resurrect';

    store.getState().setSessionSummaries([
      summary({
        id: sessionId,
        isBusy: false,
        activeTurnId: null,
        lastActivityAt: 5000,
      }),
    ]);

    store.getState().setSessionSummaries([
      summary({
        id: 'sess-no-resurrect',
        updatedAt: 4_900,
        isBusy: true,
        activeTurnId: 'turn-old',
        lastActivityAt: 4_900,
      }),
    ]);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.isBusy).toBe(false);
    expect(after?.activeTurnId).toBeNull();
  });

  it('drops sessions present in prev but missing from next (matches wholesale-replace deletion semantics)', () => {
    const store = createSessionStore();

    store.getState().setSessionSummaries([
      summary({ id: 'keep' }),
      summary({ id: 'remove' }),
    ]);

    store.getState().setSessionSummaries([summary({ id: 'keep' })]);

    const ids = store.getState().sessionSummaries.map((s) => s.id);
    expect(ids).toEqual(['keep']);
  });

  it('takes non-updatedAt cloud fields (preview, messageCount) — cloud is authoritative for content', () => {
    const store = createSessionStore();
    const sessionId = 'sess-content';

    store.getState().setSessionSummaries([
      summary({
        id: sessionId,
        updatedAt: 1_700_000_010_000,
        preview: 'old preview',
        messageCount: 3,
      }),
    ]);

    store.getState().setSessionSummaries([
      summary({
        id: sessionId,
        updatedAt: 1_700_000_005_000, // cloud has older updatedAt
        preview: 'cloud preview', // but newer content
        messageCount: 5,
      }),
    ]);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    // Sort key ratcheted up.
    expect(after?.updatedAt).toBe(1_700_000_010_000);
    // But content is taken from cloud (cloud is source of truth for content).
    expect(after?.preview).toBe('cloud preview');
    expect(after?.messageCount).toBe(5);
  });

  it('prunes orphaned drafts when their session is removed by the merge', () => {
    const store = createSessionStore();

    store.getState().setSessionSummaries([summary({ id: 'sess-A' }), summary({ id: 'sess-B' })]);
    store.getState().setDraftForSession('sess-A', 'pending draft');
    store.getState().setDraftForSession('sess-B', 'other draft');

    expect(store.getState().draftsBySessionId['sess-A']).toBeDefined();
    expect(store.getState().draftsBySessionId['sess-B']).toBeDefined();

    // Cloud sends only sess-A; sess-B's draft must be pruned.
    store.getState().setSessionSummaries([summary({ id: 'sess-A' })]);

    expect(store.getState().draftsBySessionId['sess-A']).toBeDefined();
    expect(store.getState().draftsBySessionId['sess-B']).toBeUndefined();
  });
});
