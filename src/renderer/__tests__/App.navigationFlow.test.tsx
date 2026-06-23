// @vitest-environment happy-dom
/**
 * App.navigationFlow.test.tsx — Tier B partial-flow integration test
 * (navigation-first). See docs/plans/260529_apptsx-hardening/subagent_reports/
 *   260529_233000_arbitrator-scoping-synthesis.md  (section 3C — the plan)
 *   260529_230200_researcher-harness-feasibility-spike.md  (flow ranking)
 *
 * ── The recurring bug class this guards ──────────────────────────────────────
 * "A new opener bypasses the scroll/contract wrapper and calls the raw engine
 * `openHistorySession` directly" (PM 260416 / 260512 — thread jumps to the top
 * on session switch). App.tsx owns a wrapper, `executeOpenHistorySession`, which
 * MUST run the scroll-settling contract (`beginSwitchTiming` +
 * `markPendingHistoryScroll`) BEFORE it calls the raw engine
 * `openHistorySession`. The static `no-restricted-syntax` lint (Stage A) catches
 * a *new raw call site* at the AST level; this dynamic test catches the
 * complementary failure the lint cannot see — a user-facing opener that is wired
 * to a path which reaches the raw engine WITHOUT first going through the
 * contract.
 *
 * ── What this test asserts (and how) ─────────────────────────────────────────
 * It drives the real user-facing conversation-open path: the production
 * `SessionSurfaceContent` receives all session callbacks via `actionsRef`; the
 * one that opens a history session is `handleOpenHistorySession`. We mock
 * `SessionSurfaceContent` ONLY to capture that ref (so we can invoke the
 * App-owned opener exactly as a click would), and we instrument the two real
 * seams of the contract by wrapping the real hooks:
 *   - `markPendingHistoryScroll`  (from `useConversationAutoScroll`) — the
 *     scroll-settling contract entry point the wrapper calls first.
 *   - the raw engine `openHistorySession` (from `useAgentSessionEngine`) — the
 *     low-level opener the wrapper must call AFTER the contract.
 * Both real implementations are preserved; the wrappers only record call order
 * into a shared log. The test then asserts:
 *   (1) opening a history session calls `markPendingHistoryScroll` for that
 *       session, then calls the raw engine `openHistorySession` for that session
 *       — in that order. A future opener that bypasses the wrapper would call
 *       the raw engine without the preceding `markPendingHistoryScroll`, and
 *       this test FAILS.
 *
 * ── Coverage honesty (what is / is NOT covered) ──────────────────────────────
 * COVERED: the App-owned opener callback that `SessionSurfaceContent` invokes
 * routes through the wrapper, and the wrapper fires the scroll-settling contract
 * (`markPendingHistoryScroll`) for the target session BEFORE the raw engine open
 * for that same session. This is the exact invariant the 260416/260512 class
 * violated.
 * NOT COVERED (happy-dom limits / deferred per the synthesis): real scroll
 * position / virtualizer / layout settling behaviour; composer-submission
 * (`onCommit`) flow (deferred to a follow-up); other openers wired elsewhere in
 * the tree (sidebar DOM clicks, keyboard shortcuts) — we drive the canonical
 * App-owned callback the surface receives, not every DOM affordance. The lint in
 * Stage A is the static complement that covers raw call sites the AST can see.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { SessionSurfaceActions } from '@renderer/features/agent-session/components/SessionSurfaceContent';

// ── Shared, hoisted instrumentation ─────────────────────────────────────────
// vi.mock factories are hoisted above imports, so anything they reference must
// be created via vi.hoisted (also hoisted) rather than module-scope const.
const harness = vi.hoisted(() => {
  type CallEvent = { fn: 'markPendingHistoryScroll' | 'rawOpenHistorySession'; sessionId: string };
  return {
    // Ordered log of the two instrumented contract calls.
    callLog: [] as CallEvent[],
    // Captured live actionsRef from the mocked SessionSurfaceContent, so the
    // test can invoke the App-owned opener exactly as the surface would.
    capturedActionsRef: { current: null } as { current: RefObject<SessionSurfaceActions> | null },
    // Latest `isRevealMasked` App received from the real useConversationAutoScroll
    // on its most recent render. This is the exact value that drives BOTH
    // user-visible symptoms of a stuck mask: the settling skeleton overlay
    // (ConversationPane) and the frozen sidebar (`shouldFreezeSidebarList =
    // isRevealMasked || ...`, App.tsx). The surface components are mocked in
    // this harness, so the hook output App consumes is the honest observable.
    lastRevealMasked: null as boolean | null,
    record(event: CallEvent): void {
      this.callLog.push(event);
    },
    reset(): void {
      this.callLog = [];
      this.capturedActionsRef.current = null;
      this.lastRevealMasked = null;
    },
  };
});

// ── AtlasCanvas neutralisation (MUST be in this file: vi.mock hoists per-file).
// Same rationale as App.smoke.test.tsx — the only WebGL/WebGPU leaf in App's
// static graph; crashes at module-eval under happy-dom unless mocked.
vi.mock('@renderer/features/atlas/components/AtlasCanvas', () => ({
  AtlasCanvas: () => null,
}));

// ── Mock SessionSurfaceContent to capture the App-owned actionsRef ───────────
// We preserve the real `SessionSurfaceActions` type export (the App typechecks
// against it) and replace ONLY the component with a null-render capture probe.
// This is the user-facing seam: whatever opener the surface is given is exactly
// what a click would invoke.
vi.mock('@renderer/features/agent-session/components/SessionSurfaceContent', () => ({
  SessionSurfaceContent: (props: { actionsRef: RefObject<SessionSurfaceActions> }) => {
    harness.capturedActionsRef.current = props.actionsRef;
    return null;
  },
}));

// ── Mock FlowPanelsShell so the 'sessions' surface content renders regardless
// of which surface is active. App's `FlowPanelsShell` only mounts the ACTIVE
// surface's content (a freshly-mounted App lands on Home, not Sessions), so the
// real shell would never mount SessionSurfaceContent — and our capture probe
// would never fire. Rendering the sessions surface content directly mounts the
// (mocked) SessionSurfaceContent, which captures the App-owned actionsRef. The
// opener callback we then invoke is the SAME ref a real sidebar click would use.
vi.mock('@renderer/features/flow-panels/FlowPanelsShell', () => ({
  FlowPanelsShell: (props: { surfaces: Record<string, { content: ReactNode } | undefined> }) => {
    return props.surfaces?.['sessions']?.content ?? null;
  },
}));

// ── Instrument the real useConversationAutoScroll: wrap markPendingHistoryScroll
// (the scroll-settling contract entry point) while passing everything else
// through unchanged, so App's full behaviour is preserved.
vi.mock('@renderer/features/agent-session/hooks/useConversationAutoScroll', async () => {
  const actual = await vi.importActual<
    typeof import('@renderer/features/agent-session/hooks/useConversationAutoScroll')
  >('@renderer/features/agent-session/hooks/useConversationAutoScroll');
  return {
    ...actual,
    useConversationAutoScroll: (...args: Parameters<typeof actual.useConversationAutoScroll>) => {
      const result = actual.useConversationAutoScroll(...args);
      // Record the mask state App consumes on every render (see harness doc).
      harness.lastRevealMasked = result.isRevealMasked;
      const realMark = result.markPendingHistoryScroll;
      return {
        ...result,
        markPendingHistoryScroll: (sessionId: string, markTimeCurrentSessionId: string) => {
          harness.record({ fn: 'markPendingHistoryScroll', sessionId });
          return realMark(sessionId, markTimeCurrentSessionId);
        },
      };
    },
  };
});

// ── Instrument the real useAgentSessionEngine: wrap the raw engine
// openHistorySession (the low-level opener the wrapper must call LAST) while
// passing everything else through unchanged.
vi.mock('@renderer/features/agent-session/hooks/useAgentSessionEngine', async () => {
  const actual = await vi.importActual<
    typeof import('@renderer/features/agent-session/hooks/useAgentSessionEngine')
  >('@renderer/features/agent-session/hooks/useAgentSessionEngine');
  return {
    ...actual,
    useAgentSessionEngine: (
      ...args: Parameters<typeof actual.useAgentSessionEngine>
    ) => {
      const api = actual.useAgentSessionEngine(...args);
      const realOpen = api.openHistorySession;
      return {
        ...api,
        openHistorySession: (sessionId: string) => {
          harness.record({ fn: 'rawOpenHistorySession', sessionId });
          // Record order FIRST, then call through to the REAL engine opener.
          // realOpen hits the undefined-resolve preload bridges and resolves
          // false, but the ordering invariant we assert is established by the
          // record() above (before realOpen runs), so the resolved value is
          // irrelevant here; we still call through so the engine's pre-call
          // work runs.
          return realOpen(sessionId);
        },
      };
    },
  };
});

import { installPreloadBridges, mountApp } from './_harness/mountApp';
import { getSessionStoreState } from '@renderer/features/agent-session/store/sessionStore';

/**
 * Shared faithful bridge overrides for the navigation flows in this file.
 *
 * - `settingsApi.get`: App renders the main UI (and thus the session surface)
 *   only when `settings` is loaded and onboarding is complete
 *   (`shouldRenderMainApp = !!settings && !isInOnboardingSequence`).
 *   `useSettingsFeature` runs the resolved value through `normalizeSettings`,
 *   which fills all other defaults — a minimal completed-onboarding object is
 *   enough. NOTE: intentionally NO `coreDirectory`. With a coreDirectory set,
 *   PermissionComponents fires `permissionsApi.checkFileAccess()` and feeds the
 *   (undefined) resolved value into a `setStatus` updater that dereferences it
 *   during React's render phase (outside the call's try/catch) — a hard crash.
 *   Leaving coreDirectory unset takes the `fileAccess: 'unknown'` branch.
 * - `authApi.getState`: the full main UI pulls AuthGate into the tree; `useAuth`
 *   would store the undefined-resolve default, then crash reading
 *   `authState.isAuthenticated`. Provide a faithful authenticated AuthState.
 * - `appApi.safeModeState`: SafeModeOrchestrator stores the resolved value into
 *   App state, then App reads `safeModeContext.isEnabled` — undefined-resolve
 *   would overwrite the `{ isEnabled: false }` initial state and crash.
 * - `errorRecoveryApi.getState`: useErrorRecovery stores the resolved value
 *   into state, then reads `state.errorCategory`. Provide the idle state.
 */
function installFlowBridges(): ReturnType<typeof installPreloadBridges> {
  const completedSettings = {
    onboardingCompleted: true,
    onboardingCompletedAt: Date.now(),
  };
  return installPreloadBridges({
    settingsApi: {
      get: () => Promise.resolve(completedSettings),
    },
    authApi: {
      getState: () =>
        Promise.resolve({ isAuthenticated: true, user: null, isLoading: false }),
    },
    appApi: {
      safeModeState: () => Promise.resolve({ isEnabled: false }),
    },
    errorRecoveryApi: {
      getState: () =>
        Promise.resolve({
          evaluationId: null,
          status: 'idle',
          errorCategory: null,
          evaluation: null,
          startedAt: null,
          quipIndex: 0,
        }),
    },
  });
}

// Bounded poll: flush microtasks + one macrotask per tick inside act(), then
// re-check `predicate`, up to `maxTicks`. More robust than a single fixed-shape
// flush (a future extra effect hop before the surface mounts / before the
// wrapper's pre-await work would otherwise flake the test); the success case
// exits on the first satisfied tick. If the predicate never holds (a real
// regression), the poll exhausts maxTicks and the downstream assertions fail —
// which is the intended signal.
async function flushUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('App navigation flow — opener routes through the scroll-settling wrapper', () => {
  let restoreBridges: (() => void) | null = null;
  let unmountApp: (() => void) | null = null;

  afterEach(() => {
    if (unmountApp) {
      unmountApp();
      unmountApp = null;
    }
    if (restoreBridges) {
      restoreBridges();
      restoreBridges = null;
    }
    harness.reset();
  });

  it('opens a history session via markPendingHistoryScroll (contract) BEFORE the raw engine open', async () => {
    const bridges = installFlowBridges();
    restoreBridges = bridges.restore;

    const { unmount, mountError } = mountApp();
    unmountApp = unmount;
    expect(mountError).toBeNull();

    // Settings load asynchronously in a mount effect (`useSettingsFeature` →
    // `await settingsApi.get()` → `setSettings`), and only once `settings` is
    // populated does App render the main UI / session surface. Poll (bounded)
    // until the (mocked) SessionSurfaceContent mounts and captures the App-owned
    // actionsRef, rather than assuming it settles in exactly one macrotask.
    await flushUntil(() => harness.capturedActionsRef.current != null);

    // Sanity: the session surface rendered and captured the App-owned actionsRef.
    expect(harness.capturedActionsRef.current).not.toBeNull();
    const actions = harness.capturedActionsRef.current!.current;
    expect(typeof actions.handleOpenHistorySession).toBe('function');

    // Drive the canonical user-facing opener. Use a sessionId that differs from
    // the freshly-mounted currentSessionId so the wrapper's same-session
    // early-return guard does NOT short-circuit the scroll-settling path.
    // handleOpenHistorySession is fire-and-forget over an async wrapper; flush
    // the microtask queue (inside act) so the wrapper's synchronous pre-`await`
    // work (beginSwitchTiming + markPendingHistoryScroll) and the subsequent raw
    // engine call are both recorded.
    const targetSessionId = 'nav-flow-target-session';
    await act(async () => {
      actions.handleOpenHistorySession(targetSessionId, 'sidebar');
    });
    // Poll (bounded) until BOTH instrumented contract calls for the target
    // session are recorded, instead of assuming a fixed one-macrotask settle.
    await flushUntil(
      () =>
        harness.callLog.some(
          (e) => e.fn === 'markPendingHistoryScroll' && e.sessionId === targetSessionId,
        ) &&
        harness.callLog.some(
          (e) => e.fn === 'rawOpenHistorySession' && e.sessionId === targetSessionId,
        ),
    );

    // The ordering invariant: the contract (markPendingHistoryScroll) for the
    // target session must be recorded, and it must precede the raw engine open
    // for that same session. A future opener that bypasses the wrapper would
    // produce a rawOpenHistorySession entry with NO preceding
    // markPendingHistoryScroll for that session — and this assertion fails.
    const markIdx = harness.callLog.findIndex(
      (e) => e.fn === 'markPendingHistoryScroll' && e.sessionId === targetSessionId,
    );
    const rawIdx = harness.callLog.findIndex(
      (e) => e.fn === 'rawOpenHistorySession' && e.sessionId === targetSessionId,
    );

    expect(markIdx, 'scroll-settling contract (markPendingHistoryScroll) must fire for the opened session')
      .toBeGreaterThanOrEqual(0);
    expect(rawIdx, 'raw engine openHistorySession must be reached for the opened session')
      .toBeGreaterThanOrEqual(0);
    expect(
      markIdx,
      'markPendingHistoryScroll (contract) must precede the raw engine openHistorySession',
    ).toBeLessThan(rawIdx);
  });

  // ── Stuck reveal-mask regression (docs/plans/260611_fix-stuck-reveal-mask) ──
  // Bug shape: open a history session, then start a new chat before the
  // scroll-settle completes. The pending mark targets the history session; the
  // new chat switches `currentSessionId` to a fresh id, the pending-history
  // effect's FOX-3040 session-id gate early-returns forever, and
  // `isRevealMasked` stays true with no self-heal — stuck skeleton overlay +
  // frozen sidebar (`shouldFreezeSidebarList`) until that exact session
  // remounts. This drives the REAL App wiring end to end: the canonical opener
  // (`handleOpenHistorySession`) with a genuine cache-hit store switch, then
  // the real new-chat path (`handleNewChat` → resetConversationState →
  // resetSessionState → store resetSession).
  it('reveal mask is not left stuck when new-chat interrupts a history-session open', async () => {
    const bridges = installFlowBridges();
    restoreBridges = bridges.restore;

    const { unmount, mountError } = mountApp();
    unmountApp = unmount;
    expect(mountError).toBeNull();

    await flushUntil(() => harness.capturedActionsRef.current != null);
    expect(harness.capturedActionsRef.current).not.toBeNull();
    const actions = harness.capturedActionsRef.current!.current;

    // Seed a history session in the REAL session store: give the current
    // session content, then resetSession() — the outgoing session is
    // snapshotted into sessionSummaries AND the LRU cache (loadedSessions via
    // addOrUpdateHistorySession → cacheSession). The open below is therefore a
    // genuine synchronous cache-hit that applies the store switch — the open
    // SUCCEEDS, so the open-failure cancel path (App's
    // `cancelPendingHistoryScroll(sessionId)` on `opened === false`) cannot
    // mask the bug in this harness.
    await act(async () => {
      getSessionStoreState().addUserMessage('history session seed message');
    });
    const historySessionId = getSessionStoreState().currentSessionId;
    await act(async () => {
      getSessionStoreState().resetSession();
    });
    // Vacuity guards: the seed must be cache-resident (else the engine open
    // would IPC-fail against the undefined-resolve bridges and the
    // failure-path cancel would clear the mask for the WRONG reason), and the
    // store must now be on a different session.
    expect(getSessionStoreState().getLoadedSession(historySessionId)).toBeDefined();
    expect(getSessionStoreState().currentSessionId).not.toBe(historySessionId);

    // Open the history session via the canonical user-facing opener.
    await act(async () => {
      actions.handleOpenHistorySession(historySessionId, 'sidebar');
    });
    await flushUntil(() => getSessionStoreState().currentSessionId === historySessionId);
    expect(
      getSessionStoreState().currentSessionId,
      'cache-hit open must apply the store switch (vacuity guard)',
    ).toBe(historySessionId);

    // Mid-settle window: the opener marked the pending history scroll and the
    // reveal mask is up. The ConversationPane never mounts in this harness
    // (SessionSurfaceContent is mocked), so the settle primitive cannot
    // consume the mark — exactly the in-flight state the user interrupts.
    expect(
      harness.lastRevealMasked,
      'reveal mask must be up mid-open (vacuity guard: the interrupt below must hit a live mask)',
    ).toBe(true);

    // The user immediately starts a new chat (the repro: history-open →
    // new-chat within the settle window).
    await act(async () => {
      actions.handleNewChat('header_button');
    });
    await flushUntil(() => getSessionStoreState().currentSessionId !== historySessionId);
    expect(getSessionStoreState().currentSessionId).not.toBe(historySessionId);

    // The pending mark now targets a session that is neither current nor
    // mark-time-current — it is orphaned. The mask must come down (bounded
    // poll gives any self-heal path ample ticks). A stuck-true value here is
    // the bug: permanent skeleton overlay + frozen sidebar on the NEW chat.
    await flushUntil(() => harness.lastRevealMasked === false, 20);
    expect(
      harness.lastRevealMasked,
      'reveal mask must not stay stuck after new-chat orphans the pending history-scroll mark',
    ).toBe(false);
  });
});
