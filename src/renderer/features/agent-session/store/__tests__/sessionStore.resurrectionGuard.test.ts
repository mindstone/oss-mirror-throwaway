import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSessionSummary } from '@shared/types';
import type { AgentSessionWithRuntime } from '../../types';
import { createSessionStore } from '../sessionStore';

// ---------------------------------------------------------------------------
// Resurrection-guard / tombstone-ledger tests.
//
// These tests are LOAD-BEARING: if the tombstone ledger (or the F1/F2 fixes
// layered on it) is neutralized, they go red. They pin the by-construction
// "a removed/cleared session id can never be re-created or un-deleted from any
// summary-insertion path" rule, plus the two GPT-review fixes:
//   F1 — clearAllSessionsForE2E tombstones the CURRENT in-memory session id and
//        all loaded-session ids (not only currently-visible summaries), so a
//        stale pending save for the prior session cannot resurrect it into the
//        freshly-cleared sidebar (the positional :611 / 2nd-Draft-test failure).
//   F2 — soft-deleting a current session that has meaningful content but NO
//        prior summary row synthesizes a Trash row, so the legitimately
//        soft-deleted session survives a later tombstone-filtered reload
//        instead of being lost (data loss).
//
// The tombstone ledger is MODULE-scoped (shared across createSessionStore()
// instances), so every test uses UNIQUE session ids to avoid cross-test
// pollution.
// ---------------------------------------------------------------------------

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
    e2eApi: { isEnabled: true },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

let summaryCounter = 0;
const summary = (
  overrides: Partial<AgentSessionSummary> = {},
): AgentSessionSummary => ({
  id: `sess-resurrect-${summaryCounter++}`,
  title: 'resurrection test',
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

describe('tombstone ledger — by-construction resurrection block', () => {
  it('updateSessionSummary cannot re-create a hard-removed session', () => {
    const store = createSessionStore();
    const id = 'tombstone-hard-remove';

    store.getState().setSessionSummaries([summary({ id, title: 'live' })]);
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(true);

    // Hard remove → tombstoned.
    store.getState().removeHistorySession(id);
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);

    // A stale async save that resolves after the remove lands here. It must be
    // a no-op — the removed session must NOT reappear.
    store.getState().updateSessionSummary(summary({ id, title: 'STALE RE-ADD' }));
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);
  });

  it('updateSessionSummary cannot un-delete a soft-deleted (trashed) session', () => {
    const store = createSessionStore();
    const id = 'tombstone-soft-delete-undelete';

    // Seed a present, non-current summary row, then soft-delete (trash) it.
    store.getState().setSessionSummaries([summary({ id, title: 'trash me' })]);
    store.getState().softDeleteSession(id);

    const trashed = store.getState().sessionSummaries.find((s) => s.id === id);
    expect(trashed?.deletedAt).toBeTruthy();

    // A stale terminal re-add / save would clear deletedAt and silently
    // un-trash. The tombstone must reject it — row stays soft-deleted.
    store.getState().updateSessionSummary(summary({ id, title: 'STALE', deletedAt: null }));
    const after = store.getState().sessionSummaries.find((s) => s.id === id);
    expect(after?.deletedAt).toBeTruthy();
  });

  it('addOrUpdateHistorySession cannot re-create a removed session', () => {
    const store = createSessionStore();
    const id = 'tombstone-add-history';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().removeHistorySession(id);

    const staleSession: AgentSessionWithRuntime = {
      id,
      title: 'STALE BACKGROUND DEMOTE',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
    };
    store.getState().addOrUpdateHistorySession(staleSession);

    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);
  });

  it('setSessionSummaries (disk reconcile) drops a stale incoming row for a removed id', () => {
    const store = createSessionStore();
    const id = 'tombstone-disk-reconcile';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().removeHistorySession(id);

    // A disk-list request that started before the remove resolves afterwards
    // carrying the old (live) row. The tombstone filter must drop it.
    store.getState().setSessionSummaries([summary({ id, title: 'STALE DISK ROW' })]);
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);
  });

  it('restoreSession clears the tombstone so an un-trashed session works again', () => {
    const store = createSessionStore();
    const id = 'tombstone-restore';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().softDeleteSession(id);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt,
    ).toBeTruthy();

    // Explicit un-trash clears the tombstone.
    store.getState().restoreSession(id);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt ?? null,
    ).toBeNull();

    // After restore, legitimate summary updates are accepted again.
    store.getState().updateSessionSummary(summary({ id, title: 'updated after restore' }));
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.title,
    ).toBe('updated after restore');
  });

  it('does NOT tombstone a genuinely-new session id (no false block)', () => {
    const store = createSessionStore();
    const removedId = 'tombstone-unrelated-removed';
    const freshId = 'tombstone-fresh-background';

    store.getState().setSessionSummaries([summary({ id: removedId })]);
    store.getState().removeHistorySession(removedId);

    // A genuinely-new background session was never removed → not tombstoned →
    // adds normally.
    store.getState().updateSessionSummary(summary({ id: freshId, title: 'new bg' }));
    expect(store.getState().sessionSummaries.some((s) => s.id === freshId)).toBe(true);
  });
});

describe('F1 — clearAllSessionsForE2E tombstones current + loaded session ids', () => {
  it('blocks a stale pending save for the PRIOR current session after clear', () => {
    const store = createSessionStore();

    // Prior test had a current session with meaningful content but it was never
    // added to sessionSummaries / disk yet (so main returns no deletedId for it
    // and it is absent from summaries — the F1 gap).
    const priorCurrentId = store.getState().currentSessionId;
    expect(priorCurrentId).toBeTruthy();

    // E2E clear runs (main process returned no deletedIds for this id).
    store.getState().clearAllSessionsForE2E([]);

    // The new blank current session is a DIFFERENT, fresh id.
    const newCurrentId = store.getState().currentSessionId;
    expect(newCurrentId).not.toBe(priorCurrentId);

    // A pending saveSessionAndUpdateSummary() for the PRIOR current session
    // resolves AFTER the clear and lands in updateSessionSummary. Without F1
    // (tombstoning currentSessionId) this resurrects "Session A ready" into the
    // freshly-cleared sidebar — the positional 2nd-Draft-test failure.
    store.getState().updateSessionSummary(
      summary({ id: priorCurrentId, title: 'Session A ready' }),
    );

    expect(
      store.getState().sessionSummaries.some((s) => s.id === priorCurrentId),
    ).toBe(false);
  });

  it('blocks a stale save for a LOADED (non-current) session after clear', () => {
    const store = createSessionStore();
    const loadedId = 'f1-loaded-session';

    // A loaded (LRU-cached, non-current) session with no summary row.
    const loadedSession: AgentSessionWithRuntime = {
      id: loadedId,
      title: 'loaded',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages: [],
      eventsByTurn: {},
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      resolvedAt: null,
    };
    store.getState().cacheSession(loadedSession);
    expect(store.getState().loadedSessions.has(loadedId)).toBe(true);

    store.getState().clearAllSessionsForE2E([]);

    // A stale save for the loaded id resolves after the clear → must be blocked.
    store.getState().updateSessionSummary(
      summary({ id: loadedId, title: 'STALE LOADED RE-ADD' }),
    );
    expect(
      store.getState().sessionSummaries.some((s) => s.id === loadedId),
    ).toBe(false);
  });

  it('the fresh post-clear current session is NOT tombstoned (accepts updates)', () => {
    const store = createSessionStore();
    store.getState().clearAllSessionsForE2E([]);
    const freshCurrentId = store.getState().currentSessionId;

    // The brand-new blank session must be able to accept summary updates.
    store.getState().updateSessionSummary(
      summary({ id: freshCurrentId, title: 'fresh session' }),
    );
    expect(
      store.getState().sessionSummaries.some((s) => s.id === freshCurrentId),
    ).toBe(true);
  });
});

describe('F2 — soft-deleting an unsummarized current session creates a recoverable Trash row', () => {
  it('synthesizes a Trash row that survives a tombstone-filtered reload', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_050_000);

    const store = createSessionStore();
    const currentId = store.getState().currentSessionId;

    // Current session has meaningful content (a draft) but NO sessionSummaries
    // row yet — content lives only in memory, not in the sidebar list.
    store.getState().setDraftForSession(currentId, 'important unsaved note');
    expect(store.getState().sessionSummaries.some((s) => s.id === currentId)).toBe(false);

    // Soft-delete (trash) the current session.
    store.getState().softDeleteSession(currentId);

    // F2: a present-with-deletedAt Trash row must now exist in renderer state.
    const trashRow = store.getState().sessionSummaries.find((s) => s.id === currentId);
    expect(trashRow).toBeDefined();
    expect(trashRow?.deletedAt).toBeTruthy();
    // The disk row was persisted with deletedAt (survives restart).
    expect(window.sessionsApi.upsert).toHaveBeenCalled();

    // Now a disk→store reconcile runs. The id is tombstoned, so the incoming
    // disk copy is filtered — the reattach path must keep the existing Trash
    // row. Simulate the reload carrying the (filtered) disk row.
    store.getState().setSessionSummaries([
      summary({ id: currentId, title: 'note', deletedAt: 1_700_000_050_000 }),
    ]);

    const afterReload = store.getState().sessionSummaries.find((s) => s.id === currentId);
    expect(afterReload).toBeDefined();
    expect(afterReload?.deletedAt).toBeTruthy();
  });

  it('Trash row survives a reload that no longer carries the row (reattach path)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_060_000);

    const store = createSessionStore();
    const currentId = store.getState().currentSessionId;

    store.getState().setDraftForSession(currentId, 'another note');
    store.getState().softDeleteSession(currentId);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === currentId)?.deletedAt,
    ).toBeTruthy();

    // Reload arrives with the row absent (e.g. captured before the soft delete
    // wrote it, or a list that simply omits it). The reattach path must keep
    // the legitimately soft-deleted row from being LOST.
    store.getState().setSessionSummaries([]);

    const after = store.getState().sessionSummaries.find((s) => s.id === currentId);
    expect(after).toBeDefined();
    expect(after?.deletedAt).toBeTruthy();
  });
});
