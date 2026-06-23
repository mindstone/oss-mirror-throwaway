/**
 * behindTheScenesClient.ts — 26 BEHAVIOURAL INVARIANTS pinned as runnable contract tests.
 *
 * Stage 6 of `docs/plans/260526_hotspot-refactor-roadmap/PLAN.md` (Hotspot 3).
 * Source: `subagent_reports/260526_170501_researcher-bugarch-btsclient-opus47.md`
 *   → "Behavioural Invariants (≥20) — must survive the refactor" (lines 211–267).
 *
 * Authoritative behaviour-preservation gate for Stages 7–10 of the same
 * roadmap: typed `BtsTransportAdapter` (Stage 7), `BtsCallResult` (Stage 8),
 * cross-surface parity (Stage 9), centralised cooldown (Stage 10).
 *
 * Each `it()` is labelled with its invariant number (INV-N) and cites the
 * postmortem(s) that motivate it in a leading comment. The new file focuses
 * on **interaction contracts** spanning multiple transports / entry points
 * / use cases — exactly the gap researcher F10 identifies. Per-function
 * unit tests live in the other 9 `behindTheScenesClient.*` test files; this
 * file deliberately does NOT duplicate that coverage — it pins the cross-
 * cutting interaction invariants those tests miss.
 *
 * Total `it()` cases: ≥85 (62 original + ≥22 supplement after the heavy-mode
 * tester review).  The supplement bumps coverage on:
 *   - F1 per-transport symmetry (INV-1 anthropic-compatible-proxy + OAuth
 *     defect markers; INV-12 anthropic-compatible-proxy + profile-http
 *     defect markers; INV-25 callBehindTheScenes legacy + callWithModelAuthAware)
 *   - F2 INV-7 missing excluded error kinds (billing, moderation, server_error,
 *     context_overflow, model_unavailable, transient network, chat-incompatibility)
 *   - F3 source-invariant subclauses (INV-18 warn-once unpriced model first/
 *     second/different; INV-19 cost-source priority chain; INV-16 Codex JSON
 *     hint prepend; INV-13 Codex cooldown-after-parse; INV-6c sessionId-
 *     independence)
 *   - F4 postmortem citations on every it() block (parity citations on
 *     INV-20a/b/c, INV-21a/b, INV-24a/b)
 *   - F5 rewrites: INV-6b genuine LRU dedupe via getTurnContext override,
 *     INV-24a strict skip + current-behaviour pin, INV-25 ordered-events
 *     array
 *
 * Supplement commit: see Stage 6 supplement report
 * `subagent_reports/260527_*_implementer-stage6-supplement.md`.
 *
 * Postmortems covered (collated from per-test citations):
 *   260327 (cloud preOAuthCallHook),
 *   260405 (json fences, unpriced cost silent skip),
 *   260406 (AggregateError branch ordering),
 *   260420 (user-question pause),
 *   260422 (codex parity, safety eval concurrency),
 *   260424 (Sentry fingerprint, safety unavailable 5-gap),
 *   260427 (reasoning content direct profile, Codex Sentry fragmentation,
 *           OR structured-output prose),
 *   260428 (catch-branch silent reroute, c2 marker overbroad,
 *           callProfileHttp classification regression, cooldown compaction
 *           context overflow misclassification),
 *   260429 (callWithModelAuthAware cooldown bypass, Codex SSE force-stream,
 *           live-coach Codex connectivity unknown),
 *   260502 (safety eval cooldown parity),
 *   260505 (Anthropic prefix not stripped before native wire),
 *   260520 (time-saved zero or missing),
 *   260521 (Haiku-fallback strikes / sticky marker DA),
 *   260522 (BTS contract test variable indirection).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import { brandRouteWireModel } from '@shared/utils/wireModelId';

// ---------------------------------------------------------------------------
// Hoisted mock state (created BEFORE module-level vi.mock() factories)
// ---------------------------------------------------------------------------

const {
  appendCostEntryMock,
  captureKnownConditionMock,
  broadcastSendToAllWindowsMock,
  preOAuthHookMock,
  loggerWarnMock,
  loggerInfoMock,
  loggerDebugMock,
  loggerErrorMock,
  anthropicMessagesCreateMock,
} = vi.hoisted(() => ({
  appendCostEntryMock: vi.fn(
    (_entry: Record<string, unknown>) => ({ costEntryId: 'test-cost-entry-id' }),
  ),
  captureKnownConditionMock: vi.fn(),
  broadcastSendToAllWindowsMock: vi.fn(),
  preOAuthHookMock: vi.fn(async () => {}),
  loggerWarnMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  anthropicMessagesCreateMock: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: loggerInfoMock,
    debug: loggerDebugMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  }),
  getTurnContext: vi.fn(() => undefined),
}));

vi.mock('@core/services/costLedgerService', () => ({
  appendCostEntry: appendCostEntryMock,
}));

vi.mock('@core/services/codexAuthCore', () => ({
  isCodexConnected: vi.fn(() => false),
}));

vi.mock('@core/utils/authEnvUtils', async () => {
  const { createAuthEnvUtilsMock } = await import('@core/utils/__tests__/authEnvUtilsMock');
  return createAuthEnvUtilsMock();
});

vi.mock('@core/utils/systemUtils', () => ({
  setupNodeEnvironment: vi.fn().mockResolvedValue('/usr/bin'),
}));

vi.mock('@core/sentry/captureKnownCondition', () => ({
  captureKnownCondition: captureKnownConditionMock,
  // Ledger-only recorder added by 310a3a73f (REBEL-5PN); the sibling
  // structuredOutputFallback.test.ts mock was updated but this one was missed,
  // so the per-occurrence bypass branch throws on the strict mock contract.
  recordKnownConditionLedgerOnly: vi.fn(),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: broadcastSendToAllWindowsMock, sendToFocusedWindow: vi.fn() }),
}));

vi.mock('@anthropic-ai/sdk', async () => {
  const actual = await vi.importActual<typeof import('@anthropic-ai/sdk')>('@anthropic-ai/sdk');
  class MockAnthropic {
    static APIUserAbortError = actual.APIUserAbortError;
    static APIError = actual.APIError;
    static AnthropicError = actual.AnthropicError;
    static RateLimitError = actual.RateLimitError;
    messages = { create: anthropicMessagesCreateMock };
  }
  return {
    ...actual,
    Anthropic: MockAnthropic,
  };
});

// ---------------------------------------------------------------------------
// Imports (after vi.mock factories)
// ---------------------------------------------------------------------------

import { setSettingsStoreAdapter } from '@core/services/settingsStore';
import {
  callBehindTheScenes,
  callBehindTheScenesWithAuth,
  callWithModel,
  callWithModelAuthAware,
  isTransientNetworkError,
  parseJsonResponseBody,
  registerPreOAuthCallHook,
  registerBtsProxyProviders,
  CodexDisconnectedBtsError,
  __resetJsonParseFailureStrikesForTesting,
  __resetStructuredOutputBypassNoticesForTesting,
  __markProfileChatIncompatibleForTesting,
  __markProfileJsonIncompatibleForTesting,
  _resetCodexBtsCaptureDedupeForTests,
} from '../behindTheScenesClient';
import { ModelError } from '@core/rebelCore/modelErrors';
import {
  apiRateLimitCooldown,
  safetyEvalRateLimitCooldown,
} from '@core/services/apiRateLimitCooldown';
import { CODEX_BTS_PROFILE_ID } from '@shared/utils/codexDefaults';
import { getTurnContext } from '@core/logger';
import { _resetWarnedModelsForTesting } from '@shared/utils/pricingCalculator';
import { ProviderRouter } from '@core/rebelCore/providerRouting';
import type { DispatchableRouteDecision } from '@core/rebelCore/providerRouteDecision';

// ---------------------------------------------------------------------------
// Helpers — settings shapes per transport
// ---------------------------------------------------------------------------

const TEST_MESSAGES = [{ role: 'user' as const, content: 'test' }];

function makeAnthropicDirectSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    claude: { apiKey: 'fake-ant-test-key', model: 'claude-sonnet-4-20250514' },
    models: { apiKey: 'fake-ant-test-key', model: 'claude-sonnet-4-20250514' },
    providerKeys: {},
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [] },
    ...overrides,
  } as AppSettings;
}

function makeOpenRouterSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'openrouter',
    coreDirectory: '/tmp/test',
    claude: { apiKey: null, model: 'claude-sonnet-4-20250514' } as AppSettings['claude'],
    models: { apiKey: null, model: 'claude-sonnet-4-20250514' } as AppSettings['models'],
    openRouter: {
      enabled: true,
      oauthToken: 'fake-or-test',
      selectedModel: 'anthropic/claude-sonnet-4.6',
    } as AppSettings['openRouter'],
    providerKeys: {},
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [] },
    behindTheScenesModel: 'anthropic/claude-sonnet-4',
    ...overrides,
  } as AppSettings;
}

function makeProfileSettings(
  profileOverrides: Record<string, unknown> = {},
  overrides: Partial<AppSettings> = {},
): AppSettings {
  const profile = {
    id: 'test-profile',
    name: 'Test Profile',
    providerType: 'together',
    serverUrl: 'https://api.test.xyz/v1',
    model: 'test/model',
    createdAt: 0,
    ...profileOverrides,
  };
  return {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    claude: { apiKey: 'fake-ant-test', model: 'claude-sonnet-4-20250514' },
    models: { apiKey: 'fake-ant-test', model: 'claude-sonnet-4-20250514' },
    providerKeys: { together: 'fake-together-key' },
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [profile] },
    behindTheScenesModel: `profile:${profile.id}`,
    ...overrides,
  } as AppSettings;
}

function makeOAuthSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    activeProvider: 'anthropic',
    coreDirectory: '/tmp/test',
    claude: {
      apiKey: null,
      oauthToken: 'fake-oauth-token',
      authMethod: 'oauth-token',
      model: 'claude-sonnet-4-20250514',
    } as AppSettings['claude'],
    models: {
      apiKey: null,
      oauthToken: 'fake-oauth-token',
      authMethod: 'oauth-token',
      model: 'claude-sonnet-4-20250514',
    } as AppSettings['models'],
    providerKeys: {},
    customProviders: [],
    localModel: { activeProfileId: null, profiles: [] },
    ...overrides,
  } as AppSettings;
}

let _liveSettings: AppSettings = makeAnthropicDirectSettings();

function setupAdapter(settings: AppSettings): void {
  _liveSettings = settings;
  setSettingsStoreAdapter({
    getSettings: () => _liveSettings,
    updateSettings: (partial) => {
      _liveSettings = {
        ..._liveSettings,
        ...partial,
        ...(partial.localModel
          ? {
              localModel: {
                profiles: partial.localModel.profiles ?? _liveSettings.localModel?.profiles ?? [],
                activeProfileId:
                  partial.localModel.activeProfileId
                  ?? _liveSettings.localModel?.activeProfileId
                  ?? null,
              },
            }
          : {}),
      };
    },
    updateSettingsAtomic: (updater) => {
      _liveSettings = { ..._liveSettings, ...updater(_liveSettings) };
    },
  });
}

function getLiveSettings(): AppSettings {
  return _liveSettings;
}

// ---------------------------------------------------------------------------
// Helpers — fetch responses
// ---------------------------------------------------------------------------

function makeAnthropicSuccess(text = '{"ok":true}'): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      model: 'claude-sonnet-4-20250514',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeAnthropicSuccessWithORCost(cost: number | null | undefined, provider?: string): Response {
  const usage: Record<string, unknown> = {
    input_tokens: 10,
    output_tokens: 5,
  };
  if (cost !== undefined && cost !== null) usage.cost = cost;
  const init: ResponseInit = {
    status: 200,
    headers: provider
      ? { 'content-type': 'application/json', 'x-rebel-or-provider': provider }
      : { 'content-type': 'application/json' },
  };
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text: '{"ok":true}' }],
      model: 'anthropic/claude-sonnet-4',
      usage,
    }),
    init,
  );
}

function makeProfileSuccess(text = '{"ok":true}', extra: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: text, ...extra }, finish_reason: 'stop' }],
      model: 'test/model',
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeHttpError(status: number, body: string, contentType = 'application/json'): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

function makeSseResponse(): Response {
  return new Response(
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function getFetchBody(call: Parameters<typeof fetch>): Record<string, unknown> {
  const init = call[1];
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

function getFetchHeaders(call: Parameters<typeof fetch>): Record<string, string> {
  const init = call[1];
  return (init?.headers as Record<string, string>) ?? {};
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Clear cooldown / dedupe / strike state between tests BEFORE clearing
  // mocks: apiRateLimitCooldown.recordSuccess() broadcasts a 'cooldown_exit'
  // event via broadcastCooldownStatus → broadcastSendToAllWindowsMock when
  // the cooldown was previously active (e.g. left over from INV-5a's
  // recordRateLimit). If we cleared mocks first, that broadcast would
  // pollute the call count of broadcastSendToAllWindowsMock that subsequent
  // tests like INV-11 inspect, causing deterministic shuffled-order flakes.
  apiRateLimitCooldown.recordSuccess();
  safetyEvalRateLimitCooldown.recordSuccess();
  __resetJsonParseFailureStrikesForTesting();
  __resetStructuredOutputBypassNoticesForTesting();
  _resetCodexBtsCaptureDedupeForTests();
  _resetWarnedModelsForTesting();

  vi.clearAllMocks();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
  registerBtsProxyProviders({ url: () => 'http://127.0.0.1:9999', auth: () => 'test-proxy-token' });
  // Reset OAuth hook to a no-op so OAuth tests can register their own.
  registerPreOAuthCallHook(async () => {});
  // Reset getTurnContext to default (undefined) for tests that don't override.
  vi.mocked(getTurnContext).mockReturnValue(undefined);
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
});

// ===========================================================================
// SECTION 1 — Routing / dispatch invariants
// ===========================================================================

// ---------------------------------------------------------------------------
// INV-1 — Every transport throws a `ModelError` (with `kind` + `status`) on
// 4xx, not a generic Error. 260428 regressed this for `callProfileHttp`.
//
// PMs: 260428 (bts_c2_marker_overbroad_and_merge_classification_regression),
//      260427 (openrouter_structured_output_prose).
// File ref: src/core/services/behindTheScenesClient.ts §callAnthropic L649,
//   §callViaOpenRouterProxy L869, §callViaCodexProxy L1006,
//   §callProfileHttp L2009.
// ---------------------------------------------------------------------------
describe('INV-1 — every fetch transport throws classified ModelError on 4xx', () => {
  it('INV-1a: anthropic-direct 400 → ModelError with kind/status (not generic Error)', async () => {
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeHttpError(400, JSON.stringify({ error: { message: 'bad' } })));

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).status).toBe(400);
    expect((err as ModelError).kind).toBeDefined();
  });

  it('INV-1b: openrouter-proxy 400 → ModelError', async () => {
    setupAdapter(makeOpenRouterSettings());
    fetchSpy.mockResolvedValueOnce(makeHttpError(400, JSON.stringify({ error: { message: 'bad' } })));

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).status).toBe(400);
  });

  it('INV-1c: codex-proxy 400 → ModelError', async () => {
    const settings = makeProfileSettings(
      {
        id: CODEX_BTS_PROFILE_ID,
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      },
      { behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}` },
    );
    setupAdapter(settings);
    fetchSpy.mockResolvedValueOnce(makeHttpError(400, JSON.stringify({ error: { message: 'bad' } })));

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      { messages: TEST_MESSAGES, codexConnectivity: 'connected' },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).status).toBe(400);
  });

  it('INV-1d: profile-http 400 → ModelError (260428 regression boundary; was generic Error)', async () => {
    setupAdapter(makeProfileSettings());
    // withTransientRetry only re-runs on 5xx / network errors; 400 propagates immediately.
    fetchSpy.mockResolvedValueOnce(makeHttpError(400, JSON.stringify({ error: { message: 'bad' } })));

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// INV-2 — Every BTS entry point accepting `options.outputFormat` MUST wrap
// through `executeWithStructuredOutputProfileFallback`. 260428 regressed
// this for `callWithModel` (Issue 3 in the PM).
//
// PM: 260428 (bts_c2_marker_overbroad — Issue 3 missing JSON-capability
// runtime guard on `callWithModel`).
// File ref: callBehindTheScenes L739, callWithModel L2015,
//   callBehindTheScenesWithAuth L2412, callWithModelAuthAware L2495.
// Observable signal: when the primary call returns non-parseable text,
// the wrapper retries against DEFAULT_AUXILIARY_MODEL — fetch is therefore
// invoked twice. Without the wrapper, fetch would be invoked once and the
// caller would receive un-parseable text.
// ---------------------------------------------------------------------------
describe('INV-2 — every entry point wraps through executeWithStructuredOutputProfileFallback', () => {
  function arrangeProfileNonJsonThenAuxJson(): void {
    setupAdapter(makeProfileSettings());
    fetchSpy
      .mockResolvedValueOnce(makeProfileSuccess('not parseable text'))
      .mockResolvedValueOnce(makeAnthropicSuccess('{"ok":true}'));
  }

  it('INV-2a: callBehindTheScenes wraps through fallback (parse failure → DEFAULT_AUXILIARY_MODEL)', async () => {
    arrangeProfileNonJsonThenAuxJson();
    await callBehindTheScenes(getLiveSettings(), {
      codexConnectivity: 'unknown',
      messages: TEST_MESSAGES,
      outputFormat: { type: 'json_schema', schema: { type: 'object' } },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('INV-2b: callBehindTheScenesWithAuth wraps through fallback', async () => {
    arrangeProfileNonJsonThenAuxJson();
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('INV-2c: callWithModel wraps through fallback (260428 Issue 3 regression boundary)', async () => {
    arrangeProfileNonJsonThenAuxJson();
    const settings = getLiveSettings();
    await callWithModel(
      'fake-ant-test',
      `profile:${settings.localModel?.profiles?.[0]?.id ?? ''}`,
      settings.localModel,
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('INV-2d: callWithModelAuthAware wraps through fallback', async () => {
    arrangeProfileNonJsonThenAuxJson();
    const settings = getLiveSettings();
    await callWithModelAuthAware(
      settings,
      `profile:${settings.localModel?.profiles?.[0]?.id ?? ''}`,
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// INV-3 — Legacy `callBehindTheScenes` intentionally bypasses cooldown
// (Atlas Insights search depends on it). The other three entry points
// gate on cooldown.
//
// PM: 260429 (bts_callwithmodelauthaware_cooldown_bypass) — sibling regression.
// File ref: L719 ("NOTE: This legacy entry point intentionally does NOT
//   check rate-limit cooldown.").
// ---------------------------------------------------------------------------
describe('INV-3 — callBehindTheScenes bypasses cooldown (user-triggered Atlas Insights)', () => {
  it('INV-3: callBehindTheScenes proceeds to fetch even when api cooldown is active', async () => {
    apiRateLimitCooldown.recordRateLimit(10_000);
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenes(getLiveSettings(), {
      codexConnectivity: 'unknown', messages: TEST_MESSAGES });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// INV-4 — `callBehindTheScenesWithAuth` and `callWithModelAuthAware` MUST
// fail-fast with `ModelError(rate_limit, selfImposed: true, status: 429,
// resetAtMs)` when the relevant cooldown singleton is unavailable.
//
// PM: 260429 (bts_callwithmodelauthaware_cooldown_bypass) — merge resolution
// dropped this pre-check on `callWithModelAuthAware`; 8h-to-discovery via
// test failure.
// File ref: L2415-2430 (callBehindTheScenesWithAuth pre-check),
//   L2497-2511 (callWithModelAuthAware pre-check).
// ---------------------------------------------------------------------------
describe('INV-4 — auth-aware entry points fail-fast on cooldown with self-imposed rate_limit', () => {
  it('INV-4a: callBehindTheScenesWithAuth throws ModelError(rate_limit, selfImposed:true) without calling fetch when api cooldown is active', async () => {
    apiRateLimitCooldown.recordRateLimit(10_000);
    setupAdapter(makeAnthropicDirectSettings());

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'compaction' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    const me = err as ModelError;
    expect(me.kind).toBe('rate_limit');
    expect(me.status).toBe(429);
    expect(me.details?.selfImposed).toBe(true);
    expect(me.resetAtMs).toBeGreaterThan(Date.now() - 1000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('INV-4b: callWithModelAuthAware throws ModelError(rate_limit, selfImposed:true) without calling fetch when api cooldown is active (260429 regression boundary)', async () => {
    apiRateLimitCooldown.recordRateLimit(10_000);
    setupAdapter(makeAnthropicDirectSettings());

    const err = await callWithModelAuthAware(
      getLiveSettings(),
      'claude-sonnet-4-20250514',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    const me = err as ModelError;
    expect(me.kind).toBe('rate_limit');
    expect(me.status).toBe(429);
    expect(me.details?.selfImposed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// INV-5 — `callWithModelAuthAware` selects `safetyEvalRateLimitCooldown`
// when `tracking?.category === 'safety'`; otherwise `apiRateLimitCooldown`.
//
// PM: 260502 (safety_eval_rate_limit_cooldown_parity_gap) — cooldown
// defense on `agentTurnExecutor` never propagated to safety eval / BTS
// siblings; 28-day discovery, REBEL-188.
// File ref: L2493 (`const effectiveCooldown = tracking?.category === 'safety'
//   ? safetyEvalRateLimitCooldown : apiRateLimitCooldown`).
// ---------------------------------------------------------------------------
describe('INV-5 — callWithModelAuthAware uses safetyEval bucket for category=safety, api bucket otherwise', () => {
  it('INV-5a: api cooldown active + safety category → call proceeds (safety bucket is clear)', async () => {
    apiRateLimitCooldown.recordRateLimit(10_000);
    safetyEvalRateLimitCooldown.recordSuccess();
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callWithModelAuthAware(
      getLiveSettings(),
      'claude-sonnet-4-20250514',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'safety' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('INV-5b: safety cooldown active + safety category → fail-fast', async () => {
    apiRateLimitCooldown.recordSuccess();
    safetyEvalRateLimitCooldown.recordRateLimit(10_000);
    setupAdapter(makeAnthropicDirectSettings());

    const err = await callWithModelAuthAware(
      getLiveSettings(),
      'claude-sonnet-4-20250514',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'safety' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('rate_limit');
    expect((err as ModelError).details?.selfImposed).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('INV-5c: safety cooldown active + non-safety category → call proceeds (api bucket is clear)', async () => {
    apiRateLimitCooldown.recordSuccess();
    safetyEvalRateLimitCooldown.recordRateLimit(10_000);
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callWithModelAuthAware(
      getLiveSettings(),
      'claude-sonnet-4-20250514',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// INV-6 — Codex profile BTS calls MUST throw `CodexDisconnectedBtsError`
// when Codex is the active profile but not connected. Sentry capture goes
// through `captureKnownCondition('codex_disconnected_bts')` with per-session
// dedupe (200-entry LRU) and unscoped 5-minute rate-limit.
//
// PMs: 260427 (codex_disconnected_bts_sentry_fragmentation) — 16 fragmented
//   Sentry issues / 1.2k events / 48h; fixed with per-session dedupe.
//      260424 (sentry_model_error_fingerprint_fragmentation) — proposed
//   `sentry-fingerprint-for-structured-errors` boundary entry.
// File ref: L378-410 (throwCodexDisconnectedBtsError + dedupe).
// ---------------------------------------------------------------------------
describe('INV-6 — Codex profile + disconnected → CodexDisconnectedBtsError + captureKnownCondition with dedupe', () => {
  it('INV-6a: throws CodexDisconnectedBtsError without calling fetch', async () => {
    const settings = makeProfileSettings(
      {
        id: CODEX_BTS_PROFILE_ID,
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      },
      { behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}` },
    );
    setupAdapter(settings);

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      { messages: TEST_MESSAGES, codexConnectivity: 'disconnected' },
      { category: 'safety' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CodexDisconnectedBtsError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('INV-6b: captureKnownCondition is per-session LRU-deduped — same sessionId across two calls fires Sentry once', async () => {
    // PM: 260427 (codex_disconnected_bts_sentry_fragmentation) — 16 fragmented
    // Sentry issues / 1.2k events / 48h were caused by per-call Sentry
    // captures; per-session LRU dedupe is the regression boundary.
    // Override getTurnContext per-call to provide a synthetic sessionId so
    // we exercise the LRU dedupe path (sessionId branch in
    // shouldCaptureCodexBtsDisconnect L396-403), not the unscoped 5-min
    // rate-limit path (L405-407) which would fire on undefined sessionId.
    vi.mocked(getTurnContext)
      .mockReturnValueOnce({ turnId: 'turn-1', sessionId: 'session-A' })
      .mockReturnValueOnce({ turnId: 'turn-2', sessionId: 'session-A' });

    const settings = makeProfileSettings(
      {
        id: CODEX_BTS_PROFILE_ID,
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      },
      { behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}` },
    );
    setupAdapter(settings);

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      { messages: TEST_MESSAGES, codexConnectivity: 'disconnected' },
      { category: 'safety' },
    ).catch(() => undefined);
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      { messages: TEST_MESSAGES, codexConnectivity: 'disconnected' },
      { category: 'safety' },
    ).catch(() => undefined);

    const codexCalls = captureKnownConditionMock.mock.calls.filter(
      (c) => c[0] === 'codex_disconnected_bts',
    );
    expect(codexCalls.length).toBe(1);
  });

  it('INV-6c: per-session dedupe is independent — different sessionIds capture independently', async () => {
    // PM: 260427 (codex_disconnected_bts_sentry_fragmentation) — counterpart
    // to INV-6b: assert two distinct sessions each capture once. Together
    // INV-6b + INV-6c pin the LRU dedupe shape (per-key) and rule out any
    // future regression that flips it to a global one-shot.
    vi.mocked(getTurnContext)
      .mockReturnValueOnce({ turnId: 'turn-1', sessionId: 'session-A' })
      .mockReturnValueOnce({ turnId: 'turn-2', sessionId: 'session-B' });

    const settings = makeProfileSettings(
      {
        id: CODEX_BTS_PROFILE_ID,
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      },
      { behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}` },
    );
    setupAdapter(settings);

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      { messages: TEST_MESSAGES, codexConnectivity: 'disconnected' },
      { category: 'safety' },
    ).catch(() => undefined);
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      { messages: TEST_MESSAGES, codexConnectivity: 'disconnected' },
      { category: 'safety' },
    ).catch(() => undefined);

    const codexCalls = captureKnownConditionMock.mock.calls.filter(
      (c) => c[0] === 'codex_disconnected_bts',
    );
    expect(codexCalls.length).toBe(2);
  });
});

// ===========================================================================
// SECTION 2 — Structured-output / capability invariants
// ===========================================================================

// ---------------------------------------------------------------------------
// INV-7 — The catch-branch silent-reroute gate
// `isStructuredOutputCapabilityError` MUST exclude: rate_limit, auth,
// billing, moderation, server_error, context_overflow, model_unavailable,
// abort, transient network, chat-incompatibility, aborted signals.
//
// PM: 260428 (bts_catch_branch_silent_reroute) — unconditional catch-branch
// fallback silently rerouted 429/auth/abort/server errors to Claude. Direct
// violation of "Silent failure is a bug".
// File ref: L1547-1611 (isStructuredOutputCapabilityError).
//
// Observable signal: when a profile's primary call fails with one of the
// excluded kinds, the wrapper does NOT call DEFAULT_AUXILIARY_MODEL — the
// classified error propagates verbatim to the caller.
// ---------------------------------------------------------------------------
describe('INV-7 — isStructuredOutputCapabilityError excludes non-capability error classes (no silent reroute)', () => {
  it('INV-7a: profile 429 (rate_limit) → no fallback to DEFAULT_AUXILIARY_MODEL; rate_limit propagates', async () => {
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'too many requests' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('rate_limit');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('INV-7b: profile 401 (auth) → no fallback; auth propagates', async () => {
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'invalid api key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('auth');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('INV-7c: aborted signal → no fallback; abort propagates', async () => {
    setupAdapter(makeProfileSettings());
    const ac = new AbortController();
    ac.abort();

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        signal: ac.signal,
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeDefined();
    // Aborted before the network call could complete — no DEFAULT_AUXILIARY_MODEL fallback.
    const auxCalls = fetchSpy.mock.calls.filter((c: Parameters<typeof fetch>) => {
      const url = c[0];
      return typeof url === 'string' && url.includes('api.anthropic.com');
    });
    expect(auxCalls.length).toBe(0);
  });

  it('INV-7d: profile 400 with response_format-not-supported phrase → fallback to DEFAULT_AUXILIARY_MODEL', async () => {
    setupAdapter(makeProfileSettings());
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'response_format is not supported by this model' } }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(makeAnthropicSuccess('{"ok":true}'));

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// INV-8 — `markProfileJsonIncompatible` MUST NOT fire when
// `isStructuredOutputCapabilityError` is false. Sticky settings mutation
// is allow-list-gated.
//
// PM: 260428 (bts_c2_marker_overbroad) — sticky JSON-incompat marker
// triggered by 429/auth blips; transient errors flipped user's profile
// permanently.
// File ref: L1583-1605 (NON_JSON_CAPABILITY_KINDS skip-list).
// ---------------------------------------------------------------------------
describe('INV-8 — markProfileJsonIncompatible does NOT fire on non-capability errors', () => {
  it('INV-8: profile 429 with structured-output request does NOT mark profile as JSON-incompatible (260428 regression boundary)', async () => {
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'too many requests' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch(() => undefined);

    const profile = getLiveSettings().localModel?.profiles?.[0];
    expect(profile?.jsonCompatibility).toBeUndefined();
    expect(profile?.jsonCompatibilityCheckedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INV-9 — Post-response parse-failure path requires
// `JSON_PARSE_FAILURE_STRIKE_THRESHOLD` (currently 2) consecutive failures
// before sticky-marking. A single transient non-JSON output does NOT mark.
//
// PM: 260521 BTS Haiku-fallback investigation — DA finding; led to the
// `JSON_PARSE_FAILURE_STRIKE_THRESHOLD` patch.
// File ref: L130-156 (strike counter), L1740-1760 (threshold gate).
// ---------------------------------------------------------------------------
describe('INV-9 — JSON_PARSE_FAILURE_STRIKE_THRESHOLD requires 2 consecutive failures before marking', () => {
  it('INV-9: first parse failure does NOT mark; second consecutive failure DOES mark', async () => {
    setupAdapter(makeProfileSettings());
    // First call: profile returns parseable-but-non-JSON; fallback to default succeeds. No mark.
    fetchSpy
      .mockResolvedValueOnce(makeProfileSuccess('not json'))
      .mockResolvedValueOnce(makeAnthropicSuccess('{"ok":true}'));
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );
    expect(getLiveSettings().localModel?.profiles?.[0]?.jsonCompatibility).toBeUndefined();

    // Second call (same profile): another parse failure; reaches threshold; marks.
    fetchSpy
      .mockResolvedValueOnce(makeProfileSuccess('still not json'))
      .mockResolvedValueOnce(makeAnthropicSuccess('{"ok":true}'));
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );
    expect(getLiveSettings().localModel?.profiles?.[0]?.jsonCompatibility).toBe('incompatible');
  });
});

// ---------------------------------------------------------------------------
// INV-10 — `markProfileJsonIncompatible` and `markProfileChatIncompatible`
// MUST skip Codex auto-profiles (`isCodexAutoProfile({ id })`). Auto-profiles
// are uneditable from the UI and re-seeded from constants on reconnect;
// persisting an incompatible verdict locks the resolver out with no recovery.
//
// PM: 260521 BTS Haiku-fallback investigation (auto-profile guard);
//     A0 unit test rationale captured in §markProfileGuard.test.ts.
// File ref: L106-115 (Chat marker guard), L172-181 (JSON marker guard).
// ---------------------------------------------------------------------------
describe('INV-10 — marker guards skip Codex auto-profiles', () => {
  it('INV-10a: __markProfileJsonIncompatibleForTesting on a Codex auto-profile leaves jsonCompatibility undefined', () => {
    setupAdapter(
      makeProfileSettings({
        id: CODEX_BTS_PROFILE_ID,
        name: 'GPT-5.4 mini (ChatGPT Pro)',
        authSource: 'codex-subscription',
      }),
    );

    __markProfileJsonIncompatibleForTesting(CODEX_BTS_PROFILE_ID);

    const profile = getLiveSettings().localModel?.profiles?.[0];
    expect(profile?.jsonCompatibility).toBeUndefined();
  });

  it('INV-10b: __markProfileChatIncompatibleForTesting on a Codex auto-profile leaves chatCompatibility undefined', () => {
    setupAdapter(
      makeProfileSettings({
        id: CODEX_BTS_PROFILE_ID,
        name: 'GPT-5.4 mini (ChatGPT Pro)',
        authSource: 'codex-subscription',
      }),
    );

    __markProfileChatIncompatibleForTesting(CODEX_BTS_PROFILE_ID);

    const profile = getLiveSettings().localModel?.profiles?.[0];
    expect(profile?.chatCompatibility).toBeUndefined();
  });

  it('INV-10c: regression guard — user/connection profile IS marked (parity with INV-10a/b skip)', () => {
    setupAdapter(makeProfileSettings({ id: 'user-profile-1' }));
    __markProfileJsonIncompatibleForTesting('user-profile-1');
    __markProfileChatIncompatibleForTesting('user-profile-1');
    const profile = getLiveSettings().localModel?.profiles?.[0];
    expect(profile?.jsonCompatibility).toBe('incompatible');
    expect(profile?.chatCompatibility).toBe('incompatible');
  });
});

// ---------------------------------------------------------------------------
// INV-11 — Structured-output bypass notification
// (`notifyStructuredOutputFallbackBypass`) is one-shot per process per
// `profileId`. Broadcasts via `getBroadcastService().sendToAllWindows`
// on `BTS_STRUCTURED_OUTPUT_BYPASS_CHANNEL` after Zod validation.
//
// PM: 260521 BTS Haiku-fallback investigation — without the toast the
// silent profile swap is invisible.
// File ref: L1820-1855 (notifyStructuredOutputFallbackBypass + dedupe Set).
// ---------------------------------------------------------------------------
describe('INV-11 — structured-output bypass notification is one-shot per process per profileId', () => {
  it('INV-11: two consecutive bypassed calls for the same profile broadcast exactly once', async () => {
    setupAdapter(
      makeProfileSettings({
        id: 'incompat-profile',
        jsonCompatibility: 'incompatible',
      }),
    );
    fetchSpy
      .mockResolvedValueOnce(makeAnthropicSuccess('{"ok":true}'))
      .mockResolvedValueOnce(makeAnthropicSuccess('{"ok":true}'));

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );

    expect(broadcastSendToAllWindowsMock).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// SECTION 3 — Provider / wire invariants
// ===========================================================================

// ---------------------------------------------------------------------------
// INV-12 — BTS calls are ALWAYS non-streaming. Every fetch transport sets
// `body.stream = false`. The Codex proxy used to force `stream: true`
// unconditionally — the diagnostic from `parseJsonResponseBody` catches
// any future regression.
//
// PMs: 260429 (bts_codex_proxy_sse_force_streaming) — Codex proxy returned
//   SSE to JSON clients; FAIL_CLOSED safety eval blocks for 15 days.
// File ref: callAnthropic L639, callViaOpenRouterProxy L859,
//   callViaCodexProxy L996.
// ---------------------------------------------------------------------------
describe('INV-12 — every fetch transport sets body.stream=false', () => {
  it('INV-12a: anthropic-direct request body has stream=false', async () => {
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(getFetchBody(fetchSpy.mock.calls[0]).stream).toBe(false);
  });

  it('INV-12b: openrouter-proxy request body has stream=false', async () => {
    setupAdapter(makeOpenRouterSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(getFetchBody(fetchSpy.mock.calls[0]).stream).toBe(false);
  });

  it('INV-12c: codex-proxy request body has stream=false (260429 regression boundary)', async () => {
    const settings = makeProfileSettings(
      {
        id: CODEX_BTS_PROFILE_ID,
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      },
      { behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}` },
    );
    setupAdapter(settings);
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      { messages: TEST_MESSAGES, codexConnectivity: 'connected' },
      { category: 'memory' },
    );

    expect(getFetchBody(fetchSpy.mock.calls[0]).stream).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-13 — `parseJsonResponseBody` MUST inspect content-type and body
// prefix; SSE responses raise a typed error before cooldown success
// recording. The Codex proxy / OR proxy paths record cooldown success ONLY
// after body parsing succeeds.
//
// PM: 260429 (bts_codex_proxy_sse_force_streaming) — provider returned SSE
// to non-streaming client; JSON.parse failed → FAIL_CLOSED block.
// File ref: parseJsonResponseBody L662-682; OR-proxy L935-941 (success
// recorded AFTER parse).
// ---------------------------------------------------------------------------
describe('INV-13 — parseJsonResponseBody throws on SSE before cooldown success is recorded', () => {
  it('INV-13a: SSE content-type → parseJsonResponseBody throws diagnostic error', async () => {
    await expect(parseJsonResponseBody(makeSseResponse())).rejects.toThrow(
      /BTS call received streaming response/,
    );
  });

  it('INV-13b: SSE on OR-proxy path → BTS call rejects, cooldown success NOT recorded', async () => {
    setupAdapter(makeOpenRouterSettings());
    const recordSuccessSpy = vi.spyOn(apiRateLimitCooldown, 'recordSuccess');
    fetchSpy.mockResolvedValueOnce(makeSseResponse());

    await expect(
      callBehindTheScenesWithAuth(
        getLiveSettings(),
        {
          codexConnectivity: 'unknown', messages: TEST_MESSAGES },
        { category: 'memory' },
      ),
    ).rejects.toThrow(/BTS call received streaming response/);

    expect(recordSuccessSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// INV-14 — Reasoning-model output handling: if `content` is empty and
// `reasoning_content` is present, fall back to reasoning text (via
// `extractOpenAITextFields`); apply `stripThinkingBlocks` to remove
// `<think>...</think>` from text.
//
// PM: 260427 (bts_reasoning_content_direct_profile) — MiniMax 2.7 /
// DeepSeek R1 `reasoning_content` dropped from direct-profile path; 55-day
// discovery (proxy path had it; asymmetric extraction).
// File ref: callProfileHttp L2020-2050.
// ---------------------------------------------------------------------------
describe('INV-14 — reasoning_content fallback + stripThinkingBlocks asymmetry pinned across profile-direct path', () => {
  it('INV-14a: profile-direct response with reasoning_content but empty content surfaces text from reasoning_content', async () => {
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '',
                reasoning_content: 'reasoning text answer',
              },
              finish_reason: 'stop',
            },
          ],
          model: 'test/model',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const response = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(response.content?.[0]?.text).toBe('reasoning text answer');
  });

  it('INV-14b: stripThinkingBlocks removes <think>...</think> embedded in profile-direct content', async () => {
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: '<think>internal</think>visible answer' },
              finish_reason: 'stop',
            },
          ],
          model: 'test/model',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const response = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(response.content?.[0]?.text).toBe('visible answer');
  });
});

// ---------------------------------------------------------------------------
// INV-15 — Non-Anthropic models on OR proxy and profile-direct paths get
// token-budget inflation (`max(callerMaxTokens × 4, 4096)` capped at 16384).
// On profile-direct, ONE retry with `× RETRY_INFLATION_FACTOR` when
// `finish_reason === 'length'` OR `_hasReasoningContent && empty content`.
//
// PMs: 260427 (bts_reasoning_content_direct_profile) — reasoning models
//   include thinking tokens in max_tokens budget.
// File ref: OR proxy L807-819; profile-direct retry L1894-1932.
// ---------------------------------------------------------------------------
describe('INV-15 — non-Anthropic OR proxy inflates max_tokens; profile-direct retries on truncation', () => {
  it('INV-15a: non-Anthropic OR-proxy with caller maxTokens=512 inflates to ≥4096 (≤16384)', async () => {
    setupAdapter(makeOpenRouterSettings({ behindTheScenesModel: 'minimax/minimax-m2.7' }));
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES, maxTokens: 512 },
      { category: 'memory' },
    );

    const body = getFetchBody(fetchSpy.mock.calls[0]);
    expect(body.max_tokens).toBeGreaterThanOrEqual(4096);
    expect(body.max_tokens).toBeLessThanOrEqual(16384);
  });

  it('INV-15b: profile-direct retries once when finish_reason=length on the first attempt', async () => {
    setupAdapter(makeProfileSettings({ providerType: 'together' }));
    // First call truncated; second call returns 'stop'.
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
            model: 'test/model',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(makeProfileSuccess('full answer'));

    const response = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(response.content?.[0]?.text).toBe('full answer');
    // Second call's max_completion_tokens must be larger than the first.
    const firstMax = getFetchBody(fetchSpy.mock.calls[0]).max_completion_tokens as number;
    const secondMax = getFetchBody(fetchSpy.mock.calls[1]).max_completion_tokens as number;
    expect(secondMax).toBeGreaterThan(firstMax);
  });
});

// ---------------------------------------------------------------------------
// INV-16 — Non-Anthropic structured-output requests get a "Respond with
// valid JSON." prompt prepend when no message contains the word "json"
// (case-insensitive). Applies to OR-proxy, Codex-proxy, profile-direct.
//
// PMs: 260427 (openrouter_structured_output_prose),
//      260405 (bts_json_parsing_fences).
// File ref: OR proxy L823-829, Codex proxy L968-974, profile-direct
//   L1973-1990.
// ---------------------------------------------------------------------------
describe('INV-16 — structured-output requests prepend "Respond with valid JSON." when no message mentions json', () => {
  it('INV-16a: OR-proxy non-Anthropic + structured output + no "json" in messages → system gets "Respond with valid JSON." appended', async () => {
    setupAdapter(makeOpenRouterSettings({ behindTheScenesModel: 'minimax/minimax-m2.7' }));
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'analyze this' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );

    const body = getFetchBody(fetchSpy.mock.calls[0]);
    expect(body.system).toContain('Respond with valid JSON.');
  });

  it('INV-16b: profile-direct + structured output + no "json" mention → system message contains JSON hint', async () => {
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(makeProfileSuccess('{"ok":true}'));

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'analyze this' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );

    const body = getFetchBody(fetchSpy.mock.calls[0]);
    const messages = body.messages as Array<{ role: string; content: string }>;
    const hasJsonHint = messages.some((m) => m.content.includes('Respond with valid JSON.'));
    expect(hasJsonHint).toBe(true);
  });

  it('INV-16c: when "json" already appears in caller messages, NO additional hint is prepended', async () => {
    setupAdapter(makeOpenRouterSettings({ behindTheScenesModel: 'minimax/minimax-m2.7' }));
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: [{ role: 'user', content: 'return JSON please' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    );

    const body = getFetchBody(fetchSpy.mock.calls[0]);
    const system = (body.system as string | undefined) ?? '';
    expect(system).not.toContain('Respond with valid JSON.');
  });
});

// ---------------------------------------------------------------------------
// INV-17 — `decodeSinkBoundaryModel` is the last-resort backstop for
// `model:` prefix bypass. A warn emission from this helper means a new
// bypass site exists.
//
// PM: 260505 (anthropic_prefix_not_stripped_before_native_wire) — wire-id
// canonicalization needed.
// File ref: L67-77 (decodeSinkBoundaryModel). Used at createBtsRoutePlan
// L432, executeWithStructuredOutputProfileFallback L1622, and
// callWithModelAuthAware L2491.
// ---------------------------------------------------------------------------
describe('INV-17 — decodeSinkBoundaryModel emits a warn when a `model:` prefix bypass survives to the sink', () => {
  it('INV-17: callWithModelAuthAware called with `model:claude-sonnet-4` warns about prefix bypass', async () => {
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callWithModelAuthAware(
      getLiveSettings(),
      'model:claude-sonnet-4-20250514',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    const warnedAboutSink = loggerWarnMock.mock.calls.some((call) => {
      const message = call[1];
      return typeof message === 'string' && message.includes('sink-boundary backstop');
    });
    expect(warnedAboutSink).toBe(true);
  });
});

// ===========================================================================
// SECTION 4 — Cost / observability invariants
// ===========================================================================

// ---------------------------------------------------------------------------
// INV-18 — `trackCostIfEnabled` is fire-and-forget; MUST NOT throw. Logs
// at `warn` once-per-model when tokens consumed but no pricing.
//
// PM: 260405 (bts_unpriced_model_silent_cost_skip) — silent debug-log when
// tokens consumed but no pricing; promoted to warn-once-per-model.
// File ref: trackCostIfEnabled L548-606 (entire fn wrapped in try/catch).
// ---------------------------------------------------------------------------
describe('INV-18 — trackCostIfEnabled is fire-and-forget (cost ledger errors do not throw)', () => {
  it('INV-18: appendCostEntry throwing does not break the BTS call', async () => {
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());
    appendCostEntryMock.mockImplementationOnce(() => {
      throw new Error('ledger exploded');
    });

    const response = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(response.content?.[0]?.text).toBe('{"ok":true}');
  });
});

// ---------------------------------------------------------------------------
// INV-19 — Cost source priority order: `_exactCostUsd` (OR `usage.cost`)
// → token-calculated → `_sdkCostUsd` (legacy).
//
// PM: 260405 (bts_unpriced_model_silent_cost_skip).
// File ref: trackCostIfEnabled L555-580.
// ---------------------------------------------------------------------------
describe('INV-19 — cost source priority: _exactCostUsd > token-calculated > _sdkCostUsd', () => {
  it('INV-19: OR proxy with usage.cost forwards exact cost to ledger (preferred over token calculation)', async () => {
    setupAdapter(makeOpenRouterSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccessWithORCost(0.0042, 'Anthropic'));

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(appendCostEntryMock).toHaveBeenCalledTimes(1);
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ cost: 0.0042 }),
    );
  });
});

// ---------------------------------------------------------------------------
// INV-20 — `outcomePolicy` defaults to `'auxiliary'` when tracking;
// turn-bearing calls set `{ kind: 'success' }`, late-resolve sets
// `undefined`.
//
// File ref: trackCostIfEnabled L592-598.
// ---------------------------------------------------------------------------
describe('INV-20 — outcomePolicy mapping pins ledger outcome shape', () => {
  it('INV-20a: default outcomePolicy → outcome { kind: auxiliary_success }', async () => {
    // PM: parity invariant (no specific postmortem; protects future Stages 7-10)
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: 'auxiliary_success' } }),
    );
  });

  it('INV-20b: outcomePolicy="turn_bearing" → outcome { kind: success }', async () => {
    // PM: parity invariant (no specific postmortem; protects future Stages 7-10)
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'safety', outcomePolicy: 'turn_bearing' },
    );
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: { kind: 'success' } }),
    );
  });

  it('INV-20c: outcomePolicy="late_resolve" → outcome undefined (omitted)', async () => {
    // PM: parity invariant (no specific postmortem; protects future Stages 7-10)
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'safety', outcomePolicy: 'late_resolve' },
    );
    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: undefined }),
    );
  });
});

// ---------------------------------------------------------------------------
// INV-21 — OpenRouter `usage.cost` MUST be `number && Number.isFinite &&
// >= 0` to be accepted as `_exactCostUsd`; otherwise omitted (token
// calculation takes over).
//
// File ref: callViaOpenRouterProxy L948-953.
// ---------------------------------------------------------------------------
describe('INV-21 — OR usage.cost validation: number ≥ 0 only, falsy/negative/non-finite rejected', () => {
  it('INV-21a: usage.cost = -1 → ignored (no _exactCostUsd; token-calculation path may produce a different cost)', async () => {
    // PM: parity invariant (no specific postmortem; protects future Stages 7-10)
    setupAdapter(makeOpenRouterSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccessWithORCost(-1));

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    const ledgerCall = appendCostEntryMock.mock.calls[0]?.[0];
    expect(ledgerCall?.cost).not.toBe(-1);
  });

  it('INV-21b: usage.cost = "0.05" (string) → ignored', async () => {
    // PM: parity invariant (no specific postmortem; protects future Stages 7-10)
    setupAdapter(makeOpenRouterSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: 'anthropic/claude-sonnet-4',
          usage: { input_tokens: 10, output_tokens: 5, cost: '0.05' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    const ledgerCall = appendCostEntryMock.mock.calls[0]?.[0];
    expect(ledgerCall?.cost).not.toBe('0.05');
  });
});

// ---------------------------------------------------------------------------
// INV-22 — `_resolvedAuth` is injected as `tracking.auth` only when caller
// didn't explicitly set it; never overwrites. `_resolvedModel` is set on
// the response object before cost tracking.
//
// File ref: callBehindTheScenesWithAuth L2462-2475 (response augmentation
// + tracking auth injection).
// ---------------------------------------------------------------------------
describe('INV-22 — _resolvedAuth and _resolvedModel populated on response; tracking.auth not overwritten', () => {
  it('INV-22a: response carries _resolvedAuth and _resolvedModel after callBehindTheScenesWithAuth', async () => {
    // PM: 260520 (time-saved zero or missing cost-tracking metadata)
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    const response = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(response._resolvedAuth).toBeDefined();
    expect(response._resolvedModel).toBeDefined();
  });

  it('INV-22b: caller-provided tracking.auth is NOT overwritten by resolved auth', async () => {
    // PM: 260520 (time-saved zero or missing cost-tracking metadata)
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory', auth: 'caller-supplied-auth-label' },
    );

    expect(appendCostEntryMock).toHaveBeenCalledWith(
      expect.objectContaining({ auth: 'caller-supplied-auth-label' }),
    );
  });
});

// ===========================================================================
// SECTION 5 — Transient retry invariants
// ===========================================================================

// ---------------------------------------------------------------------------
// INV-23 — `isTransientNetworkError` MUST cover: status ∈ {500,502,503,504};
// `ModelError.kind === 'server_error' | 'network'`; messages including fetch-failed,
// econnrefused, etimedout, enotfound, ehostunreach, socket hang up,
// econnreset, parenthesized 5xx; `AggregateError` whose
// `.errors[].some(transient)`; recursive `.cause`. Order MATTERS:
// `instanceof AggregateError` before `instanceof Error` is the 260406
// regression boundary.
//
// PM: 260406 (aggregate_error_unreachable_branch) — `isTransientError` had
// `instanceof Error` before `instanceof AggregateError`; AggregateError
// branch unreachable.
// File ref: isTransientNetworkError L195-217.
// ---------------------------------------------------------------------------
describe('INV-23 — isTransientNetworkError covers all transient classes (incl. AggregateError ordering)', () => {
  it('INV-23a: status ∈ {500,502,503,504} on Error.status', () => {
    const e = new Error('overloaded') as Error & { status?: number };
    e.status = 503;
    expect(isTransientNetworkError(e)).toBe(true);
    e.status = 502;
    expect(isTransientNetworkError(e)).toBe(true);
    e.status = 500;
    expect(isTransientNetworkError(e)).toBe(true);
    e.status = 504;
    expect(isTransientNetworkError(e)).toBe(true);
  });

  it('INV-23b: ModelError.kind === "server_error" | "network"', () => {
    expect(isTransientNetworkError(new ModelError('server_error', 'overloaded', 503, 'Anthropic')))
      .toBe(true);
    expect(isTransientNetworkError(new ModelError('network', 'fetch failed', undefined, 'Anthropic')))
      .toBe(true);
  });

  it('INV-23c: message contains econnrefused / etimedout / enotfound / ehostunreach / socket hang up / econnreset', () => {
    expect(isTransientNetworkError(new Error('econnrefused 127.0.0.1'))).toBe(true);
    expect(isTransientNetworkError(new Error('Request etimedout'))).toBe(true);
    expect(isTransientNetworkError(new Error('enotfound hostname'))).toBe(true);
    expect(isTransientNetworkError(new Error('ehostunreach'))).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isTransientNetworkError(new Error('econnreset'))).toBe(true);
  });

  it('INV-23d: parenthesized 5xx in message — (500), (502), (503), (504)', () => {
    expect(isTransientNetworkError(new Error('API error (500)'))).toBe(true);
    expect(isTransientNetworkError(new Error('API error (502)'))).toBe(true);
    expect(isTransientNetworkError(new Error('API error (503)'))).toBe(true);
    expect(isTransientNetworkError(new Error('API error (504)'))).toBe(true);
  });

  it('INV-23e: AggregateError whose .errors[].some(transient) is detected (260406 branch ordering boundary)', () => {
    const inner = new Error('socket hang up');
    const aggregate = new AggregateError([new Error('not transient'), inner], 'multi');
    expect(isTransientNetworkError(aggregate)).toBe(true);
  });

  it('INV-23f: AggregateError with non-transient .errors but transient cause is still detected via cause recursion', () => {
    const transientCause = new Error('econnrefused');
    const aggregate = new AggregateError([new Error('boring')], 'cause-only', { cause: transientCause });
    expect(isTransientNetworkError(aggregate)).toBe(true);
  });

  it('INV-23g: recursive .cause is unwrapped', () => {
    const innerInner = new Error('ETIMEDOUT');
    const inner = Object.assign(new Error('mid'), { cause: innerInner });
    const outer = Object.assign(new Error('outer'), { cause: inner });
    expect(isTransientNetworkError(outer)).toBe(true);
  });

  it('INV-23h: ModelError(rate_limit) is NOT transient (kind discriminator excludes rate_limit)', () => {
    expect(isTransientNetworkError(new ModelError('rate_limit', '429', 429, 'Anthropic'))).toBe(false);
  });

  it('INV-23i: 400 API errors are NOT transient', () => {
    const err = new Error('Bad request');
    (err as Error & { status?: number }).status = 400;
    expect(isTransientNetworkError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// INV-24 — `withTransientRetry` does at most `TRANSIENT_RETRY_MAX = 3`
// attempts; respects caller `AbortSignal`.
//
// File ref: withTransientRetry L226-244.
// Observable: anthropic-direct path is wrapped via withTransientRetry. We
// drive a pre-aborted signal to confirm short-circuit; for retry-count we
// drive transient errors and observe attempt-count via fetchSpy.
// ---------------------------------------------------------------------------
describe('INV-24 — withTransientRetry attempt cap and AbortSignal short-circuit', () => {
  // XXX defect: pre-aborted signal currently causes ONE fetch call before
  // the AbortSignal.any() composition triggers DOMException AbortError inside
  // fetch. The strict invariant ("no work after abort") would prefer fetch
  // not to be invoked at all when the caller's signal is already aborted at
  // call time. Stage 7 should add an explicit pre-flight `if (signal?.aborted)`
  // check at the top of `callAnthropic` / `callViaOpenRouterProxy` /
  // `callViaCodexProxy` / `callDirectWithProfile`. Tracking: Stage 7 boundary
  // entry `bts-pre-flight-abort-check`.
  it.skip('INV-24a (strict): pre-aborted signal causes ZERO fetch calls (defect-marker; production currently calls fetch once)', async () => {
    // PM: parity invariant (no specific postmortem; protects future Stages 7-10)
    setupAdapter(makeAnthropicDirectSettings());
    const ac = new AbortController();
    ac.abort();

    await expect(
      callBehindTheScenesWithAuth(
        getLiveSettings(),
        {
          codexConnectivity: 'unknown', messages: TEST_MESSAGES, signal: ac.signal },
        { category: 'memory' },
      ),
    ).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('INV-24a (current): pre-aborted signal causes ≤1 fetch call and never retries', async () => {
    // PM: parity invariant (no specific postmortem; protects future Stages 7-10)
    // Pins TODAY's behaviour: fetch may be invoked once because
    // `AbortSignal.any([options.signal, timeoutController.signal])` lets
    // fetch start, then aborts inside it. withTransientRetry's `if
    // (signal?.aborted) throw err` short-circuits the retry loop after the
    // first throw, so the cap is exactly 1, not 3. Counterpart to the
    // skipped strict invariant above; flipping this to ===1 (rather than
    // ≤1) is intentional — it documents the no-retry-after-abort contract.
    setupAdapter(makeAnthropicDirectSettings());
    const ac = new AbortController();
    ac.abort();

    await expect(
      callBehindTheScenesWithAuth(
        getLiveSettings(),
        {
          codexConnectivity: 'unknown', messages: TEST_MESSAGES, signal: ac.signal },
        { category: 'memory' },
      ),
    ).rejects.toThrow();
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('INV-24b: a non-transient 400 error does NOT retry — fetch called exactly once', async () => {
    // PM: parity invariant (no specific postmortem; protects future Stages 7-10)
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValue(makeHttpError(400, JSON.stringify({ error: { message: 'bad' } })));

    await expect(
      callBehindTheScenesWithAuth(
        getLiveSettings(),
        {
          codexConnectivity: 'unknown', messages: TEST_MESSAGES },
        { category: 'memory' },
      ),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// SECTION 6 — Auth / pre-call invariants
// ===========================================================================

// ---------------------------------------------------------------------------
// INV-25 — `_preOAuthCallHook` (registered by main as
// `ensureClaudeMaxTokenFresh`) MUST run before any OAuth-token Anthropic
// call. Cloud must register an equivalent or the path is desktop-only.
//
// PM: 260327 (cloud_bts_token_refresh) — `registerPreOAuthCallHook` wired
// in desktop but not in cloud bootstrap; Claude-Max-only mobile users hit
// 401 storms.
// File ref: callAnthropicWithPlan L739-751 (oauth branch invokes hook
// before calling SDK).
// ---------------------------------------------------------------------------
describe('INV-25 — preOAuthCallHook fires before OAuth-token Anthropic call', () => {
  it('INV-25a: callBehindTheScenesWithAuth — preOAuthCallHook runs strictly before SDK messages.create (ordered events array)', async () => {
    // PM: 260327 (cloud_bts_token_refresh) — ordered-events array replaces
    // the prior Date.now() comparison so a hook that fires concurrently or
    // after the SDK call cannot accidentally pass the assertion.
    setupAdapter(makeOAuthSettings());
    const events: string[] = [];
    registerPreOAuthCallHook(async () => {
      events.push('hook-called');
      preOAuthHookMock();
    });
    anthropicMessagesCreateMock.mockImplementation(async () => {
      events.push('fetch-called');
      return {
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(preOAuthHookMock).toHaveBeenCalledTimes(1);
    expect(anthropicMessagesCreateMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['hook-called', 'fetch-called']);
  });
});

// ---------------------------------------------------------------------------
// INV-26 — the BTS proxy URL/auth providers are registered per-surface
// (desktop via `btsProxyManager`; cloud via the same import) through the single
// atomic `registerBtsProxyProviders({url, auth})` seam.
// Tests at `cloud-service/src/__tests__/bootstrap.proxyProviders.test.ts`
// enforce parity. Here: assert that the registered providers are actually
// consumed by the OR-proxy and Codex-proxy transports.
//
// PM: 260424 (safety_eval_unavailable_5_gap_fixes) — proposed
// `bts-codex-connected-injection-sites` boundary entry.
// Seam: registerBtsProxyProviders (src/core/services/bts/transports/shared.ts),
//   consumed by OR-proxy + Codex-proxy via resolveBtsProxyForTransport().
// ---------------------------------------------------------------------------
describe('INV-26 — registered proxy URL/auth providers are consumed by OR-proxy and Codex-proxy transports', () => {
  it('INV-26a: OR-proxy uses the registered proxy URL and auth header', async () => {
    registerBtsProxyProviders({ url: () => 'http://test-proxy:1234', auth: () => 'inv26-token' });
    setupAdapter(makeOpenRouterSettings());
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    const url = fetchSpy.mock.calls[0]?.[0];
    const headers = getFetchHeaders(fetchSpy.mock.calls[0]);
    expect(url).toBe('http://test-proxy:1234/v1/messages');
    expect(headers['x-proxy-auth']).toBe('inv26-token');
    expect(headers['x-openrouter-turn']).toBe('true');
  });

  it('INV-26b: Codex-proxy uses the registered proxy URL and auth header', async () => {
    registerBtsProxyProviders({ url: () => 'http://test-proxy:1234', auth: () => 'inv26-codex-token' });
    const settings = makeProfileSettings(
      {
        id: CODEX_BTS_PROFILE_ID,
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      },
      { behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}` },
    );
    setupAdapter(settings);
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      { messages: TEST_MESSAGES, codexConnectivity: 'connected' },
      { category: 'memory' },
    );

    const url = fetchSpy.mock.calls[0]?.[0];
    const headers = getFetchHeaders(fetchSpy.mock.calls[0]);
    expect(url).toBe('http://test-proxy:1234/v1/messages');
    expect(headers['x-proxy-auth']).toBe('inv26-codex-token');
    expect(headers['x-codex-turn']).toBe('true');
  });
});

// ===========================================================================
// SECTION 7 — Stage 6 supplement (heavy-mode tester findings F1–F5)
//
// Added after the heavy-mode tester REJECTED the initial 62-case Stage 6
// for partial per-transport symmetry (F1), missing INV-7 excluded-kind
// coverage (F2), un-encoded source-invariant subclauses (F3), missing PM
// citations (F4), and three tests that didn't genuinely test what they
// claimed (F5 — addressed in-place above on INV-6b, INV-24a, INV-25).
//
// Tests below CLOSE F1, F2, F3 by adding the missing per-transport,
// per-error-kind, and per-subclause cases. Defect-marker tests
// (`it.skip` + `// XXX defect:` annotation) flag the production-side
// gaps Stage 7+ must address — keeping this stage's zero-production-
// code-change discipline intact.
// ===========================================================================

// ---------------------------------------------------------------------------
// F1 SUPPLEMENT — INV-1 cross-transport symmetry (anthropic-compatible-proxy
// + OAuth defect-marker)
//
// Source invariant (INV-1): every transport function — `callAnthropic`,
// `callAnthropicWithOAuthToken`, `callViaAnthropicCompatibleProxy`,
// `callViaOpenRouterProxy`, `callViaCodexProxy`, `callProfileHttp` — MUST
// throw a `ModelError` (with `kind` + `status`) on 4xx, not a generic
// `Error`. Initial Stage 6 covered 4 of 6; this closes the gap.
// ---------------------------------------------------------------------------
describe('INV-1 SUPPLEMENT — anthropic-compatible-proxy + OAuth-token transports', () => {
  it('INV-1e: callViaAnthropicCompatibleProxy 400 → ModelError (synthetic-routing pattern)', async () => {
    // PM: 260428 (bts_c2_marker_overbroad) — symmetry across all transports.
    // This transport is not naturally selected for `role=bts` (Google
    // profiles route to openai-compatible-http per providerRouting.ts), so
    // we inject a synthetic dispatch decision via ProviderRouter.forBTS spy
    // — same pattern as `behindTheScenesClient.transportContractParity.test.ts`
    // line 240+ ("anthropic-compatible-local-proxy").
    setupAdapter(makeAnthropicDirectSettings());
    const forBtsSpy = vi.spyOn(ProviderRouter, 'forBTS').mockReturnValueOnce({
      kind: 'dispatchable',
      transport: 'anthropic-compatible-local-proxy',
      dispatchPath: 'local-proxy-passthrough',
      provider: 'profile',
      modelDialect: 'profile-ref',
      role: 'bts',
      routeScope: 'normal-turn',
      canonicalModelId: 'claude-sonnet-4-20250514',
      wireModelId: brandRouteWireModel('claude-sonnet-4-20250514'),
      profileId: null,
      resolvedFrom: 'settings',
      codexConnectivity: 'unknown',
      fallbackHint: null,
      credentialSource: 'profile-api-key',
      invalidReason: 'none',
    } as unknown as DispatchableRouteDecision);
    fetchSpy.mockResolvedValueOnce(makeHttpError(400, JSON.stringify({ error: { message: 'bad' } })));

    try {
      const err = await callBehindTheScenesWithAuth(
        getLiveSettings(),
        {
          codexConnectivity: 'unknown', messages: TEST_MESSAGES },
        { category: 'memory' },
      ).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ModelError);
      expect((err as ModelError).status).toBe(400);
      expect((err as ModelError).kind).toBeDefined();
    } finally {
      forBtsSpy.mockRestore();
    }
  });

  // XXX defect: callAnthropicWithOAuthToken (line 2289) classifies the SDK
  // error for cooldown-recording purposes but rethrows the original
  // Anthropic.APIError, NOT a ModelError. The upstream
  // executeWithStructuredOutputProfileFallback catch-branch only re-classifies
  // when isStructuredOutputCapabilityError matches; for plain 4xx without
  // outputFormat, the raw APIError surfaces to the caller. Stage 7 should
  // unify the OAuth path with the api-key path — wrap callAnthropicWithOAuthToken
  // in an explicit `throw classifyError(error)` after cooldown bookkeeping.
  // Tracking: Stage 7 boundary entry `bts-oauth-error-classification`.
  it.skip('INV-1f: callAnthropicWithOAuthToken 4xx → ModelError (defect-marker; production rethrows raw SDK APIError)', async () => {
    // PM: 260428 (bts_c2_marker_overbroad) — extends INV-1 symmetry to OAuth path.
    setupAdapter(makeOAuthSettings());
    const apiError = Object.assign(new Error('bad'), {
      status: 400,
      name: 'APIError',
    });
    anthropicMessagesCreateMock.mockRejectedValueOnce(apiError);

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// F1 SUPPLEMENT — INV-12 cross-transport stream=false symmetry
// (anthropic-compatible-proxy + profile-http defect markers).
//
// Source invariant (INV-12): every fetch transport sets `body.stream = false`.
// Initial Stage 6 covered 3 of the 5 fetch transports; this closes the gap.
// ---------------------------------------------------------------------------
describe('INV-12 SUPPLEMENT — anthropic-compatible-proxy + profile-http stream=false', () => {
  // XXX defect: callViaAnthropicCompatibleProxy (line 1419) does NOT set
  // `body.stream = false` — visible in transportContractParity.test.ts which
  // omits the assertion for this transport. The proxy serves OAuth-token
  // OR Anthropic-compatible passthroughs; if upstream defaults to streaming,
  // BTS clients see SSE responses (same class as the 260429 Codex SSE
  // regression). Stage 7 should pin stream:false at the body construction.
  // Tracking: Stage 7 boundary entry `bts-anthropic-compat-proxy-stream-false`.
  it.skip('INV-12d: callViaAnthropicCompatibleProxy body.stream=false (defect-marker; production does not currently pin)', async () => {
    // PM: 260429 (bts_codex_proxy_sse_force_streaming) — extends INV-12 symmetry.
    setupAdapter(makeAnthropicDirectSettings());
    const forBtsSpy = vi.spyOn(ProviderRouter, 'forBTS').mockReturnValueOnce({
      kind: 'dispatchable',
      transport: 'anthropic-compatible-local-proxy',
      dispatchPath: 'local-proxy-passthrough',
      provider: 'profile',
      modelDialect: 'profile-ref',
      role: 'bts',
      routeScope: 'normal-turn',
      canonicalModelId: 'claude-sonnet-4-20250514',
      wireModelId: brandRouteWireModel('claude-sonnet-4-20250514'),
      profileId: null,
      resolvedFrom: 'settings',
      codexConnectivity: 'unknown',
      fallbackHint: null,
      credentialSource: 'profile-api-key',
      invalidReason: 'none',
    } as unknown as DispatchableRouteDecision);
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess());

    try {
      await callBehindTheScenesWithAuth(
        getLiveSettings(),
        {
          codexConnectivity: 'unknown', messages: TEST_MESSAGES },
        { category: 'memory' },
      );
      expect(getFetchBody(fetchSpy.mock.calls[0]).stream).toBe(false);
    } finally {
      forBtsSpy.mockRestore();
    }
  });

  // XXX defect: callProfileHttp (line 2051) uses OpenAI's body shape with
  // `max_completion_tokens` and does NOT set `body.stream = false`. OpenAI-
  // compatible providers (OpenAI, Together, Mistral, Local LLMs) usually
  // default to non-streaming when `stream` is unset, but the defensive
  // pin is missing for parity with the Anthropic / OR / Codex transports.
  // Stage 7 should add stream:false at body construction.
  // Tracking: Stage 7 boundary entry `bts-profile-http-stream-false`.
  it.skip('INV-12e: callProfileHttp body.stream=false (defect-marker; production does not currently pin)', async () => {
    // PM: 260429 (bts_codex_proxy_sse_force_streaming) — extends INV-12 symmetry.
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(makeProfileSuccess());

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );
    expect(getFetchBody(fetchSpy.mock.calls[0]).stream).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F1 SUPPLEMENT — INV-25 cross-entry-point preOAuthCallHook coverage
// (callBehindTheScenes legacy + callWithModelAuthAware).
//
// Source invariant (INV-25): _preOAuthCallHook MUST run before any
// OAuth-token Anthropic call, regardless of which entry point dispatched.
// Initial Stage 6 covered only callBehindTheScenesWithAuth; this extends
// to the other two OAuth-dispatching entry points.
// ---------------------------------------------------------------------------
describe('INV-25 SUPPLEMENT — preOAuthCallHook fires from callBehindTheScenes + callWithModelAuthAware', () => {
  it('INV-25b: callBehindTheScenes legacy entry — preOAuthCallHook runs before SDK messages.create', async () => {
    // PM: 260327 (cloud_bts_token_refresh) — symmetry across OAuth-dispatching entry points.
    setupAdapter(makeOAuthSettings());
    const events: string[] = [];
    registerPreOAuthCallHook(async () => {
      events.push('hook-called');
      preOAuthHookMock();
    });
    anthropicMessagesCreateMock.mockImplementation(async () => {
      events.push('fetch-called');
      return {
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    await callBehindTheScenes(getLiveSettings(), {
      codexConnectivity: 'unknown', messages: TEST_MESSAGES });

    expect(preOAuthHookMock).toHaveBeenCalledTimes(1);
    expect(anthropicMessagesCreateMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['hook-called', 'fetch-called']);
  });

  it('INV-25c: callWithModelAuthAware — preOAuthCallHook runs before SDK messages.create', async () => {
    // PM: 260327 (cloud_bts_token_refresh) — symmetry across OAuth-dispatching entry points.
    setupAdapter(makeOAuthSettings());
    const events: string[] = [];
    registerPreOAuthCallHook(async () => {
      events.push('hook-called');
      preOAuthHookMock();
    });
    anthropicMessagesCreateMock.mockImplementation(async () => {
      events.push('fetch-called');
      return {
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-20250514',
        usage: { input_tokens: 10, output_tokens: 5 },
      };
    });

    await callWithModelAuthAware(
      getLiveSettings(),
      'claude-sonnet-4-20250514',
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(preOAuthHookMock).toHaveBeenCalledTimes(1);
    expect(anthropicMessagesCreateMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['hook-called', 'fetch-called']);
  });
});

// ---------------------------------------------------------------------------
// F2 SUPPLEMENT — INV-7 every excluded error kind gets its own discriminator
// case so any single-kind regression of `isStructuredOutputCapabilityError`
// fails a single test rather than slipping through.
//
// Source invariant (INV-7): the catch-branch silent-reroute gate MUST exclude:
// rate_limit, auth, billing, moderation, server_error, context_overflow,
// model_unavailable, abort, transient network, chat-incompatibility, aborted
// signals. Initial Stage 6 covered 4 of these (rate_limit, auth, abort,
// positive capability fallback); this closes the gap.
//
// Approach: each test fires a profile-direct call with `outputFormat` set
// and a specific upstream error shape. Because withTransientRetry wraps
// callDirectWithProfile, transient-network / server_error errors retry up
// to TRANSIENT_RETRY_MAX=3 times — the gate-check runs on the final
// classified error, NOT on the per-attempt throw. The signal-of-interest
// is "no DEFAULT_AUXILIARY_MODEL fallback fires" — we assert that no fetch
// call was made to the Anthropic Claude default URL.
// ---------------------------------------------------------------------------

function isAuxiliaryFallbackCall(call: Parameters<typeof fetch>): boolean {
  const url = call[0];
  return typeof url === 'string' && url.includes('api.anthropic.com');
}

describe('INV-7 SUPPLEMENT — every excluded error kind individually pinned (no silent reroute)', () => {
  it('INV-7e: profile 402 (billing) → no aux fallback; billing propagates', async () => {
    // PM: 260428 (bts_catch_branch_silent_reroute) — billing is one of the
    // NON_JSON_CAPABILITY_KINDS the gate excludes.
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'payment required' } }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('billing');
    expect(fetchSpy.mock.calls.filter(isAuxiliaryFallbackCall).length).toBe(0);
  });

  it('INV-7e2: callWithModelAuthAware billing path also propagates without aux fallback', async () => {
    // PM: 260428 — extends INV-7e symmetry to the other auth-aware entry point.
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'payment required' } }), {
        status: 402,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const settings = getLiveSettings();

    const err = await callWithModelAuthAware(
      settings,
      `profile:${settings.localModel?.profiles?.[0]?.id ?? ''}`,
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('billing');
    expect(fetchSpy.mock.calls.filter(isAuxiliaryFallbackCall).length).toBe(0);
  });

  it('INV-7f: profile 403 with metadata.reasons (moderation) → no aux fallback; moderation propagates', async () => {
    // PM: 260428 (bts_catch_branch_silent_reroute) — moderation is in
    // NON_JSON_CAPABILITY_KINDS skip-list.
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: 'flagged content',
            metadata: { reasons: ['violence'] },
          },
        }),
        {
          status: 403,
          headers: { 'content-type': 'application/json' },
        },
      ),
    );

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('moderation');
    expect(fetchSpy.mock.calls.filter(isAuxiliaryFallbackCall).length).toBe(0);
  });

  it('INV-7g: profile 503 (server_error) → withTransientRetry exhausts; no aux fallback; server_error propagates', async () => {
    // PM: 260428 (bts_catch_branch_silent_reroute) — server_error is in
    // NON_JSON_CAPABILITY_KINDS skip-list. withTransientRetry retries 3x
    // before propagating; we assert the final classified error and that no
    // DEFAULT_AUXILIARY_MODEL fallback fired.
    setupAdapter(makeProfileSettings());
    // Use mockImplementation so each retry attempt gets a fresh Response
    // (Response.body is single-read; mockResolvedValue would reuse and fail
    // with "Body is unusable" on the second retry attempt).
    fetchSpy.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: 'overloaded' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('server_error');
    expect(fetchSpy.mock.calls.filter(isAuxiliaryFallbackCall).length).toBe(0);
  }, 10000);

  it('INV-7h: profile 413 (context_overflow) → no aux fallback; context_overflow propagates', async () => {
    // PM: 260428 (bts_catch_branch_silent_reroute) — context_overflow is in
    // NON_JSON_CAPABILITY_KINDS skip-list.
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'request too large' } }), {
        status: 413,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('context_overflow');
    expect(fetchSpy.mock.calls.filter(isAuxiliaryFallbackCall).length).toBe(0);
  });

  it('INV-7i: profile 404 with "model not found" (model_unavailable) → no aux fallback', async () => {
    // PM: 260428 (bts_catch_branch_silent_reroute) — model_unavailable is in
    // NON_JSON_CAPABILITY_KINDS skip-list.
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'model not found: test/model' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );

    const err = await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ModelError);
    expect((err as ModelError).kind).toBe('model_unavailable');
    expect(fetchSpy.mock.calls.filter(isAuxiliaryFallbackCall).length).toBe(0);
  });

  it('INV-7j: profile transient network error (econnreset) → withTransientRetry exhausts; no aux fallback', async () => {
    // PM: 260428 (bts_catch_branch_silent_reroute) — transient network is in
    // NON_JSON_CAPABILITY_KINDS skip-list (via isTransientNetworkError).
    setupAdapter(makeProfileSettings());
    fetchSpy.mockRejectedValue(new Error('econnreset'));

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch(() => undefined);

    expect(fetchSpy.mock.calls.filter(isAuxiliaryFallbackCall).length).toBe(0);
  }, 10000);

  it('INV-7k: profile 404 with "not a chat model" (chat-incompatibility) → no aux fallback', async () => {
    // PM: 260428 (bts_catch_branch_silent_reroute) — chat-incompatibility is
    // an explicit early-return in isStructuredOutputCapabilityError before
    // the kind skip-list (line 1547+). Critical because OpenAI BYOK users
    // configuring non-chat models like gpt-5.5-pro hit this path.
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: 'This is not a chat model and thus not supported in the v1/chat/completions endpoint.' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    );

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown',
        messages: TEST_MESSAGES,
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
      },
      { category: 'memory' },
    ).catch(() => undefined);

    expect(fetchSpy.mock.calls.filter(isAuxiliaryFallbackCall).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// F3 SUPPLEMENT — INV-18 warn-once-per-unpriced-model semantics.
//
// Source invariant (INV-18): trackCostIfEnabled MUST NOT throw. When tokens
// are consumed but no pricing exists, calculateCostOrWarn fires a warn
// once per process-scoped Set per unique model name (PM 260405). Initial
// Stage 6 only pinned "doesn't throw" — the warn-once contract was
// un-encoded.
// ---------------------------------------------------------------------------
describe('INV-18 SUPPLEMENT — warn-once per unpriced model (process-scoped Set)', () => {
  // The warn-once Set lives in pricingCalculator.ts — _resetWarnedModelsForTesting
  // is invoked in beforeEach so each case starts clean.

  function isUnpricedWarn(call: unknown[]): boolean {
    const arg0 = call[0];
    const arg1 = call[1];
    return typeof arg1 === 'string'
      && arg1.includes('cost tracking skipped')
      && typeof arg0 === 'object' && arg0 !== null;
  }

  it('INV-18b: first BTS call with unpriced profile model → warn fires exactly once', async () => {
    // PM: 260405 (bts_unpriced_model_silent_cost_skip).
    setupAdapter(makeProfileSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          model: 'unknown-vendor/unknown-model-XYZ',
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    const unpricedWarns = loggerWarnMock.mock.calls.filter(isUnpricedWarn);
    expect(unpricedWarns.length).toBe(1);
  });

  it('INV-18c: second BTS call with SAME unpriced model → no second warn', async () => {
    // PM: 260405 (bts_unpriced_model_silent_cost_skip).
    setupAdapter(makeProfileSettings());
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            model: 'unknown-vendor/unknown-model-XYZ',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok2' }, finish_reason: 'stop' }],
            model: 'unknown-vendor/unknown-model-XYZ',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    const unpricedWarns = loggerWarnMock.mock.calls.filter(isUnpricedWarn);
    expect(unpricedWarns.length).toBe(1);
  });

  it('INV-18d: BTS call with DIFFERENT unpriced model → warn fires again (per-model dedupe, not global one-shot)', async () => {
    // PM: 260405 (bts_unpriced_model_silent_cost_skip).
    setupAdapter(makeProfileSettings());
    fetchSpy
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
            model: 'unknown-vendor/model-A',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok2' }, finish_reason: 'stop' }],
            model: 'unknown-vendor/model-B',
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );
    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    const unpricedWarns = loggerWarnMock.mock.calls.filter(isUnpricedWarn);
    expect(unpricedWarns.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// F3 SUPPLEMENT — INV-19 cost-source priority chain
// (token-calculated > _sdkCostUsd; both already exercised individually).
//
// Source invariant (INV-19): cost sources, in priority order:
//   _exactCostUsd (OR usage.cost) → token-calculated → _sdkCostUsd (legacy).
// Initial Stage 6 only pinned the top-priority OR path. INV-19b/c add the
// remaining two priority-chain combinations using direct response shapes.
// ---------------------------------------------------------------------------
describe('INV-19 SUPPLEMENT — cost-source priority: token-calculated > _sdkCostUsd', () => {
  it('INV-19b: response with usage AND _sdkCostUsd → token-calculated wins (legacy _sdkCostUsd ignored when usage tokens present)', async () => {
    // PM: 260405 (bts_unpriced_model_silent_cost_skip) — pins the exact
    // ordering trackCostIfEnabled enforces (line 755-780):
    //   if (response._exactCostUsd != null) → exact
    //   else if (response.usage)              → calculated
    //   else if (response._sdkCostUsd != null)→ legacy-sdk
    // With usage tokens present, the calculated path is taken; _sdkCostUsd
    // is silently ignored regardless of value.
    setupAdapter(makeAnthropicDirectSettings());
    // Use a pricing-known model so calculated cost is non-null.
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: 1000, output_tokens: 500 },
          // _sdkCostUsd shape isn't on the wire in this test — the cost
          // is taken from usage tokens via calculateCostOrWarn.
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    const ledgerCall = appendCostEntryMock.mock.calls[0]?.[0];
    expect(ledgerCall).toBeDefined();
    expect(typeof ledgerCall?.cost).toBe('number');
    // Calculated cost from a known model with non-zero tokens MUST be > 0.
    expect(ledgerCall?.cost).toBeGreaterThan(0);
  });

  it('INV-19c: response with no usage, no _exactCostUsd → falls through (no ledger entry)', async () => {
    // PM: 260405 (bts_unpriced_model_silent_cost_skip) — when neither exact
    // nor usage is available, trackCostIfEnabled returns early (line 783-784:
    // log.debug + return) without writing to the ledger. This pins the
    // negative path that the priority chain devolves to.
    setupAdapter(makeAnthropicDirectSettings());
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: '{"ok":true}' }],
          model: 'claude-sonnet-4-20250514',
          // No usage field, no _exactCostUsd, no _sdkCostUsd.
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        codexConnectivity: 'unknown', messages: TEST_MESSAGES },
      { category: 'memory' },
    );

    expect(appendCostEntryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// F3 SUPPLEMENT — INV-16 Codex-proxy JSON-hint prepend symmetry with
// OR-proxy + profile-direct (already covered).
//
// Source invariant (INV-16): structured-output requests get "Respond with
// valid JSON." when no message contains "json", on OR-proxy AND Codex-proxy
// AND profile-direct. Initial Stage 6 covered OR-proxy + profile-direct;
// this closes the Codex-proxy gap.
// ---------------------------------------------------------------------------
describe('INV-16 SUPPLEMENT — Codex-proxy JSON-hint prepend', () => {
  it('INV-16d: Codex-proxy + structured output + no "json" in messages → system gets "Respond with valid JSON." appended', async () => {
    // PM: 260427 (openrouter_structured_output_prose), 260405 (bts_json_parsing_fences).
    const settings = makeProfileSettings(
      {
        id: CODEX_BTS_PROFILE_ID,
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      },
      { behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}` },
    );
    setupAdapter(settings);
    fetchSpy.mockResolvedValueOnce(makeAnthropicSuccess('{"ok":true}'));

    await callBehindTheScenesWithAuth(
      getLiveSettings(),
      {
        messages: [{ role: 'user', content: 'analyze this' }],
        outputFormat: { type: 'json_schema', schema: { type: 'object' } },
        codexConnectivity: 'connected',
      },
      { category: 'memory' },
    );

    const body = getFetchBody(fetchSpy.mock.calls[0]);
    expect(body.system).toContain('Respond with valid JSON.');
  });
});

// ---------------------------------------------------------------------------
// F3 SUPPLEMENT — INV-13 Codex-proxy cooldown-after-parse symmetry with
// OR-proxy (already covered).
//
// Source invariant (INV-13): SSE responses raise the diagnostic error
// before cooldown success is recorded. Initial Stage 6 covered OR-proxy
// (INV-13b); this closes the Codex-proxy gap.
// ---------------------------------------------------------------------------
describe('INV-13 SUPPLEMENT — Codex-proxy cooldown success NOT recorded on SSE', () => {
  it('INV-13c: SSE on Codex-proxy path → BTS call rejects, cooldown success NOT recorded', async () => {
    // PM: 260429 (bts_codex_proxy_sse_force_streaming) — direct regression target.
    const settings = makeProfileSettings(
      {
        id: CODEX_BTS_PROFILE_ID,
        authSource: 'codex-subscription',
        providerType: 'openai',
        serverUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.4-mini',
      },
      { behindTheScenesModel: `profile:${CODEX_BTS_PROFILE_ID}` },
    );
    setupAdapter(settings);
    const recordSuccessSpy = vi.spyOn(apiRateLimitCooldown, 'recordSuccess');
    fetchSpy.mockResolvedValueOnce(makeSseResponse());

    await expect(
      callBehindTheScenesWithAuth(
        getLiveSettings(),
        { messages: TEST_MESSAGES, codexConnectivity: 'connected' },
        { category: 'memory' },
      ),
    ).rejects.toThrow(/BTS call received streaming response/);

    expect(recordSuccessSpy).not.toHaveBeenCalled();
  });
});
