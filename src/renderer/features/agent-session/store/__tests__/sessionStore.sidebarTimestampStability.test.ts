import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../sessionStore';
import type { AgentSessionWithRuntime } from '../../types';

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

/**
 * Regression for docs-private/investigations/260424_sidebar_reorders_on_selection.md.
 *
 * `addOrUpdateHistorySession` is called every time the user selects a different
 * conversation in the sidebar (via `openHistorySession` snapshotting the
 * previously-current session and writing it back). The snapshot recomputes
 * `updatedAt = Math.max(lastMessageAt, draftUpdatedAt, createdAt)` which is
 * generally LESS than the `summary.updatedAt` value that `processHistoryEvent`
 * stamped to `Date.now()` on the most recent turn event. Without the
 * `Math.max(summary.updatedAt, existing.updatedAt)` guard, every selection
 * downgraded the timestamp and shuffled the sidebar order.
 */
describe('addOrUpdateHistorySession — preserves higher updatedAt on replace', () => {
  it('does not downgrade summary.updatedAt when an existing summary has a more recent value', () => {
    const store = createSessionStore();
    const sessionId = 'sess-test-1';

    // Seed an existing summary with a "live" event-stamped updatedAt (later than
    // any message in the session). Mirrors what processHistoryEvent produces
    // when a non-terminal event fires for the session.
    const liveUpdatedAt = 1_700_000_000_000;
    const session: AgentSessionWithRuntime = {
      id: sessionId,
      title: 'Test session',
      createdAt: liveUpdatedAt - 60_000,
      updatedAt: liveUpdatedAt - 30_000, // older than the live summary value
      messages: [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'user',
          text: 'hi',
          createdAt: liveUpdatedAt - 30_000,
        },
      ],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      doneAt: null,
      starredAt: null,
      origin: 'manual',
      runtime: undefined as unknown as AgentSessionWithRuntime['runtime'],
      memoryUpdateStatusByTurn: {},
      timeSavedStatusByTurn: {},
      compactionBoundaries: [],
      privateMode: false,
    };

    // First insert seeds the summary.
    store.getState().addOrUpdateHistorySession(session);
    // Simulate processHistoryEvent bumping the summary later (during a turn).
    const seeded = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(seeded).toBeDefined();
    store.getState().updateSessionSummary({
      ...seeded!,
      updatedAt: liveUpdatedAt,
    });
    expect(
      store.getState().sessionSummaries.find((s) => s.id === sessionId)?.updatedAt,
    ).toBe(liveUpdatedAt);

    // Now simulate the snapshot+writeback that happens when the user selects
    // ANOTHER session: the snapshot's updatedAt is max(lastMessageAt, draft,
    // createdAt) which here is liveUpdatedAt - 30_000, strictly less than the
    // event-stamped summary value.
    const olderSnapshot = { ...session, updatedAt: liveUpdatedAt - 30_000 };
    store.getState().addOrUpdateHistorySession(olderSnapshot);

    // The sidebar's source-of-truth timestamp must NOT have been downgraded.
    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.updatedAt).toBe(liveUpdatedAt);
  });

  it('still adopts the snapshot updatedAt when it is newer than the existing summary', () => {
    const store = createSessionStore();
    const sessionId = 'sess-test-2';

    const baseTime = 1_700_000_000_000;
    const session: AgentSessionWithRuntime = {
      id: sessionId,
      title: 'Newer snapshot wins',
      createdAt: baseTime,
      updatedAt: baseTime,
      messages: [
        {
          id: 'msg-1',
          turnId: 'turn-1',
          role: 'user',
          text: 'hi',
          createdAt: baseTime,
        },
      ],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
      doneAt: null,
      starredAt: null,
      origin: 'manual',
      runtime: undefined as unknown as AgentSessionWithRuntime['runtime'],
      memoryUpdateStatusByTurn: {},
      timeSavedStatusByTurn: {},
      compactionBoundaries: [],
      privateMode: false,
    };

    store.getState().addOrUpdateHistorySession(session);

    // A fresher snapshot (newer message appended) must still win.
    const newer = baseTime + 10_000;
    const newerSnapshot: AgentSessionWithRuntime = {
      ...session,
      updatedAt: newer,
      messages: [
        ...session.messages,
        {
          id: 'msg-2',
          turnId: 'turn-2',
          role: 'assistant',
          text: 'hi back',
          createdAt: newer,
        },
      ],
    };
    store.getState().addOrUpdateHistorySession(newerSnapshot);

    const after = store.getState().sessionSummaries.find((s) => s.id === sessionId);
    expect(after?.updatedAt).toBe(newer);
  });
});
