import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession, AgentSessionSummary } from '@shared/types';
import { createSessionStore } from '../sessionStore';

// ---------------------------------------------------------------------------
// Delete-wins behavioral contract for the summary producers NOT covered by
// sessionStore.resurrectionGuard.test.ts (postmortem
// 260607_tombstone_ledger_f1_f2_block_renderer, rec 0244e406e12a79d3).
//
// resurrectionGuard pins: updateSessionSummary, addOrUpdateHistorySession,
// setSessionSummaries (disk reconcile), restoreSession, F1 e2e-clear, F2 Trash
// synthesis. This suite extends the same contract — "stale producer work that
// lands AFTER a removal must not re-create or un-delete the id, and only an
// explicit restore re-admits it" — to the remaining producers:
//   - ingestExternalSessions (cloud/automation ingest)
//   - emptyTrash (permanent delete) followed by a stale save
//   - addReceiptMessageToSession (approval receipt; this was the last
//     add-if-missing producer that bypassed the ledger before the
//     delete-authority classifier closed it)
//
// The ledger is MODULE-scoped, so every test uses UNIQUE session ids.
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
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const summary = (
  overrides: Partial<AgentSessionSummary> = {},
): AgentSessionSummary => ({
  id: 'producer-test',
  title: 'producer test',
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

const externalSession = (overrides: Partial<AgentSession> = {}): AgentSession => ({
  id: 'producer-external',
  title: 'external',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_999_000,
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: 1_700_000_999_000,
  doneAt: null,
  starredAt: null,
  deletedAt: null,
  origin: 'automation',
  ...overrides,
});

describe('ingestExternalSessions — delete-wins', () => {
  it('cannot re-create a hard-removed session id', () => {
    const store = createSessionStore();
    const id = 'producer-ingest-hard-removed';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().removeHistorySession(id);
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);

    // A cloud/automation ingest that snapshotted before the delete lands late
    // carrying a fully-formed, NEWER session — it must not re-enter.
    store.getState().ingestExternalSessions([externalSession({ id })]);
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);
  });

  it('cannot un-delete a soft-deleted (trashed) session', () => {
    const store = createSessionStore();
    const id = 'producer-ingest-undelete';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().softDeleteSession(id);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt,
    ).toBeTruthy();

    // Stale live ingest copy (deletedAt: null, newer updatedAt) would normally
    // replace the existing row — the delete authority must reject it.
    store.getState().ingestExternalSessions([
      externalSession({ id, deletedAt: null, updatedAt: Date.now() + 60_000 }),
    ]);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt,
    ).toBeTruthy();
  });

  it('explicit restore re-admits ingest for the id', () => {
    const store = createSessionStore();
    const id = 'producer-ingest-restored';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().softDeleteSession(id);
    store.getState().restoreSession(id);

    store.getState().ingestExternalSessions([
      externalSession({ id, title: 'ingested after restore', updatedAt: Date.now() + 60_000 }),
    ]);
    const row = store.getState().sessionSummaries.find((s) => s.id === id);
    expect(row?.title).toBe('ingested after restore');
    expect(row?.deletedAt ?? null).toBeNull();
  });

  it('still ingests a genuinely-new background session normally (no false block)', () => {
    const store = createSessionStore();
    const removedId = 'producer-ingest-other-removed';
    const freshId = 'producer-ingest-fresh';

    store.getState().setSessionSummaries([summary({ id: removedId })]);
    store.getState().removeHistorySession(removedId);

    store.getState().ingestExternalSessions([externalSession({ id: freshId })]);
    expect(store.getState().sessionSummaries.some((s) => s.id === freshId)).toBe(true);
  });
});

describe('emptyTrash — delete-wins', () => {
  it('a stale save landing after emptyTrash cannot re-create the purged id', () => {
    const store = createSessionStore();
    const id = 'producer-empty-trash';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().softDeleteSession(id);
    store.getState().emptyTrash();
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);

    // Stale producers landing after the purge: persistence save + ingest.
    store.getState().updateSessionSummary(summary({ id, title: 'STALE SAVE' }));
    store.getState().ingestExternalSessions([externalSession({ id })]);
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);
  });
});

describe('restart soundness — persisted Trash rows are authoritative without a ledger entry', () => {
  // After a renderer restart the module-scoped ledger is empty, but soft-
  // deleted rows persisted to disk re-enter state via setSessionSummaries()
  // with deletedAt set. The classifier's state-derived input (review F1,
  // round 2) must reject live producer writes over those rows — the exact
  // silent-un-delete-across-restart sequence.
  const trashRow = (id: string): ReturnType<typeof summary> =>
    summary({ id, title: 'trashed before restart', deletedAt: 1_700_000_050_000 });

  it('load Trash row → ingest stale live copy → rejected, row stays deleted', () => {
    const store = createSessionStore();
    const id = 'producer-restart-ingest';

    // Restart simulation: the Trash row arrives from disk; this renderer
    // lifetime never observed the soft delete (no ledger entry).
    store.getState().setSessionSummaries([trashRow(id)]);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt,
    ).toBeTruthy();

    // Stale live cloud/automation copy with a NEWER updatedAt would replace
    // the row (deletedAt: null) if classification trusted only the ledger.
    store.getState().ingestExternalSessions([
      externalSession({ id, deletedAt: null, updatedAt: Date.now() + 60_000 }),
    ]);
    const after = store.getState().sessionSummaries.find((s) => s.id === id);
    expect(after).toBeDefined();
    expect(after?.deletedAt).toBeTruthy();
  });

  it('load Trash row → stale live save (updateSessionSummary) → rejected', () => {
    const store = createSessionStore();
    const id = 'producer-restart-save';

    store.getState().setSessionSummaries([trashRow(id)]);
    store.getState().updateSessionSummary(summary({ id, title: 'STALE LIVE', deletedAt: null }));

    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt,
    ).toBeTruthy();
  });

  it('load Trash row → subsequent reload keeps it in Trash (reattach without ledger)', () => {
    const store = createSessionStore();
    const id = 'producer-restart-rereload';

    store.getState().setSessionSummaries([trashRow(id)]);
    // Second disk reload carries the same Trash row; its incoming copy is
    // state-derived-filtered, so the reattach path must keep the existing row
    // rather than dropping it from the Trash view.
    store.getState().setSessionSummaries([trashRow(id)]);

    const after = store.getState().sessionSummaries.find((s) => s.id === id);
    expect(after).toBeDefined();
    expect(after?.deletedAt).toBeTruthy();
  });

  it('explicit restore re-admits live writes for a restart-loaded Trash row', () => {
    const store = createSessionStore();
    const id = 'producer-restart-restore';

    store.getState().setSessionSummaries([trashRow(id)]);
    store.getState().restoreSession(id);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt ?? null,
    ).toBeNull();

    store.getState().ingestExternalSessions([
      externalSession({ id, title: 'live after restore', updatedAt: Date.now() + 60_000 }),
    ]);
    const after = store.getState().sessionSummaries.find((s) => s.id === id);
    expect(after?.title).toBe('live after restore');
    expect(after?.deletedAt ?? null).toBeNull();
  });
});

describe('addReceiptMessageToSession — delete-wins (former ledger bypass)', () => {
  it('refuses to re-create a hard-removed session from a stale disk read', async () => {
    const store = createSessionStore();
    const id = 'producer-receipt-hard-removed';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().removeHistorySession(id);

    // Simulate an in-flight disk read that snapshotted the session before the
    // delete: sessionsApi.get still resolves the full (stale) session.
    (window.sessionsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      externalSession({ id }),
    );
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockClear();

    const delivered = await store.getState().addReceiptMessageToSession(id, 'Approved ✔');

    expect(delivered).toBe(false);
    // No summary row resurrected…
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(false);
    // …and the stale session was NOT rewritten to disk.
    expect(window.sessionsApi.upsert).not.toHaveBeenCalled();
  });

  it('refuses to touch a soft-deleted (trashed) session', async () => {
    const store = createSessionStore();
    const id = 'producer-receipt-trashed';

    store.getState().setSessionSummaries([summary({ id })]);
    store.getState().softDeleteSession(id);

    (window.sessionsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      externalSession({ id, deletedAt: null }),
    );
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockClear();

    const delivered = await store.getState().addReceiptMessageToSession(id, 'Approved ✔');

    expect(delivered).toBe(false);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt,
    ).toBeTruthy();
    expect(window.sessionsApi.upsert).not.toHaveBeenCalled();
  });

  it('delivers normally to a live (never-removed) session', async () => {
    const store = createSessionStore();
    const id = 'producer-receipt-live';

    store.getState().setSessionSummaries([summary({ id })]);
    (window.sessionsApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(
      externalSession({ id }),
    );

    const delivered = await store.getState().addReceiptMessageToSession(id, 'Approved ✔');

    expect(delivered).toBe(true);
    expect(store.getState().sessionSummaries.some((s) => s.id === id)).toBe(true);
    expect(window.sessionsApi.upsert).toHaveBeenCalled();
  });

  it('TOCTOU: a delete landing while the session load is in flight still wins', async () => {
    const store = createSessionStore();
    const id = 'producer-receipt-toctou';

    store.getState().setSessionSummaries([summary({ id })]);

    // Hold sessionsApi.get unresolved so the receipt's async load is pending
    // when the delete lands. (Queue resolvers: softDeleteSession's metadata
    // persist also calls get; only the FIRST call belongs to the receipt.)
    const resolvers: Array<(value: unknown) => void> = [];
    (window.sessionsApi.get as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }),
    );

    // 1. Start the receipt — it awaits the (held) session load.
    const pending = store.getState().addReceiptMessageToSession(id, 'Approved ✔');
    expect(resolvers.length).toBe(1);

    // 2. The user soft-deletes the target while the load is in flight.
    store.getState().softDeleteSession(id);
    (window.sessionsApi.upsert as ReturnType<typeof vi.fn>).mockClear();

    // 3. The load resolves with the STALE (live) session. Classification runs
    //    after this await, so the delete recorded in step 2 must win.
    resolvers[0](externalSession({ id, deletedAt: null }));
    const delivered = await pending;

    expect(delivered).toBe(false);
    expect(
      store.getState().sessionSummaries.find((s) => s.id === id)?.deletedAt,
    ).toBeTruthy();
    expect(window.sessionsApi.upsert).not.toHaveBeenCalled();
  });
});
