/**
 * Cross-surface 429 failover parity — real handler + real candidate enumeration
 * under CLOUD-wired seams.
 *
 * Blocker-2 residual of docs/plans/260622_provider-routing-prodflip-prep/PLAN.md
 * (Stage 2). The desktop Stage-4b suite
 * (`src/main/services/__tests__/turnErrorRecovery.test.ts` →
 * `handleRateLimitFallback — Stage 4b multi-provider failover`) proves the 429
 * provider-chain failover decision on the desktop surface. This file proves the
 * SAME real core handler makes the SAME failover decisions when the codex/managed
 * boundaries are wired with CLOUD impls — there is no platform guard in the
 * recovery path, so cloud/mobile run the same Stage-4b chain.
 *
 * SCOPE — what this DOES prove (and what it deliberately does NOT):
 *   - PROVES: the REAL `handleRateLimitFallback` (NOT a mock of it) + the REAL
 *     `getFailoverCredentialCandidates` / `enumerateProviderModeCandidates`
 *     (`@core/rebelCore/providerRouting` is NOT mocked, unlike the desktop suite)
 *     produce the correct A→B failover decision — per-credential cooldown, the
 *     `retryTurn` overrides (attempted set), and the exhaustion terminal — when the
 *     candidate enumeration runs through the CLOUD-wired codex + managed seams:
 *       - `setCodexAuthProvider(DEFAULT_CODEX_AUTH_PROVIDER)` — bootstrap.ts:595
 *       - `registerManagedKeyAvailability(() => false)` — bootstrap.ts:1098 (DI-05:
 *         managed is fail-closed on cloud AND excluded from failover by design)
 *     This is the cross-surface assertion the planner called for (§5 assertion (1)):
 *     the candidate set is computed the same under cloud-wired seams.
 *   - DOES NOT PROVE (out of scope for this run): the full cloud bootstrap/executor
 *     re-drive end-to-end. `retryTurn` is MOCKED — we assert the handler CALLS it
 *     with the right overrides, not that the cloud executor then re-resolves a fresh
 *     route and re-runs the turn. A full cloud-executor smoke is a heavier,
 *     separate test (intentionally not added here).
 *
 * Determinism note: the two usable credentials are credential-FIELD based, not
 * env-based — `openrouter-oauth-token` reads `settings.openRouter.oauthToken`, and
 * `anthropic-api-key` reads `settings.models.apiKey` via
 * `classifyAnthropicSettingsCredential` (NOT `process.env.ANTHROPIC_API_KEY`). So
 * a live `ANTHROPIC_API_KEY` in the cloud test env cannot perturb the candidate set.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted mock refs — created BEFORE the module-level vi.mock() factories.
// We mock ONLY the side-effect sinks the handler writes to. We deliberately do
// NOT mock @core/rebelCore/providerRouting — getFailoverCredentialCandidates is
// the seam under test and must run for real through the cloud-wired codex/managed
// boundaries.
// ---------------------------------------------------------------------------
const {
  completeTurnCleanupMock,
  makeSyntheticResultMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  recordRateLimitMock,
  providerRecordRateLimitMock,
  providerRecordSuccessMock,
  registryMocks,
} = vi.hoisted(() => ({
  completeTurnCleanupMock: vi.fn(),
  makeSyntheticResultMock: vi.fn((_turnId: string, text = '', turnEndReason?: string) => ({
    type: 'result',
    text,
    model: 'claude-sonnet-4-5',
    timestamp: 123,
    ...(turnEndReason ? { turnEndReason } : {}),
  })),
  dispatchAgentEventMock: vi.fn(),
  dispatchAgentErrorEventMock: vi.fn(() => ({ ok: true })),
  recordRateLimitMock: vi.fn(),
  providerRecordRateLimitMock: vi.fn(),
  providerRecordSuccessMock: vi.fn(),
  registryMocks: {
    addTurnFallback: vi.fn(),
    getRetryCount: vi.fn(() => 0),
    incrementRetryCount: vi.fn(() => 1),
    markActionableErrorDispatched: vi.fn(),
    hasActionableErrorDispatched: vi.fn(() => false),
  },
}));

// Side-effect sinks — mocked. These mirror the desktop suite's sink mocks.
vi.mock('@main/services/agentTurnCleanup', () => ({
  completeTurnCleanup: completeTurnCleanupMock,
  makeSyntheticResult: makeSyntheticResultMock,
}));

vi.mock('@main/services/agentEventDispatcher', () => ({
  clearAnswerPhaseStartedSentinel: vi.fn(),
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('@main/services/agentTurnRegistry', () => ({
  agentTurnRegistry: registryMocks,
}));

vi.mock('@core/services/apiRateLimitCooldown', () => ({
  apiRateLimitCooldown: {
    recordRateLimit: recordRateLimitMock,
  },
  safetyEvalRateLimitCooldown: {
    remainingMs: vi.fn(() => 0),
    isAvailable: vi.fn(() => true),
    recordRateLimit: vi.fn(),
    recordSuccess: vi.fn(),
    reset: vi.fn(),
  },
}));

vi.mock('@core/services/providerRateLimitCooldowns', () => ({
  providerRateLimitCooldowns: {
    recordRateLimit: providerRecordRateLimitMock,
    recordSuccess: providerRecordSuccessMock,
    isInCooldown: vi.fn(() => false),
    cooledDownSources: vi.fn(() => new Set()),
    clearAll: vi.fn(),
    remainingMs: vi.fn(() => 0),
  },
}));

// ---------------------------------------------------------------------------
// SUT + cloud boundary seams (imported AFTER mocks).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- allowlisted in scripts/check-cross-surface-imports.ts
import {
  handleRateLimitFallback,
  type ErrorRecoveryContext,
} from '@main/services/turnErrorRecovery';
import { setCodexAuthProvider } from '@core/codexAuth';
import { DEFAULT_CODEX_AUTH_PROVIDER } from '@core/services/defaultCodexAuthProvider';
import {
  registerManagedKeyAvailability,
  __resetManagedKeyAvailabilityForTesting,
} from '@core/rebelCore/managedKeyAvailability';
import { getFailoverCredentialCandidates } from '@core/rebelCore/providerRouting';
import type { ProviderRouteSettings } from '@core/rebelCore/providerRouting';
import type { ProviderCredentialSource } from '@core/rebelCore/providerRouteDecision';

// ---------------------------------------------------------------------------
// Context factory — wired for the multi-provider failover branch.
// flag=true + resolvedFrom='settings' + two usable credential candidates
// (openrouter-oauth-token + anthropic-api-key). Mirrors the desktop
// makeMultiProviderContext but built standalone in the cloud project.
// ---------------------------------------------------------------------------
function makeCloudFailoverContext(
  overrides: Partial<ErrorRecoveryContext> = {},
): ErrorRecoveryContext {
  const multiProviderSettings = {
    coreDirectory: '/tmp/test',
    models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
    openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
    localModel: { profiles: [], activeProfileId: null },
    experimental: { multiProviderRoutingEnabled: true },
    enabledProviders: ['openrouter', 'anthropic'],
  };

  const plan = {
    decision: {
      kind: 'dispatchable',
      provider: 'openrouter',
      transport: 'openrouter',
      dispatchPath: 'direct-provider',
      modelDialect: 'anthropic-native',
      role: 'execution',
      routeScope: 'normal-turn',
      routedModel: null,
      canonicalModelId: 'claude-sonnet-4-5',
      wireModelId: 'claude-sonnet-4-5',
      profileId: null,
      resolvedFrom: 'settings',
      codexConnectivity: 'disconnected',
      fallbackHint: null,
      credentialSource: 'openrouter-oauth-token',
      invalidReason: 'none',
    },
    auth: {
      kind: 'oauth',
      resolvedAuthLabel: 'oauth',
      credentialStatus: 'available',
      apiKey: 'or-token',
      env: [['OPENROUTER_API_KEY', 'or-token']],
    },
    headers: [],
    proxyBaseURL: null,
    resolvedAuthLabel: 'oauth',
    proxyRequired: false,
    invalidReason: null,
  } as unknown as ErrorRecoveryContext['plan'];

  return {
    error: new Error('rate limit exceeded'),
    turnId: 'cloud-turn-id',
    win: null,
    turnLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    } as unknown as ErrorRecoveryContext['turnLogger'],
    abortController: new AbortController(),
    settings: multiProviderSettings as unknown as ErrorRecoveryContext['settings'],
    rendererSessionId: 'renderer-session-1',
    modelConfig: { model: 'claude-sonnet-4-5', envOverrides: undefined } as unknown as ErrorRecoveryContext['modelConfig'],
    extendedContextEnabled: false,
    queryOptions: { model: 'claude-sonnet-4-5', env: {}, maxTurns: 1 } as unknown as ErrorRecoveryContext['queryOptions'],
    buildQueryOptions: vi.fn(() => ({ model: 'claude-sonnet-4-5', env: {}, maxTurns: 1 })) as unknown as ErrorRecoveryContext['buildQueryOptions'],
    createPromptOrGenerator: vi.fn(() => 'test prompt'),
    routerContext: undefined,
    thinkingModelOverride: undefined,
    plan,
    routeInput: {
      // NOTE: handler reads getFailoverCredentialCandidates(ctx.routeInput.settings, …)
      // — routeInput.settings is the turn-start snapshot (hasManagedKey injected on
      // desktop; here we leave it unset so the real getManagedKeyAvailability() cloud
      // seam (() => false) resolves it, which is exactly the cloud path).
      settings: multiProviderSettings,
      model: 'claude-sonnet-4-5',
      codexConnectivity: 'disconnected',
      routeScope: 'normal-turn',
      role: 'execution',
    } as unknown as ErrorRecoveryContext['routeInput'],
    routeRuntimeContextForDecision: vi.fn(() => ({})) as unknown as ErrorRecoveryContext['routeRuntimeContextForDecision'],
    applyRoutePlan: vi.fn(),
    activeProfile: null,
    isDirectRoleProfile: false,
    altModelFallbackAttempted: false,
    nestedFallbackQueryAttempted: false,
    thinkingProfile: null,
    workingProfile: null,
    availableProfiles: [],
    requestedModelForTurn: 'claude-sonnet-4-5',
    messageCount: 0,
    receivedResultMessage: false,
    lastMessageType: undefined,
    lastToolName: undefined,
    mcpMode: undefined,
    hasMedia: false,
    abortedByWatchdog: false,
    abortedByAwaitingApiStall: false,
    watchdogFired: false,
    watchdogFiredAt: undefined,
    maxWatchdogLevel: 0,
    watchdogLevel: 0,
    effectiveAbortMs: 0,
    rawStreamEventCount: 0,
    rawStreamLastEventType: null,
    rawStreamLastEventAgeMs: null,
    effectiveResetConversation: false,
    turnOptions: undefined,
    prompt: 'test prompt',
    retryTurn: vi.fn(async () => {}),
    ...overrides,
  } as ErrorRecoveryContext;
}

// ---------------------------------------------------------------------------
// Cloud boundary wiring — faithfully model the cloud bootstrap ordering.
// ---------------------------------------------------------------------------
describe('Cross-surface 429 failover parity — real handler + real candidate enumeration under cloud-wired seams (retryTurn mocked; full cloud executor re-drive out of scope)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    // Cloud bootstrap wiring (bootstrap.ts:595 / :1098): Codex via the default
    // provider (no tokens seeded → isConnected() false), managed fail-closed.
    setCodexAuthProvider(DEFAULT_CODEX_AUTH_PROVIDER);
    __resetManagedKeyAvailabilityForTesting();
    registerManagedKeyAvailability(() => false);
  });

  afterEach(() => {
    __resetManagedKeyAvailabilityForTesting();
  });

  // -------------------------------------------------------------------------
  // (1) PARITY: candidate enumeration under cloud-wired seams returns BOTH
  //     usable credentials. This is the planner §5 assertion (1) — the seam,
  //     run for real through the cloud codex/managed boundaries, sees both A and B.
  // -------------------------------------------------------------------------
  it('getFailoverCredentialCandidates (real) returns both A and B under cloud codex/managed seams', () => {
    const ctx = makeCloudFailoverContext();
    const candidates = getFailoverCredentialCandidates(
      ctx.routeInput.settings as unknown as ProviderRouteSettings,
      { codexConnectivity: ctx.routeInput.codexConnectivity },
    );
    expect(candidates.size).toBe(2);
    expect(candidates.has('openrouter-oauth-token' as ProviderCredentialSource)).toBe(true);
    expect(candidates.has('anthropic-api-key' as ProviderCredentialSource)).toBe(true);
    // Managed (mindstone) is fail-closed + failover-excluded on cloud → never a candidate.
    expect(candidates.has('mindstone-managed-key' as ProviderCredentialSource)).toBe(false);
    // Codex is not connected on this cloud surface → never a candidate.
    expect(candidates.has('codex-subscription' as ProviderCredentialSource)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // (2) A→B failover decision: first 429 on provider A (openrouter) →
  //     per-credential cooldown recorded + retryTurn CALLED with A in the
  //     attempted set. Drives the REAL handler with REAL candidate enumeration;
  //     retryTurn is mocked (we assert the handler requests the re-drive, not
  //     that the cloud executor then performs it — that's out of scope).
  // -------------------------------------------------------------------------
  it('first 429 on A → records per-credential cooldown for A + calls retryTurn with A attempted (real handler decision; retryTurn mocked)', async () => {
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeCloudFailoverContext({ retryTurn: retryTurnMock });

    const result = await handleRateLimitFallback(ctx);

    // Transparent hop: handled, no error event dispatched.
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: false });
    // Per-credential cooldown recorded for the failed source A.
    expect(providerRecordRateLimitMock).toHaveBeenCalledWith('openrouter-oauth-token', undefined);
    // Global cooldown NOT recorded on a transparent hop.
    expect(recordRateLimitMock).not.toHaveBeenCalled();
    // Error event NOT dispatched on a transparent hop.
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    // retryTurn called with A in rateLimitAttemptedCredentialSources, fresh re-resolution.
    expect(retryTurnMock).toHaveBeenCalledTimes(1);
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      routeRebuildHint: undefined,
      inFlightProviderRoutePlan: undefined,
      rateLimitAttemptedCredentialSources: expect.arrayContaining(['openrouter-oauth-token']),
    }));
    const lastCallArg = (retryTurnMock.mock.lastCall as unknown as [{ rateLimitAttemptedCredentialSources?: unknown[] }] | undefined)?.[0];
    expect(lastCallArg?.rateLimitAttemptedCredentialSources).toHaveLength(1);
    // Paid-fallback indicator contract: placeholder provider fallback recorded.
    expect(registryMocks.addTurnFallback).toHaveBeenCalledWith('cloud-turn-id', expect.objectContaining({
      type: 'provider',
      from: 'openrouter-oauth-token',
      to: 'auto-failover',
      reason: 'multi-provider-rate-limit-failover',
    }));
  });

  // -------------------------------------------------------------------------
  // (3) Second 429 on B with BOTH attempted → terminal all-providers-rate-limited.
  //     The route is now on provider B (anthropic); both credentials are in the
  //     attempted set → remaining is empty → honest terminal, NO retry.
  // -------------------------------------------------------------------------
  it('second 429 on B with both attempted → terminal all-providers-rate-limited (no retry)', async () => {
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeCloudFailoverContext({
      // Route is now on B (anthropic); A already attempted on the prior hop.
      turnOptions: {
        rateLimitAttemptedCredentialSources: ['openrouter-oauth-token'],
      } as unknown as ErrorRecoveryContext['turnOptions'],
      plan: {
        decision: {
          kind: 'dispatchable',
          provider: 'anthropic',
          transport: 'anthropic-direct',
          dispatchPath: 'direct-provider',
          modelDialect: 'anthropic-native',
          role: 'execution',
          routeScope: 'normal-turn',
          routedModel: null,
          canonicalModelId: 'claude-sonnet-4-5',
          wireModelId: 'claude-sonnet-4-5',
          profileId: null,
          resolvedFrom: 'settings',
          codexConnectivity: 'disconnected',
          fallbackHint: null,
          credentialSource: 'anthropic-api-key',
          invalidReason: 'none',
        },
        auth: {
          kind: 'api-key',
          resolvedAuthLabel: 'api-key',
          credentialStatus: 'available',
          apiKey: 'fake-anthropic-key',
          env: [['ANTHROPIC_API_KEY', 'fake-anthropic-key']],
        },
        headers: [],
        proxyBaseURL: null,
        resolvedAuthLabel: 'api-key',
        proxyRequired: false,
        invalidReason: null,
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    // Terminal: handled + activity emitted (error event surfaced).
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
    // No further retry — both providers exhausted.
    expect(retryTurnMock).not.toHaveBeenCalled();
    // Global backstop cooldown recorded now that we terminate.
    expect(recordRateLimitMock).toHaveBeenCalled();
    // Per-credential cooldown still recorded for B (the credential that just 429'd).
    expect(providerRecordRateLimitMock).toHaveBeenCalledWith('anthropic-api-key', undefined);
    // Honest terminal with the rate-limit-exhaustion failoverReason.
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'cloud-turn-id',
      expect.anything(),
      expect.objectContaining({
        rateLimitProvider: 'anthropic-api-key',
        failoverReason: 'all-providers-rate-limited',
      }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('cloud-turn-id', 'rate-limit');
  });
});
