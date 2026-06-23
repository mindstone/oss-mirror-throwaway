// @vitest-environment happy-dom
/**
 * Stage 1 of docs/plans/260611_fix-cache-hit-nav-race/PLAN.md —
 * RED tests for the cache-hit stale-apply navigation race in
 * `openHistorySession` plus its loading-state defects.
 *
 * Bug mechanism (Chief-verified): a cache-MISS open bumps the module-level
 * `sessionLoadRequestCounter` and re-checks it after the IPC await, but a
 * cache-HIT open applies the store switch synchronously WITHOUT bumping the
 * counter. So: open B (miss, IPC in flight) → open D (hit, applies) → B's
 * continuation passes the stale-counter check and applies → the user ends on
 * B although they last clicked D.
 *
 * Test groups:
 * - RED A–D are EXPECTED TO FAIL on pre-fix code — each failure demonstrates
 *   one defect (wrong-session apply; non-engine-door apply; stale loading
 *   state surviving a superseding hit; catch stomping a newer load's loading
 *   state). Stage 2 turns them green.
 * - The preservation tests pass pre-fix AND must stay green post-fix — they
 *   pin miss-vs-miss supersession, plain opens, and the
 *   failed-opens-don't-supersede asymmetry (corrupted cache hit).
 *
 * Harness notes (mirrors the supersedePolicy sibling): renders the real
 * engine hook against the real `useSessionStore`, with `window.sessionsApi`
 * mocked. IPC `sessions:get` is controlled per session id via manually
 * resolvable deferred promises so the race interleavings are deterministic.
 *
 * IMPORTANT: assertions cover externally visible state only (store
 * `currentSessionId` / `loadingSessionId`, open return values) — NEVER the
 * module-level request counter, which leaks across tests in this file. Every
 * test uses its own unique session ids so leaked counter/cache state from a
 * prior test cannot mask a red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentSession } from '@shared/types';
import { useAgentSessionEngine, type AgentSessionEngineApi } from '../useAgentSessionEngine';
import {
  clearCurrentSessionEvents,
  useSessionStore,
} from '../../store/sessionStore';

vi.mock('@renderer/contexts', () => ({
  useEmitLog: vi.fn(() => vi.fn()),
  useRecordBreadcrumb: vi.fn(() => vi.fn()),
}));

vi.mock('@renderer/src/sentry', () => ({
  captureRendererException: vi.fn(),
  captureRendererMessage: vi.fn(),
}));

const engineRef: { current: AgentSessionEngineApi | null } = { current: null };
const showToastMock = vi.fn();

function TestHarness() {
  engineRef.current = useAgentSessionEngine({
    emitLog: vi.fn(),
    recordBreadcrumb: vi.fn(),
    showToast: showToastMock,
  });
  return null;
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Per-session-id deferred control over `window.sessionsApi.get`.
 * FIFO queue per id so duplicate same-session opens get DISTINCT deferreds
 * (request-scoped ownership tests need to settle them independently).
 * Ids with an empty/no queue resolve to null immediately (covers the
 * cache-hit path's background full-fidelity disk fetch, which we don't drive).
 */
const ipcGetDeferreds = new Map<string, Deferred<AgentSession | null>[]>();

function deferIpcGet(sessionId: string): Deferred<AgentSession | null> {
  const deferred = createDeferred<AgentSession | null>();
  const queue = ipcGetDeferreds.get(sessionId) ?? [];
  queue.push(deferred);
  ipcGetDeferreds.set(sessionId, queue);
  return deferred;
}

const makeSession = (id: string, overrides: Partial<AgentSession> = {}): AgentSession => ({
  id,
  title: `Session ${id}`,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  messages: [],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: null,
  doneAt: null,
  origin: 'manual',
  ...overrides,
});

/** Seed the store's LRU cache so opening `id` is a cache HIT. */
function seedCachedSession(id: string, overrides: Partial<AgentSession> = {}): void {
  act(() => {
    useSessionStore.getState().cacheSession({
      ...makeSession(id, overrides),
      runtime: {
        startedAt: null,
        lastActivityAt: null,
        activeTurnId: null,
        terminated: false,
      },
    });
  });
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  ipcGetDeferreds.clear();
  // @ts-expect-error - test env flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  vi.stubGlobal('sessionsApi', {
    get: vi.fn(
      ({ id }: { id: string }) => ipcGetDeferreds.get(id)?.shift()?.promise ?? Promise.resolve(null),
    ),
    upsert: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    applyTurnEventUnion: vi.fn().mockResolvedValue({ success: true }),
  });

  vi.stubGlobal('api', {
    onAgentEvent: vi.fn(() => () => {}),
    onSessionTitleGenerated: vi.fn(() => () => {}),
    onSessionActivitySummaryGenerated: vi.fn(() => () => {}),
    onSafetyEvaluating: vi.fn(() => () => {}),
    onSafetyEvaluated: vi.fn(() => () => {}),
    onSafetyEvaluatingComplete: vi.fn(() => () => {}),
  });

  vi.stubGlobal('agentApi', {
    onSessionTitleGenerated: vi.fn(() => () => {}),
    stopTurn: vi.fn().mockResolvedValue({ success: true }),
    turn: vi.fn().mockResolvedValue({ turnId: 'default-turn' }),
    evaluateDoneSafety: vi.fn().mockResolvedValue({ safeToMarkDone: false, reason: 'test' }),
    deleteCachedAttachments: vi.fn().mockResolvedValue({ success: true }),
  });

  act(() => {
    clearCurrentSessionEvents();
    useSessionStore.getState().resetSession();
    useSessionStore.getState().clearAllPendingTurns();
    useSessionStore.getState().setLoadingSession(null);
  });

  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
  }
  container = null;
  root = null;
  engineRef.current = null;
  ipcGetDeferreds.clear();
  clearCurrentSessionEvents();
});

async function mountHarness(): Promise<void> {
  await act(async () => {
    root!.render(createElement(TestHarness));
  });
  expect(engineRef.current).not.toBeNull();
}

/**
 * Start a cache-MISS open whose IPC `sessions:get` stays pending until the
 * test resolves/rejects the returned deferred. The synchronous prefix of
 * `openHistorySession` (counter bump, setLoadingSession) runs inside `act`;
 * the continuation runs when the deferred settles (drive it inside an async
 * `act`).
 */
function startPendingMissOpen(sessionId: string): {
  deferred: Deferred<AgentSession | null>;
  openPromise: Promise<boolean>;
} {
  const deferred = deferIpcGet(sessionId);
  let openPromise!: Promise<boolean>;
  act(() => {
    openPromise = engineRef.current!.openHistorySession(sessionId);
  });
  return { deferred, openPromise };
}

describe('useAgentSessionEngine — openHistorySession load race', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // RED tests — expected to FAIL pre-fix; each failure demonstrates a defect.
  // ─────────────────────────────────────────────────────────────────────────

  it('RED A: a cache-hit open supersedes an in-flight cache-miss load (last click wins)', async () => {
    await mountHarness();
    const missId = 'race-a-miss-b';
    const hitId = 'race-a-hit-d';
    seedCachedSession(hitId);

    // Open B — cache miss, IPC left pending.
    const { deferred, openPromise } = startPendingMissOpen(missId);

    // Open D — cache hit, applies synchronously. This is the user's LAST click.
    let hitResult: boolean | undefined;
    await act(async () => {
      hitResult = await engineRef.current!.openHistorySession(hitId);
    });
    expect(hitResult).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(hitId);

    // Now B's IPC resolves late.
    let missResult: boolean | undefined;
    await act(async () => {
      deferred.resolve(makeSession(missId));
      missResult = await openPromise;
    });

    // Last click (D, the cache hit) must win. Pre-fix: B's continuation
    // passes the stale-counter check (the hit never bumped it) and applies,
    // leaving the user on B.
    expect(useSessionStore.getState().currentSessionId).toBe(hitId);
    expect(missResult).toBe(false);
  });

  it('RED B: a store-level session switch outside the engine (resetSession / New Chat) supersedes an in-flight miss load', async () => {
    await mountHarness();
    const missId = 'race-b-miss';

    // Open B — cache miss, IPC left pending.
    const { deferred, openPromise } = startPendingMissOpen(missId);

    // Switch session OUTSIDE the engine: the store action App's New Chat
    // path bottoms out in (engine resetSessionState → store.resetSession).
    let newChatId!: string;
    act(() => {
      newChatId = useSessionStore.getState().resetSession();
    });
    expect(useSessionStore.getState().currentSessionId).toBe(newChatId);

    // B's IPC resolves late.
    let missResult: boolean | undefined;
    await act(async () => {
      deferred.resolve(makeSession(missId));
      missResult = await openPromise;
    });

    // The new chat was the user's last navigation — B must not apply over it.
    // Pre-fix: resetSession doesn't participate in the counter protocol, so
    // B's continuation applies and yanks the user off their new chat.
    expect(useSessionStore.getState().currentSessionId).toBe(newChatId);
    expect(missResult).toBe(false);
  });

  it('RED C: a superseding cache-hit open clears the in-flight loading state immediately', async () => {
    await mountHarness();
    const missId = 'race-c-miss-b';
    const hitId = 'race-c-hit-d';
    seedCachedSession(hitId);

    // Open B — cache miss, IPC left pending. Sanity: loading state is B's.
    const { deferred, openPromise } = startPendingMissOpen(missId);
    expect(useSessionStore.getState().loadingSessionId).toBe(missId);

    // Open D — cache hit, applies synchronously.
    let hitResult: boolean | undefined;
    await act(async () => {
      hitResult = await engineRef.current!.openHistorySession(hitId);
    });
    expect(hitResult).toBe(true);

    // IMMEDIATELY — B's IPC is still pending. The applied hit must have
    // cleared the superseded load's spinner state. Pre-fix the hit path
    // never touches loading state, so `loadingSessionId` stays stuck on B
    // for as long as B's IPC hangs (potentially forever).
    expect(useSessionStore.getState().currentSessionId).toBe(hitId);
    expect(useSessionStore.getState().loadingSessionId).toBeNull();

    // Settle the dangling load for clean teardown.
    await act(async () => {
      deferred.resolve(null);
      await openPromise;
    });
  });

  it("RED D: a stale load's IPC failure must not stomp a newer load's loading state", async () => {
    await mountHarness();
    const missB = 'race-d-miss-b';
    const missC = 'race-d-miss-c';

    // Open B then C — both cache misses, both IPC pending. C's bump
    // supersedes B; loading state now belongs to C.
    const pendingB = startPendingMissOpen(missB);
    const pendingC = startPendingMissOpen(missC);
    expect(useSessionStore.getState().loadingSessionId).toBe(missC);

    // B's IPC REJECTS while C is still loading.
    let bResult: boolean | undefined;
    await act(async () => {
      pendingB.deferred.reject(new Error('IPC failure for stale load'));
      bResult = await pendingB.openPromise;
    });
    expect(bResult).toBe(false);

    // C's load is still in flight — its loading state must survive B's
    // failure. Pre-fix: B's catch calls setLoadingSession(null)
    // unconditionally, stomping C's spinner to null.
    expect(useSessionStore.getState().loadingSessionId).toBe(missC);

    // Settle C for clean teardown (and confirm it still applies).
    let cResult: boolean | undefined;
    await act(async () => {
      pendingC.deferred.resolve(makeSession(missC));
      cResult = await pendingC.openPromise;
    });
    expect(cResult).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(missC);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Request-scoped loading ownership (stage-2 review F1): rapid DUPLICATE
  // opens of the SAME session create distinct requests sharing one
  // loadingSessionId. The stale request must not clear the newer request's
  // loading state — neither on stale-resolve nor on reject.
  // ─────────────────────────────────────────────────────────────────────────

  it('ownership: a duplicate same-session stale load resolving does not clear the newer request loading state', async () => {
    await mountHarness();
    const missId = 'own-dup-resolve';

    const first = startPendingMissOpen(missId);
    const second = startPendingMissOpen(missId);
    expect(useSessionStore.getState().loadingSessionId).toBe(missId);

    // The FIRST (stale) request resolves; the second is still in flight.
    let firstResult: boolean | undefined;
    await act(async () => {
      first.deferred.resolve(makeSession(missId));
      firstResult = await first.openPromise;
    });
    expect(firstResult).toBe(false);

    // Loading state belongs to request #2 — it must survive #1's abort.
    expect(useSessionStore.getState().loadingSessionId).toBe(missId);

    // Request #2 completes normally and applies.
    let secondResult: boolean | undefined;
    await act(async () => {
      second.deferred.resolve(makeSession(missId));
      secondResult = await second.openPromise;
    });
    expect(secondResult).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(missId);
    expect(useSessionStore.getState().loadingSessionId).toBeNull();
  });

  it('ownership: a duplicate same-session stale load REJECTING does not clear the newer request loading state', async () => {
    await mountHarness();
    const missId = 'own-dup-reject';

    const first = startPendingMissOpen(missId);
    const second = startPendingMissOpen(missId);
    expect(useSessionStore.getState().loadingSessionId).toBe(missId);

    let firstResult: boolean | undefined;
    await act(async () => {
      first.deferred.reject(new Error('stale duplicate load failed'));
      firstResult = await first.openPromise;
    });
    expect(firstResult).toBe(false);

    // Pre-refinement: #1's catch cleared loading whenever it pointed at the
    // same session id — stomping #2's state. Request-scoped ownership keeps it.
    expect(useSessionStore.getState().loadingSessionId).toBe(missId);

    let secondResult: boolean | undefined;
    await act(async () => {
      second.deferred.resolve(makeSession(missId));
      secondResult = await second.openPromise;
    });
    expect(secondResult).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(missId);
    expect(useSessionStore.getState().loadingSessionId).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Preservation tests — green pre-fix AND post-fix; pin behavior the fix
  // must not break.
  // ─────────────────────────────────────────────────────────────────────────

  it('preservation: miss-vs-miss race — the newer miss wins, the older is aborted', async () => {
    await mountHarness();
    const missB = 'pres-mm-b';
    const missC = 'pres-mm-c';

    const pendingB = startPendingMissOpen(missB);
    const pendingC = startPendingMissOpen(missC);

    // Resolve in request order: B (stale) first, then C (newest).
    let bResult: boolean | undefined;
    await act(async () => {
      pendingB.deferred.resolve(makeSession(missB));
      bResult = await pendingB.openPromise;
    });
    let cResult: boolean | undefined;
    await act(async () => {
      pendingC.deferred.resolve(makeSession(missC));
      cResult = await pendingC.openPromise;
    });

    expect(bResult).toBe(false);
    expect(cResult).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(missC);
    expect(useSessionStore.getState().loadingSessionId).toBeNull();
  });

  it('preservation: a plain single cache-hit open applies', async () => {
    await mountHarness();
    const hitId = 'pres-single-hit';
    seedCachedSession(hitId);

    let result: boolean | undefined;
    await act(async () => {
      result = await engineRef.current!.openHistorySession(hitId);
    });

    expect(result).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(hitId);
    expect(useSessionStore.getState().loadingSessionId).toBeNull();
  });

  it('preservation: a plain single cache-miss open loads via IPC and applies', async () => {
    await mountHarness();
    const missId = 'pres-single-miss';

    const { deferred, openPromise } = startPendingMissOpen(missId);
    expect(useSessionStore.getState().loadingSessionId).toBe(missId);

    let result: boolean | undefined;
    await act(async () => {
      deferred.resolve(makeSession(missId));
      result = await openPromise;
    });

    expect(result).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(missId);
    expect(useSessionStore.getState().loadingSessionId).toBeNull();
  });

  it('preservation (ABA): a back-to-origin cache-hit open supersedes an in-flight miss (apply bump, not origin guard)', async () => {
    // Stage 2 addition: pins the counter-bump-at-apply mechanism
    // INDEPENDENTLY of the captured-origin guard. Interleaving: current is A
    // → open B (miss, pending; captured origin = A) → re-open A (cache hit,
    // applies; currentSessionId stays A). B's origin check then passes
    // (current === origin === A — the ABA hole the DA flagged), so ONLY the
    // apply-site counter bump can abort B. Without it B applies over the
    // user's last click (A).
    await mountHarness();
    const hitA = 'pres-aba-hit-a';
    const missB = 'pres-aba-miss-b';
    seedCachedSession(hitA);

    // Establish A as the current session (plain cache-hit open).
    await act(async () => {
      await engineRef.current!.openHistorySession(hitA);
    });
    expect(useSessionStore.getState().currentSessionId).toBe(hitA);

    // Open B — cache miss, IPC pending; origin captured as A.
    const { deferred, openPromise } = startPendingMissOpen(missB);

    // Re-open A — cache hit, applies; current returns to (stays) A.
    let hitResult: boolean | undefined;
    await act(async () => {
      hitResult = await engineRef.current!.openHistorySession(hitA);
    });
    expect(hitResult).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(hitA);

    // B resolves late — it must NOT apply over the user's last click (A).
    let missResult: boolean | undefined;
    await act(async () => {
      deferred.resolve(makeSession(missB));
      missResult = await openPromise;
    });
    expect(missResult).toBe(false);
    expect(useSessionStore.getState().currentSessionId).toBe(hitA);
  });

  it('preservation: a corrupted cache-hit open (fails pre-apply) does NOT supersede a pending miss', async () => {
    await mountHarness();
    const missId = 'pres-corrupt-miss-b';
    const corruptedId = 'pres-corrupt-x';
    seedCachedSession(corruptedId, { isCorrupted: true });

    // Open B — cache miss, IPC pending.
    const { deferred, openPromise } = startPendingMissOpen(missId);

    // Open corrupted X — cache hit, but returns false BEFORE the store apply.
    // Failed opens must NOT supersede in-flight loads (the asymmetry with
    // applies-supersede semantics, pinned here per the plan's Assumption #5).
    let corruptedResult: boolean | undefined;
    await act(async () => {
      corruptedResult = await engineRef.current!.openHistorySession(corruptedId);
    });
    expect(corruptedResult).toBe(false);

    // B's load completes and must still apply.
    let missResult: boolean | undefined;
    await act(async () => {
      deferred.resolve(makeSession(missId));
      missResult = await openPromise;
    });
    expect(missResult).toBe(true);
    expect(useSessionStore.getState().currentSessionId).toBe(missId);
  });
});
