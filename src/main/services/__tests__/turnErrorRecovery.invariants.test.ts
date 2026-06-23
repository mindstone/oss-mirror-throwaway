/**
 * turnErrorRecovery.ts — 25 BEHAVIOURAL INVARIANTS pinned as runnable contract tests.
 *
 * Stage 1 of `docs/plans/260526_hotspot-refactor-roadmap/PLAN.md` (Hotspot 2).
 * Source: `subagent_reports/260526_154201_researcher-bugarch-turnerrorrecovery-opus47.md`
 *   → "Behavioural invariants the Planner must preserve" (25 numbered invariants).
 *
 * Purpose: pin the *interaction contract* of the recovery dispatcher
 * (handler ordering, ctx-mutation invariants, terminal-event single-emit,
 * cleanup-reason discriminator, classifier coverage, restart-safety gates,
 * Sentry capture sites) so Stage 2-5 carve-outs are provably behaviour-
 * preserving. Per-handler tests live in turnErrorRecovery.test.ts; this
 * file deliberately does NOT duplicate that coverage — it pins the cross-
 * handler invariants those tests miss.
 *
 * Each `it()` is labelled with its invariant number (INV-N).
 *
 * Aim: catch regressions of the prior postmortems
 * (260427 outer-retry-guard, 260513 compaction overlay misrouting,
 *  260331 timeout symmetry, 260425 dual-emit, 260424 Sentry fingerprint).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createModelNormalizationMock } from './agentTurnExecutor.testHarness';
import type { ConversationStateShape } from '@shared/utils/conversationState';


vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
    getSubscriptionState: vi.fn(() => null),
    getManagedAllowanceResetsAt: vi.fn(() => undefined),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

// ---------------------------------------------------------------------------
// vi.hoisted mock refs — created BEFORE module-level vi.mock() calls
// (mirrors the pattern in turnErrorRecovery.test.ts so we re-use the same
//  shape; this file is self-contained — mocks here do NOT leak to that file)
// ---------------------------------------------------------------------------
const {
  isNetworkErrorMock,
  isTransientErrorMock,
  diagnoseTimeoutMock,
  runAgentQueryMock,
  completeTurnCleanupMock,
  makeSyntheticResultMock,
  dispatchAgentEventMock,
  dispatchAgentErrorEventMock,
  getErrorKindMock,
  isExtendedContextUnavailableErrorMock,
  isThinkingModelUnavailableErrorMock,
  downgradeThinkingModelConfigMock,
  stripExtendedContextFromConfigMock,
  resolveModelConfigMock,
  isRateLimitMessageMock,
  extractRetryAfterMsMock,
  loadConversationHistoryMock,
  delayWithAbortMock,
  recordRateLimitMock,
  captureExceptionMock,
  captureMessageMock,
  updateLastApiCallTimeMock,
  getRateLimitFallbackTargetMock,
  safeDispatchLearnedLimitsFromErrorMock,
  getSettingsMock,
  updateSettingsMock,
  mockTurnLogger,
  registryMocks,
} = vi.hoisted(() => {
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const safeDispatchLearnedLimitsFromErrorMock = vi.fn((..._args: unknown[]) => null as any);

  return {
    isNetworkErrorMock: vi.fn(() => false),
    isTransientErrorMock: vi.fn(() => false),
    diagnoseTimeoutMock: vi.fn(),
    runAgentQueryMock: vi.fn(),
    completeTurnCleanupMock: vi.fn(),
    makeSyntheticResultMock: vi.fn((_turnId: string, text = '', turnEndReason?: string) => ({
      type: 'result',
      text,
      model: 'claude-sonnet-4-5',
      timestamp: 123,
      ...(turnEndReason ? { turnEndReason } : {}),
    })),
    dispatchAgentEventMock: vi.fn(),
    dispatchAgentErrorEventMock: vi.fn((win: unknown, turnId: string, rawError: unknown, opts?: {
      humanizedOverride?: string;
      isTransient?: boolean;
      errorKindOverride?: string;
      providerOverride?: string;
    }) => {
      const rawMessage =
        typeof rawError === 'string'
          ? rawError
          : rawError instanceof Error
            ? rawError.message
            : String(rawError ?? '');
      const errorKind = opts?.errorKindOverride
        ?? (typeof rawError === 'object' && rawError !== null && typeof (rawError as { __agentErrorKind?: unknown }).__agentErrorKind === 'string'
          ? (rawError as { __agentErrorKind: string }).__agentErrorKind
          : getErrorKindMock(rawError));
      const provider = opts?.providerOverride
        ?? (typeof rawError === 'object' && rawError !== null && typeof (rawError as { provider?: unknown }).provider === 'string'
          ? (rawError as { provider: string }).provider
          : undefined);

      dispatchAgentEventMock(win, turnId, {
        type: 'error',
        error: opts?.humanizedOverride ?? rawMessage,
        ...(opts?.isTransient !== undefined ? { isTransient: opts.isTransient } : {}),
        ...(errorKind && errorKind !== 'unknown' ? { errorKind } : {}),
        ...(provider ? { provider } : {}),
        errorSource: 'main',
        timestamp: Date.now(),
      });

      return {
        ok: true,
        ...(errorKind && errorKind !== 'unknown' ? { dispatchedErrorKind: errorKind } : {}),
      };
    }),
    getErrorKindMock: vi.fn<(error: unknown) => string>(() => 'unknown' as string),
    isExtendedContextUnavailableErrorMock: vi.fn(() => false),
    isThinkingModelUnavailableErrorMock: vi.fn(() => false),
    downgradeThinkingModelConfigMock: vi.fn((cfg: unknown) => cfg),
    stripExtendedContextFromConfigMock: vi.fn((cfg: unknown) => cfg),
    resolveModelConfigMock: vi.fn((model: string) => ({
      model,
      envOverrides: undefined,
    })),
    isRateLimitMessageMock: vi.fn(() => false),
    extractRetryAfterMsMock: vi.fn<(message: string) => number | undefined>(() => undefined),
    loadConversationHistoryMock: vi.fn(async () => ''),
    delayWithAbortMock: vi.fn<(ms: number, signal?: AbortSignal) => Promise<boolean>>(),
    recordRateLimitMock: vi.fn(),
    captureExceptionMock: vi.fn(),
    captureMessageMock: vi.fn(),
    updateLastApiCallTimeMock: vi.fn(),
    getRateLimitFallbackTargetMock: vi.fn((): unknown => null),
    safeDispatchLearnedLimitsFromErrorMock,
    getSettingsMock: vi.fn((): {
      localModel: {
        profiles: Array<{
          id: string;
          model: string;
          providerType: string;
          chatCompatibility: string;
          name: string;
          chatCompatibilityCheckedAt?: string;
        }>;
        activeProfileId: string | null;
      };
    } => ({
      localModel: { profiles: [], activeProfileId: null },
    })),
    updateSettingsMock: vi.fn(),
    mockTurnLogger,
    registryMocks: {
      markExtendedContextFailed: vi.fn(),
      clearExtendedContextFailed: vi.fn(),
      setTurnExtendedContext: vi.fn(),
      setTurnModel: vi.fn(),
      addTurnFallback: vi.fn(),
      getRetryCount: vi.fn(() => 0),
      incrementRetryCount: vi.fn(() => 1),
      deleteRetryCount: vi.fn(),
      getRetryStartTime: vi.fn((): number | undefined => undefined),
      setRetryStartTime: vi.fn(),
      deleteRetryStartTime: vi.fn(),
      cleanupForRetry: vi.fn(),
      getActiveTurnController: vi.fn(() => null),
      getContextAccumulator: vi.fn((): ConversationStateShape | undefined => undefined),
      getOrCreateAccumulator: vi.fn(() => ({
        hasPossiblyMutatingToolCall: vi.fn(() => false),
        getExecutedToolCalls: vi.fn(() => []),
      })),
      hasContextOverflowDispatched: vi.fn(() => false),
      markContextOverflowDispatched: vi.fn(),
      hasOutputCapRetryAttempted: vi.fn(() => false),
      markOutputCapRetryAttempted: vi.fn(),
      getTurnPrompt: vi.fn(() => ''),
      hasActionableErrorDispatched: vi.fn(() => false),
      markActionableErrorDispatched: vi.fn(),
      getTurnSpawnDelayed: vi.fn(() => false),
      getActiveTurnCount: vi.fn(() => 1),
      setTurnCloseCallback: vi.fn(),
      deleteTurnCloseCallback: vi.fn(),
      getTurnModel: vi.fn(() => 'claude-sonnet-4-5'),
      getTurnActiveProvider: vi.fn(() => undefined),
      hasUserQuestionPending: vi.fn(() => false),
      setTurnContextWindow: vi.fn(),
      setTurnAuthMethod: vi.fn(),
      setTurnActiveProvider: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../agentQueryRunner', () => ({
  runAgentQuery: runAgentQueryMock,
}));

vi.mock('../agentTurnCleanup', () => ({
  completeTurnCleanup: completeTurnCleanupMock,
  makeSyntheticResult: makeSyntheticResultMock,
}));

vi.mock('../agentEventDispatcher', () => ({
  clearAnswerPhaseStartedSentinel: vi.fn(),
  dispatchAgentEvent: dispatchAgentEventMock,
  dispatchAgentErrorEvent: dispatchAgentErrorEventMock,
}));

vi.mock('../agentTurnRegistry', () => ({
  agentTurnRegistry: registryMocks,
}));

vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/utils/agentErrorCatalog');
  return {
    ...actual,
    getErrorKind: getErrorKindMock,
  };
});

vi.mock('@shared/utils/modelNormalization', () =>
  createModelNormalizationMock({ resolveModelConfigMock }, {
    stripExtendedContextFromConfig: stripExtendedContextFromConfigMock,
    isExtendedContextUnavailableError: isExtendedContextUnavailableErrorMock,
    isThinkingModelUnavailableError: isThinkingModelUnavailableErrorMock,
    downgradeThinkingModelConfig: downgradeThinkingModelConfigMock,
    getModelDisplayName: vi.fn((model: string) => model),
  }));

vi.mock('@shared/utils/friendlyErrors', () => ({
  humanizeError: vi.fn((msg: string) => msg),
  humanizeProviderServerError: vi.fn(() => 'The model service had a moment. Retry — your work so far is saved.'),
  classifyBillingSubtype: vi.fn(() => 'unknown'),
  isTransientError: isTransientErrorMock,
  isNetworkError: isNetworkErrorMock,
  isRateLimitMessage: isRateLimitMessageMock,
  extractRetryAfterMs: extractRetryAfterMsMock,
}));

vi.mock('@shared/utils/toolNameValidation', () => ({
  isToolNameLengthError: vi.fn(() => false),
}));

vi.mock('../conversationHistoryService', () => ({
  loadConversationHistory: loadConversationHistoryMock,
}));

vi.mock('@core/services/timeoutDiagnosticsService', () => ({
  diagnoseTimeout: diagnoseTimeoutMock,
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: vi.fn(() => ({
    captureException: captureExceptionMock,
    captureMessage: captureMessageMock,
  })),
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

vi.mock('@core/utils/delayWithAbort', () => ({
  delayWithAbort: delayWithAbortMock,
}));

vi.mock('../promptCacheWarmupService', () => ({
  updateLastApiCallTime: updateLastApiCallTimeMock,
}));

vi.mock('@core/utils/authEnvUtils', () => ({
  getRateLimitFallbackTarget: getRateLimitFallbackTargetMock,
}));

vi.mock('@core/rebelCore/dispatchLearnedLimitsFromError', () => ({
  dispatchLearnedLimitsFromError: safeDispatchLearnedLimitsFromErrorMock,
  safeDispatchLearnedLimitsFromError: safeDispatchLearnedLimitsFromErrorMock,
}));

vi.mock('@core/services/settingsStore', () => ({
  getSettings: getSettingsMock,
  updateSettings: updateSettingsMock,
  updateSettingsAtomic: vi.fn(),
  onSettingsChange: vi.fn(() => () => undefined),
}));

vi.mock('../../utils/agentTurnUtils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/agentTurnUtils')>();
  return {
    getErrorMessage: actual.getErrorMessage,
    getErrorName: actual.getErrorName,
    getRawErrorMessage: actual.getRawErrorMessage,
    getErrorProvider: actual.getErrorProvider,
    isApiOutputMessage: actual.isApiOutputMessage,
  };
});

// ---------------------------------------------------------------------------
// Import SUT (after mocks)
// ---------------------------------------------------------------------------

import {
  handleAbortErrors,
  handleToolInputTooLarge,
  handleServerErrorRetry,
  handlePostFallbackServerError,
  handleTransientAndProcessExitRetry,
  handleRateLimitFallback,
  classifyAndDispatchError,
  dispatchErrorRecovery,
  type ErrorRecoveryContext,
} from '../turnErrorRecovery';
import { ModelError } from '@core/rebelCore/modelErrors';
import { AUTO_ABORT_MS } from '../watchdogTracker';

// ---------------------------------------------------------------------------
// Factory helper — sensible defaults; mirrors turnErrorRecovery.test.ts
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ErrorRecoveryContext> = {}): ErrorRecoveryContext {
  const defaultEnv = { ANTHROPIC_API_KEY: 'fake-ant-test-key' };
  const defaultQueryOptions = { model: 'claude-sonnet-4-5', env: defaultEnv, maxTurns: 1 };
  const defaultPlan = {
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
      apiKey: 'fake-ant-test-key',
      env: [['ANTHROPIC_API_KEY', 'fake-ant-test-key']],
    },
    headers: [],
    proxyBaseURL: null,
    resolvedAuthLabel: 'api-key',
    proxyRequired: false,
    invalidReason: null,
  } as unknown as ErrorRecoveryContext['plan'];

  return {
    error: new Error('test error'),
    turnId: 'test-turn-id',
    win: null,
    turnLogger: mockTurnLogger as unknown as ErrorRecoveryContext['turnLogger'],
    abortController: new AbortController(),
    settings: {
      coreDirectory: '/tmp/test',
      activeProvider: 'anthropic',
      claude: {
        model: 'claude-sonnet-4-5',
        thinkingModel: null,
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: false,
        thinkingEffort: 'medium',
        apiKey: 'fake-ant-test-key',
        longContextFallbackModel: null,
      },
      diagnostics: { debugBreadcrumbsUntil: null },
      voice: {
        provider: 'openai-whisper',
        openaiApiKey: null,
        elevenlabsApiKey: null,
        model: 'whisper-1',
        ttsVoice: null,
        activationHotkey: 'Alt+Space',
        activationHotkeyVoiceMode: 'Alt+Space',
      },
      localModel: { profiles: [], activeProfileId: null },
    } as unknown as ErrorRecoveryContext['settings'],
    rendererSessionId: 'renderer-session-1',
    modelConfig: { model: 'claude-sonnet-4-5', envOverrides: undefined } as unknown as ErrorRecoveryContext['modelConfig'],
    extendedContextEnabled: false,
    queryOptions: defaultQueryOptions as unknown as ErrorRecoveryContext['queryOptions'],
    buildQueryOptions: vi.fn(() => defaultQueryOptions) as unknown as ErrorRecoveryContext['buildQueryOptions'],
    createPromptOrGenerator: vi.fn(() => 'test prompt'),
    routerContext: undefined,
    thinkingModelOverride: undefined,
    plan: defaultPlan,
    routeInput: {
      settings: {
        activeProvider: 'anthropic',
        claude: { apiKey: 'fake-ant-test-key', model: 'claude-sonnet-4-5' },
        localModel: { profiles: [], activeProfileId: null },
      },
      model: 'claude-sonnet-4-5',
      codexConnectivity: 'disconnected',
      routeScope: 'normal-turn',
      role: 'execution',
    } as unknown as ErrorRecoveryContext['routeInput'],
    routeRuntimeContextForDecision: vi.fn(() => ({
      anthropicApiKey: 'fake-ant-test-key',
    })) as unknown as ErrorRecoveryContext['routeRuntimeContextForDecision'],
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
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  isNetworkErrorMock.mockReturnValue(false);
  isTransientErrorMock.mockReturnValue(false);
  runAgentQueryMock.mockResolvedValue({ abortedByUser: false, terminatedByHandler: false });
  getErrorKindMock.mockReturnValue('unknown');
  isExtendedContextUnavailableErrorMock.mockReturnValue(false);
  isThinkingModelUnavailableErrorMock.mockReturnValue(false);
  isRateLimitMessageMock.mockReturnValue(false);
  extractRetryAfterMsMock.mockReturnValue(undefined);
  delayWithAbortMock.mockResolvedValue(false);
  loadConversationHistoryMock.mockResolvedValue('');
  registryMocks.getRetryCount.mockReturnValue(0);
  registryMocks.incrementRetryCount.mockReturnValue(1);
  registryMocks.hasOutputCapRetryAttempted.mockReturnValue(false);
  registryMocks.hasContextOverflowDispatched.mockReturnValue(false);
  registryMocks.hasUserQuestionPending.mockReturnValue(false);
  safeDispatchLearnedLimitsFromErrorMock.mockReturnValue(null);
  getSettingsMock.mockReturnValue({ localModel: { profiles: [], activeProfileId: null } });
  resolveModelConfigMock.mockImplementation((model: string) => ({ model, envOverrides: undefined }));
  stripExtendedContextFromConfigMock.mockImplementation((cfg: unknown) => cfg);
  downgradeThinkingModelConfigMock.mockImplementation((cfg: unknown) => cfg);
});

// ===========================================================================
// INV-1 — Exactly one terminal `result` event per recovery dispatch path
//
// Bug archaeology § "Behavioural invariants": dual-emit edge cases (260425)
// violate this; for non-dual-producer paths we pin "exactly one synthetic
// `result` event per recovery dispatch". Rephrased to match the verifiable
// part of current behaviour (see report § Concerns; the renderer-side
// supersede covers the remainder).
// ===========================================================================
describe('INV-1 — terminal-event single-emit per recovery dispatch', () => {
  it('INV-1a: watchdog auto-abort path emits exactly one synthetic `result` event with turnEndReason="error"', () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeContext({ abortController: ac, abortedByWatchdog: true });

    handleAbortErrors(ctx);

    const resultEvents = dispatchAgentEventMock.mock.calls
      .map((c) => c[2] as { type: string; turnEndReason?: string })
      .filter((e) => e.type === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0].turnEndReason).toBe('error');
  });

  it('INV-1b: tool_input_too_large emits exactly one synthetic `result` event with turnEndReason="error" and one cleanup', () => {
    registryMocks.getOrCreateAccumulator.mockReturnValue({
      hasPossiblyMutatingToolCall: vi.fn(() => false),
      getExecutedToolCalls: vi.fn(() => []),
    });
    const err = new ModelError(
      'tool_input_too_large',
      'cap exceeded',
      undefined,
      undefined,
      { details: { toolName: 'X', bytesAccumulated: 1, capBytes: 1 } },
    );
    const ctx = makeContext({ error: err });

    expect(handleToolInputTooLarge(ctx)).toMatchObject({ kind: 'handled' });

    const resultEvents = dispatchAgentEventMock.mock.calls
      .map((c) => c[2] as { type: string; turnEndReason?: string })
      .filter((e) => e.type === 'result');
    expect(resultEvents).toHaveLength(1);
    expect(resultEvents[0].turnEndReason).toBe('error');
    expect(completeTurnCleanupMock).toHaveBeenCalledTimes(1);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'tool-input-too-large');
  });
});

// ===========================================================================
// INV-2 — Watchdog auto-abort copy uses *effective* abort threshold
// (not static AUTO_ABORT_MS — judge-granted extensions must be reflected)
//
// File reference: lines 545-547.
// ===========================================================================
describe('INV-2 — watchdog auto-abort copy uses effectiveAbortMs', () => {
  it('INV-2: copy reports the effective abort threshold (judge-extended), not the static AUTO_ABORT_MS', () => {
    const ac = new AbortController();
    ac.abort();
    const extendedAbortMs = AUTO_ABORT_MS + 60 * 60_000;
    const ctx = makeContext({
      abortController: ac,
      abortedByWatchdog: true,
      effectiveAbortMs: extendedAbortMs,
    });

    handleAbortErrors(ctx);

    const expectedMinutes = Math.round(extendedAbortMs / 60_000);
    const errorEvent = dispatchAgentEventMock.mock.calls[0][2] as { error?: string };
    expect(errorEvent.error).toContain(`unresponsive for ${expectedMinutes} minutes`);
    expect(errorEvent.error).not.toContain(`unresponsive for ${Math.round(AUTO_ABORT_MS / 60_000)} minutes`);
  });
});

// ===========================================================================
// INV-3 — User abort, watchdog abort, and supersede are all distinguishable
// in user-visible status copy AND cleanup-reason discriminator.
//
// File reference: lines 526-600.
// ===========================================================================
describe('INV-3 — abort-type discriminator is preserved end-to-end', () => {
  it('INV-3a: superseded => single `result` event with turnEndReason="superseded", no "stopped by user" status', () => {
    const ac = new AbortController();
    ac.abort('superseded');
    const ctx = makeContext({ abortController: ac });

    handleAbortErrors(ctx);

    expect(dispatchAgentEventMock).toHaveBeenCalledTimes(1);
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'result', turnEndReason: 'superseded' }),
    );
  });

  it('INV-3b: user abort => "Agent turn stopped by user" status + result with turnEndReason="user_stopped"', () => {
    const ac = new AbortController();
    ac.abort();
    const ctx = makeContext({ abortController: ac, abortedByWatchdog: false });

    handleAbortErrors(ctx);

    expect(dispatchAgentEventMock).toHaveBeenNthCalledWith(
      1,
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'status', message: 'Agent turn stopped by user' }),
    );
    expect(dispatchAgentEventMock).toHaveBeenNthCalledWith(
      2,
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'result', turnEndReason: 'user_stopped' }),
    );
  });

  it('INV-3c: dispatcher cleanup reason is "watchdog-aborted" / "aborted" / "error" by signal source', async () => {
    // user abort
    const userAc = new AbortController();
    userAc.abort();
    const userCtx = makeContext({ abortController: userAc, abortedByWatchdog: false });
    await dispatchErrorRecovery(userCtx);
    expect(completeTurnCleanupMock).toHaveBeenLastCalledWith('test-turn-id', 'aborted');

    // watchdog abort
    completeTurnCleanupMock.mockClear();
    const watchdogAc = new AbortController();
    watchdogAc.abort();
    const watchdogCtx = makeContext({ abortController: watchdogAc, abortedByWatchdog: true });
    await dispatchErrorRecovery(watchdogCtx);
    expect(completeTurnCleanupMock).toHaveBeenLastCalledWith('test-turn-id', 'watchdog-aborted');
  });
});

// ===========================================================================
// INV-4 — Tool-input-too-large is non-retryable. No retry path; non-transient.
//
// File reference: lines 614-705.
// ===========================================================================
describe('INV-4 — tool_input_too_large is non-retryable', () => {
  it('INV-4: dispatcher emits non-transient terminal error and completes cleanup with "tool-input-too-large" — no retry', async () => {
    registryMocks.getOrCreateAccumulator.mockReturnValue({
      hasPossiblyMutatingToolCall: vi.fn(() => false),
      getExecutedToolCalls: vi.fn(() => []),
    });
    const err = new ModelError(
      'tool_input_too_large',
      'cap exceeded',
      undefined,
      undefined,
      { details: { toolName: 'X', bytesAccumulated: 1, capBytes: 1 } },
    );
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({ error: err, retryTurn });

    await dispatchErrorRecovery(ctx);

    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3] as { isTransient?: boolean } | undefined;
    expect(opts?.isTransient).toBe(false);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'tool-input-too-large');
    expect(retryTurn).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// INV-5 — 1M → 200K context downgrade is remembered for the session.
//
// File reference: line 727 via agentTurnRegistry.markExtendedContextFailed.
// ===========================================================================
describe('INV-5 — 1M→200K downgrade is remembered for the renderer session', () => {
  it('INV-5: handleExtendedContextFallback marks the session via agentTurnRegistry.markExtendedContextFailed', async () => {
    isExtendedContextUnavailableErrorMock.mockReturnValue(true);
    const { handleExtendedContextFallback } = await import('../turnErrorRecovery');
    const ctx = makeContext({
      error: new Error('extended context unavailable'),
      rendererSessionId: 'session-X',
      extendedContextEnabled: true,
    });

    await handleExtendedContextFallback(ctx);

    expect(registryMocks.markExtendedContextFailed).toHaveBeenCalledWith('session-X');
  });
});

// ===========================================================================
// INV-6 — Thinking-model downgrade status message names the *resolved*
// fallback model (post-260417 — no hardcoded fallback model names).
//
// File reference: line 818 (`Using ${getModelDisplayName(fallbackModel)} ...`).
// ===========================================================================
describe('INV-6 — thinking-model downgrade message names the resolved fallback model', () => {
  it('INV-6: status copy interpolates the dynamic fallback model from downgradeThinkingModelConfig (no hardcoded id)', async () => {
    isThinkingModelUnavailableErrorMock.mockReturnValue(true);
    downgradeThinkingModelConfigMock.mockReturnValue({
      model: 'claude-sonnet-4-5',
      envOverrides: { PLANNING_MODEL: 'claude-haiku-4-5-DYNAMIC' },
    });
    const { handleThinkingModelFallback } = await import('../turnErrorRecovery');
    const ctx = makeContext({
      error: new Error('thinking model not supported'),
      modelConfig: {
        model: 'claude-sonnet-4-5',
        envOverrides: { PLANNING_MODEL: 'claude-opus-4-7' },
      } as unknown as ErrorRecoveryContext['modelConfig'],
    });

    await handleThinkingModelFallback(ctx);

    const statusEvents = dispatchAgentEventMock.mock.calls
      .map((c) => c[2] as { type?: string; message?: string })
      .filter((e) => e.type === 'status' && typeof e.message === 'string');
    expect(statusEvents.length).toBeGreaterThan(0);
    expect(statusEvents[0].message).toContain('claude-haiku-4-5-DYNAMIC');
  });
});

// ===========================================================================
// INV-7 — Alt-model fast retry skipped when real API output already streamed.
//
// File reference: line 1002 ("duplicate replies" guard).
// ===========================================================================
describe('INV-7 — alt-model fast retry skipped when messageCount > 0', () => {
  it('INV-7: messageCount > 0 routes to terminal mid-conversation error rather than retryTurn', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    const retryTurn = vi.fn(async () => {});
    const { handleAltModelFallback } = await import('../turnErrorRecovery');
    const ctx = makeContext({
      error: new ModelError('server_error', 'proxy unavailable', 503, 'OpenAI'),
      messageCount: 3,
      activeProfile: { model: 'gpt-5.5', provider: 'openai', name: 'OpenAI' } as unknown as ErrorRecoveryContext['activeProfile'],
      retryTurn,
    });

    const handled = await handleAltModelFallback(ctx, /* isAltModelError */ true);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).not.toHaveBeenCalled();
    expect(runAgentQueryMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'alt-model-error');
  });
});

// ===========================================================================
// INV-8 — Server-error retry budget is wall-clock 4 minutes (post-260409),
// not 5. After budget exhaustion: terminal dispatch, no retry.
//
// File reference: line 1268 (TOTAL_RETRY_BUDGET_MS = 240_000).
// ===========================================================================
describe('INV-8 — server-error retry budget is wall-clock 240_000ms (4 minutes)', () => {
  it('INV-8: when more than 4 minutes have elapsed, retries stop and terminal error dispatches', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(1);
    // Wall-clock budget exceeded by 1 second
    registryMocks.getRetryStartTime.mockReturnValue(Date.now() - 240_000 - 1000);
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('server_error', 'overloaded', 503, 'Anthropic'),
      retryTurn,
    });

    const handled = await handleServerErrorRetry(ctx, /* isServerErrorRetry */ true, /* isAltModelError */ false);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'server-error');
    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3] as { humanizedOverride?: string } | undefined;
    expect(opts?.humanizedOverride).toMatch(/unavailable for \d+s/);
  });
});

// ===========================================================================
// INV-9 — Server-error retries skip when real API output already streamed.
//
// File reference: line 1218 (messageCount > 0 guard, post-260427).
// ===========================================================================
describe('INV-9 — server-error retry skipped when messageCount > 0', () => {
  it('INV-9: messageCount > 0 falls through to terminal dispatch without retry, preserving any partial output', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(0);
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('server_error', 'overloaded', 503, 'Anthropic'),
      messageCount: 4,
      retryTurn,
    });

    const handled = await handleServerErrorRetry(ctx, true, false);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).not.toHaveBeenCalled();
    expect(delayWithAbortMock).not.toHaveBeenCalled();
    expect(mockTurnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageCount: 4 }),
      expect.stringContaining('Server error retry skipped'),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'server-error');
  });
});

// ===========================================================================
// INV-10 — Billing errors are NEVER retried and NEVER routed to alt-model.
//
// File reference: dispatcher line ~2702 + handler line 1545.
// ===========================================================================
describe('INV-10 — billing errors are never retried and never routed to alt-model', () => {
  it('INV-10: dispatcher routes billing to handleBillingError; cleanup reason is "billing-error"; no retry, no alt-model', async () => {
    getErrorKindMock.mockReturnValue('billing');
    isRateLimitMessageMock.mockReturnValue(true); // even if message-substring suggests rate-limit
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('429 insufficient_quota - usage limit exceeded'),
      isDirectRoleProfile: true, // would otherwise tempt alt-model fallback for transient/server errors
      retryTurn,
    });

    await dispatchErrorRecovery(ctx);

    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'billing-error');
    expect(retryTurn).not.toHaveBeenCalled();
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// INV-11 — Managed-model-not-allowed (Handler 6.4) wins over generic billing
// classification (Handler 6.5). 6.4 must precede 6.5 in dispatcher.
//
// File reference: dispatcher lines ~2742-2746 (4.4 before 4.5).
// ===========================================================================
describe('INV-11 — managed_model_not_allowed precedes billing in dispatcher', () => {
  it('INV-11: cleanup reason is "managed-model-not-allowed", not "billing-error"', async () => {
    getErrorKindMock.mockReturnValue('managed_model_not_allowed');
    const ctx = makeContext({
      error: new ModelError(
        'managed_model_not_allowed',
        'model not allowed by managed plan',
        403,
        'mindstone',
        { details: { managedModelNotAllowed: { requested: 'gpt-5.5-pro', allowed: ['gpt-5.5'] } } },
      ),
    });

    await dispatchErrorRecovery(ctx);

    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'managed-model-not-allowed');
    expect(completeTurnCleanupMock).not.toHaveBeenCalledWith('test-turn-id', 'billing-error');
  });
});

// ===========================================================================
// INV-12 — Rate-limit fallback `messageCount > 0` bypass requires
// !nestedFallbackQueryAttempted (post-260427).
//
// File reference: lines 333-339 (canAttemptConfiguredFallback).
// ===========================================================================
describe('INV-12 — rate-limit messageCount bypass refused when nested fallback ran', () => {
  it('INV-12: nestedFallbackQueryAttempted=true blocks the rate-limit configured-fallback bypass even when source=rate-limit', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    isRateLimitMessageMock.mockReturnValue(true);
    const retryTurn = vi.fn(async () => {});
    // Setup so that getRateLimitFallbackTarget would otherwise return null
    // (no Codex single-pick fallback) — so handleRateLimitFallback only path
    // out is configured-fallback, which must be blocked by INV-12.
    getRateLimitFallbackTargetMock.mockReturnValue(null);

    const ctx = makeContext({
      error: new ModelError('rate_limit', '429 too many requests', 429, 'OpenAI'),
      messageCount: 5,
      nestedFallbackQueryAttempted: true,
      // ensure non-Codex active provider so single-pick doesn't engage
      settings: {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/test',
        claude: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn,
    });

    const handled = await handleRateLimitFallback(ctx);

    expect(handled).toMatchObject({ kind: 'handled' });
    // No retry — fallback bypass refused, default rate-limit terminal path taken
    expect(retryTurn).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });
});

// ===========================================================================
// INV-13 — Codex rate limit waterfall: tier → OpenRouter → Anthropic, once
// per turn (rateLimitFallbackAttempted latch).
//
// File reference: lines 1657-1740.
// ===========================================================================
describe('INV-13 — Codex rate-limit waterfall is one-shot per turn', () => {
  it('INV-13: when turnOptions.rateLimitFallbackAttempted=true the waterfall does not re-fire', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        claude: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
      turnOptions: { rateLimitFallbackAttempted: true },
      retryTurn,
    });

    const handled = await handleRateLimitFallback(ctx);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });
});

// ===========================================================================
// INV-14 — Empty-result anomaly priority order:
// text recovery > tool recovery > zero-output dedicated > generic.
//
// File reference: lines 2110-2280.
// ===========================================================================
describe('INV-14 — empty_result_anomaly recovery priority order', () => {
  it('INV-14a: assistant-text recovery wins over tool-result recovery when both are present', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [{ role: 'assistant', text: 'Here is a summary.' }],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'web_search', stage: 'end', detail: 'r', isError: false, timestamp: 1 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const ctx = makeContext({ error: new Error('empty_result_anomaly: empty result with output tokens') });

    await classifyAndDispatchError(ctx);

    expect(makeSyntheticResultMock).toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining('Here is a summary.'),
      'error',
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-graceful-degradation');
  });

  it('INV-14b: zero-output anomaly (no recoverable content) routes to "completed-zero-output-no-recovery"', async () => {
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
    const ctx = makeContext({
      error: new EmptyResultAnomalyError({
        lastTurnOutputTokens: 0,
        loopTotalOutputTokens: 0,
        model: 'claude-opus-4-7',
        stopReason: 'end_turn',
      }),
    });

    await classifyAndDispatchError(ctx);

    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-zero-output-no-recovery');
  });
});

// ===========================================================================
// INV-15 — Pending user-question state coerces empty_result_anomaly to a
// clean awaiting_user pause (post-260420 Stage 2).
//
// File reference: lines 1990-2030.
// ===========================================================================
describe('INV-15 — user_question_pending coerces empty_result_anomaly to clean pause', () => {
  it('INV-15: hasUserQuestionPending=true => synthetic result with turnEndReason="awaiting_user" + cleanup "completed-pause-coerced"', async () => {
    registryMocks.hasUserQuestionPending.mockReturnValue(true);
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: { 'test-turn-id': [] },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);
    const ctx = makeContext({ error: new Error('empty_result_anomaly: empty result with output tokens') });

    await classifyAndDispatchError(ctx);

    expect(makeSyntheticResultMock).toHaveBeenCalledWith('test-turn-id', '', 'awaiting_user');
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-pause-coerced');
    // Sentry capture is observable (the regression-tagged path), not silent
    expect(captureExceptionMock).toHaveBeenCalled();
  });
});

// ===========================================================================
// INV-16 — Network errors bypass alt-model and server-error handlers; they
// flow to handler 9 (transient retry).
//
// File reference: dispatcher lines ~2713-2718.
// ===========================================================================
describe('INV-16 — network errors bypass alt-model and server-error handlers', () => {
  it('INV-16: network failure on direct-role profile is not classified as alt-model error', async () => {
    isNetworkErrorMock.mockReturnValue(true);
    isTransientErrorMock.mockReturnValue(true);
    getErrorKindMock.mockReturnValue('server_error'); // server_error + network → must NOT take alt-model path
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('fetch failed: ECONNREFUSED'),
      isDirectRoleProfile: true,
      retryTurn,
    });

    await dispatchErrorRecovery(ctx);

    // Alt-model would have called runAgentQuery for a Claude fallback — must NOT happen
    expect(runAgentQueryMock).not.toHaveBeenCalled();
    // Network errors flow into handler 9 (transient retry), which calls retryTurn
    expect(retryTurn).toHaveBeenCalled();
  });
});

// ===========================================================================
// INV-17 — Output-cap retry is one-shot per (turnId, model, profileId)
// with a messageCount === 0 gate.
//
// File reference: lines 1990-2050.
// ===========================================================================
describe('INV-17 — output-cap retry is one-shot per (turn, model, profile) with messageCount === 0 gate', () => {
  it('INV-17a: write succeeds + messageCount=0 + key not latched => retry, mark latch', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    safeDispatchLearnedLimitsFromErrorMock.mockReturnValue({ ok: true, observedCap: 8192, profileId: 'p1' });
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError(
        'invalid_request',
        'output cap exceeded',
        400,
        'Anthropic',
        { details: { outputCap: 8192 } },
      ),
      activeProfile: { id: 'p1', outputTokensSource: 'auto' } as unknown as ErrorRecoveryContext['activeProfile'],
      retryTurn,
      messageCount: 0,
    });

    const handled = await classifyAndDispatchError(ctx);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).toHaveBeenCalledTimes(1);
    expect(registryMocks.markOutputCapRetryAttempted).toHaveBeenCalledWith('test-turn-id|claude-sonnet-4-5|p1');
  });

  it('INV-17b: messageCount > 0 blocks output-cap retry even when key not latched', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    safeDispatchLearnedLimitsFromErrorMock.mockReturnValue({ ok: true, observedCap: 8192, profileId: 'p1' });
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError(
        'invalid_request',
        'output cap exceeded',
        400,
        'Anthropic',
        { details: { outputCap: 8192 } },
      ),
      activeProfile: { id: 'p1', outputTokensSource: 'auto' } as unknown as ErrorRecoveryContext['activeProfile'],
      retryTurn,
      messageCount: 7,
    });

    await classifyAndDispatchError(ctx);

    expect(retryTurn).not.toHaveBeenCalled();
    expect(registryMocks.markOutputCapRetryAttempted).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// INV-18 — Long-context fallback retry is one-shot per turn with a
// messageCount === 0 gate.
//
// File reference: line ~2540 (canTryLongContextFallback).
// ===========================================================================
describe('INV-18 — long-context fallback is one-shot with messageCount === 0 gate', () => {
  it('INV-18: messageCount > 0 prevents long-context fallback retry even with valid fallback target', async () => {
    getErrorKindMock.mockReturnValue('context_overflow');
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('Request too large (max 20MB).'),
      messageCount: 4,
      hasMedia: false,
      requestedModelForTurn: 'claude-sonnet-4-5',
      settings: {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/test',
        claude: {
          model: 'claude-sonnet-4-5',
          longContextFallbackModel: 'claude-haiku-4-5',
          apiKey: 'fake-ant-test-key',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn,
    });

    await classifyAndDispatchError(ctx);

    expect(retryTurn).not.toHaveBeenCalled();
    // Falls through to compaction-via-context_overflow event
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'context_overflow' }),
    );
  });
});

// ===========================================================================
// INV-19 — Context-overflow recovery emits exactly one `context_overflow`
// event per turn.
//
// File reference: line 2562 (hasContextOverflowDispatched / mark…).
// ===========================================================================
describe('INV-19 — context_overflow event is single-emit per turn', () => {
  it('INV-19a: first overflow marks the turn and emits context_overflow', async () => {
    registryMocks.hasContextOverflowDispatched.mockReturnValue(false);
    const ctx = makeContext({
      error: new Error('context window exceeded — too many tokens'),
      hasMedia: false,
    });

    await classifyAndDispatchError(ctx);

    expect(registryMocks.markContextOverflowDispatched).toHaveBeenCalledWith('test-turn-id');
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'context_overflow' }),
    );
  });

  it('INV-19b: subsequent overflow on same turn is suppressed (no second context_overflow event)', async () => {
    registryMocks.hasContextOverflowDispatched.mockReturnValue(true);
    const ctx = makeContext({
      error: new Error('context window exceeded — too many tokens'),
      hasMedia: false,
    });

    await classifyAndDispatchError(ctx);

    expect(registryMocks.markContextOverflowDispatched).not.toHaveBeenCalled();
    const overflowEvents = dispatchAgentEventMock.mock.calls
      .map((c) => c[2] as { type?: string })
      .filter((e) => e.type === 'context_overflow');
    expect(overflowEvents).toHaveLength(0);
  });
});

// ===========================================================================
// INV-20 — Transient retry: extended backoff for network errors (5–30s),
// short delays for other transients (1–8s); status surfaced only on network.
//
// File reference: lines 1894-1900.
// ===========================================================================
describe('INV-20 — transient retry distinguishes network-error backoff from other transients', () => {
  it('INV-20a: network errors get >=5000ms initial delay AND a status event', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(true);
    delayWithAbortMock.mockResolvedValue(false);
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('ETIMEDOUT'),
      retryTurn,
    });

    await handleTransientAndProcessExitRetry(ctx);

    expect(retryTurn).toHaveBeenCalled();
    expect(delayWithAbortMock).toHaveBeenCalledTimes(1);
    const [delayMs] = delayWithAbortMock.mock.calls[0];
    expect(delayMs as number).toBeGreaterThanOrEqual(5000);
    expect(delayMs as number).toBeLessThanOrEqual(30_000);
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'status' }),
    );
  });

  it('INV-20b: non-network transients get <=8000ms delay and NO user-visible status', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(false);
    delayWithAbortMock.mockResolvedValue(false);
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('503 Service Unavailable'),
      retryTurn,
    });

    await handleTransientAndProcessExitRetry(ctx);

    expect(retryTurn).toHaveBeenCalled();
    const [delayMs] = delayWithAbortMock.mock.calls[0];
    expect(delayMs as number).toBeLessThanOrEqual(8000);
    const statusEvents = dispatchAgentEventMock.mock.calls
      .map((c) => c[2] as { type?: string })
      .filter((e) => e.type === 'status');
    expect(statusEvents).toHaveLength(0);
  });
});

// ===========================================================================
// INV-21 — Empty_result_anomaly gets exactly one fresh-turn retry before
// reporting (resetConversation: true).
//
// File reference: line 1855.
// ===========================================================================
describe('INV-21 — empty_result_anomaly: exactly one fresh-turn retry then graceful degradation', () => {
  it('INV-21a: first hit retries with resetConversation=true', async () => {
    registryMocks.getRetryCount.mockReturnValue(0);
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('empty_result_anomaly: empty result'),
      retryTurn,
    });

    const handled = await handleTransientAndProcessExitRetry(ctx);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).toHaveBeenCalledWith({ resetConversation: true });
  });

  it('INV-21b: second hit (retryCount >= 1) falls through to graceful degradation', async () => {
    registryMocks.getRetryCount.mockReturnValue(1);
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('empty_result_anomaly: empty result'),
      retryTurn,
    });

    const handled = await handleTransientAndProcessExitRetry(ctx);

    expect(handled).toMatchObject({ kind: 'passthrough' });
    expect(retryTurn).not.toHaveBeenCalled();
    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ errorCategory: 'empty_result_anomaly' }),
      expect.stringContaining('falling through to graceful degradation'),
    );
  });
});

// ===========================================================================
// INV-22 — MessageTimeoutError with `reason: 'hard_cap'` skips
// network/Anthropic-status diagnostics.
//
// File reference: line 2608.
// ===========================================================================
describe('INV-22 — MessageTimeoutError reason="hard_cap" skips diagnoseTimeout', () => {
  it('INV-22: hard_cap timeout never invokes diagnoseTimeout (it was active, not stalled)', async () => {
    const err = Object.assign(new Error('Hard cap exceeded'), {
      name: 'MessageTimeoutError',
      reason: 'hard_cap',
      timeoutMs: 90 * 60_000,
    });
    const ctx = makeContext({ error: err });

    await classifyAndDispatchError(ctx);

    expect(diagnoseTimeoutMock).not.toHaveBeenCalled();
    const event = dispatchAgentEventMock.mock.calls[0][2] as { error?: string };
    expect(event.error).toContain('over');
    expect(event.error).toContain('minutes');
  });
});

// ===========================================================================
// INV-23 — MessageTimeoutError Sentry capture is deduped per
// (rendererSessionId × category) with LRU of 500.
//
// File reference: line 117 (MAX_EXPECTED_TIMEOUT_SENTRY_KEYS).
// ===========================================================================
describe('INV-23 — message_timeout Sentry capture is deduped per (sessionId × category)', () => {
  it('INV-23: second timeout in same session does not re-capture, but is logged with the suppression message', async () => {
    diagnoseTimeoutMock.mockResolvedValue({ kind: 'transient_stall' });
    const makeTimeoutError = () => {
      const err = new Error('stall and timed out');
      err.name = 'MessageTimeoutError';
      return err;
    };

    const first = makeContext({
      error: makeTimeoutError(),
      rendererSessionId: 'shared-session-INV23',
    });
    const second = makeContext({
      error: makeTimeoutError(),
      rendererSessionId: 'shared-session-INV23',
      turnId: 'turn-INV23-2',
    });

    await classifyAndDispatchError(first);
    await classifyAndDispatchError(second);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        fallthroughCategory: 'message_timeout',
        rendererSessionId: 'shared-session-INV23',
      }),
      expect.stringContaining('suppressing duplicate Sentry capture'),
    );
  });
});

// ===========================================================================
// INV-24 — ChatIncompatibility auto-mark fires at dispatcher step 2.5,
// BEFORE the thinking-model handler (which also catches model_unavailable).
//
// File reference: dispatcher lines ~2738-2762.
// ===========================================================================
describe('INV-24 — chat-incompat auto-mark fires at dispatcher step 2.5', () => {
  it('INV-24: chat-incompat error on a compatible profile causes updateSettings to mark the profile incompatible', async () => {
    // Error message includes the chat-incompat substring so isChatIncompatibilityError() returns true
    const err = new Error('400 invalid_request_error: This is not a chat model and thus not supported in the v1/chat/completions endpoint.');
    const incompatibleProfile = {
      id: 'profile-X',
      model: 'gpt-5.5-pro',
      providerType: 'openai',
      chatCompatibility: 'compatible',
      name: 'BYOK profile',
    };
    getSettingsMock.mockReturnValue({
      localModel: {
        profiles: [incompatibleProfile],
        activeProfileId: 'profile-X',
      },
    });

    const ctx = makeContext({
      error: err,
      activeProfile: incompatibleProfile as unknown as ErrorRecoveryContext['activeProfile'],
      isDirectRoleProfile: true,
    });

    await dispatchErrorRecovery(ctx);

    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    const updateArg = updateSettingsMock.mock.calls[0][0] as {
      localModel: { profiles: Array<{ id: string; chatCompatibility: string; chatCompatibilityCheckedAt?: string }> };
    };
    const updatedTarget = updateArg.localModel.profiles.find((p) => p.id === 'profile-X');
    expect(updatedTarget?.chatCompatibility).toBe('incompatible');
    expect(updatedTarget?.chatCompatibilityCheckedAt).toEqual(expect.any(String));
  });
});

// ===========================================================================
// INV-26 — Tool-use-incompatibility auto-mark (Gemini thought_signature;
// REBEL-5RJ variant 2) fires at dispatcher step 2.6, mirroring INV-24.
// ===========================================================================
describe('INV-26 — tool-use-incompat auto-mark fires at dispatcher step 2.6', () => {
  it('INV-26: thought_signature error on a tool-compatible profile marks it tool-use-incompatible', async () => {
    const err = new Error('400 invalid_request_error: Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly.');
    const profile = {
      id: 'profile-G',
      model: 'gemini-2.5-pro',
      providerType: 'other',
      chatCompatibility: 'compatible',
      toolUseCompatibility: 'compatible',
      name: 'Gateway profile',
    };
    getSettingsMock.mockReturnValue({
      localModel: {
        profiles: [profile],
        activeProfileId: 'profile-G',
      },
    });

    const ctx = makeContext({
      error: err,
      activeProfile: profile as unknown as ErrorRecoveryContext['activeProfile'],
      isDirectRoleProfile: true,
    });

    await dispatchErrorRecovery(ctx);

    expect(updateSettingsMock).toHaveBeenCalledTimes(1);
    const updateArg = updateSettingsMock.mock.calls[0][0] as {
      localModel: { profiles: Array<{ id: string; toolUseCompatibility: string; toolUseCompatibilityCheckedAt?: string }> };
    };
    const updatedTarget = updateArg.localModel.profiles.find((p) => p.id === 'profile-G');
    expect(updatedTarget?.toolUseCompatibility).toBe('incompatible');
    expect(updatedTarget?.toolUseCompatibilityCheckedAt).toEqual(expect.any(String));
  });
});

// ===========================================================================
// INV-25 — Recovery handlers never bypass completeTurnCleanup. Every
// terminal exit path either explicitly calls completeTurnCleanup (returns
// true) or returns false letting the dispatcher's final step do it.
//
// File reference: dispatcher tail.
// ===========================================================================
describe('INV-25 — recovery dispatcher always reaches completeTurnCleanup', () => {
  it('INV-25a: unknown/no-op error path => dispatcher final cleanup with reason="error"', async () => {
    getErrorKindMock.mockReturnValue('unknown');
    const ctx = makeContext({ error: new Error('totally novel weird error') });

    await dispatchErrorRecovery(ctx);

    expect(completeTurnCleanupMock).toHaveBeenCalledTimes(1);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'error');
  });

  it('INV-25b: post-fallback server error retries-exhausted path completes cleanup with "server-error"', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(2);
    const ctx = makeContext({
      error: new ModelError('server_error', 'after fallback overloaded', 503, 'Anthropic'),
    });

    const handled = await handlePostFallbackServerError(ctx, /* isServerErrorRetry */ false, /* isNetworkFailure */ false);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'server-error');
  });
});

// ===========================================================================
// Sentry capture-site coverage — pinning the 7+ raw getErrorReporter()
// .captureException(...) sites that the bug archaeology report flags as
// candidates for the future captureKnownCondition wrapper migration.
// (Stage 5 will migrate; Stage 1 just pins the *count* and *categorisation*.)
//
// Bug archaeology § "Bug clusters / Sentry observability calibration"
// ===========================================================================
describe('Sentry capture-site coverage (raw captureException — Stage 5 wrapper candidates)', () => {
  it('Sentry-A: tool_input_too_large captures with structured tags', () => {
    registryMocks.getOrCreateAccumulator.mockReturnValue({
      hasPossiblyMutatingToolCall: vi.fn(() => false),
      getExecutedToolCalls: vi.fn(() => []),
    });
    const err = new ModelError(
      'tool_input_too_large',
      'cap exceeded',
      undefined,
      undefined,
      { details: { toolName: 'X', bytesAccumulated: 10, capBytes: 5 } },
    );
    const ctx = makeContext({ error: err });

    handleToolInputTooLarge(ctx);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureExceptionMock).toHaveBeenCalledWith(
      err,
      expect.objectContaining({
        tags: expect.objectContaining({ tool_input_too_large: true, tool_name: 'X' }),
      }),
    );
  });

  it('Sentry-B: classifyAndDispatchError on ModelError uses the captureKnownCondition fingerprint shape', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    const err = new ModelError('rate_limit', 'rate limited', 429, 'anthropic', { upstreamProvider: 'aws-bedrock' });
    const ctx = makeContext({ error: err });

    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, captureCtx] = captureExceptionMock.mock.calls[0];
    expect(captureCtx).toMatchObject({
      fingerprint: ['model-error', 'rate_limit', 'anthropic', 'aws-bedrock'],
      _knownConditionWrapped: true,
    });
  });
});

// ===========================================================================
// SUPPLEMENT — adversarial cases closing F1-F6 from
// `subagent_reports/260526_185000_tester-stage1-invariants-review.md`.
// All cases pin TODAY's observable behaviour so Stage 2-5 carve-outs can use
// this file as a behaviour-preservation gate.
// ===========================================================================

// ---------------------------------------------------------------------------
// F1 — Adversarial nested-fallback "tried-and-failed" with real activity.
//
// Drives a nested `runAgentQuery` (via handleExtendedContextFallback) that
// emits real API output through `onApiOutput` and then rejects. Pins that:
//   1. ctx.nestedFallbackQueryAttempted gets set
//   2. ctx.messageCount reflects the real API output the runner emitted
//   3. the downstream restart gate (handleServerErrorRetry) refuses to retry
//   4. cleanup reason is the activity-aware "server-error" discriminator
//
// File reference: lines 887-925 (200K nested fallback runs onApiOutput),
// 1218 (handleServerErrorRetry messageCount > 0 guard).
// Closes review F1 — the existing INV-12 mutates ctx fields directly.
// ---------------------------------------------------------------------------
describe('INV-12-adv — nested fallback runs onApiOutput then fails; activity-aware downstream gate refuses retry', () => {
  it('INV-12-adv: nested 200K fallback emits onApiOutput then rejects → nestedFallbackQueryAttempted=true, messageCount bumped, server-error retry refuses', async () => {
    isExtendedContextUnavailableErrorMock.mockReturnValue(true);
    const config200K = { model: 'claude-sonnet-4-5', envOverrides: undefined };
    stripExtendedContextFromConfigMock.mockReturnValue(
      config200K as unknown as ReturnType<typeof stripExtendedContextFromConfigMock>,
    );

    runAgentQueryMock.mockImplementationOnce(
      async (config: { onApiOutput: (m: unknown) => void }) => {
        config.onApiOutput({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } });
        config.onApiOutput({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
        throw new ModelError('server_error', 'overloaded mid-stream', 503, 'Anthropic');
      },
    );

    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('extended context unavailable'),
      extendedContextEnabled: true,
      messageCount: 0,
      retryTurn,
    });

    const { handleExtendedContextFallback } = await import('../turnErrorRecovery');
    const handled = await handleExtendedContextFallback(ctx);

    expect(handled).toMatchObject({ kind: 'soft-failed', activityEmitted: true });
    expect(ctx.nestedFallbackQueryAttempted).toBe(true);
    expect(ctx.messageCount).toBe(2);
    expect(ctx.error).toBeInstanceOf(ModelError);

    getErrorKindMock.mockReturnValue('server_error');
    const serverHandled = await handleServerErrorRetry(ctx, /* isServerErrorRetry */ true, /* isAltModelError */ false);

    expect(serverHandled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).not.toHaveBeenCalled();
    expect(delayWithAbortMock).not.toHaveBeenCalled();
    expect(mockTurnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ messageCount: 2 }),
      expect.stringContaining('Server error retry skipped'),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'server-error');
  });
});

// ---------------------------------------------------------------------------
// F2 — Codex rate-limit messageCount === 0 gate.
//
// Pins handleRateLimitFallback's `isCodex && !alreadyAttempted &&
// messageCount === 0` single-pick fallback gate (line ~1657). Two sub-cases
// in two it() bodies for clarity. Closes review F2.
//
// File reference: lines 1648-1740.
// ---------------------------------------------------------------------------
describe('INV-9-codex — Codex single-pick rate-limit fallback gates on messageCount === 0', () => {
  it('INV-9-codex-a: Codex + messageCount=0 + !nestedFallbackQueryAttempted + fallback target available → fallback dispatched (retryTurn called, recordRateLimit called)', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    isRateLimitMessageMock.mockReturnValue(true);
    extractRetryAfterMsMock.mockReturnValue(60_000);
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', '429 too many requests', 429, 'OpenAI'),
      messageCount: 0,
      nestedFallbackQueryAttempted: false,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        claude: { model: 'claude-sonnet-4-5' },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn,
    });

    const handled = await handleRateLimitFallback(ctx);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).toHaveBeenCalledTimes(1);
    expect(recordRateLimitMock).toHaveBeenCalledWith(60_000);
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
    expect(registryMocks.addTurnFallback).toHaveBeenCalledWith(
      'test-turn-id',
      expect.objectContaining({ reason: 'codex-rate-limit' }),
    );
  });

  it('INV-9-codex-b: Codex + messageCount > 0 + fallback target available → gate refuses; no retry, cleanup with rate-limit reason', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    isRateLimitMessageMock.mockReturnValue(true);
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });
    const retryTurn = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', '429 too many requests', 429, 'OpenAI'),
      messageCount: 6,
      nestedFallbackQueryAttempted: false,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        claude: { model: 'claude-sonnet-4-5' },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn,
    });

    const handled = await handleRateLimitFallback(ctx);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurn).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });
});

// ---------------------------------------------------------------------------
// F3 — Exact underscore `request_too_large` classifier cascade.
//
// Pins lines 2249-2259: `lowerErrorMsg.includes('request_too_large')` matches
// the exact-underscore form. With hasMedia=true the cascade routes to the
// attachment-size dispatch ("Your attachment exceeds the 32MB API limit...")
// — note the underscore form does NOT match `isContextOverflowError` because
// that branch only matches the spaced "request too large" or "413". Pinned
// here so Stage 4's typed-classifier migration cannot silently change either
// branch. Closes review F3.
//
// File reference: lines 2249-2280, 2430-2440 (attachment dispatch),
//                 2575+ (generic else-branch dispatch).
// ---------------------------------------------------------------------------
describe('INV-18-classifier — exact underscore `request_too_large` cascade', () => {
  it('INV-18-classifier-a: exact `request_too_large` + hasMedia=true → attachment-size dispatch (32MB API limit copy)', async () => {
    const ctx = makeContext({
      error: new Error('request_too_large'),
      hasMedia: true,
    });

    await classifyAndDispatchError(ctx);

    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3] as { humanizedOverride?: string } | undefined;
    expect(opts?.humanizedOverride).toContain('32MB API limit');
    const overflowEvents = dispatchAgentEventMock.mock.calls
      .map((c) => c[2] as { type?: string })
      .filter((e) => e.type === 'context_overflow');
    expect(overflowEvents).toHaveLength(0);
  });

  it('INV-18-classifier-b: exact `request_too_large` + hasMedia=false → falls through to generic dispatch (no attachment override, no context_overflow event)', async () => {
    const ctx = makeContext({
      error: new Error('request_too_large'),
      hasMedia: false,
    });

    await classifyAndDispatchError(ctx);

    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3] as { humanizedOverride?: string } | undefined;
    expect(opts?.humanizedOverride).toBeUndefined();
    const overflowEvents = dispatchAgentEventMock.mock.calls
      .map((c) => c[2] as { type?: string })
      .filter((e) => e.type === 'context_overflow');
    expect(overflowEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// F4 — Table-driven coverage of the remaining raw `captureException` sites.
//
// Stage 5 (PLAN.md hotspot 2) migrated these sites to `captureKnownCondition`.
// Each site now routes through the registry-owned fingerprint — no raw
// `captureException` survives in this file. The expectations below pin both
// the legacy tag shape (still attached for searchability) AND the new
// fingerprint + `_knownConditionWrapped: true` flag, so a future regression
// that drops the wrapper at any of these sites breaks this suite.
//
// Sites covered (file refs):
//   - managed-model-not-allowed:           handleManagedModelNotAllowed
//   - billing:                             handleBillingError
//   - empty-result text-recovery:          classifyAndDispatchError
//   - empty-result tool-recovery:          classifyAndDispatchError
//   - empty-result zero-output:            classifyAndDispatchError
//   - empty-result retry-failed:           classifyAndDispatchError
//   - user-question-pending coercion:      classifyAndDispatchError
//   - generic non-ModelError fallthrough:  classifyAndDispatchError
//
// Closes review F4 + Stage 5 cluster 3 (Sentry observability calibration).
// ---------------------------------------------------------------------------
describe('INV-Sentry-table — capture-site coverage for Stage 5 wrapper migration', () => {
  type SentryCaseSpec = {
    site: string;
    arrange: () => Promise<{ run: () => Promise<void> }>;
    expectedTagFragment: Record<string, unknown>;
    expectedFingerprint: readonly string[];
  };

  const cases: SentryCaseSpec[] = [
    {
      site: 'managed-model-not-allowed',
      expectedTagFragment: { error_kind: 'managed_model_not_allowed' },
      expectedFingerprint: ['recovery-managed-model-not-allowed', 'mindstone'],
      arrange: async () => {
        getErrorKindMock.mockReturnValue('managed_model_not_allowed');
        const ctx = makeContext({
          error: new ModelError(
            'managed_model_not_allowed',
            'model not allowed by managed plan',
            403,
            'mindstone',
            { details: { managedModelNotAllowed: { requested: 'gpt-5.5-pro', allowed: ['gpt-5.5'] } } },
          ),
        });
        return { run: async () => { await dispatchErrorRecovery(ctx); } };
      },
    },
    {
      site: 'billing',
      expectedTagFragment: { error_kind: 'billing' },
      expectedFingerprint: ['recovery-billing-quota', 'unknown'],
      arrange: async () => {
        getErrorKindMock.mockReturnValue('billing');
        const ctx = makeContext({
          error: new Error('429 insufficient_quota - usage limit exceeded'),
        });
        return { run: async () => { await dispatchErrorRecovery(ctx); } };
      },
    },
    {
      site: 'empty-result-text-recovery',
      expectedTagFragment: { sdk_error_category: 'empty_result_anomaly', empty_result_classification: 'text_recovery' },
      expectedFingerprint: ['recovery-empty-result-anomaly', 'text_recovery'],
      arrange: async () => {
        registryMocks.getContextAccumulator.mockReturnValue({
          messages: [{ role: 'assistant', text: 'Here is a summary.' }],
          eventsByTurn: { 'test-turn-id': [] },
          activeTurnId: 'test-turn-id',
          isBusy: false,
          lastError: null,
          lastErrorSource: null,
          terminatedTurnIds: new Set(),
        } as unknown as ConversationStateShape);
        const ctx = makeContext({ error: new Error('empty_result_anomaly: empty result with output tokens') });
        return { run: async () => { await classifyAndDispatchError(ctx); } };
      },
    },
    {
      site: 'empty-result-tool-recovery',
      expectedTagFragment: { sdk_error_category: 'empty_result_anomaly', empty_result_classification: 'tool_recovery' },
      expectedFingerprint: ['recovery-empty-result-anomaly', 'tool_recovery'],
      arrange: async () => {
        registryMocks.getContextAccumulator.mockReturnValue({
          messages: [],
          eventsByTurn: {
            'test-turn-id': [
              { type: 'tool', toolName: 'web_search', stage: 'end', detail: 'r', isError: false, timestamp: 1 },
            ],
          },
          activeTurnId: 'test-turn-id',
          isBusy: false,
          lastError: null,
          lastErrorSource: null,
          terminatedTurnIds: new Set(),
        } as unknown as ConversationStateShape);
        const ctx = makeContext({ error: new Error('empty_result_anomaly: empty result with output tokens') });
        return { run: async () => { await classifyAndDispatchError(ctx); } };
      },
    },
    {
      site: 'empty-result-zero-output',
      expectedTagFragment: { sdk_error_category: 'empty_result_anomaly', empty_result_classification: 'zero_output_no_recovery' },
      expectedFingerprint: ['recovery-empty-result-anomaly', 'zero_output_no_recovery'],
      arrange: async () => {
        registryMocks.getContextAccumulator.mockReturnValue(undefined);
        const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
        const ctx = makeContext({
          error: new EmptyResultAnomalyError({
            lastTurnOutputTokens: 0,
            loopTotalOutputTokens: 0,
            model: 'claude-opus-4-7',
            stopReason: 'end_turn',
          }),
        });
        return { run: async () => { await classifyAndDispatchError(ctx); } };
      },
    },
    {
      site: 'empty-result-retry-failed',
      expectedTagFragment: { sdk_error_category: 'empty_result_anomaly', empty_result_classification: 'retry_failed_no_recovery' },
      expectedFingerprint: ['recovery-empty-result-anomaly', 'retry_failed_no_recovery'],
      arrange: async () => {
        registryMocks.getContextAccumulator.mockReturnValue(undefined);
        registryMocks.getRetryCount.mockReturnValue(1);
        const ctx = makeContext({ error: new Error('empty_result_anomaly: empty result with output tokens') });
        return { run: async () => { await classifyAndDispatchError(ctx); } };
      },
    },
    {
      site: 'user-question-pending-coercion',
      expectedTagFragment: { regression: 'pause_detection_missed' },
      expectedFingerprint: ['recovery-pause-detection-missed'],
      arrange: async () => {
        registryMocks.hasUserQuestionPending.mockReturnValue(true);
        registryMocks.getContextAccumulator.mockReturnValue({
          messages: [],
          eventsByTurn: { 'test-turn-id': [] },
          activeTurnId: 'test-turn-id',
          isBusy: false,
          lastError: null,
          lastErrorSource: null,
          terminatedTurnIds: new Set(),
        } as unknown as ConversationStateShape);
        const ctx = makeContext({ error: new Error('empty_result_anomaly: empty result with output tokens') });
        return { run: async () => { await classifyAndDispatchError(ctx); } };
      },
    },
    {
      site: 'generic-non-ModelError-fallthrough',
      expectedTagFragment: { source: 'rebel-core-runtime' },
      expectedFingerprint: ['recovery-unknown-error'],
      arrange: async () => {
        getErrorKindMock.mockReturnValue('unknown');
        const ctx = makeContext({ error: new Error('totally novel weird thing') });
        return { run: async () => { await classifyAndDispatchError(ctx); } };
      },
    },
  ];

  it.each(cases)(
    'INV-Sentry-table[$site]: captures exactly once via captureKnownCondition with stable fingerprint and `_knownConditionWrapped: true`',
    async (spec) => {
      const { run } = await spec.arrange();
      await run();

      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [, captureCtx] = captureExceptionMock.mock.calls[0] as [
        unknown,
        { tags?: Record<string, unknown>; fingerprint?: readonly string[]; _knownConditionWrapped?: unknown } | undefined,
      ];
      expect(captureCtx?.tags).toMatchObject(spec.expectedTagFragment);
      expect(captureCtx?.fingerprint).toEqual(spec.expectedFingerprint);
      expect(captureCtx?._knownConditionWrapped).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// F5 — Dual-producer terminal-event single-emit.
//
// Pins TODAY's behaviour: turnErrorRecovery has no producer-side awareness of
// other terminal-event emitters (e.g. agentMessageHandler — see PM 260425
// `260425_classified_followon_error_dropped_by_turnid_guard_postmortem.md`).
// When a simulated agentMessageHandler-style producer has already dispatched
// an error event for the same turnId, turnErrorRecovery still emits its own
// terminal events (the renderer-side supersede in `conversationState.ts` is
// the only guard). Pin this honestly so the post-260425 renderer fix isn't
// regressed silently, and so a future producer-side coordinator (Stage TBD)
// has a tracking test to flip when the durable structural fix lands. Closes
// review F5.
//
// TODO Stage TBD: producer-side single-emit. When that lands, this test must
// be flipped to assert `terminalEventCount === 1` (the second-emit is
// swallowed) instead of `terminalEventCount > 1`.
// ---------------------------------------------------------------------------
describe('INV-1c — dual-producer terminal-event single-emit (pinning current behaviour)', () => {
  it('INV-1c: turnErrorRecovery emits its terminal events even when an external producer already dispatched one for the same turnId — renderer supersede is the only guard today (TODO Stage TBD: producer-side single-emit coordinator)', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');

    dispatchAgentEventMock({} /* simulated EventWindow */, 'test-turn-id', {
      type: 'error',
      error: 'Provider returned error',
      errorSource: 'main',
      timestamp: Date.now(),
    });
    const externalEmitCount = dispatchAgentEventMock.mock.calls.length;
    expect(externalEmitCount).toBe(1);

    const ctx = makeContext({
      error: new ModelError('rate_limit', '429 too many', 429, 'OpenAI'),
    });

    await dispatchErrorRecovery(ctx);

    const terminalEvents = dispatchAgentEventMock.mock.calls
      .map((c) => c[2] as { type?: string })
      .filter((e) => e.type === 'error' || e.type === 'result');
    expect(terminalEvents.length).toBeGreaterThan(externalEmitCount);
  });
});

// ---------------------------------------------------------------------------
// F6 — Compaction-overlay routing producer contract.
//
// PM 260513 was a producer/consumer contract drift on the `context_overflow`
// event. This case pins the producer's payload shape so the renderer-side
// overlay router (and `RecoveryEvent` reducer) can key off stable fields:
//   { type: 'context_overflow', originalPrompt: string, timestamp: number }
//
// The schema lives in `src/shared/types/agent.ts` (the AgentEvent discriminated
// union). Stage 1 only gates the producer side; the renderer/recovery
// pipeline test would belong to its own integration harness. Closes review
// F6 (producer-side; consumer-side wired test is out of scope for the
// invariant suite — see review for context).
//
// File reference: lines 2546-2558 (`dispatchAgentEvent` with `context_overflow`).
// ---------------------------------------------------------------------------
describe('INV-18-routing — context_overflow producer payload matches the renderer contract', () => {
  it('INV-18-routing: emitted context_overflow event includes the type/originalPrompt/timestamp fields the consumer keys off (per src/shared/types/agent.ts)', async () => {
    registryMocks.hasContextOverflowDispatched.mockReturnValue(false);
    registryMocks.getTurnPrompt.mockReturnValue('Compact this please.');
    const ctx = makeContext({
      error: new Error('context window exceeded — too many tokens'),
      hasMedia: false,
    });

    await classifyAndDispatchError(ctx);

    const overflowCalls = dispatchAgentEventMock.mock.calls.filter(
      (c) => (c[2] as { type?: string }).type === 'context_overflow',
    );
    expect(overflowCalls).toHaveLength(1);
    const [winArg, turnIdArg, payload] = overflowCalls[0] as [
      unknown,
      string,
      { type: string; originalPrompt?: unknown; timestamp?: unknown },
    ];
    expect(winArg).toBeNull();
    expect(turnIdArg).toBe('test-turn-id');
    expect(payload).toMatchObject({
      type: 'context_overflow',
      originalPrompt: 'Compact this please.',
    });
    expect(typeof payload.timestamp).toBe('number');
  });
});
