import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../sessionStore';

/**
 * Stage 6 of docs/plans/260501_composer_tiptap_atmention_bugfix.md.
 *
 * Tests for the new `upsertDraftDurable` action — the atomic compare-and-swap
 * upsert with awaited durable-persist acknowledgement used by the
 * localStorage→store migration in `useDraftPersistence.ts`.
 *
 * Contract:
 *   - `{ ok: true }` after the in-memory write is observable to subsequent
 *     `getState()` reads (post next-tick).
 *   - `{ ok: false, reason: 'concurrent_write' }` when `expectedCurrent` is
 *     provided and doesn't match the live store value (CAS rejection — store
 *     state stays unchanged).
 *   - `{ ok: false, reason: 'timeout' }` when the next-tick scheduler can't
 *     fire within 5s.
 *   - In-memory write is observable IMMEDIATELY after the synchronous Zustand
 *     `set()` call inside the action — before the awaited resolution.
 */

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
  vi.unstubAllGlobals();
});

describe('sessionStore.upsertDraftDurable', () => {
  it('returns { ok: true } and writes the draft when no expectedCurrent is provided', async () => {
    const store = createSessionStore();
    const sessionId = 'session-A';

    const result = await store.getState().upsertDraftDurable(sessionId, 'hello');

    expect(result).toEqual({ ok: true });
    const draft = store.getState().draftsBySessionId[sessionId];
    expect(draft?.text).toBe('hello');
    expect(typeof draft?.updatedAt).toBe('number');
  });

  it('returns { ok: true } when expectedCurrent matches the existing draft text', async () => {
    const store = createSessionStore();
    const sessionId = 'session-A';

    // Seed an existing draft via the normal write path.
    store.getState().setDraftForSession(sessionId, 'old');

    const result = await store
      .getState()
      .upsertDraftDurable(sessionId, 'new', 'old');

    expect(result).toEqual({ ok: true });
    expect(store.getState().draftsBySessionId[sessionId]?.text).toBe('new');
  });

  it('returns { ok: false, reason: "concurrent_write" } when expectedCurrent does not match', async () => {
    const store = createSessionStore();
    const sessionId = 'session-A';

    // Seed live store with text the migration was NOT expecting.
    store.getState().setDraftForSession(sessionId, 'user-typed-this');

    // Migration thought the current was empty, but the user already typed.
    const result = await store
      .getState()
      .upsertDraftDurable(sessionId, 'migration-cleaned', '');

    expect(result).toEqual({ ok: false, reason: 'concurrent_write' });
    // CAS rejection leaves the user's text untouched.
    expect(store.getState().draftsBySessionId[sessionId]?.text).toBe(
      'user-typed-this',
    );
  });

  it('makes the in-memory write observable IMMEDIATELY after set() — before await resolves', async () => {
    const store = createSessionStore();
    const sessionId = 'session-A';

    // Kick off the action without awaiting; the synchronous `set()` callback
    // fires inside the action body before the first `await`, so the next
    // store read should see the new draft text.
    const promise = store.getState().upsertDraftDurable(sessionId, 'fresh');
    const drafted = store.getState().draftsBySessionId[sessionId];
    expect(drafted?.text).toBe('fresh');
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('returns { ok: false, reason: "timeout" } when the next-tick scheduler cannot fire within 5s', async () => {
    vi.useFakeTimers();
    const store = createSessionStore();
    const sessionId = 'session-A';

    // Action's set() runs synchronously; the awaited Promise.race then queues
    // a setTimeout(0) winner and a setTimeout(5000) timeout. Advancing fake
    // timers past 5000ms WITHOUT firing the 0-tick winner exercises the
    // timeout path. We do this by stubbing setTimeout so the 0-delay handler
    // never fires, while the 5000-delay handler still does.
    const realSetTimeout = globalThis.setTimeout;
    type SetTimeoutFn = typeof globalThis.setTimeout;
    const stubbed = vi.fn((fn: () => void, ms?: number) => {
      // Ignore the 0-tick resolver so only the timeout fires.
      if (ms === 0) return 0 as unknown as ReturnType<typeof realSetTimeout>;
      return realSetTimeout(fn, ms);
    }) as unknown as SetTimeoutFn;
    vi.stubGlobal('setTimeout', stubbed);

    try {
      const promise = store.getState().upsertDraftDurable(sessionId, 'hello');
      // Fast-forward past the 5s rejection.
      await vi.advanceTimersByTimeAsync(5001);
      const result = await promise;
      expect(result).toEqual({ ok: false, reason: 'timeout' });
      // The in-memory write still landed before the timeout (set() is sync).
      expect(store.getState().draftsBySessionId[sessionId]?.text).toBe('hello');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
