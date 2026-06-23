import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '@shared/types';
import type { AgentSessionSummary } from '@shared/ipc/schemas/sessions';
import { isSessionActive } from '@rebel/shared';
import { createSessionStore } from '../sessionStore';

/**
 * Lifecycle/star writer regression tests after the CONTRACT stage removed
 * `pinnedAt`. `doneAt` is now the single source of truth:
 *   Active = doneAt: null
 *   Done   = doneAt: <ts>
 * Writers must keep `doneAt` consistent on toggle/reopen/star cross-effects;
 * a stale `doneAt` on a reopened conversation could cause it to read as Done
 * (and be evicted) on core/cloud readers.
 *
 * Originally the Stage-2 F1 dual-write regression suite; rewritten for Stage 7.
 * See docs/plans/260614_done-state-rename/PLAN.md.
 */

const flushMicrotasks = async (ticks = 6): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
};

let upsertMock: ReturnType<typeof vi.fn>;
let getMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  upsertMock = vi.fn().mockResolvedValue({ success: true });
  getMock = vi.fn().mockResolvedValue(null);
  vi.stubGlobal('window', {
    sessionsApi: {
      get: getMock,
      upsert: upsertMock,
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

let counter = 0;
const summary = (
  overrides: Partial<AgentSessionSummary> = {},
): AgentSessionSummary => ({
  id: `sess-dualwrite-${counter++}`,
  title: 'dual-write test',
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

/**
 * Full session shape as it would arrive from disk. `doneAt` is the single
 * lifecycle source of truth; reopen must clear it.
 */
const fullSession = (overrides: Partial<AgentSession>): AgentSession =>
  ({
    id: 'unused',
    title: 'lifecycle full session',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    doneAt: null,
    starredAt: null,
    deletedAt: null,
    origin: 'manual',
    ...overrides,
  }) as AgentSession;

const lastUpsertPayload = (): AgentSession => {
  expect(upsertMock).toHaveBeenCalled();
  const calls = upsertMock.mock.calls;
  return calls[calls.length - 1]![0] as AgentSession;
};

describe('sessionStore lifecycle/star writers (Stage 7 — doneAt single source)', () => {
  it('togglePinSession reopen of a Done session clears doneAt', async () => {
    const store = createSessionStore();
    const id = 'reopen-done';
    const oldDoneTs = 1_600_000_000_000;

    // Non-current Done history session (doneAt set). Reopening it must produce
    // a consistent Active row: doneAt:null.
    store.getState().setSessionSummaries([
      summary({ id, doneAt: oldDoneTs }),
    ]);
    getMock.mockResolvedValueOnce(fullSession({ id, doneAt: oldDoneTs }));

    store.getState().togglePinSession(id);

    // Synchronous summary state is consistent immediately.
    const row = store.getState().sessionSummaries.find((s) => s.id === id)!;
    expect(row.doneAt).toBeNull();

    // Async persisted payload is consistent.
    await flushMicrotasks();
    const persisted = lastUpsertPayload();
    expect(persisted.doneAt).toBeNull();
  });

  it('togglePinSession marking an Active non-current session Done sets doneAt', async () => {
    const store = createSessionStore();
    const id = 'mark-active-done';

    // Active non-current session (doneAt null). Marking it Done must produce a
    // consistent Done row: doneAt:<ts>.
    store.getState().setSessionSummaries([
      summary({ id, doneAt: null }),
    ]);
    getMock.mockResolvedValueOnce(fullSession({ id, doneAt: null }));

    store.getState().togglePinSession(id);

    const row = store.getState().sessionSummaries.find((s) => s.id === id)!;
    expect(row.doneAt).not.toBeNull();

    await flushMicrotasks();
    const persisted = lastUpsertPayload();
    expect(persisted.doneAt).not.toBeNull();
  });

  it('toggleStarSession starring a Done session reopens it and clears doneAt', async () => {
    const store = createSessionStore();
    const id = 'star-reopen-done';
    const oldDoneTs = 1_600_000_000_000;

    // Done, unstarred history session. Starring reopens it (existing
    // cross-effect) and must clear doneAt for consistency.
    store.getState().setSessionSummaries([
      summary({ id, doneAt: oldDoneTs, starredAt: null }),
    ]);
    getMock.mockResolvedValueOnce(
      fullSession({ id, doneAt: oldDoneTs, starredAt: null }),
    );

    store.getState().toggleStarSession(id);

    const row = store.getState().sessionSummaries.find((s) => s.id === id)!;
    expect(row.starredAt).not.toBeNull();
    expect(row.doneAt).toBeNull(); // reopened

    await flushMicrotasks();
    const persisted = lastUpsertPayload();
    expect(persisted.starredAt).not.toBeNull();
    expect(persisted.doneAt).toBeNull();
  });

  it('toggleStarSession starring a Done background session keeps doneAt set', async () => {
    const store = createSessionStore();
    const id = 'automation-source-capture--star-background-done';
    const oldDoneTs = 1_600_000_000_000;

    store.getState().setSessionSummaries([
      summary({ id, doneAt: oldDoneTs, starredAt: null, origin: 'automation' }),
    ]);
    getMock.mockResolvedValueOnce(
      fullSession({ id, doneAt: oldDoneTs, starredAt: null, origin: 'automation' }),
    );

    store.getState().toggleStarSession(id);

    const row = store.getState().sessionSummaries.find((s) => s.id === id)!;
    expect(row.starredAt).not.toBeNull();
    expect(row.doneAt).toBe(oldDoneTs);

    await flushMicrotasks();
    const persisted = lastUpsertPayload();
    expect(persisted.starredAt).not.toBeNull();
    expect(persisted.doneAt).toBe(oldDoneTs);
  });

  it('toggleStarSession on an already-Active session leaves doneAt unchanged (null)', async () => {
    const store = createSessionStore();
    const id = 'star-active';

    // Active session: starring should NOT touch lifecycle; doneAt stays null.
    store.getState().setSessionSummaries([
      summary({ id, doneAt: null, starredAt: null }),
    ]);
    getMock.mockResolvedValueOnce(
      fullSession({ id, doneAt: null, starredAt: null }),
    );

    store.getState().toggleStarSession(id);

    const row = store.getState().sessionSummaries.find((s) => s.id === id)!;
    expect(row.starredAt).not.toBeNull();
    expect(row.doneAt).toBeNull();

    await flushMicrotasks();
    const persisted = lastUpsertPayload();
    expect(persisted.doneAt).toBeNull();
  });

  it('current-session snapshot sets doneAt on mark Done', () => {
    const store = createSessionStore();
    const id = store.getState().currentSessionId;

    // Current session is Active (doneAt null — the store default). Give it
    // content so the snapshot is non-null, then mark it Done and confirm the
    // snapshot's doneAt is set.
    store.setState({ currentSessionDoneAt: null });
    store.getState().addUserMessage('hello');

    store.getState().togglePinSession(id);

    expect(store.getState().currentSessionDoneAt).not.toBeNull();
    const snapshot = store.getState().snapshotCurrentSession();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.doneAt).not.toBeNull();
  });

  it('current-session: marking an Active starred session Done sets doneAt and removes the star', () => {
    const store = createSessionStore();
    const id = store.getState().currentSessionId;

    // Active + starred current session. Marking Done must set doneAt and clear
    // the star (existing cross-effect "marking done removes star").
    store.setState({
      currentSessionDoneAt: null,
      currentSessionStarredAt: 1_700_000_000_000,
    });

    store.getState().togglePinSession(id);

    expect(store.getState().currentSessionDoneAt).not.toBeNull();
    expect(store.getState().currentSessionStarredAt).toBeNull();
  });

  it('current-session: starring a Done session reopens it (doneAt cleared)', () => {
    const store = createSessionStore();
    const id = store.getState().currentSessionId;

    // Done current session (doneAt set). Starring must reopen it (doneAt → null)
    // via the existing "star reopens a Done conversation" cross-effect.
    store.setState({
      currentSessionDoneAt: 1_700_000_000_000,
      currentSessionStarredAt: null,
    });

    store.getState().toggleStarSession(id);

    expect(store.getState().currentSessionStarredAt).not.toBeNull();
    expect(store.getState().currentSessionDoneAt).toBeNull(); // reopened
  });

  it('current-session: starring a Done background session keeps doneAt set', () => {
    const store = createSessionStore();
    const id = 'automation-source-capture--current-background-done';
    const oldDoneTs = 1_700_000_000_000;

    store.setState({
      currentSessionId: id,
      currentSessionDoneAt: oldDoneTs,
      currentSessionStarredAt: null,
      sessionSummaries: [
        summary({ id, doneAt: oldDoneTs, starredAt: null, origin: 'automation' }),
      ],
    });

    store.getState().toggleStarSession(id);

    expect(store.getState().currentSessionStarredAt).not.toBeNull();
    expect(store.getState().currentSessionDoneAt).toBe(oldDoneTs);
    const row = store.getState().sessionSummaries.find((s) => s.id === id)!;
    expect(row.starredAt).not.toBeNull();
    expect(row.doneAt).toBe(oldDoneTs);
  });

  it('togglePinSession remains a generic lifecycle writer for background sessions', async () => {
    const store = createSessionStore();
    const id = 'automation-source-capture--generic-lifecycle';
    const oldDoneTs = 1_600_000_000_000;

    store.getState().setSessionSummaries([
      summary({ id, doneAt: oldDoneTs, starredAt: null, origin: 'automation' }),
    ]);
    getMock.mockResolvedValueOnce(
      fullSession({ id, doneAt: oldDoneTs, starredAt: null, origin: 'automation' }),
    );

    store.getState().togglePinSession(id);

    const row = store.getState().sessionSummaries.find((s) => s.id === id)!;
    expect(row.doneAt).toBeNull();
    expect(row.starredAt).toBeNull();

    await flushMicrotasks();
    const persisted = lastUpsertPayload();
    expect(persisted.doneAt).toBeNull();
  });
});

/**
 * Deferred from the Stage 3 review: the highest-visibility regression class.
 * If a newly created conversation were ever Done by default (currentSessionDoneAt
 * non-null), EVERY new conversation would appear in the Done tab instead of
 * Active. A single inverted default or a missed init flip would cause this, and
 * the compiler can't catch a polarity mistake — only a test can.
 * See docs/plans/260614_done-state-rename/PLAN.md (Stage 8).
 */
describe('sessionStore — a newly created conversation is Active', () => {
  it('the store default current session is Active (doneAt === null)', () => {
    const store = createSessionStore();
    expect(store.getState().currentSessionDoneAt).toBeNull();
    expect(
      isSessionActive({ doneAt: store.getState().currentSessionDoneAt }),
    ).toBe(true);
  });

  it('resetSession() produces an Active new conversation (doneAt === null)', () => {
    const store = createSessionStore();
    const firstId = store.getState().currentSessionId;

    // Sanity: even after marking the prior conversation Done, the freshly
    // created one must be Active.
    store.setState({ currentSessionDoneAt: 1_700_000_000_000 });

    store.getState().resetSession();

    expect(store.getState().currentSessionId).not.toBe(firstId);
    expect(store.getState().currentSessionDoneAt).toBeNull();
    expect(
      isSessionActive({ doneAt: store.getState().currentSessionDoneAt }),
    ).toBe(true);
  });
});
