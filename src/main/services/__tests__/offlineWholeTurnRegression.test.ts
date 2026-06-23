/**
 * Offline client→recovery composition regression test — the LAYER INTERACTION the
 * offline-hang bug lived in (postmortem 260619 Rec 1; planning doc
 * docs/plans/260619_offline-prevention-hardening/PLAN.md Stage 2).
 *
 * The original hang was invisible to unit tests because every piece was correct
 * in isolation. It lived ONLY in the interaction of:
 *   (offline → proxy-masks-as-500 → classified transient `server_error`)
 *   × (the Anthropic SDK's own retry layer STACKED under our `runWithRetry`)
 *   × (a watchdog whose 5-min fast-fail gate was interactive-only — `origin:automation`
 *      stayed exposed to the 10/30-min ceilings).
 *
 * The existing per-layer tests each prove one piece:
 *   - `anthropicClient.offlineFailFast.test.ts` / `openaiClient.offlineFailFast.test.ts`
 *     stub `doCreate`/`doStream` (ABOVE the SDK retry layer) → they prove the gate
 *     fires but CANNOT prove the bounded SDK×runWithRetry *product* (the SDK retry
 *     layer is stubbed out).
 *   - `turnErrorRecovery.test.ts` exercises recovery handlers in isolation and never
 *     covers `handleOfflineFailFast`.
 * None compose the two, and none lock origin-parity at the recovery layer. This
 * test does both.
 *
 * Layer A (real client, real SDK retry, fetch-level seam): drive the REAL
 * `AnthropicClient.create()` through the REAL `runWithRetry` AND the REAL Anthropic
 * SDK retry layer (OpenRouter-passthrough config inherits the SDK default
 * `maxRetries ?? 2`, exactly like production) by stubbing `globalThis.fetch` to
 * return the offline-masked 500. Counting `globalThis.fetch` POSTs proves the
 * BOUNDED total fetch attempts (assertion 1) — the storm short-circuits and the
 * genuine `offlineFailFast`-marked error is produced (NOT hand-built).
 *
 * Layer B (real recovery routing): feed THAT genuine produced error into the REAL
 * `dispatchErrorRecovery`. Assert it ends FAST via the `message_timeout` "Try
 * again" terminal with NO retry from recovery (assertion 2), for BOTH `origin:
 * manual | automation` (assertion 3).
 *
 * SCOPE BOUNDARY (honest about what this does and does NOT cover — GPT-5.5-high
 * review F1/F2):
 *   - It DOES NOT drive the real turn runner or the watchdog. It does NOT prove the
 *     production automation turn reaches this client→recovery sequence before the
 *     watchdog ceilings — the original origin gate lives in `agentTurnExecute.ts`'s
 *     watchdog, which this test does not exercise.
 *   - Assertion 2 proves "no retry / no re-storm FROM RECOVERY after a marked
 *     error," NOT "no dangle in the full turn lifecycle."
 *   - Assertion 3 proves "RECOVERY is origin-agnostic once handed an offlineFailFast
 *     error" — a regression lock that `handleOfflineFailFast` (and its ordering
 *     ahead of the re-storm handlers) is never made origin-gated. It is NOT
 *     end-to-end watchdog-origin parity. The full origin-axis watchdog coverage is
 *     the deferred `cluster_id: watchdog-classification-test-matrix` follow-up
 *     (postmortem Rec 5). The recovery context is deliberately minimal (only the
 *     handlers up to 1.6 execute); see makeRecoveryContext.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Shared mock: the reachability probe. Both layers consult `isMachineOffline`.
// Mocking it directly (a) lets us drive the verdict deterministically and (b)
// keeps the probe's OWN corroboration HEAD fetches out of the upstream
// fetch-attempt count (Layer A counts only the messages POSTs).
// ---------------------------------------------------------------------------
const { isMachineOfflineMock } = vi.hoisted(() => ({
  isMachineOfflineMock: vi.fn<(...args: unknown[]) => Promise<boolean>>(),
}));

vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  isMachineOffline: isMachineOfflineMock,
  // `dispatchErrorRecovery`'s message-timeout path can call diagnoseTimeout; it is
  // never reached on the offline-fail-fast terminal (handler 1.6 returns early),
  // but mock it so the module import is satisfied.
  diagnoseTimeout: vi.fn(async () => ({ kind: 'transient_stall' })),
}));

// ===========================================================================
// Recovery-layer mock scaffold (Layer B). Modeled on turnErrorRecovery.test.ts —
// scoped to what executes UP TO + INCLUDING handleOfflineFailFast (handlers 1,
// 1.5, 1.6). `runAgentQuery` is mocked so we can ASSERT it is never called (no
// re-storm / no model fallback). The dispatch sinks are captured so we can assert
// the message_timeout terminal contract.
// ===========================================================================
const {
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  completeTurnCleanupMock,
  makeSyntheticResultMock,
  runAgentQueryMock,
  getErrorKindMock,
  registryMocks,
  mockTurnLogger,
} = vi.hoisted(() => {
  return {
    dispatchAgentEventMock: vi.fn(),
    // Mirror the real dispatcher's event-shaping closely enough that the
    // message_timeout contract surfaces on the captured error event.
    dispatchAgentErrorEventMock: vi.fn((win: unknown, turnId: string, rawError: unknown, opts?: {
      humanizedOverride?: string;
      isTransient?: boolean;
      errorKindOverride?: string;
      markActionable?: boolean;
    }) => {
      const rawMessage =
        typeof rawError === 'string'
          ? rawError
          : rawError instanceof Error
            ? rawError.message
            : String(rawError ?? '');
      const errorKind = opts?.errorKindOverride;
      dispatchAgentEventMock(win, turnId, {
        type: 'error',
        error: opts?.humanizedOverride ?? rawMessage,
        ...(opts?.isTransient !== undefined ? { isTransient: opts.isTransient } : {}),
        ...(errorKind ? { errorKind } : {}),
        errorSource: 'main',
        timestamp: Date.now(),
      });
      if (opts?.markActionable === true) {
        registryMocks.markActionableErrorDispatched(turnId);
      }
      return { ok: true, ...(errorKind ? { dispatchedErrorKind: errorKind } : {}) };
    }),
    completeTurnCleanupMock: vi.fn(),
    makeSyntheticResultMock: vi.fn((_turnId: string, text = '', turnEndReason?: string) => ({
      type: 'result',
      text,
      timestamp: 123,
      ...(turnEndReason ? { turnEndReason } : {}),
    })),
    runAgentQueryMock: vi.fn(async () => ({ abortedByUser: false, terminatedByHandler: false })),
    getErrorKindMock: vi.fn<(error: unknown) => string>(() => 'unknown'),
    registryMocks: {
      markActionableErrorDispatched: vi.fn(),
      getOrCreateAccumulator: vi.fn(() => ({
        hasPossiblyMutatingToolCall: vi.fn(() => false),
        getExecutedToolCalls: vi.fn(() => []),
      })),
      // These are only reached if the offline gate is DEFEATED (recovery falls
      // through to the re-storming transient-retry handler). Stubbed so a broken
      // gate fails on a CLEAN assertion (no message_timeout terminal / runAgentQuery
      // called) rather than a TypeError — keeps the red→green proof legible.
      getRetryCount: vi.fn(() => 0),
      incrementRetryCount: vi.fn(() => 1),
      getRetryStartTime: vi.fn((): number | undefined => undefined),
      setRetryStartTime: vi.fn(),
      cleanupForRetry: vi.fn(),
      hasActionableErrorDispatched: vi.fn(() => false),
    },
    mockTurnLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('../agentEventDispatcher', () => ({
  clearAnswerPhaseStartedSentinel: vi.fn(),
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('../agentTurnCleanup', () => ({
  completeTurnCleanup: completeTurnCleanupMock,
  makeSyntheticResult: makeSyntheticResultMock,
}));

vi.mock('../agentQueryRunner', () => ({
  runAgentQuery: runAgentQueryMock,
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: registryMocks,
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/utils/agentErrorCatalog');
  return { ...actual, getErrorKind: getErrorKindMock };
});

vi.mock('@core/services/settingsStore', () => ({
  getSettings: vi.fn(() => ({ localModel: { profiles: [] } })),
  updateSettings: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { AnthropicClient } from '@core/rebelCore/clients/anthropicClient';
import { ModelError } from '@core/rebelCore/modelErrors';
import { OFFLINE_FAIL_FAST_MESSAGE } from '@core/rebelCore/clients/offlineFailFast';
import { dispatchErrorRecovery, type ErrorRecoveryContext } from '../turnErrorRecovery';

// ---------------------------------------------------------------------------
// Layer A helpers — real client + real SDK retry, fetch-level seam.
// ---------------------------------------------------------------------------

const MESSAGES_PATH = '/v1/messages';

/** The offline-masked-as-500 envelope the OpenRouter passthrough returns when an
 * offline `fetch` throws ENOTFOUND instantly (localModelProxyServer.ts :3835). */
function makeProxy500(): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'OpenRouter passthrough failed' } }),
    { status: 500, headers: { 'content-type': 'application/json' } },
  );
}

function makeOpenRouterPassthroughClient(): AnthropicClient {
  // `x-openrouter-turn: true` is exactly how production marks the OpenRouter
  // passthrough; the constructor does NOT pass `maxRetries`, so the SDK inherits
  // its default (≈2) — the very stacking that produced the storm.
  return new AnthropicClient({
    apiKey: 'test-key',
    baseURL: 'http://127.0.0.1:0', // never actually hit — globalThis.fetch is stubbed
    defaultHeaders: { 'x-openrouter-turn': 'true' },
  });
}

const BASE_CREATE_PARAMS = {
  // Plain string id is fine for create(); resolveAnthropicWireModel maps it.
  model: 'claude-sonnet-4-5' as unknown as Parameters<AnthropicClient['create']>[0]['model'],
  systemPrompt: 'System prompt',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 64,
};

/**
 * Drive the REAL AnthropicClient.create() through the REAL runWithRetry AND the
 * REAL Anthropic SDK retry layer with `globalThis.fetch` stubbed to the offline
 * 500. Returns the thrown error + the number of upstream messages POSTs the stack
 * actually issued (the SDK×runWithRetry product).
 */
async function produceOfflineTurnError(): Promise<{ error: unknown; upstreamFetchCount: number }> {
  let upstreamFetchCount = 0;
  const fetchStub = vi.fn(async (url: unknown) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.href : String((url as { url?: string })?.url ?? url);
    if (href.includes(MESSAGES_PATH)) {
      upstreamFetchCount += 1;
    }
    return makeProxy500();
  });
  vi.stubGlobal('fetch', fetchStub);
  try {
    const client = makeOpenRouterPassthroughClient();
    const error = await client.create({ ...BASE_CREATE_PARAMS }).catch((e) => e);
    return { error, upstreamFetchCount };
  } finally {
    vi.unstubAllGlobals();
  }
}

// ---------------------------------------------------------------------------
// Layer B helper — minimal ErrorRecoveryContext for the offline-fail-fast path.
// Only handlers 1 (abort), 1.5 (tool-input-too-large), 1.6 (offline-fail-fast)
// execute before the terminal returns, so this context only needs to satisfy
// those. `origin` is NOT a field on ErrorRecoveryContext — the recovery layer is
// origin-AGNOSTIC by construction (the origin gate lives in the watchdog, above
// this layer). We therefore parametrize the WHOLE-TURN scenario over the
// watchdog-origin flags a turn carries and assert recovery is identical.
// ---------------------------------------------------------------------------

type TurnOrigin = 'manual' | 'automation';

function makeRecoveryContext(error: unknown, origin: TurnOrigin): ErrorRecoveryContext {
  // An offline turn produced by Layer A is NOT an abort: the controller is not
  // aborted and the error name is not 'AbortError'. The origin flags below mirror
  // what each origin's turn would carry into recovery; for an offline fail-fast,
  // the turn never reached the watchdog, so abortedByWatchdog/awaitingApiStall are
  // false for BOTH — the parametrization proves recovery doesn't branch on origin.
  const isAutomation = origin === 'automation';
  return {
    error,
    turnId: `offline-turn-${origin}`,
    win: null,
    turnLogger: mockTurnLogger as unknown as ErrorRecoveryContext['turnLogger'],
    abortController: new AbortController(),
    messageCount: 0,
    abortedByWatchdog: false,
    abortedByAwaitingApiStall: false,
    // Field present in the real context for telemetry; harmless here.
    turnOptions: { origin } as unknown as ErrorRecoveryContext['turnOptions'],
    plan: {
      decision: { credentialSource: 'anthropic-api-key' },
    } as unknown as ErrorRecoveryContext['plan'],
    // The remaining fields are only read by handlers AFTER 1.6, which never run on
    // the offline-fail-fast terminal. Cast a minimal stub.
    _isAutomation: isAutomation,
  } as unknown as ErrorRecoveryContext;
}

// ===========================================================================
// Tests
// ===========================================================================

describe('offline whole-turn regression (postmortem 260619 Rec 1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getErrorKindMock.mockReturnValue('unknown');
    delete process.env.REBEL_OFFLINE_FAILFAST;
    // Layer A backoff sleeps (runWithRetry + SDK) must be real-but-skipped — but
    // for the OFFLINE case the gate short-circuits BEFORE any runWithRetry sleep,
    // and the SDK's inner retries on the first attempt use small (<1s) jittered
    // backoffs. Pin Math.random to 0 for determinism; use real timers so the SDK's
    // own setTimeout-based backoff resolves naturally within the short bound.
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.REBEL_OFFLINE_FAILFAST;
  });

  // -------------------------------------------------------------------------
  // Assertion 1 — BOUNDED total fetch attempts across the stacked layers.
  // -------------------------------------------------------------------------
  it('ASSERTION 1: offline turn issues a BOUNDED number of upstream fetches (no storm) and produces the offlineFailFast terminal error', async () => {
    isMachineOfflineMock.mockResolvedValue(true);

    const { error, upstreamFetchCount } = await produceOfflineTurnError();

    // The genuine error is produced by the REAL stack (not hand-built) and carries
    // the structural marker recovery keys on.
    expect(error).toBeInstanceOf(ModelError);
    expect((error as ModelError).details?.offlineFailFast).toBe(true);

    // Without the gate, the worst case is (1 + runWithRetry MAX_RETRIES=3) ×
    // (1 + SDK maxRetries≈2) = 4 × 3 = 12 upstream POSTs per turn — the storm.
    // With the gate, the FIRST runWithRetry attempt exhausts the SDK's inner
    // retries (1 + 2 = 3 POSTs), then the gate short-circuits BEFORE the second
    // runWithRetry attempt → bound is the single-runWithRetry-attempt SDK product.
    // Assert a TIGHT bound well below the storm (≤ 4 leaves headroom for SDK
    // jitter without admitting a second runWithRetry cycle, which would be ≥ 6).
    expect(upstreamFetchCount).toBeGreaterThanOrEqual(1);
    expect(upstreamFetchCount).toBeLessThanOrEqual(4);

    // The probe was consulted (the gate engaged), at most once.
    expect(isMachineOfflineMock).toHaveBeenCalledTimes(1);
  });

  it('ASSERTION 1 (contrast): an ONLINE transient turn retries through BOTH layers — proving the bound above is the gate, not an artifact', async () => {
    // Same offline-masked 500, but the probe says ONLINE → fail-open → retries as
    // today through runWithRetry (3) × SDK (≈2). This SHOULD storm (≫ the offline
    // bound), which is exactly why the offline gate matters. We assert it produces
    // strictly MORE upstream fetches than the offline bound — locking that the
    // offline test's tight bound is caused by the gate.
    isMachineOfflineMock.mockResolvedValue(false);

    const { error, upstreamFetchCount } = await produceOfflineTurnError();

    expect(error).toBeInstanceOf(ModelError);
    // No fail-fast marker on the online path.
    expect((error as ModelError).details?.offlineFailFast).toBeUndefined();
    // Strictly more than the offline bound — the storm the gate prevents.
    expect(upstreamFetchCount).toBeGreaterThan(4);
  }, 15_000);

  // -------------------------------------------------------------------------
  // Assertions 2 + 3 — FAST retryable terminal, parametrized over origin.
  // -------------------------------------------------------------------------
  describe.each<TurnOrigin>(['manual', 'automation'])(
    'ASSERTION 2+3: origin=%s — recovery ends FAST via message_timeout with no retry from recovery',
    (origin) => {
      it('routes the genuine offline error to the message_timeout "Try again" terminal — recovery is origin-agnostic once handed an offlineFailFast error', async () => {
        isMachineOfflineMock.mockResolvedValue(true);

        // Produce the GENUINE error from the real client stack (Layer A), then run
        // the REAL recovery dispatcher over it (Layer B).
        const { error } = await produceOfflineTurnError();
        expect((error as ModelError).details?.offlineFailFast).toBe(true);

        const ctx = makeRecoveryContext(error, origin);
        await dispatchErrorRecovery(ctx);

        // (2a) The recognised retryable message_timeout terminal fired with the
        // honest offline copy + actionable Try-again surface.
        const errorEvent = dispatchAgentEventMock.mock.calls
          .map((c) => c[2] as { type?: string; errorKind?: string; isTransient?: boolean; error?: string })
          .find((e) => e?.type === 'error');
        expect(errorEvent?.errorKind).toBe('message_timeout');
        expect(errorEvent?.isTransient).toBe(true);
        expect(errorEvent?.error).toBe(OFFLINE_FAIL_FAST_MESSAGE);
        expect(registryMocks.markActionableErrorDispatched).toHaveBeenCalledWith(ctx.turnId);

        // (2b) A synthetic result('error') FOLLOWS so the renderer clears isBusy —
        // recovery TERMINATES the turn here instead of returning control to the
        // loop (which, with no terminal, is what dangles to the watchdog ceilings).
        // This proves recovery's terminal, not full-lifecycle no-dangle (see SCOPE
        // BOUNDARY in the file header).
        const resultEvent = dispatchAgentEventMock.mock.calls
          .map((c) => c[2] as { type?: string; turnEndReason?: string })
          .find((e) => e?.type === 'result');
        expect(resultEvent?.turnEndReason).toBe('error');
        expect(completeTurnCleanupMock).toHaveBeenCalledWith(ctx.turnId, 'error');

        // (2c) NO re-storm: recovery did NOT issue another model query / fallback.
        // This is the property that, if broken, re-issues the turn over the dead
        // network and resurrects the storm.
        expect(runAgentQueryMock).not.toHaveBeenCalled();
      });
    },
  );

  it('ASSERTION 3 (recovery parity lock): manual and automation metadata reach byte-identical RECOVERY outcomes given a genuine offlineFailFast error', async () => {
    isMachineOfflineMock.mockResolvedValue(true);

    const capture = async (origin: TurnOrigin) => {
      vi.clearAllMocks();
      getErrorKindMock.mockReturnValue('unknown');
      const { error } = await produceOfflineTurnError();
      await dispatchErrorRecovery(makeRecoveryContext(error, origin));
      const errorEvent = dispatchAgentEventMock.mock.calls
        .map((c) => c[2] as { type?: string; errorKind?: string; isTransient?: boolean })
        .find((e) => e?.type === 'error');
      return {
        errorKind: errorEvent?.errorKind,
        isTransient: errorEvent?.isTransient,
        runAgentQueryCalled: runAgentQueryMock.mock.calls.length,
        cleanupReason: completeTurnCleanupMock.mock.calls[0]?.[1],
      };
    };

    const manual = await capture('manual');
    const automation = await capture('automation');

    // The recovery outcome is IDENTICAL across origin metadata: `handleOfflineFailFast`
    // (and its ordering ahead of the re-storm handlers) is never origin-gated. This
    // locks the recovery half of the fix against re-introducing an origin branch —
    // it is NOT a claim about the end-to-end watchdog-origin path (see SCOPE BOUNDARY).
    expect(automation).toEqual(manual);
    expect(automation.errorKind).toBe('message_timeout');
    expect(automation.runAgentQueryCalled).toBe(0);
  });
});
