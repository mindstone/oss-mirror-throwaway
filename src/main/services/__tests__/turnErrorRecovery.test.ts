import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APIError } from '@anthropic-ai/sdk';
import {
  createBuildContinuationContextMock,
  createModelNormalizationMock,
} from './agentTurnExecutor.testHarness';
import type { ConversationStateShape } from '@shared/utils/conversationState';
import type { AgentEvent, ModelProfile } from '@shared/types';
import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';
import { EmptyResultAnomalyError } from '@shared/utils/emptyResultAnomalyError';
import { RECOVERY_OWNER_BY_KIND, type RecoveryOwner } from '@core/services/turnErrorRecoveryOwnership';


vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
    getSubscriptionState: vi.fn(() => null),
    getManagedAllowanceResetsAt: vi.fn(() => undefined),
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

// ---------------------------------------------------------------------------
// vi.hoisted mock refs — create BEFORE module-level vi.mock() calls
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
  providerRecordRateLimitMock,
  providerRecordSuccessMock,
  getFailoverCredentialCandidatesMock,
  captureExceptionMock,
  captureMessageMock,
  updateLastApiCallTimeMock,
  getRateLimitFallbackTargetMock,
  dispatchLearnedLimitsFromErrorMock,
  safeDispatchLearnedLimitsFromErrorMock,
  mockTurnLogger,
  registryMocks,
} = vi.hoisted(() => {
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const dispatchLearnedLimitsFromErrorMock = vi.fn((..._args: unknown[]) => null as any);

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
      intentionalCopyOverrideForKind?: string;
      isTransient?: boolean;
      errorKindOverride?: string;
      providerOverride?: string;
      markActionable?: boolean;
      timeoutDiagnostic?: unknown;
      watchdogDiagnostic?: unknown;
      rateLimitMetaOverride?: unknown;
      timestampOverride?: number;
      recoveryOwner?: RecoveryOwner;
    }) => {
      const rawMessage =
        typeof rawError === 'string'
          ? rawError
          : typeof rawError === 'object' && rawError !== null && typeof (rawError as { __rawMessage?: unknown }).__rawMessage === 'string'
              ? (rawError as { __rawMessage: string }).__rawMessage
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
        ...(opts?.timeoutDiagnostic ? { timeoutDiagnostic: opts.timeoutDiagnostic } : {}),
        ...(opts?.watchdogDiagnostic ? { watchdogDiagnostic: opts.watchdogDiagnostic } : {}),
        ...(errorKind === 'rate_limit' && opts?.rateLimitMetaOverride ? { rateLimitMeta: opts.rateLimitMetaOverride } : {}),
        errorSource: 'main',
        timestamp: opts?.timestampOverride ?? Date.now(),
      });

      if (opts?.markActionable === true || (errorKind === 'billing' && opts?.markActionable !== false)) {
        registryMocks.markActionableErrorDispatched(turnId);
      }

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
    providerRecordRateLimitMock: vi.fn(),
    providerRecordSuccessMock: vi.fn(),
    getFailoverCredentialCandidatesMock: vi.fn((): ReadonlySet<string> => new Set()),
    captureExceptionMock: vi.fn(),
    captureMessageMock: vi.fn(),
    updateLastApiCallTimeMock: vi.fn(),
    getRateLimitFallbackTargetMock: vi.fn((): unknown => null),
    dispatchLearnedLimitsFromErrorMock,
    safeDispatchLearnedLimitsFromErrorMock: dispatchLearnedLimitsFromErrorMock,
    mockTurnLogger,
    registryMocks: {
      markExtendedContextFailed: vi.fn(),
      clearExtendedContextFailed: vi.fn(),
      setTurnExtendedContext: vi.fn(),
      setTurnModel: vi.fn(),
      addTurnFallback: vi.fn(),
      setTurnAuthMethod: vi.fn(),
      setTurnActiveProvider: vi.fn(),
      getRetryCount: vi.fn(() => 0),
      incrementRetryCount: vi.fn(() => 1),
      deleteRetryCount: vi.fn(),
      getRetryStartTime: vi.fn((): number | undefined => undefined),
      setRetryStartTime: vi.fn(),
      deleteRetryStartTime: vi.fn(),
      cleanupForRetry: vi.fn(),
      getActiveTurnController: vi.fn(() => null),
      getContextAccumulator: vi.fn((): ConversationStateShape | undefined => undefined),
      getOrCreateAccumulator: vi.fn((): {
        hasPossiblyMutatingToolCall: () => boolean;
        getExecutedToolCalls: () => Array<{
          toolName: string;
          toolUseId?: string;
          annotations: Record<string, unknown>;
          timestamp: number;
        }>;
      } => ({
        hasPossiblyMutatingToolCall: vi.fn(() => false),
        getExecutedToolCalls: vi.fn(() => []),
      })),
      hasContextOverflowDispatched: vi.fn(() => false),
      markContextOverflowDispatched: vi.fn(),
      hasOutputCapRetryAttempted: vi.fn((_key: string) => false),
      markOutputCapRetryAttempted: vi.fn((_key: string) => {}),
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
    },
  };
});

// ---------------------------------------------------------------------------
// Module mocks (must mirror imports of turnErrorRecovery.ts)
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
  humanizeProviderServerError: vi.fn((provider?: string) => {
    const lower = provider?.toLowerCase() ?? '';
    if (lower.includes('openai') || lower.includes('codex')) return 'OpenAI Codex had a moment. Retry — your work so far is saved.';
    if (lower.includes('anthropic')) return 'Anthropic had a moment. Retry — your work so far is saved.';
    return 'The model service had a moment. Retry — your work so far is saved.';
  }),
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

vi.mock('@core/services/buildContinuationContext', () => createBuildContinuationContextMock());

 
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

vi.mock('@core/rebelCore/providerRouting', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/rebelCore/providerRouting')>();
  return {
    ...actual,
    getFailoverCredentialCandidates: getFailoverCredentialCandidatesMock,
  };
});

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
  dispatchLearnedLimitsFromError: dispatchLearnedLimitsFromErrorMock,
  safeDispatchLearnedLimitsFromError: safeDispatchLearnedLimitsFromErrorMock,
}));

// Pass through actual pure error helpers (no deps, no side effects)
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
  handleExtendedContextFallback,
  handleAltModelFallback,
  handleProviderChainRecoveryFallback,
  handleServerErrorRetry,
  handleBillingError,
  handleRateLimitFallback,
  handleThinkingModelFallback,
  handlePostFallbackServerError,
  handleTransientAndProcessExitRetry,
  handleToolInputTooLarge,
  handleOfflineFailFast,
  classifyAndDispatchError,
  dispatchErrorRecovery,
  roleFromDecisionRole,
  type ErrorRecoveryContext,
  type TurnRetryOverrides,
} from '../turnErrorRecovery';
import { classifyError, ModelError } from '@core/rebelCore/modelErrors';
import { annotateModelRuntimeRole } from '@core/rebelCore/configuredRoleFallback';
import { ConnectionNotConfiguredError } from '@shared/utils/connectionCredentials';
import { AUTO_ABORT_MS } from '../watchdogTracker';

// ---------------------------------------------------------------------------
// Factory helper — sensible defaults, override per-test
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
    // Cast intentional: minimal mock; kind + dispatchPath included explicitly to match runtime contract.
  } as unknown as ErrorRecoveryContext['plan'];

  return {
    error: new Error('test error'),
    turnId: 'test-turn-id',
    win: null,
    turnLogger: mockTurnLogger as unknown as ErrorRecoveryContext['turnLogger'],
    abortController: new AbortController(),
    settings: {
      coreDirectory: '/tmp/test',
      models: {
        model: 'claude-sonnet-4-5',
        thinkingModel: null,
        permissionMode: 'bypassPermissions',
        executablePath: null,
        planMode: false,
        extendedContext: false,
        thinkingEffort: 'medium',
        apiKey: null,
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
        models: { apiKey: 'fake-ant-test-key', model: 'claude-sonnet-4-5' },
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

  // Sensible defaults for each mock
  isNetworkErrorMock.mockReturnValue(false);
  isTransientErrorMock.mockReturnValue(false);
  runAgentQueryMock.mockResolvedValue({
    abortedByUser: false,
    terminatedByHandler: false,
  });
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
  dispatchLearnedLimitsFromErrorMock.mockReturnValue(null);
  resolveModelConfigMock.mockImplementation((model: string) => ({
    model,
    envOverrides: undefined,
  }));
  stripExtendedContextFromConfigMock.mockImplementation((cfg: unknown) => cfg);
  downgradeThinkingModelConfigMock.mockImplementation((cfg: unknown) => cfg);
  // Stage 4b: default — no failover candidates (flag-off behaviour)
  getFailoverCredentialCandidatesMock.mockReturnValue(new Set());
});

// ===========================================================================
// handleAbortErrors
// ===========================================================================

describe('handleAbortErrors', () => {
  it('dispatches watchdog auto-abort via the helper with watchdogDiagnostic metadata', () => {
    const abortController = new AbortController();
    abortController.abort();
    const ctx = makeContext({
      abortController,
      abortedByWatchdog: true,
      lastMessageType: 'tool_result',
      messageCount: 3,
      rawStreamEventCount: 5,
      rawStreamLastEventType: 'assistant_delta',
      rawStreamLastEventAgeMs: 9000,
      watchdogLevel: 2,
      maxWatchdogLevel: 4,
      effectiveAbortMs: 120_000,
      requestedModelForTurn: 'claude-sonnet-4-5',
    });

    const result = handleAbortErrors(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(dispatchAgentEventMock).toHaveBeenNthCalledWith(
      1,
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        error: 'This turn was unresponsive for 2 minutes and was stopped automatically. You can try sending your message again.',
        errorSource: 'main',
        watchdogDiagnostic: {
          phase: 'processing',
          messageCount: 3,
          rawStreamEventCount: 5,
          rawStreamLastEventType: 'assistant_delta',
          rawStreamLastEventAgeMs: 9000,
          watchdogLevel: 2,
          maxWatchdogLevel: 4,
          effectiveAbortMs: 120_000,
          model: 'claude-sonnet-4-5',
        },
      }),
    );
    expect(dispatchAgentEventMock).toHaveBeenNthCalledWith(
      2,
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'result' }),
    );
  });

  // Stage 1a (260617_bricked-state-0448-electron42) FIX 1: the AbortError catch
  // path (handleAbortErrors) MUST also honour `abortedByAwaitingApiStall` and
  // emit the recognised retryable `message_timeout` terminal — not generic
  // watchdog copy. Otherwise a realistic abort (timeoutAsyncIterator grace-timeout
  // throw after signal.aborted) silently bypasses the "Try again" surface.
  it('emits a retryable message_timeout terminal (not generic watchdog copy) for an awaiting_api hard stall caught as AbortError', () => {
    const abortController = new AbortController();
    abortController.abort();
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const ctx = makeContext({
      abortController,
      error: abortError,
      abortedByWatchdog: true,
      abortedByAwaitingApiStall: true,
      lastMessageType: 'user',
      messageCount: 0,
      rawStreamEventCount: 0,
      rawStreamLastEventType: null,
      rawStreamLastEventAgeMs: null,
      watchdogLevel: 5,
      maxWatchdogLevel: 5,
      effectiveAbortMs: 300_000,
      requestedModelForTurn: 'claude-sonnet-4-5',
    });

    const result = handleAbortErrors(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    // Error event carries the message_timeout retryable contract (NOT generic
    // watchdog copy with no errorKind).
    const errorEvent = dispatchAgentEventMock.mock.calls[0]?.[2] as {
      type?: string;
      errorKind?: string;
      isTransient?: boolean;
      watchdogDiagnostic?: { phase?: string };
    };
    expect(errorEvent?.type).toBe('error');
    expect(errorEvent?.errorKind).toBe('message_timeout');
    expect(errorEvent?.isTransient).toBe(true);
    expect(errorEvent?.watchdogDiagnostic?.phase).toBe('awaiting_api');
    // markActionable:true → registry told to mark the error actionable (retry surface).
    expect(registryMocks.markActionableErrorDispatched).toHaveBeenCalledWith('test-turn-id');
    // Synthetic result('error') FOLLOWS so a renderer clears isBusy.
    expect(dispatchAgentEventMock).toHaveBeenNthCalledWith(
      2,
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'result', turnEndReason: 'error' }),
    );
  });

  it('renders the watchdog auto-abort copy from AUTO_ABORT_MS so it stays in sync with the constant', () => {
    const abortController = new AbortController();
    abortController.abort();
    const ctx = makeContext({
      abortController,
      abortedByWatchdog: true,
    });

    handleAbortErrors(ctx);

    const expectedMinutes = Math.round(AUTO_ABORT_MS / 60_000);
    const errorEvent = dispatchAgentEventMock.mock.calls[0]?.[2] as { error?: string };
    expect(errorEvent?.error).toContain(`unresponsive for ${expectedMinutes} minutes`);
  });

  it('dispatches superseded abort silently (no "stopped by user" status)', () => {
    const abortController = new AbortController();
    abortController.abort('superseded');
    const ctx = makeContext({ abortController });

    const result = handleAbortErrors(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    // Should dispatch only a synthetic result with turnEndReason: 'superseded'
    // — no status event with "Agent turn stopped by user"
    expect(dispatchAgentEventMock).toHaveBeenCalledTimes(1);
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'result', turnEndReason: 'superseded' }),
    );
  });

  it('dispatches upstream abort via the helper as a transient error', () => {
    const upstreamAbort = new Error('request aborted');
    upstreamAbort.name = 'AbortError';
    const ctx = makeContext({ error: upstreamAbort });

    const result = handleAbortErrors(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(dispatchAgentEventMock).toHaveBeenNthCalledWith(
      1,
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        error: 'The AI took too long to respond. Your message is safe — try sending it again.',
        isTransient: true,
        errorSource: 'main',
      }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'upstream-abort');
  });
});

// ===========================================================================
// handleExtendedContextFallback
// ===========================================================================

describe('handleExtendedContextFallback', () => {
  it('returns false when error is not extended-context-unavailable', async () => {
    isExtendedContextUnavailableErrorMock.mockReturnValue(false);
    const ctx = makeContext();

    const result = await handleExtendedContextFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });

  it('returns soft-failed (falls through) when 200K also fails', async () => {
    isExtendedContextUnavailableErrorMock.mockReturnValue(true);

    const config200K = { model: 'claude-sonnet-4-5', envOverrides: undefined };
    stripExtendedContextFromConfigMock.mockReturnValue(config200K);

    runAgentQueryMock.mockRejectedValueOnce(new Error('200K failed'));

    const ctx = makeContext({
      error: new Error('extended context unavailable'),
      extendedContextEnabled: true,
    });

    const result = await handleExtendedContextFallback(ctx);

    // Falls through — 200K fallback failed (ctx.error reassigned).
    expect(result).toMatchObject({ kind: 'soft-failed' });
    expect(runAgentQueryMock).toHaveBeenCalledTimes(1);
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
  });

  // Regression: nested fallback runAgentQuery() must wire onApiOutput so any
  // real API output emitted before a throw bumps ctx.messageCount. Otherwise
  // downstream retry handlers (server retry, post-fallback retry, transient
  // retry) see stale messageCount=0 and may silently retry, duplicating output.
  // Two reviewers (lens-completeness, lens-behavioral-safety) flagged this as a
  // gap that became reachable after the system:init filter landed.
  // F4 update: synthetic system:* filtering now happens INSIDE the runner —
  // it only calls onApiOutput for real API output. This test mocks that
  // contract directly.
  it('bumps ctx.messageCount via onApiOutput when 200K fallback emits output before throwing', async () => {
    isExtendedContextUnavailableErrorMock.mockReturnValue(true);

    const config200K = { model: 'claude-sonnet-4-5', envOverrides: undefined };
    stripExtendedContextFromConfigMock.mockReturnValue(config200K);

    // Simulate the runner emitting 2 real API-output messages (it does its own
    // filtering — synthetic system:* never reach onApiOutput) before a transient
    // throw.
    runAgentQueryMock.mockImplementationOnce(async (config: { onApiOutput: (m: unknown) => void }) => {
      config.onApiOutput({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } });
      config.onApiOutput({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
      throw new Error('200K transient mid-stream');
    });

    const ctx = makeContext({
      error: new Error('extended context unavailable'),
      extendedContextEnabled: true,
      messageCount: 0,
    });

    const result = await handleExtendedContextFallback(ctx);

    expect(result).toMatchObject({ kind: 'soft-failed', activityEmitted: true });
    // Two real API output messages (assistant text + tool_result) — system:* filtered out
    expect(ctx.messageCount).toBe(2);
    expect(ctx.error).toBeInstanceOf(Error);
    expect((ctx.error as Error).message).toBe('200K transient mid-stream');
  });
});

// ===========================================================================
// handleThinkingModelFallback
// ===========================================================================

describe('handleThinkingModelFallback', () => {
  it('prefers configured thinking fallback over legacy downgrade when model_unavailable is recoverable', async () => {
    getErrorKindMock.mockReturnValue('model_unavailable');
    const retryTurnMock = vi.fn(async () => {});
    const annotatedError = annotateModelRuntimeRole(
      new ModelError('model_unavailable', 'Planner model unavailable', 404, 'Anthropic'),
      { role: 'thinking', model: 'claude-opus-4-7', phase: 'planning' },
    );
    const ctx = makeContext({
      error: annotatedError,
      settings: {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          thinkingModel: 'claude-opus-4-7',
          thinkingFallback: 'model:gpt-5.5',
          apiKey: 'fake-ant-test-key',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: {
            model: 'gpt-5.5',
            thinkingModel: 'claude-opus-4-7',
            thinkingFallback: 'model:gpt-5.5',
            apiKey: 'fake-ant-test-key',
          },
          localModel: { profiles: [], activeProfileId: null },
        },
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      retryTurn: retryTurnMock,
    });

    const result = await handleThinkingModelFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'gpt-5.5',
      workingProfileOverrideId: '',
      thinkingModelOverride: '',
      configuredRoleFallbackAttempted: { thinking: true },
      routeRebuildHint: {
        kind: 'configured-role-fallback',
        role: 'thinking',
        target: { kind: 'model', model: 'gpt-5.5' },
        failedModel: 'claude-opus-4-7',
        errorKind: 'model_unavailable',
      },
      inFlightProviderRoutePlan: ctx.plan,
    }));
    expect(downgradeThinkingModelConfigMock).not.toHaveBeenCalled();
  });

  it('does not run legacy thinking downgrade for working-role model_unavailable without configured fallback', async () => {
    getErrorKindMock.mockReturnValue('model_unavailable');
    isThinkingModelUnavailableErrorMock.mockReturnValue(false);

    const baseCtx = makeContext();
    const ctx = makeContext({
      error: new ModelError('model_unavailable', 'working model unavailable', 404, 'OpenAI'),
      plan: {
        ...baseCtx.plan,
        decision: {
          ...baseCtx.plan.decision,
          role: 'execution',
          wireModelId: 'gpt-5.5',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      requestedModelForTurn: 'gpt-5.5',
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'gpt-5.5' },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'codex',
          models: { model: 'gpt-5.5' },
          localModel: { profiles: [], activeProfileId: null },
        },
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
    });

    const result = await handleThinkingModelFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(downgradeThinkingModelConfigMock).not.toHaveBeenCalled();
  });

  it('does NOT trigger the thinking-model downgrade for image_input_unsupported (260610 Stage 4 pin)', async () => {
    // The new kind must flow to a terminal, actionable error event - silent
    // model-downgrade would mask the image-capability problem and the
    // downgraded model would re-fail on the same image-bearing history.
    //
    // NOTE: this test mocks BOTH discriminators the handler keys on, so on
    // its own it would be circular. It is honest only as a PAIR with the
    // real-predicate counterpart in src/core/rebelCore/__tests__/
    // modelErrors.test.ts ("does NOT match the legacy thinking-model-
    // unavailable predicate"), which asserts the REAL classified incident
    // error has kind !== 'model_unavailable' and the REAL
    // isThinkingModelUnavailableError() rejects it. Keep the pair together
    // if either test moves (Claude stage-4 review F4).
    getErrorKindMock.mockReturnValue('image_input_unsupported');
    isThinkingModelUnavailableErrorMock.mockReturnValue(false);

    const ctx = makeContext({
      error: new ModelError(
        'image_input_unsupported',
        'No endpoints found that support image input',
        404,
        'OpenRouter',
      ),
    });

    const result = await handleThinkingModelFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough', reason: 'not-thinking-model-unavailable' });
    expect(downgradeThinkingModelConfigMock).not.toHaveBeenCalled();
  });

  it('rebuilds the route plan with a thinking-downgrade hint and the in-flight plan snapshot', async () => {
    isThinkingModelUnavailableErrorMock.mockReturnValue(true);
    downgradeThinkingModelConfigMock.mockReturnValue({
      model: 'claude-sonnet-4-5',
      envOverrides: { PLANNING_MODEL: 'claude-haiku-4-5' },
    });

    const baseCtx = makeContext();
    const inFlightPlan = {
      ...baseCtx.plan,
      decision: {
        ...baseCtx.plan.decision,
        codexConnectivity: 'connected',
      },
    } as ErrorRecoveryContext['plan'];
    const applyRoutePlanMock = vi.fn();
    const routeRuntimeContextForDecisionMock = vi.fn(() => ({
      anthropicApiKey: 'fake-ant-test-key',
    }));
    const ctx = makeContext({
      error: new Error('thinking not supported'),
      modelConfig: {
        model: 'claude-sonnet-4-5',
        envOverrides: { PLANNING_MODEL: 'claude-opus-4-7' },
      } as unknown as ErrorRecoveryContext['modelConfig'],
      settings: {
        coreDirectory: '/tmp/test',
        activeProvider: 'anthropic',
        models: {
          model: 'claude-sonnet-4-5',
          thinkingModel: 'claude-opus-4-7',
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
      plan: inFlightPlan,
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: { apiKey: 'fake-ant-test-key', model: 'claude-sonnet-4-5', thinkingModel: 'claude-opus-4-7' },
          localModel: { profiles: [], activeProfileId: null },
        },
        model: 'claude-sonnet-4-5',
        codexConnectivity: 'disconnected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      routeRuntimeContextForDecision: routeRuntimeContextForDecisionMock as unknown as ErrorRecoveryContext['routeRuntimeContextForDecision'],
      applyRoutePlan: applyRoutePlanMock,
    });

    const result = await handleThinkingModelFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(routeRuntimeContextForDecisionMock).toHaveBeenCalledWith(expect.objectContaining({
      fallbackHint: { kind: 'thinking-downgrade', reason: 'thinking-not-supported' },
      codexConnectivity: 'connected',
      wireModelId: 'claude-haiku-4-5',
    }));
    expect(applyRoutePlanMock).toHaveBeenCalledWith(expect.objectContaining({
      decision: expect.objectContaining({
        fallbackHint: { kind: 'thinking-downgrade', reason: 'thinking-not-supported' },
        codexConnectivity: 'connected',
        wireModelId: 'claude-haiku-4-5',
      }),
    }));
  });

  it('dispatches a friendly reconnect error when fallback rebuild/query options resolve to a terminal reconnect state', async () => {
    isThinkingModelUnavailableErrorMock.mockReturnValue(true);
    downgradeThinkingModelConfigMock.mockReturnValue({
      model: 'claude-sonnet-4-5',
      envOverrides: { PLANNING_MODEL: 'claude-haiku-4-5' },
    });
    const reconnectError = new ConnectionNotConfiguredError(
      'Anthropic needs an API key. Add it in Settings to continue.',
      'Anthropic',
    );
    const buildQueryOptions = vi.fn(() => {
      throw reconnectError;
    });
    const ctx = makeContext({
      error: new Error('thinking not supported'),
      modelConfig: {
        model: 'claude-sonnet-4-5',
        envOverrides: { PLANNING_MODEL: 'claude-opus-4-7' },
      } as unknown as ErrorRecoveryContext['modelConfig'],
      buildQueryOptions: buildQueryOptions as unknown as ErrorRecoveryContext['buildQueryOptions'],
    });

    const result = await handleThinkingModelFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(buildQueryOptions).toHaveBeenCalledTimes(1);
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      reconnectError,
      expect.objectContaining({ recoveryOwner: 'thinking_model_fallback_handler' }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'connection-not-configured');
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });

  it('wires the REAL downgrade ladder through the handler: unavailable Fable thinking model retries on Opus 4.8 (Testing F4/T1)', async () => {
    // No hand-fed downgrade config: delegate the mock seam to the REAL
    // modelNormalization implementation so this test fails if the handler
    // stops calling the real ladder or passes the wrong config through.
    const actual = await vi.importActual<typeof import('@shared/utils/modelNormalization')>(
      '@shared/utils/modelNormalization',
    );
    expect(actual.getThinkingModelDowngradeTarget('claude-fable-5')).toBe(actual.PREFERRED_PLANNING_MODEL);
    downgradeThinkingModelConfigMock.mockImplementation((cfg: unknown) =>
      actual.downgradeThinkingModelConfig(cfg as Parameters<typeof actual.downgradeThinkingModelConfig>[0]),
    );
    isThinkingModelUnavailableErrorMock.mockReturnValue(true);

    const routeRuntimeContextForDecisionMock = vi.fn(() => ({
      anthropicApiKey: 'fake-ant-test-key',
    }));
    const ctx = makeContext({
      error: new Error('thinking not supported'),
      modelConfig: {
        model: 'claude-sonnet-4-6',
        envOverrides: { PLANNING_MODEL: 'claude-fable-5' },
      } as unknown as ErrorRecoveryContext['modelConfig'],
      routeRuntimeContextForDecision: routeRuntimeContextForDecisionMock as unknown as ErrorRecoveryContext['routeRuntimeContextForDecision'],
    });

    const result = await handleThinkingModelFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(downgradeThinkingModelConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({ envOverrides: { PLANNING_MODEL: 'claude-fable-5' } }),
    );
    // The REAL Fable→Opus ladder step propagated through the handler:
    // configChanged === true, ctx.modelConfig replaced, route plan rebuilt
    // on the downgrade target (NOT a hand-fed constant).
    expect(ctx.modelConfig.envOverrides?.PLANNING_MODEL).toBe(actual.PREFERRED_PLANNING_MODEL);
    expect(routeRuntimeContextForDecisionMock).toHaveBeenCalledWith(expect.objectContaining({
      fallbackHint: { kind: 'thinking-downgrade', reason: 'thinking-not-supported' },
      wireModelId: actual.PREFERRED_PLANNING_MODEL,
    }));
    // configChanged → user-facing status event → retry via runAgentQuery.
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(null, 'test-turn-id', expect.objectContaining({
      type: 'status',
      message: expect.stringContaining('not available on your plan'),
    }));
    expect(runAgentQueryMock).toHaveBeenCalledTimes(1);
  });

  it('REAL ladder counterpart: thinking model already on the terminal fallback soft-fails with the honest "already on fallback" log', async () => {
    const actual = await vi.importActual<typeof import('@shared/utils/modelNormalization')>(
      '@shared/utils/modelNormalization',
    );
    downgradeThinkingModelConfigMock.mockImplementation((cfg: unknown) =>
      actual.downgradeThinkingModelConfig(cfg as Parameters<typeof actual.downgradeThinkingModelConfig>[0]),
    );
    isThinkingModelUnavailableErrorMock.mockReturnValue(true);

    const ctx = makeContext({
      error: new Error('thinking not supported'),
      modelConfig: {
        model: 'claude-sonnet-4-6',
        envOverrides: { PLANNING_MODEL: actual.FALLBACK_PLANNING_MODEL },
      } as unknown as ErrorRecoveryContext['modelConfig'],
    });

    const result = await handleThinkingModelFallback(ctx);

    expect(result).toMatchObject({ kind: 'soft-failed' });
    expect(mockTurnLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ currentModel: actual.FALLBACK_PLANNING_MODEL }),
      'Thinking model unavailable and already on fallback',
    );
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });

  it('rethrows non-ConnectionNotConfiguredError rebuild failures', async () => {
    isThinkingModelUnavailableErrorMock.mockReturnValue(true);
    downgradeThinkingModelConfigMock.mockReturnValue({
      model: 'claude-sonnet-4-5',
      envOverrides: { PLANNING_MODEL: 'claude-haiku-4-5' },
    });
    const rebuildError = new Error('rebuild route runtime failed');
    const routeRuntimeContextForDecision = vi.fn(() => {
      throw rebuildError;
    });
    const ctx = makeContext({
      error: new Error('thinking not supported'),
      modelConfig: {
        model: 'claude-sonnet-4-5',
        envOverrides: { PLANNING_MODEL: 'claude-opus-4-7' },
      } as unknown as ErrorRecoveryContext['modelConfig'],
      routeRuntimeContextForDecision: routeRuntimeContextForDecision as unknown as ErrorRecoveryContext['routeRuntimeContextForDecision'],
    });

    await expect(handleThinkingModelFallback(ctx)).rejects.toBe(rebuildError);
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// handleAltModelFallback
// ===========================================================================

describe('handleAltModelFallback', () => {
  it('uses real-dispatcher rate-limit copy in the terminal alt-model branch and preserves metadata without cooldown side effects', async () => {
    const { dispatchAgentErrorEvent: realDispatchAgentErrorEvent } = await import('@core/services/agentEventDispatcher');
    const sentAgentEvents: AgentEvent[] = [];
    const win = {
      isDestroyed: () => false,
      webContents: {
        send: vi.fn((channel: string, payload: { event?: AgentEvent }) => {
          if (channel === 'agent:event' && payload.event) {
            sentAgentEvents.push(payload.event);
          }
        }),
      },
    } as unknown as ErrorRecoveryContext['win'];

    dispatchAgentErrorEventMock.mockImplementationOnce((dispatchWin, turnId, rawError, opts) =>
      realDispatchAgentErrorEvent(
        dispatchWin as never,
        turnId,
        rawError,
        opts as Parameters<typeof realDispatchAgentErrorEvent>[3],
      ),
    );
    getErrorKindMock.mockImplementation((error: unknown) => (error instanceof ModelError ? error.kind : 'unknown'));

    const rateLimitError = new ModelError(
      'rate_limit',
      'Rate limit reached. Please wait a moment and try again.',
      429,
      'OpenAI',
      {
        rawMessage: 'Rate limit reached. Please wait a moment and try again.',
        resetAtMs: 1_762_000_000_000,
      },
    );
    const ctx = makeContext({
      win,
      error: rateLimitError,
      messageCount: 3,
      activeProfile: { model: 'gpt-5.5', provider: 'openai', name: 'OpenAI profile' } as unknown as ErrorRecoveryContext['activeProfile'],
    });

    const result = await handleAltModelFallback(ctx, true);

    expect(result).toMatchObject({
      kind: 'handled',
      activityEmitted: true,
      proofOfObservability: { logged: true, structured: true },
    });
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'alt-model-error');
    expect(recordRateLimitMock).not.toHaveBeenCalled();

    const terminalErrorEvent = [...sentAgentEvents].reverse().find((event) => event.type === 'error');
    expect(terminalErrorEvent?.type).toBe('error');
    expect(terminalErrorEvent).toEqual(expect.objectContaining({
      errorKind: 'rate_limit',
      rateLimitMeta: expect.objectContaining({
        rawError: 'Rate limit reached. Please wait a moment and try again.',
        resetAtMs: 1_762_000_000_000,
      }),
      resolution: expect.objectContaining({
        kind: 'rate_limit',
        title: 'Rate limit reached.',
      }),
    }));
    if (terminalErrorEvent?.type === 'error') {
      expect(terminalErrorEvent.error).toContain('rate limit was reached');
      expect(terminalErrorEvent.error).not.toContain('try sending your message again');
    }
  });

  it.each([
    ['OpenAI (Codex)', 'OpenAI Codex had a moment. Retry — your work so far is saved.'],
    ['Anthropic', 'Anthropic had a moment. Retry — your work so far is saved.'],
    [undefined, 'The model service had a moment. Retry — your work so far is saved.'],
  ])('dispatches provider-aware mid-conversation server-error copy for %s', async (provider, expectedCopy) => {
    getErrorKindMock.mockReturnValue('server_error');
    const ctx = makeContext({
      error: new ModelError('server_error', 'Unknown error', undefined, provider),
      messageCount: 3,
      activeProfile: { model: 'gpt-5.5', provider: 'openai', name: 'OpenAI profile' } as unknown as ErrorRecoveryContext['activeProfile'],
    });

    const result = await handleAltModelFallback(ctx, true);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3];
    expect(opts?.humanizedOverride).toBe(expectedCopy);
    expect(opts?.providerOverride).toBe(provider);
    expect(dispatchAgentEventMock).toHaveBeenLastCalledWith(null, 'test-turn-id', expect.objectContaining({
      type: 'error',
      error: expectedCopy,
      errorKind: 'server_error',
      ...(provider ? { provider } : {}),
    }));
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'alt-model-error');
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });

  it('prefers configured working fallback over legacy Claude fallback for direct-role profile failures', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(1);
    const retryTurnMock = vi.fn(async () => {});
    const primaryProfile = {
      id: 'primary-profile',
      model: 'gpt-5.5',
      providerType: 'openai',
      serverUrl: 'https://primary.example.com/v1',
      name: 'OpenAI profile',
    } as unknown as ModelProfile;
    const ctx = makeContext({
      error: new ModelError('server_error', 'profile overloaded', 503, 'OpenAI'),
      activeProfile: primaryProfile as unknown as ErrorRecoveryContext['activeProfile'],
      workingProfile: primaryProfile,
      isDirectRoleProfile: true,
      requestedModelForTurn: 'gpt-5.5',
      settings: {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          workingFallback: 'model:claude-haiku-4-5',
          apiKey: 'fake-ant-test-key',
        },
        localModel: { profiles: [primaryProfile], activeProfileId: 'primary-profile' },
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: {
            model: 'gpt-5.5',
            workingFallback: 'model:claude-haiku-4-5',
            apiKey: 'fake-ant-test-key',
          },
          localModel: { profiles: [primaryProfile], activeProfileId: 'primary-profile' },
        },
        model: 'gpt-5.5',
        profile: primaryProfile,
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          wireModelId: 'gpt-5.5',
          profileId: 'primary-profile',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleAltModelFallback(ctx, true);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'claude-haiku-4-5',
      workingProfileOverrideId: '',
      configuredRoleFallbackAttempted: { working: true },
      routeRebuildHint: expect.objectContaining({
        kind: 'configured-role-fallback',
        role: 'working',
        target: { kind: 'model', model: 'claude-haiku-4-5' },
      }),
    }));
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });

  it('dispatches a friendly reconnect error when alt-model fallback rebuild/query options resolve to a terminal reconnect state', async () => {
    registryMocks.getRetryCount.mockReturnValue(1); // Skip fast retry and enter Claude fallback path
    const reconnectError = new ConnectionNotConfiguredError(
      'OpenRouter needs reconnecting. Sign in again in Settings to continue.',
      'OpenRouter',
    );
    const buildQueryOptions = vi.fn(() => {
      throw reconnectError;
    });
    const ctx = makeContext({
      error: new Error('proxy bridge failed'),
      activeProfile: { model: 'gpt-5.5', provider: 'openai', name: 'OpenAI profile' } as unknown as ErrorRecoveryContext['activeProfile'],
      buildQueryOptions: buildQueryOptions as unknown as ErrorRecoveryContext['buildQueryOptions'],
    });

    const result = await handleAltModelFallback(ctx, true);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(buildQueryOptions).toHaveBeenCalledTimes(1);
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      reconnectError,
      expect.objectContaining({ recoveryOwner: 'alt_model_then_transient_retry' }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'connection-not-configured');
    expect(runAgentQueryMock).not.toHaveBeenCalled();

    // Stage B: the viability probe (rebuild + query-options) runs BEFORE the user-facing
    // backup announcement and fallback telemetry. When the fallback route is not runnable
    // for this user, we must NOT have already told them "Switching to a backup" nor recorded
    // a fallback in the registry/Sentry — that was the doomed, mislabelled-attempt symptom.
    expect(dispatchAgentEventMock).not.toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ message: 'Switching to a backup. Picking up where I left off.' }),
    );
    expect(registryMocks.addTurnFallback).not.toHaveBeenCalled();
    expect(captureMessageMock).not.toHaveBeenCalledWith('Alt-model fallback', expect.anything());
  });

  it('rethrows non-ConnectionNotConfiguredError rebuild failures in alt-model fallback', async () => {
    registryMocks.getRetryCount.mockReturnValue(1); // Skip fast retry and enter Claude fallback path
    const rebuildError = new Error('materialize plan runtime failed');
    const routeRuntimeContextForDecision = vi.fn(() => {
      throw rebuildError;
    });
    const ctx = makeContext({
      error: new Error('proxy bridge failed'),
      activeProfile: { model: 'gpt-5.5', provider: 'openai', name: 'OpenAI profile' } as unknown as ErrorRecoveryContext['activeProfile'],
      routeRuntimeContextForDecision: routeRuntimeContextForDecision as unknown as ErrorRecoveryContext['routeRuntimeContextForDecision'],
    });

    await expect(handleAltModelFallback(ctx, true)).rejects.toBe(rebuildError);
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// handleToolInputTooLarge
// ===========================================================================

describe('handleToolInputTooLarge', () => {
  function makeToolInputTooLargeError(details: Record<string, unknown> = {}): ModelError {
    return new ModelError(
      'tool_input_too_large',
      'tool input exceeded cap',
      undefined,
      undefined,
      {
        details: {
          toolName: 'Linear__create_attachment',
          bytesAccumulated: 150_000,
          capBytes: 131_072,
          ...details,
        },
      },
    );
  }

  it('returns false when error kind is not tool_input_too_large', () => {
    const ctx = makeContext({ error: new Error('something else') });
    const result = handleToolInputTooLarge(ctx);
    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
  });

  it('returns false when error is a different ModelError kind', () => {
    const other = new ModelError('rate_limit', 'rate limited');
    const ctx = makeContext({ error: other });
    const result = handleToolInputTooLarge(ctx);
    expect(result).toMatchObject({ kind: 'passthrough' });
  });

  it('dispatches safe-retry copy when no prior tools ran', () => {
    registryMocks.getOrCreateAccumulator.mockReturnValue({
      hasPossiblyMutatingToolCall: vi.fn(() => false),
      getExecutedToolCalls: vi.fn(() => []),
    });
    const ctx = makeContext({ error: makeToolInputTooLargeError() });

    const result = handleToolInputTooLarge(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3];
    expect(opts?.humanizedOverride).toContain('Linear__create_attachment');
    expect(opts?.humanizedOverride).not.toContain('Earlier steps');
    expect(opts?.isTransient).toBe(false);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith(ctx.turnId, 'tool-input-too-large');
  });

  it('dispatches cautious copy when prior tools may have mutated state', () => {
    registryMocks.getOrCreateAccumulator.mockReturnValue({
      hasPossiblyMutatingToolCall: vi.fn(() => true),
      getExecutedToolCalls: vi.fn(() => [{ toolName: 'Write', toolUseId: 'x', annotations: {}, timestamp: 1 }]),
    });
    const ctx = makeContext({ error: makeToolInputTooLargeError() });

    const result = handleToolInputTooLarge(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3];
    expect(opts?.humanizedOverride).toContain('Earlier steps');
    expect(opts?.humanizedOverride).toContain('review what was done');
  });

  it('does NOT mention $rebel_file sentinel (Wave-1 safe)', () => {
    registryMocks.getOrCreateAccumulator.mockReturnValue({
      hasPossiblyMutatingToolCall: vi.fn(() => true),
      getExecutedToolCalls: vi.fn(() => []),
    });
    const ctx = makeContext({ error: makeToolInputTooLargeError() });

    handleToolInputTooLarge(ctx);

    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3];
    expect(opts?.humanizedOverride).not.toContain('$rebel_file');
    expect(opts?.humanizedOverride).not.toContain('rebel_file');
  });

  it('captures to Sentry with tool_input_too_large tag and extras', () => {
    registryMocks.getOrCreateAccumulator.mockReturnValue({
      hasPossiblyMutatingToolCall: vi.fn(() => false),
      getExecutedToolCalls: vi.fn(() => []),
    });
    const err = makeToolInputTooLargeError();
    const ctx = makeContext({ error: err });

    handleToolInputTooLarge(ctx);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedErr, captureOpts] = captureExceptionMock.mock.calls[0] ?? [];
    expect(capturedErr).toBe(err);
    expect(captureOpts).toMatchObject({
      tags: {
        tool_input_too_large: true,
        tool_name: 'Linear__create_attachment',
        possibly_mutated: false,
      },
      extra: {
        bytesAccumulated: 150_000,
        capBytes: 131_072,
      },
    });
  });

  it('still completes cleanup when Sentry capture throws (observability must not mask errors)', () => {
    registryMocks.getOrCreateAccumulator.mockReturnValue({
      hasPossiblyMutatingToolCall: vi.fn(() => false),
      getExecutedToolCalls: vi.fn(() => []),
    });
    captureExceptionMock.mockImplementationOnce(() => { throw new Error('sentry down'); });
    const ctx = makeContext({ error: makeToolInputTooLargeError() });

    expect(() => handleToolInputTooLarge(ctx)).not.toThrow();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith(ctx.turnId, 'tool-input-too-large');
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
  });
});


// ===========================================================================
// handleOfflineFailFast — fail-fast-offline terminal (Stage 2)
// ===========================================================================

describe('handleOfflineFailFast', () => {
  function makeOfflineError(message = "You appear to be offline. Your work is saved. Try again when you're back."): ModelError {
    return new ModelError('server_error', message, undefined, 'OpenRouter', {
      details: { offlineFailFast: true },
    });
  }

  it('passthrough when error is not a ModelError', () => {
    const ctx = makeContext({ error: new Error('boom') });
    expect(handleOfflineFailFast(ctx)).toMatchObject({ kind: 'passthrough' });
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('passthrough when a ModelError lacks the offlineFailFast marker', () => {
    const ctx = makeContext({ error: new ModelError('server_error', 'plain 500') });
    expect(handleOfflineFailFast(ctx)).toMatchObject({ kind: 'passthrough' });
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('dispatches the retryable message_timeout terminal (Try-again) and ends the turn — NO retry', () => {
    const ctx = makeContext({ error: makeOfflineError() });

    const result = handleOfflineFailFast(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    // Reuses the awaiting_api terminal contract: errorKindOverride=message_timeout,
    // isTransient + markActionable so the renderer renders the "Try again" card.
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3];
    expect(opts?.errorKindOverride).toBe('message_timeout');
    expect(opts?.isTransient).toBe(true);
    expect(opts?.markActionable).toBe(true);
    expect(opts?.humanizedOverride).toContain('offline');
    // Synthetic error result flips the renderer out of busy.
    expect(makeSyntheticResultMock).toHaveBeenCalledWith(ctx.turnId, '', 'error');
    // Cleanup runs (terminal); no model-fallback / retry handlers were involved.
    expect(completeTurnCleanupMock).toHaveBeenCalledWith(ctx.turnId, 'error');
  });

  it('routes through dispatchErrorRecovery BEFORE alt-model / transient-retry handlers', async () => {
    const ctx = makeContext({ error: makeOfflineError(), isDirectRoleProfile: true });

    await dispatchErrorRecovery(ctx);

    // The offline terminal fired (message_timeout) and no turn retry was issued.
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const opts = dispatchAgentErrorEventMock.mock.calls[0]?.[3];
    expect(opts?.errorKindOverride).toBe('message_timeout');
    expect(registryMocks.incrementRetryCount).not.toHaveBeenCalled();
    expect(ctx.retryTurn).not.toHaveBeenCalled();
  });
});


// ===========================================================================
// handleServerErrorRetry
// ===========================================================================

describe('handleServerErrorRetry', () => {
  it('returns false when not a server error', async () => {
    const ctx = makeContext();

    const result = await handleServerErrorRetry(ctx, /* isServerErrorRetry */ false, /* isAltModelError */ false);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(registryMocks.getRetryCount).not.toHaveBeenCalled();
  });

  it('returns false when it is an alt-model error (handled elsewhere)', async () => {
    const ctx = makeContext();

    const result = await handleServerErrorRetry(ctx, /* isServerErrorRetry */ true, /* isAltModelError */ true);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(registryMocks.getRetryCount).not.toHaveBeenCalled();
  });

  it('retries via retryTurn when retry count < 2', async () => {
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    delayWithAbortMock.mockResolvedValue(false); // Not aborted during delay

    const ctx = makeContext();

    const result = await handleServerErrorRetry(ctx, /* isServerErrorRetry */ true, /* isAltModelError */ false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(registryMocks.incrementRetryCount).toHaveBeenCalledWith('test-turn-id');
    expect(delayWithAbortMock).toHaveBeenCalledWith(expect.any(Number), ctx.abortController.signal);
    expect(ctx.retryTurn).toHaveBeenCalled();

    // Status message dispatched about retry
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'status',
        message: expect.stringContaining('retrying automatically'),
      }),
    );
  });

  it('uses configured working fallback before terminal dispatch when retries are exhausted', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(2);

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('server_error', 'upstream overloaded', 503, 'Anthropic'),
      requestedModelForTurn: 'claude-sonnet-4-6',
      settings: {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/test',
        models: {
          model: 'claude-sonnet-4-6',
          workingFallback: 'model:claude-haiku-4-5',
          apiKey: 'fake-ant-test-key',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: {
            model: 'claude-sonnet-4-6',
            workingFallback: 'model:claude-haiku-4-5',
            apiKey: 'fake-ant-test-key',
          },
          localModel: { profiles: [], activeProfileId: null },
        },
        model: 'claude-sonnet-4-6',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          wireModelId: 'claude-sonnet-4-6',
          canonicalModelId: 'claude-sonnet-4-6',
          codexConnectivity: 'connected',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleServerErrorRetry(ctx, true, false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'claude-haiku-4-5',
      workingProfileOverrideId: '',
      configuredRoleFallbackAttempted: { working: true },
      routeRebuildHint: {
        kind: 'configured-role-fallback',
        role: 'working',
        target: { kind: 'model', model: 'claude-haiku-4-5' },
        failedModel: 'claude-sonnet-4-6',
        errorKind: 'server_error',
      },
      inFlightProviderRoutePlan: ctx.plan,
    }));
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
  });

  it('does not re-attempt configured working fallback when the per-role latch is already set', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(2);

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('server_error', 'upstream overloaded', 503, 'Anthropic'),
      settings: {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/test',
        models: {
          model: 'claude-sonnet-4-6',
          workingFallback: 'model:claude-haiku-4-5',
          apiKey: 'fake-ant-test-key',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: {
            model: 'claude-sonnet-4-6',
            workingFallback: 'model:claude-haiku-4-5',
            apiKey: 'fake-ant-test-key',
          },
          localModel: { profiles: [], activeProfileId: null },
        },
        model: 'claude-sonnet-4-6',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      turnOptions: {
        configuredRoleFallbackAttempted: { working: true },
      },
      retryTurn: retryTurnMock,
    });

    const result = await handleServerErrorRetry(ctx, true, false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'server-error');
  });

  it('fails closed when configured fallback route is terminal', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(2);

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('server_error', 'upstream overloaded', 503, 'Anthropic'),
      requestedModelForTurn: 'claude-sonnet-4-6',
      settings: {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/test',
        models: {
          model: 'claude-sonnet-4-6',
          workingFallback: 'model:openai/gpt-5.5',
          apiKey: 'fake-ant-test-key',
        },
        openRouter: { enabled: true, oauthToken: null },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: {
            model: 'claude-sonnet-4-6',
            workingFallback: 'model:openai/gpt-5.5',
            apiKey: 'fake-ant-test-key',
          },
          openRouter: { enabled: true, oauthToken: null },
          localModel: { profiles: [], activeProfileId: null },
        },
        model: 'claude-sonnet-4-6',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      retryTurn: retryTurnMock,
    });

    const result = await handleServerErrorRetry(ctx, true, false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.any(ConnectionNotConfiguredError),
      expect.objectContaining({
        providerOverride: 'OpenRouter',
      }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'connection-not-configured');
  });

  // FOX-3494 (round-2 M3 / S1): a configured fallback that resolves to a terminal
  // claude-* route under connected ChatGPT Pro with no Anthropic key must carry the
  // structured detail ({ invalidReason, wireModel, failedRole }) on the dispatched
  // raw error, so the renderer can offer the role-aware "switch to a GPT model"
  // recovery. The fallback site used to mint a bare ConnectionNotConfiguredError,
  // silently dropping that detail. Uses a profile-encoded fallback to a native-
  // Claude (Anthropic-typed) profile — a model-encoded `claude-*` fallback is
  // reinterpreted as a deliberate Anthropic provider switch (generic reason), so
  // the profile path is the realistic producer of the claude-under-codex reason.
  it('preserves claude-under-codex switch-to-GPT detail on a terminal configured fallback', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(2);

    const anthropicClaudeProfile = {
      id: 'anthropic-claude-profile',
      name: 'Claude (Anthropic)',
      providerType: 'anthropic',
      serverUrl: 'https://api.anthropic.com',
      model: 'claude-opus-4-8',
      createdAt: 1,
    };
    const settingsWithClaudeFallbackProfile = {
      activeProvider: 'codex',
      coreDirectory: '/tmp/test',
      models: {
        model: 'gpt-5.5',
        apiKey: null,
        oauthToken: null,
        // Configured working fallback → an Anthropic-typed claude profile.
        workingFallback: `profile:${anthropicClaudeProfile.id}`,
      },
      localModel: { profiles: [anthropicClaudeProfile], activeProfileId: null },
    };
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('server_error', 'upstream overloaded', 503, 'ChatGPT Pro'),
      requestedModelForTurn: 'gpt-5.5',
      availableProfiles: [anthropicClaudeProfile] as unknown as ErrorRecoveryContext['availableProfiles'],
      settings: settingsWithClaudeFallbackProfile as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: settingsWithClaudeFallbackProfile,
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      // codexConnectivityForFallback derives connectivity from the in-flight plan,
      // so the plan must report connected codex for the producer to mint the
      // primary-turn claude-under-codex reason.
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          codexConnectivity: 'connected',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleServerErrorRetry(ctx, true, false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'connection-not-configured');

    const dispatchedRawError = dispatchAgentErrorEventMock.mock.calls.at(-1)?.[2] as {
      invalidReason?: string;
      wireModel?: string;
      failedRole?: string;
    };
    expect(dispatchedRawError).toBeInstanceOf(ConnectionNotConfiguredError);
    expect(dispatchedRawError.invalidReason).toBe('missing-anthropic-credentials-for-claude-model');
    expect(dispatchedRawError.failedRole).toBe('execution');
    expect(typeof dispatchedRawError.wireModel).toBe('string');
  });

  it('skips configured fallback after a result message has already been received', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(2);

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('server_error', 'upstream overloaded', 503, 'Anthropic'),
      receivedResultMessage: true,
      settings: {
        activeProvider: 'anthropic',
        coreDirectory: '/tmp/test',
        models: {
          model: 'claude-sonnet-4-6',
          workingFallback: 'model:claude-haiku-4-5',
          apiKey: 'fake-ant-test-key',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleServerErrorRetry(ctx, true, false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'server-error');
  });

  it('dispatches error when retries exhausted (count >= 2)', async () => {
    registryMocks.getRetryCount.mockReturnValue(2); // >= MAX_SERVER_ERROR_RETRIES

    const ctx = makeContext({ error: new Error('Internal server error') });

    const result = await handleServerErrorRetry(ctx, /* isServerErrorRetry */ true, /* isAltModelError */ false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(ctx.retryTurn).not.toHaveBeenCalled();

    // Error event dispatched to user
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('rough patch'),
      }),
    );

    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'server-error');
  });
});

// ===========================================================================
// handleRateLimitFallback
// ===========================================================================

describe('handleRateLimitFallback', () => {
  it('returns false when not a rate limit error', async () => {
    getErrorKindMock.mockReturnValue('unknown');
    isRateLimitMessageMock.mockReturnValue(false);

    const ctx = makeContext();

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(runAgentQueryMock).not.toHaveBeenCalled();
  });

  it('shows error when rate limited (non-Codex provider)', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');

    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      extendedContextEnabled: false,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(runAgentQueryMock).not.toHaveBeenCalled();

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        errorKind: 'rate_limit',
      }),
    );
    expect(recordRateLimitMock).toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  it('prefers configured working fallback before Codex secondary fallback paths', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI'),
      requestedModelForTurn: 'gpt-5.5',
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          workingFallback: 'model:gpt-5.4-mini',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'codex',
          models: {
            model: 'gpt-5.5',
            workingFallback: 'model:gpt-5.4-mini',
          },
          localModel: { profiles: [], activeProfileId: null },
        },
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'codex',
          transport: 'codex-proxy',
          modelDialect: 'openai-compatible',
          canonicalModelId: 'gpt-5.5',
          wireModelId: 'gpt-5.5',
          codexConnectivity: 'connected',
          credentialSource: 'codex-subscription',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'gpt-5.4-mini',
      workingProfileOverrideId: '',
      configuredRoleFallbackAttempted: { working: true },
      routeRebuildHint: {
        kind: 'configured-role-fallback',
        role: 'working',
        target: { kind: 'model', model: 'gpt-5.4-mini' },
        failedModel: 'gpt-5.5',
        errorKind: 'rate_limit',
      },
      inFlightProviderRoutePlan: ctx.plan,
    }));
    expect(getRateLimitFallbackTargetMock).not.toHaveBeenCalled();
  });

  it('falls back to Codex secondary provider path when configured fallback latch is already set', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI'),
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          workingFallback: 'model:gpt-5.4-mini',
        },
      } as unknown as ErrorRecoveryContext['settings'],
      turnOptions: {
        configuredRoleFallbackAttempted: { working: true },
      },
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(getRateLimitFallbackTargetMock).toHaveBeenCalledTimes(1);
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      rateLimitFallbackAttempted: true,
      activeProviderOverride: 'openrouter',
      modelOverride: 'anthropic/claude-sonnet-4-5',
      routeRebuildHint: { kind: 'codex-rate-limit-provider', forceNonCodexTransport: true },
      inFlightProviderRoutePlan: ctx.plan,
    }));
  });

  it('falls back to tier model when Codex rate-limited and tier fallback configured', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'tier_model',
      modelOverride: 'claude-sonnet-4-5',
      profileOverrideId: undefined,
      rawValue: 'model:claude-sonnet-4-5',
    });

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitFallbackAttempted: true,
        modelOverride: 'claude-sonnet-4-5',
        routeRebuildHint: { kind: 'codex-rate-limit-tier', tier: 'standard' },
        inFlightProviderRoutePlan: ctx.plan,
      }),
    );
    expect(registryMocks.addTurnFallback).toHaveBeenCalledWith('test-turn-id', expect.objectContaining({
      type: 'tier_model',
      reason: 'codex-rate-limit',
    }));
  });

  it('falls back to OpenRouter when Codex rate-limited and OR configured', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitFallbackAttempted: true,
        activeProviderOverride: 'openrouter',
        modelOverride: 'anthropic/claude-sonnet-4-5',
        routeRebuildHint: { kind: 'codex-rate-limit-provider', forceNonCodexTransport: true },
        inFlightProviderRoutePlan: ctx.plan,
      }),
    );
    expect(registryMocks.addTurnFallback).toHaveBeenCalledWith('test-turn-id', expect.objectContaining({
      type: 'provider',
      to: 'openrouter',
    }));
  });

  it('falls back to Anthropic when Codex rate-limited and API key configured', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
    });

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitFallbackAttempted: true,
        activeProviderOverride: 'anthropic',
        modelOverride: 'claude-sonnet-4-5',
        routeRebuildHint: { kind: 'codex-rate-limit-provider', forceNonCodexTransport: true },
        inFlightProviderRoutePlan: ctx.plan,
      }),
    );
  });

  it('does not retry when rateLimitFallbackAttempted is already set (loop guard)', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
      turnOptions: { rateLimitFallbackAttempted: true },
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  it('does not retry Codex single-pick fallback when messageCount > 0 (partial output guard preserved on Codex path)', async () => {
    // The configured-role fallback path now bypasses the messageCount gate for
    // rate-limit retries (see "configured fallback fires when messageCount > 0
    // for rate-limit" test below), but the Codex single-pick fallback path
    // still has its own messageCount === 0 guard at the call site. This test
    // exercises that path: no workingFallback is configured, so configured
    // fallback returns no_fallback_configured, and the Codex path's own
    // messageCount guard then blocks the single-pick retry.
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue({
      kind: 'provider',
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-5',
    });

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      messageCount: 3,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  it('configured fallback fires when messageCount > 0 for rate-limit (bypass: mid-stream 429 should still recover)', async () => {
    // Non-rate-limit sources (model-unavailable, alt-model-fallback,
    // server-error-retry) keep the messageCount > 0 gate. Only rate-limit
    // bypasses, because the alternative is a hard error visible to the user.
    // The harder gates (receivedResultMessage, isToolInFlight, lastToolName)
    // still apply — see the two preservation tests below.
    getErrorKindMock.mockReturnValue('rate_limit');

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI'),
      messageCount: 12,
      requestedModelForTurn: 'gpt-5.5',
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          workingFallback: 'model:gpt-5.4-mini',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'codex',
          models: {
            model: 'gpt-5.5',
            workingFallback: 'model:gpt-5.4-mini',
          },
          localModel: { profiles: [], activeProfileId: null },
        },
        model: 'gpt-5.5',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'codex',
          transport: 'codex-proxy',
          modelDialect: 'openai-compatible',
          canonicalModelId: 'gpt-5.5',
          wireModelId: 'gpt-5.5',
          codexConnectivity: 'connected',
          credentialSource: 'codex-subscription',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOverride: 'gpt-5.4-mini',
        configuredRoleFallbackAttempted: { working: true },
        routeRebuildHint: expect.objectContaining({
          kind: 'configured-role-fallback',
          role: 'working',
        }),
      }),
    );
  });

  it('configured fallback still gated when receivedResultMessage is true even on rate-limit (no duplicate replies)', async () => {
    // Rate-limit bypasses messageCount but NOT the result-received gate.
    // Retrying after a result message has finished produces duplicate replies.
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue(null);

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI'),
      messageCount: 12,
      receivedResultMessage: true,
      requestedModelForTurn: 'gpt-5.5',
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          workingFallback: 'model:gpt-5.4-mini',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  it('configured fallback still gated when a tool is in flight even on rate-limit (no repeated side-effecting calls)', async () => {
    // Rate-limit bypasses messageCount but NOT the tool-in-flight gate.
    // Retrying while a tool is executing risks repeating side effects.
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue(null);

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI'),
      messageCount: 12,
      isToolInFlight: () => true,
      requestedModelForTurn: 'gpt-5.5',
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          workingFallback: 'model:gpt-5.4-mini',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  it('configured fallback still gated when lastToolName is set even on rate-limit (no repeated side-effecting calls)', async () => {
    // Rate-limit bypasses messageCount but NOT the lastToolName gate. A finished
    // tool means the model already kicked off side effects we mustn't repeat.
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue(null);

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI'),
      messageCount: 12,
      lastToolName: 'Bash',
      requestedModelForTurn: 'gpt-5.5',
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          workingFallback: 'model:gpt-5.4-mini',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  it('configured fallback refuses messageCount bypass when a nested fallback runAgentQuery has already run', async () => {
    // When handleExtendedContextFallback / handleThinkingModelFallback /
    // handleAltModelFallback's nested runAgentQuery has executed, it forwards
    // onApiOutput (bumps messageCount) but does NOT propagate lastToolName /
    // receivedResultMessage / watchdog tool tracker to the outer ctx. Bypassing
    // messageCount in that state could miss a tool execution and let the retry
    // duplicate side effects. Refuse the bypass — fall back to the original
    // strict gate semantics.
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue(null);

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI'),
      messageCount: 12,
      nestedFallbackQueryAttempted: true,
      requestedModelForTurn: 'gpt-5.5',
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: {
          model: 'gpt-5.5',
          workingFallback: 'model:gpt-5.4-mini',
        },
        localModel: { profiles: [], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  it('shows Settings CTA when Codex rate-limited with no backup configured', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue(null);
    extractRetryAfterMsMock.mockReturnValue(45_000);
    const error = new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI', {
      rawMessage: 'rate limit raw 429',
      resetAtMs: 1_762_000_000_000,
    });

    const ctx = makeContext({
      error,
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(recordRateLimitMock).toHaveBeenCalledWith(45_000);
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      error,
      expect.objectContaining({
        humanizedOverride: 'ChatGPT Pro hit a rate limit. Connect OpenRouter or add an Anthropic API key in Settings as a backup provider to keep working.',
        intentionalCopyOverrideForKind: 'rate_limit',
        errorKindOverride: 'rate_limit',
        providerOverride: 'OpenAI',
        rateLimitMetaOverride: {
          rawError: 'rate limit raw 429',
          retryAfterMs: 45_000,
          resetAtMs: 1_762_000_000_000,
        },
        recoveryOwner: 'rate_limit_handler',
      }),
    );
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        errorKind: 'rate_limit',
        provider: 'OpenAI',
        error: expect.stringContaining('Settings'),
        rateLimitMeta: {
          rawError: 'rate limit raw 429',
          retryAfterMs: 45_000,
          resetAtMs: 1_762_000_000_000,
        },
      }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  it('marks codex rolling-window rate_limit as plan-scoped when resetAtMs is far out', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue(null);

    const farResetAtMs = Date.now() + (5 * 60 * 60 * 1000);
    const error = new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenAI', {
      limitScope: 'provider',
      resetAtMs: farResetAtMs,
    });

    const ctx = makeContext({
      error,
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'gpt-5.5' },
      } as unknown as ErrorRecoveryContext['settings'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          credentialSource: 'codex-subscription',
        },
      } as unknown as ErrorRecoveryContext['plan'],
    });

    await handleRateLimitFallback(ctx);

    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      error,
      expect.objectContaining({
        recoveryOwner: 'rate_limit_handler',
        credentialSource: 'codex-subscription',
        limitScopeOverride: 'plan',
      }),
    );
  });

  it('keeps short-window provider rate_limit as provider-scoped (no plan override)', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');

    const nearResetAtMs = Date.now() + (5 * 60 * 1000);
    const error = new ModelError('rate_limit', 'rate limit exceeded', 429, 'OpenRouter', {
      limitScope: 'provider',
      resetAtMs: nearResetAtMs,
    });
    const ctx = makeContext({
      error,
      extendedContextEnabled: false,
      settings: {
        activeProvider: 'openrouter',
        coreDirectory: '/tmp/test',
        models: { model: 'anthropic/claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
    });

    await handleRateLimitFallback(ctx);

    const call = dispatchAgentErrorEventMock.mock.calls.at(-1);
    const opts = call?.[3] as {
      recoveryOwner?: RecoveryOwner;
      limitScopeOverride?: 'plan' | 'provider' | 'account';
    };
    expect(opts?.recoveryOwner).toBe('rate_limit_handler');
    expect(opts?.limitScopeOverride).toBeUndefined();
  });
});

// ===========================================================================
// handleBillingError
// ===========================================================================

describe('handleBillingError', () => {
  it('returns false when error is not billing kind', async () => {
    getErrorKindMock.mockReturnValue('unknown');
    const ctx = makeContext();

    const result = await handleBillingError(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
  });

  it('dispatches billing error and calls completeTurnCleanup with billing-error', async () => {
    getErrorKindMock.mockReturnValue('billing');
    const ctx = makeContext({ error: new Error('insufficient_quota') });

    const result = await handleBillingError(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        errorKind: 'billing',
        errorSource: 'main',
      }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'billing-error');
  });

  it('preserves the emitted billing AgentEvent shape via the helper snapshot', async () => {
    getErrorKindMock.mockReturnValue('billing');
    const error = Object.assign(new Error('billing error'), {
      __rawMessage: 'You have exceeded your quota',
      provider: 'OpenRouter',
    });
    const ctx = makeContext({ error });

    await handleBillingError(ctx);

    expect(registryMocks.markActionableErrorDispatched).toHaveBeenCalledTimes(1);
    const event = dispatchAgentEventMock.mock.calls[0][2] as Record<string, unknown>;
    const { timestamp, ...eventWithoutTimestamp } = event;
    expect(typeof timestamp).toBe('number');
    expect(eventWithoutTimestamp).toMatchInlineSnapshot(`
      {
        "error": "You have exceeded your quota",
        "errorKind": "billing",
        "errorSource": "main",
        "provider": "OpenRouter",
        "type": "error",
      }
    `);
  });

  it('routes billing error with message containing "429" as billing, NOT rate-limit', async () => {
    getErrorKindMock.mockReturnValue('billing');
    isRateLimitMessageMock.mockReturnValue(true); // Would match in rate limit handler

    const ctx = makeContext({ error: new Error('429 Too Many Requests - insufficient_quota') });

    const result = await handleBillingError(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        errorKind: 'billing',
      }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'billing-error');
  });

  it('routes billing error with message containing "usage limit" as billing', async () => {
    getErrorKindMock.mockReturnValue('billing');
    isRateLimitMessageMock.mockReturnValue(true); // Would match in rate limit handler

    const ctx = makeContext({ error: new Error('You have hit your usage limit for the day') });

    const result = await handleBillingError(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        errorKind: 'billing',
      }),
    );
  });

  it('marks codex usage_limit_reached billing as plan-scoped and threads credentialSource to dispatcher', async () => {
    getErrorKindMock.mockReturnValue('billing');
    const ctx = makeContext({
      error: new Error('usage_limit_reached: The usage limit has been reached'),
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          credentialSource: 'codex-subscription',
        },
      } as unknown as ErrorRecoveryContext['plan'],
    });

    const result = await handleBillingError(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      ctx.error,
      expect.objectContaining({
        recoveryOwner: 'billing_handler',
        credentialSource: 'codex-subscription',
        limitScopeOverride: 'plan',
      }),
    );
  });

  it('does not intercept rate_limit kind errors (they pass through to handler 7)', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    const ctx = makeContext({ error: new Error('rate limit exceeded') });

    const result = await handleBillingError(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// dispatchErrorRecovery — billing precedence over rate limit (integration)
// ===========================================================================

// ===========================================================================
// Stage 5 (260421_classification_driven_error_humanizer):
// After removing humanizedOverride from handleBillingError / handleRateLimitFallback
// / handleAltModelFallback's Claude-fallback rate-limit branch, the dispatcher
// receives the raw error WITHOUT any override, and its Stage 2 classification-
// first pipeline produces the subtype/provider-aware copy via humanizeAgentError.
// These regression tests lock in that intent — a future regression that adds
// `humanizedOverride` back at these sites will fail here.
// ===========================================================================
describe('Stage 5 — handlers dispatch raw error WITHOUT humanizedOverride', () => {
  it('handleBillingError: no humanizedOverride passed to dispatcher', async () => {
    getErrorKindMock.mockReturnValue('billing');
    const ctx = makeContext({ error: new Error('You exceeded your current quota, please check your plan and billing details.') });

    await handleBillingError(ctx);

    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const call = dispatchAgentErrorEventMock.mock.calls[0];
    const opts = call[3] as { humanizedOverride?: string; recoveryOwner?: RecoveryOwner } | undefined;
    expect(opts?.humanizedOverride).toBeUndefined();
    expect(opts?.recoveryOwner).toBe('billing_handler');
  });

  it('handleRateLimitFallback default path (non-Codex): no humanizedOverride passed to dispatcher', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      extendedContextEnabled: false,
    });

    await handleRateLimitFallback(ctx);

    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const call = dispatchAgentErrorEventMock.mock.calls[0];
    const opts = call[3] as { humanizedOverride?: string; recoveryOwner?: RecoveryOwner } | undefined;
    expect(opts?.humanizedOverride).toBeUndefined();
    expect(opts?.recoveryOwner).toBe('rate_limit_handler');
  });

  it('handleRateLimitFallback Codex-no-backup path passes an intentional humanizedOverride marker', async () => {
    // This path intentionally overrides rate-limit copy with a Settings CTA.
    // Stage 3 guard requires an explicit marker so this stays deliberate.
    getErrorKindMock.mockReturnValue('rate_limit');
    getRateLimitFallbackTargetMock.mockReturnValue(null);
    const ctx = makeContext({
      error: new ModelError('rate_limit', 'rate limit', 429, 'OpenAI'),
      messageCount: 0,
      settings: {
        activeProvider: 'codex',
        coreDirectory: '/tmp/test',
        models: { model: 'claude-sonnet-4-5' },
      } as unknown as ErrorRecoveryContext['settings'],
    });

    await handleRateLimitFallback(ctx);

    const call = dispatchAgentErrorEventMock.mock.calls[0];
    expect(call[3]).toBeDefined();
    const opts = call[3] as { humanizedOverride?: string; intentionalCopyOverrideForKind?: string };
    expect(opts.humanizedOverride).toContain('Settings');
    expect(opts.intentionalCopyOverrideForKind).toBe('rate_limit');
  });

  it('handleAltModelFallback Claude-fallback rate-limit branch: no humanizedOverride, records retry-after', async () => {
    // The third Stage 5 migrated site — alt-model → Claude fallback → Claude
    // itself hits a rate limit. Before Stage 5 this dispatched with a
    // `humanizedOverride: humanizeError(rawMessage) || <hard-coded fallback>`.
    // Post-Stage-5 the raw error flows through the dispatcher's Stage 2
    // pipeline. This test locks in: (a) dispatcher called once with no override,
    // (b) retry-after still recorded on the cooldown.
    registryMocks.getRetryCount.mockReturnValue(1); // exhaust fast retry → fall to Claude
    getErrorKindMock.mockImplementation((err: unknown) =>
      err instanceof ModelError ? err.kind : 'unknown'
    );
    extractRetryAfterMsMock.mockReturnValue(73_000);
    const claudeRateLimitError = new ModelError(
      'rate_limit',
      'rate limit',
      429,
      'Anthropic',
      { rawMessage: 'anthropic rate limit raw' },
    );
    runAgentQueryMock.mockRejectedValueOnce(claudeRateLimitError);

    const ctx = makeContext({
      error: new Error('alt-model proxy error'),
      messageCount: 0,
      altModelFallbackAttempted: false,
      activeProfile: { model: 'gpt-5', provider: 'openai' } as unknown as ErrorRecoveryContext['activeProfile'],
    });

    const result = await handleAltModelFallback(ctx, /* isAltModelError */ true);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(runAgentQueryMock).toHaveBeenCalledTimes(1);
    expect(recordRateLimitMock).toHaveBeenCalledWith(73_000);
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'altmodel-fallback-failed');

    // Stage 5 intent lock: dispatcher receives raw claudeFallbackError WITHOUT override.
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledTimes(1);
    const call = dispatchAgentErrorEventMock.mock.calls[0];
    expect(call[2]).toBe(claudeRateLimitError);
    const opts = call[3] as { humanizedOverride?: string; recoveryOwner?: RecoveryOwner } | undefined;
    expect(opts?.humanizedOverride).toBeUndefined();
    expect(opts?.recoveryOwner).toBe('alt_model_then_transient_retry');
  });

  it('Stage 5 snapshot: handleRateLimitFallback default path emits rate_limit event with raw-error shape (no override)', async () => {
    // Complement the billing inline snapshot (L866-878) with a rate-limit snapshot
    // that locks in the Stage 5 dispatch shape. The `error` field now surfaces the
    // raw message — the dispatcher's Stage 2 pipeline would normally humanize it,
    // but the test's mock dispatcher echoes the raw message when no override is
    // provided, proving Stage 5's intent at the handler boundary.
    getErrorKindMock.mockReturnValue('rate_limit');
    const err = Object.assign(new Error('rate limit raw text'), {
      __rawMessage: 'rate limit raw text',
      provider: 'Anthropic',
    });
    const ctx = makeContext({
      error: err,
      extendedContextEnabled: false,
    });

    await handleRateLimitFallback(ctx);

    const event = dispatchAgentEventMock.mock.calls[0][2] as Record<string, unknown>;
    const { timestamp, ...eventWithoutTimestamp } = event;
    expect(typeof timestamp).toBe('number');
    expect(eventWithoutTimestamp).toMatchInlineSnapshot(`
      {
        "error": "rate limit raw text",
        "errorKind": "rate_limit",
        "errorSource": "main",
        "provider": "Anthropic",
        "type": "error",
      }
    `);
  });
});

describe('dispatchErrorRecovery — billing kind precedes rate limit in handler chain', () => {
  it('billing error with rate-limit-like message routes to billing handler, not rate-limit', async () => {
    getErrorKindMock.mockReturnValue('billing');
    isRateLimitMessageMock.mockReturnValue(true); // message matches rate-limit pattern

    const ctx = makeContext({ error: new Error('429 insufficient_quota - usage limit exceeded') });

    await dispatchErrorRecovery(ctx);

    // Should hit billing handler, not rate-limit
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'billing-error');
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ errorKind: 'billing' }),
    );
    // Should NOT have rate-limit metadata
    const allEvents = dispatchAgentEventMock.mock.calls.map((c: unknown[]) => c[2]) as Record<string, unknown>[];
    const rateLimitEvents = allEvents.filter((e) => e.errorKind === 'rate_limit');
    expect(rateLimitEvents).toHaveLength(0);
  });
});

describe('dispatchErrorRecovery — Stage 1 rate-limit owner carve-out', () => {
  it('routes direct-role rate_limit errors to handler 7 instead of alt-model fallback', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    // Mirrors production kind-first behavior for known rate_limit kinds.
    isTransientErrorMock.mockReturnValue(true);

    const ctx = makeContext({
      error: new ModelError('rate_limit', '429 rate limit exceeded', 429, 'OpenAI'),
      isDirectRoleProfile: true,
      // Keep restart gates closed so pre-carve-out behavior deterministically
      // takes the alt-model terminal branch (red test) instead of retrying.
      messageCount: 3,
    });

    await dispatchErrorRecovery(ctx);

    expect(recordRateLimitMock).toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
    expect(completeTurnCleanupMock).not.toHaveBeenCalledWith('test-turn-id', 'alt-model-error');
  });
});

async function useActualRecoveryDiscriminators(): Promise<void> {
  const [catalog, friendlyErrors] = await Promise.all([
    vi.importActual<typeof import('@shared/utils/agentErrorCatalog')>('@shared/utils/agentErrorCatalog'),
    vi.importActual<typeof import('@shared/utils/friendlyErrors')>('@shared/utils/friendlyErrors'),
  ]);

  getErrorKindMock.mockImplementation(catalog.getErrorKind);
  (isNetworkErrorMock as unknown as { mockImplementation: (impl: typeof friendlyErrors.isNetworkError) => void })
    .mockImplementation((error: string) => friendlyErrors.isNetworkError(error));
  (isTransientErrorMock as unknown as { mockImplementation: (impl: typeof friendlyErrors.isTransientError) => void })
    .mockImplementation((
      error: string,
      kind?: AgentErrorKind,
      options?: Parameters<typeof friendlyErrors.isTransientError>[2],
    ) => friendlyErrors.isTransientError(error, kind, options));
}

describe('dispatchErrorRecovery — network dispatch-chain routing', () => {
  it('routes cause-only network errors through transient retry, not alt-model fallback', async () => {
    await useActualRecoveryDiscriminators();
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    delayWithAbortMock.mockResolvedValue(false);

    const raw = Object.assign(new Error('request failed'), {
      cause: { code: 'ECONNREFUSED', hostname: 'chatgpt.com', address: '2606:4700::1' },
    });
    const classified = classifyError(raw);
    expect(classified.kind).toBe('network');

    const ctx = makeContext({
      error: classified,
      isDirectRoleProfile: true,
    });

    await dispatchErrorRecovery(ctx);

    expect(ctx.retryTurn).toHaveBeenCalledTimes(1);
    expect(completeTurnCleanupMock).not.toHaveBeenCalledWith('test-turn-id', 'alt-model-error');
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    expect(dispatchAgentEventMock).not.toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'status', message: expect.stringContaining('Hit a snag') }),
    );
  });

  it('routes top-level fetch failures through network extended-backoff retry', async () => {
    await useActualRecoveryDiscriminators();
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    delayWithAbortMock.mockResolvedValue(false);

    const classified = classifyError(new TypeError('fetch failed'));
    expect(classified.kind).toBe('network');

    const ctx = makeContext({
      error: classified,
      isDirectRoleProfile: true,
    });

    await dispatchErrorRecovery(ctx);

    expect(ctx.retryTurn).toHaveBeenCalledTimes(1);
    const delayArg = delayWithAbortMock.mock.calls[0][0] as number;
    expect(delayArg).toBeGreaterThanOrEqual(5000);
    expect(delayArg).toBeLessThanOrEqual(6000);
    expect(completeTurnCleanupMock).not.toHaveBeenCalledWith('test-turn-id', 'alt-model-error');
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'status',
        message: expect.stringContaining('Network connection issue'),
      }),
    );
  });

  it('keeps provider 5xx with network-ish text on the server-error alt-model path', async () => {
    await useActualRecoveryDiscriminators();
    registryMocks.getRetryCount.mockReturnValue(1);

    const classified = classifyError(
      new APIError(500, undefined as never, 'TypeError: fetch failed', undefined),
      undefined,
      'OpenAI',
    );
    expect(classified.kind).toBe('server_error');

    const ctx = makeContext({
      error: classified,
      isDirectRoleProfile: true,
      messageCount: 3,
    });

    await dispatchErrorRecovery(ctx);

    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'alt-model-error');
    expect(dispatchAgentErrorEventMock).toHaveBeenCalled();
    const call = dispatchAgentErrorEventMock.mock.calls.at(-1);
    const opts = call?.[3] as { recoveryOwner?: RecoveryOwner } | undefined;
    expect(opts?.recoveryOwner).toBe('alt_model_then_server_error_retry');
    expect(ctx.retryTurn).not.toHaveBeenCalled();
  });
});

const OWNER_CLEANUP_SENTINELS: Record<RecoveryOwner, string> = {
  thinking_model_fallback_handler: 'connection-not-configured',
  managed_model_not_allowed_handler: 'managed-model-not-allowed',
  billing_handler: 'billing-error',
  rate_limit_handler: 'rate-limit',
  alt_model_then_server_error_retry: 'alt-model-error',
  alt_model_then_transient_retry: 'alt-model-error',
  classify_and_dispatch_tail: 'error',
};

type OwnershipRoutingCase = {
  kind: AgentErrorKind;
  owner: RecoveryOwner;
  expectedEventOwner?: RecoveryOwner;
  expectedCleanupReason: string;
  isDirectRoleProfile: boolean;
  isTransientKind: boolean;
  expectsErrorEventOwner?: boolean;
  contextOverrides?: Partial<ErrorRecoveryContext>;
  setup?: () => void;
};

const OWNERSHIP_ROUTING_CASES: OwnershipRoutingCase[] = (
  Object.entries(RECOVERY_OWNER_BY_KIND) as Array<[AgentErrorKind, RecoveryOwner]>
).map(([kind, owner]) => {
  if (owner === 'thinking_model_fallback_handler') {
    return {
      kind,
      owner,
      expectedCleanupReason: OWNER_CLEANUP_SENTINELS[owner],
      isDirectRoleProfile: false,
      isTransientKind: false,
      expectsErrorEventOwner: true,
      contextOverrides: {
        error: new Error(`synthetic-${kind}`),
        modelConfig: {
          model: 'claude-sonnet-4-5',
          envOverrides: { PLANNING_MODEL: 'claude-opus-4-7' },
        } as unknown as ErrorRecoveryContext['modelConfig'],
        buildQueryOptions: vi.fn(() => {
          throw new ConnectionNotConfiguredError('Anthropic needs an API key', 'Anthropic');
        }) as unknown as ErrorRecoveryContext['buildQueryOptions'],
      },
      setup: () => {
        isThinkingModelUnavailableErrorMock.mockReturnValue(true);
        downgradeThinkingModelConfigMock.mockReturnValue({
          model: 'claude-sonnet-4-5',
          envOverrides: { PLANNING_MODEL: 'claude-haiku-4-5' },
        });
      },
    };
  }

  if (kind === 'network') {
    return {
      kind,
      owner,
      expectedEventOwner: 'classify_and_dispatch_tail',
      expectedCleanupReason: 'error',
      isDirectRoleProfile: true,
      isTransientKind: true,
      contextOverrides: {
        error: new Error(`synthetic-${kind}`),
        messageCount: 3,
      },
    };
  }

  const isAltModelOwner =
    owner === 'alt_model_then_server_error_retry' || owner === 'alt_model_then_transient_retry';
  return {
    kind,
    owner,
    expectedCleanupReason: OWNER_CLEANUP_SENTINELS[owner],
    isDirectRoleProfile: isAltModelOwner,
    isTransientKind: owner === 'alt_model_then_transient_retry',
    expectsErrorEventOwner: kind !== 'context_overflow',
    contextOverrides: {
      error: new Error(`synthetic-${kind}`),
      ...(isAltModelOwner ? { messageCount: 3 } : {}),
    },
  };
});

describe('dispatchErrorRecovery — Stage 1 routing contract (synthetic per-kind)', () => {
  it('exercises at least one kind for every declared owner value', () => {
    expect(new Set(OWNERSHIP_ROUTING_CASES.map((c) => c.owner))).toEqual(
      new Set(Object.values(RECOVERY_OWNER_BY_KIND)),
    );
  });

  it.each(OWNERSHIP_ROUTING_CASES)('routes $kind to $owner', async ({ kind, owner, expectedEventOwner, expectedCleanupReason, isDirectRoleProfile, isTransientKind, expectsErrorEventOwner, contextOverrides, setup }) => {
    getErrorKindMock.mockReturnValue(kind);
    isTransientErrorMock.mockReturnValue(isTransientKind);
    setup?.();

    const ctx = makeContext({
      isDirectRoleProfile,
      ...contextOverrides,
    });

    await dispatchErrorRecovery(ctx);

    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', expectedCleanupReason);
    if (expectsErrorEventOwner === false) {
      expect(dispatchAgentEventMock).toHaveBeenCalledWith(
        null,
        'test-turn-id',
        expect.objectContaining({ type: 'context_overflow' }),
      );
      return;
    }

    expect(dispatchAgentErrorEventMock).toHaveBeenCalled();
    const call = dispatchAgentErrorEventMock.mock.calls.at(-1);
    const opts = call?.[3] as { recoveryOwner?: RecoveryOwner } | undefined;
    expect(opts?.recoveryOwner).toBe(expectedEventOwner ?? owner);
  });
});

describe('dispatchErrorRecovery — owner telemetry uses actual handling owner', () => {
  it('records classify tail ownership for unknown errors that bypass alt-model routing', async () => {
    getErrorKindMock.mockReturnValue('unknown');
    isTransientErrorMock.mockReturnValue(false);

    const ctx = makeContext({
      error: new Error('unknown synthetic failure'),
      isDirectRoleProfile: false,
    });

    await dispatchErrorRecovery(ctx);

    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'error');
    const call = dispatchAgentErrorEventMock.mock.calls.at(-1);
    const opts = call?.[3] as { recoveryOwner?: RecoveryOwner } | undefined;
    expect(opts?.recoveryOwner).toBe('classify_and_dispatch_tail');
  });
});

// ===========================================================================
// classifyAndDispatchError — request-too-large with resumed session (FOX-2969)
// ===========================================================================

describe('classifyAndDispatchError — request-too-large classification (FOX-2969)', () => {
  it('classifies request-too-large as attachment_size when current turn has media', async () => {
    // When the current turn has media, classify as attachment_size (user gets actionable guidance)
    const ctx = makeContext({
      error: new Error('Request too large (max 20MB). Try with a smaller file.'),
      hasMedia: true,
    });

    await classifyAndDispatchError(ctx);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('attachment exceeds the 32MB'),
      }),
    );
  });

  it('classifies request-too-large as context_overflow when no current media (FOX-2969 scenario)', async () => {
    // FOX-2969: user sends message with NO attachments on a resumed session,
    // but accumulated session history exceeds 20MB. Without media, this is
    // correctly classified as context_overflow, triggering compaction recovery.
    const ctx = makeContext({
      error: new Error('Request too large (max 20MB). Try with a smaller file.'),
      hasMedia: false,
    });

    await classifyAndDispatchError(ctx);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'context_overflow',
      }),
    );
  });

  it('classifies as context_overflow when no media and no resume (accumulated text context)', async () => {
    const ctx = makeContext({
      error: new Error('Request too large (max 20MB).'),
      hasMedia: false,
    });

    await classifyAndDispatchError(ctx);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'context_overflow',
      }),
    );
  });

  it('classifies Anthropic per-image byte-limit errors as attachment_size and shows image-specific copy', async () => {
    const ctx = makeContext({
      error: new Error(
        'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 12494812 bytes > 5242880 bytes',
      ),
      hasMedia: false,
    });

    await classifyAndDispatchError(ctx);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        error: 'One of your images is over the 5 MB per-image limit. Try a smaller or lower-resolution version.',
      }),
    );
  });
});

// ===========================================================================
// classifyAndDispatchError — structured-output schema rejection
// (planSchemaProviderCompat Layer 2)
// ===========================================================================

describe('classifyAndDispatchError — structured-output schema rejection', () => {
  function makeStructuredOutputRejection(rawBody: string): ModelError {
    return new ModelError(
      'invalid_request',
      `400 ${rawBody}`,
      400,
      'openai',
      { rawMessage: rawBody },
    );
  }

  it('dispatches plan-mode rejection copy when OpenAI rejects response_format schema', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    const ctx = makeContext({
      error: makeStructuredOutputRejection(
        'Invalid schema for response_format \'rebel_plan\': In context=(), \'oneOf\' is not permitted.',
      ),
    });

    await classifyAndDispatchError(ctx);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('Plan mode hit an internal error'),
      }),
    );
  });

  it('dispatches plan-mode rejection copy when Anthropic rejects output_config.format schema', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    const ctx = makeContext({
      error: makeStructuredOutputRejection(
        'output_config.format.schema: Enum value "low" does not match declared type \'["string", "null"]\' for path effort',
      ),
    });

    await classifyAndDispatchError(ctx);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('Plan mode hit an internal error'),
      }),
    );
  });

  it('does NOT match MCP tool input_schema 400s (those route to schema_validation branch)', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    const ctx = makeContext({
      error: new ModelError(
        'invalid_request',
        '400 invalid_request_error: tools.0.input_schema: JSON schema is invalid',
        400,
        'anthropic',
        { rawMessage: 'invalid_request_error: tools.0.input_schema: JSON schema is invalid' },
      ),
    });

    await classifyAndDispatchError(ctx);

    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('connected tools has an invalid configuration'),
      }),
    );
  });

  it('does NOT match non-400 invalid_request errors', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    const ctx = makeContext({
      error: new ModelError(
        'invalid_request',
        '500 response_format schema parse error',
        500,
        'openai',
        { rawMessage: 'response_format schema parse error' },
      ),
    });

    await classifyAndDispatchError(ctx);

    // Should NOT use the structured-output rejection copy
    expect(dispatchAgentEventMock).not.toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        error: expect.stringContaining('Plan mode hit an internal error'),
      }),
    );
  });
});

describe('classifyAndDispatchError — output-cap learning + retry', () => {
  it('retries once when output-cap write succeeds', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    dispatchLearnedLimitsFromErrorMock.mockReturnValue({
      ok: true,
      observedCap: 8_192,
      profileId: 'p1',
    });
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new ModelError('invalid_request', 'max_tokens: 1000000 > maximum allowed value 8192', 400, 'Anthropic', {
        details: { outputCap: 8_192 },
      }),
      activeProfile: {
        id: 'p1',
        outputTokensSource: 'auto',
      } as unknown as ErrorRecoveryContext['activeProfile'],
      retryTurn: retryTurnMock,
      messageCount: 0,
    });

    const handled = await classifyAndDispatchError(ctx);

    expect(handled).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).toHaveBeenCalledTimes(1);
    expect(registryMocks.markOutputCapRetryAttempted).toHaveBeenCalledWith('test-turn-id|claude-sonnet-4-5|p1');
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  it('does not retry when output-cap write is skipped for user-source and surfaces actionable copy', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    dispatchLearnedLimitsFromErrorMock.mockReturnValue({
      ok: false,
      reason: 'user-source',
    });
    const retryTurnMock = vi.fn(async () => {});
    const error = new ModelError(
      'invalid_request',
      'max_tokens: 1000000 > maximum allowed value 8192',
      400,
      'Anthropic',
      { details: { outputCap: 8_192 } },
    );
    const ctx = makeContext({
      error,
      activeProfile: {
        id: 'p1',
        outputTokensSource: 'user',
      } as unknown as ErrorRecoveryContext['activeProfile'],
      retryTurn: retryTurnMock,
      messageCount: 0,
    });

    const handled = await classifyAndDispatchError(ctx);

    expect(handled).toMatchObject({ kind: 'passthrough' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      error,
      expect.objectContaining({
        humanizedOverride: 'This model maxes at 8192 output tokens. Lower the cap in Settings → Models, or remove your override to let Rebel auto-detect.',
      }),
    );
  });

  it('surfaces actionable copy when writer reports user-source for a model-match profile not equal to active profile', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    dispatchLearnedLimitsFromErrorMock.mockReturnValue({
      ok: false,
      reason: 'user-source',
    });
    const retryTurnMock = vi.fn(async () => {});
    const error = new ModelError(
      'invalid_request',
      'max_tokens: 1000000 > maximum allowed value 8192',
      400,
      'Anthropic',
      { details: { outputCap: 8_192 } },
    );
    const ctx = makeContext({
      error,
      activeProfile: {
        id: 'active-profile',
        outputTokensSource: 'auto',
      } as unknown as ErrorRecoveryContext['activeProfile'],
      workingProfile: {
        id: 'working-profile',
        outputTokensSource: 'auto',
      } as unknown as ErrorRecoveryContext['workingProfile'],
      retryTurn: retryTurnMock,
      messageCount: 0,
    });

    const handled = await classifyAndDispatchError(ctx);

    expect(handled).toMatchObject({ kind: 'passthrough' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      error,
      expect.objectContaining({
        humanizedOverride: 'This model maxes at 8192 output tokens. Lower the cap in Settings → Models, or remove your override to let Rebel auto-detect.',
      }),
    );
  });

  it('preserves existing behavior when no parseable output-cap detail is present', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    dispatchLearnedLimitsFromErrorMock.mockReturnValue(null);
    const retryTurnMock = vi.fn(async () => {});
    const error = new ModelError('invalid_request', 'Invalid model name', 400, 'Anthropic');
    const ctx = makeContext({
      error,
      retryTurn: retryTurnMock,
      messageCount: 0,
    });

    const handled = await classifyAndDispatchError(ctx);

    expect(handled).toMatchObject({ kind: 'passthrough' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      error,
      expect.objectContaining({ isTransient: false }),
    );
  });

  it('deduplicates output-cap retry attempts per turn/model/profile key', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    dispatchLearnedLimitsFromErrorMock.mockReturnValue({
      ok: true,
      observedCap: 8_192,
      profileId: 'p1',
    });
    const retryKeys = new Set<string>();
    registryMocks.hasOutputCapRetryAttempted.mockImplementation((key: string) => retryKeys.has(key));
    registryMocks.markOutputCapRetryAttempted.mockImplementation((key: string) => {
      retryKeys.add(key);
    });

    const retryTurnMock = vi.fn(async () => {});
    const makeOutputCapContext = () =>
      makeContext({
        error: new ModelError(
          'invalid_request',
          'max_tokens: 1000000 > maximum allowed value 8192',
          400,
          'Anthropic',
          { details: { outputCap: 8_192 } },
        ),
        activeProfile: {
          id: 'p1',
          outputTokensSource: 'auto',
        } as unknown as ErrorRecoveryContext['activeProfile'],
        retryTurn: retryTurnMock,
        messageCount: 0,
      });

    const firstHandled = await classifyAndDispatchError(makeOutputCapContext());
    const secondHandled = await classifyAndDispatchError(makeOutputCapContext());

    expect(firstHandled).toMatchObject({ kind: 'handled' });
    expect(secondHandled).toMatchObject({ kind: 'passthrough' });
    expect(retryTurnMock).toHaveBeenCalledTimes(1);
  });
});

describe('classifyAndDispatchError — long-context fallback activity guard', () => {
  it('passes a route rebuild hint when attempting a configured long-context model fallback', async () => {
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('Request too large (max 20MB).'),
      hasMedia: false,
      messageCount: 0,
      requestedModelForTurn: 'claude-sonnet-4-5',
      retryTurn: retryTurnMock,
      settings: {
        coreDirectory: '/tmp/test',
        models: {
          model: 'claude-sonnet-4-5',
          thinkingModel: null,
          permissionMode: 'bypassPermissions',
          executablePath: null,
          planMode: false,
          extendedContext: false,
          thinkingEffort: 'medium',
          apiKey: null,
          longContextFallbackModel: 'claude-opus-4-7',
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
    });

    await classifyAndDispatchError(ctx);

    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'claude-opus-4-7',
      longContextFallbackAttempted: true,
      routeRebuildHint: { kind: 'alt-model', model: 'claude-opus-4-7' },
      inFlightProviderRoutePlan: ctx.plan,
    }));
  });

  it('passes a long-context-profile route rebuild hint when attempting a configured long-context profile fallback', async () => {
    const retryTurnMock = vi.fn(async () => {});
    const fallbackProfile = {
      id: 'profile-200k',
      name: '200K Context Profile',
      providerType: 'openai',
      serverUrl: 'https://api.openai.com/v1',
      model: 'claude-sonnet-4-5-200k',
      apiKey: 'fake-profile',
      createdAt: 1,
    };
    const ctx = makeContext({
      error: new Error('Request too large (max 200K tokens).'),
      hasMedia: false,
      messageCount: 0,
      requestedModelForTurn: 'claude-sonnet-4-5',
      availableProfiles: [fallbackProfile] as unknown as ErrorRecoveryContext['availableProfiles'],
      retryTurn: retryTurnMock,
      settings: {
        coreDirectory: '/tmp/test',
        models: {
          model: 'claude-sonnet-4-5',
          thinkingModel: null,
          permissionMode: 'bypassPermissions',
          executablePath: null,
          planMode: false,
          extendedContext: false,
          thinkingEffort: 'medium',
          apiKey: null,
          longContextFallbackModel: null,
          longContextFallbackProfileId: fallbackProfile.id,
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
        localModel: { profiles: [fallbackProfile], activeProfileId: null },
      } as unknown as ErrorRecoveryContext['settings'],
    });

    await classifyAndDispatchError(ctx);

    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      workingProfileOverrideId: fallbackProfile.id,
      modelOverride: undefined,
      longContextFallbackAttempted: true,
      routeRebuildHint: { kind: 'long-context-profile', profileId: fallbackProfile.id },
      inFlightProviderRoutePlan: ctx.plan,
    }));
  });

  it('skips long-context fallback when messageCount > 0 (agent activity already occurred)', async () => {
    const ctx = makeContext({
      error: new Error('Request too large (max 20MB).'),
      hasMedia: false,
      messageCount: 3,
      settings: {
        coreDirectory: '/tmp/test',
        models: {
          model: 'claude-sonnet-4-5',
          thinkingModel: null,
          permissionMode: 'bypassPermissions',
          executablePath: null,
          planMode: false,
          extendedContext: false,
          thinkingEffort: 'medium',
          apiKey: null,
          longContextFallbackModel: 'claude-sonnet-4-5-20250514',
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
    });

    await classifyAndDispatchError(ctx);

    // retryTurn NOT called — guard prevents long-context fallback after agent activity
    expect(ctx.retryTurn).not.toHaveBeenCalled();
    // Falls through to context_overflow compaction instead
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'context_overflow' }),
    );
  });
});

// ===========================================================================
// handlePostFallbackServerError — network error exclusion (Stage 2)
// ===========================================================================

describe('handlePostFallbackServerError', () => {
  it('returns false when isNetworkFailure is true (network errors skip this handler)', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    const ctx = makeContext({ error: new Error('fetch failed') });

    const result = await handlePostFallbackServerError(ctx, false, true);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(registryMocks.getRetryCount).not.toHaveBeenCalled();
  });

  it('handles server errors when isNetworkFailure is false', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    delayWithAbortMock.mockResolvedValue(false);
    const ctx = makeContext({ error: new Error('Internal server error') });

    const result = await handlePostFallbackServerError(ctx, false, false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(ctx.retryTurn).toHaveBeenCalled();
  });

  it('returns false when isServerErrorRetry is true (already handled by handler 6)', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    const ctx = makeContext();

    const result = await handlePostFallbackServerError(ctx, true, false);

    expect(result).toMatchObject({ kind: 'passthrough' });
  });
});

// ===========================================================================
// handleTransientAndProcessExitRetry — network-aware backoff (Stages 2-3)
// ===========================================================================

describe('handleTransientAndProcessExitRetry', () => {
  it('retries with extended backoff for network errors', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(true);
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    delayWithAbortMock.mockResolvedValue(false);

    const ctx = makeContext({ error: new Error('fetch failed') });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(ctx.retryTurn).toHaveBeenCalled();

    // Verify extended backoff — base 5000ms for network errors
    const delayArg = delayWithAbortMock.mock.calls[0][0] as number;
    expect(delayArg).toBeGreaterThanOrEqual(5000);
    expect(delayArg).toBeLessThanOrEqual(6000); // 5000 + up to 1000 jitter

    // Status event dispatched for network errors
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'status',
        message: expect.stringContaining('Network connection issue'),
      }),
    );
  });

  it('routes network-kind fetch failures through the same extended-backoff retry path', async () => {
    getErrorKindMock.mockReturnValue('network');
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(true);
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    delayWithAbortMock.mockResolvedValue(false);

    const ctx = makeContext({ error: new ModelError('network', 'fetch failed') });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(isTransientErrorMock).toHaveBeenCalledWith(
      'fetch failed',
      'network',
      expect.objectContaining({ logger: mockTurnLogger }),
    );
    const delayArg = delayWithAbortMock.mock.calls[0][0] as number;
    expect(delayArg).toBeGreaterThanOrEqual(5000);
    expect(delayArg).toBeLessThanOrEqual(6000);
    expect(ctx.retryTurn).toHaveBeenCalled();
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({
        type: 'status',
        message: expect.stringContaining('Network connection issue'),
      }),
    );
  });

  it('retries with standard backoff for non-network transient errors', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(false);
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    delayWithAbortMock.mockResolvedValue(false);

    const ctx = makeContext({ error: new Error('503 Service Unavailable') });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(ctx.retryTurn).toHaveBeenCalled();

    // Verify standard backoff — base 1000ms for non-network errors
    const delayArg = delayWithAbortMock.mock.calls[0][0] as number;
    expect(delayArg).toBeGreaterThanOrEqual(1000);
    expect(delayArg).toBeLessThanOrEqual(1500); // 1000 + up to 500 jitter

    // NO status event for non-network transient errors (silent retry)
    expect(dispatchAgentEventMock).not.toHaveBeenCalled();
  });

  it('caps network backoff at 30s on higher retry counts', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(true);
    registryMocks.getRetryCount.mockReturnValue(2); // 3rd retry
    registryMocks.incrementRetryCount.mockReturnValue(3);
    delayWithAbortMock.mockResolvedValue(false);

    const ctx = makeContext({ error: new Error('ETIMEDOUT') });

    await handleTransientAndProcessExitRetry(ctx);

    const delayArg = delayWithAbortMock.mock.calls[0][0] as number;
    // 5000 * 2^2 = 20000 + jitter. Should be capped at 30000.
    expect(delayArg).toBeLessThanOrEqual(30_000);
  });

  it('returns false when retries exhausted', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(true);
    registryMocks.getRetryCount.mockReturnValue(3); // At max

    const ctx = makeContext({ error: new Error('fetch failed') });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(ctx.retryTurn).not.toHaveBeenCalled();
  });

  it('returns false when error is not transient', async () => {
    isTransientErrorMock.mockReturnValue(false);

    const ctx = makeContext({ error: new Error('billing error') });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(ctx.retryTurn).not.toHaveBeenCalled();
  });

  it('keeps FOX-3267 / BTS-260430 invalid_request Stream must be true errors out of transient retry', async () => {
    getErrorKindMock.mockReturnValue('invalid_request');
    isTransientErrorMock.mockReturnValue(false);

    const ctx = makeContext({
      error: new Error('400 invalid_request: Stream must be true'),
    });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(ctx.retryTurn).not.toHaveBeenCalled();
    expect(isTransientErrorMock).toHaveBeenCalledWith(
      '400 invalid_request: Stream must be true',
      'invalid_request',
      { logger: mockTurnLogger },
    );
  });

  it('retries empty_result_anomaly once with a fresh turn before reporting', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(false);
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);

    const ctx = makeContext({ error: new Error('empty_result_anomaly: empty result with output tokens') });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(ctx.retryTurn).toHaveBeenCalledWith({ resetConversation: true });
  });

  it('does not retry empty_result_anomaly more than once', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(false);
    registryMocks.getRetryCount.mockReturnValue(1);

    const ctx = makeContext({ error: new Error('empty_result_anomaly: empty result with output tokens') });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(ctx.retryTurn).not.toHaveBeenCalled();
  });

  it('skips transient retry when messageCount > 0 (agent activity already occurred)', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(false);
    registryMocks.getRetryCount.mockReturnValue(0);

    const ctx = makeContext({ error: new Error('503 Service Unavailable'), messageCount: 3 });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(ctx.retryTurn).not.toHaveBeenCalled();
  });

  // Regression: the messageCount activity guard must allow silent retry when only
  // synthetic framework messages have been processed. Before the fix, system:init
  // (yielded before any API call) caused messageCount === 1 and tripped the guard,
  // so a transient connection error right after switching providers surfaced as
  // a hard error. The fix at agentTurnExecutor.ts ensures messageCount stays 0
  // until real API output is received.
  // Origin: rebel://conversation/10d9eec1-18ea-4591-8b0e-39cf19c9a36d
  it('retries silently when messageCount === 0 (only synthetic system messages processed)', async () => {
    isTransientErrorMock.mockReturnValue(true);
    isNetworkErrorMock.mockReturnValue(false);
    registryMocks.getRetryCount.mockReturnValue(0);
    registryMocks.incrementRetryCount.mockReturnValue(1);
    delayWithAbortMock.mockResolvedValue(false);

    // messageCount: 0 simulates the post-fix state — system:init (and any
    // status/warning messages) were emitted but did NOT bump the counter
    // because they aren't real API output.
    const ctx = makeContext({ error: new Error('Connection error.'), messageCount: 0 });

    const result = await handleTransientAndProcessExitRetry(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(ctx.retryTurn).toHaveBeenCalled();
  });
});

// ===========================================================================
// Activity guard tests — messageCount > 0 prevents duplicate replies
// ===========================================================================

describe('activity guards prevent retry after agent output', () => {
  it('handleServerErrorRetry skips retry when messageCount > 0', async () => {
    registryMocks.getRetryCount.mockReturnValue(0);

    const ctx = makeContext({ messageCount: 2 });

    const result = await handleServerErrorRetry(ctx, true, false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(ctx.retryTurn).not.toHaveBeenCalled();
    // Should still dispatch error to user
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('handlePostFallbackServerError skips retry when messageCount > 0', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(0);

    const ctx = makeContext({ error: new Error('Internal server error'), messageCount: 1 });

    const result = await handlePostFallbackServerError(ctx, false, false);

    expect(result).toMatchObject({ kind: 'handled' });
    expect(ctx.retryTurn).not.toHaveBeenCalled();
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'error' }),
    );
  });

  it('handleAltModelFallback skips both fast retry AND Claude fallback when messageCount > 0', async () => {
    registryMocks.getRetryCount.mockReturnValue(0);

    const ctx = makeContext({
      messageCount: 2,
      isDirectRoleProfile: false,
    });

    const result = await handleAltModelFallback(ctx, true);

    expect(result).toMatchObject({ kind: 'handled' });
    // Neither fast retry nor Claude fallback — both blocked by activity guard
    expect(ctx.retryTurn).not.toHaveBeenCalled();
    expect(runAgentQueryMock).not.toHaveBeenCalled();
    // Error dispatched to user instead
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'error' }),
    );
  });
});

// ===========================================================================
// classifyAndDispatchError — tool-result graceful degradation
// ===========================================================================

describe('classifyAndDispatchError — tool-result graceful degradation', () => {
  it('recovers from accumulated assistant text (existing behavior)', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [{ role: 'assistant', text: 'Here is a summary of the document...' }],
      eventsByTurn: { 'test-turn-id': [] },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const ctx = makeContext({
      error: new Error('empty_result_anomaly: empty result with output tokens'),
    });

    await classifyAndDispatchError(ctx);

    expect(makeSyntheticResultMock).toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining('Here is a summary of the document...'),
      'error',
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-graceful-degradation');
  });

  it('falls back to tool-result degradation when no assistant text but tools succeeded', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [{ role: 'user', text: 'Read this Notion page' }],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'notion-fetch', stage: 'start', detail: '{}', timestamp: 1 },
          { type: 'tool', toolName: 'notion-fetch', stage: 'end', detail: 'Page content here', isError: false, timestamp: 2 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const ctx = makeContext({
      error: new Error('empty_result_anomaly: empty result with output tokens'),
    });

    await classifyAndDispatchError(ctx);

    expect(makeSyntheticResultMock).toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining('completed some actions'),
      'error',
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-graceful-degradation-from-tools');
  });

  it('does not trigger tool-result degradation when all tool calls failed', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [{ role: 'user', text: 'Read this page' }],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'notion-fetch', stage: 'start', detail: '{}', timestamp: 1 },
          { type: 'tool', toolName: 'notion-fetch', stage: 'end', detail: 'Error: not found', isError: true, timestamp: 2 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const ctx = makeContext({
      error: new Error('empty_result_anomaly: empty result with output tokens'),
    });

    await classifyAndDispatchError(ctx);

    // Should NOT use tool-result degradation — falls through to generic error handling
    expect(completeTurnCleanupMock).not.toHaveBeenCalledWith(
      'test-turn-id',
      'completed-graceful-degradation-from-tools',
    );
  });

  // Bug regression: synthesizing "completed some actions" off the back of a
  // bookkeeping-only turn (TaskUpdate / MissionSet / TodoWrite / etc) is the
  // recovery-path twin of the synthesis-gate bug. Bookkeeping tools must be
  // filtered the same way in the gate (synthesisGate) and the recovery path
  // (turnErrorRecovery) — otherwise a model that planned but never acted
  // looks like it succeeded.
  // See: docs-private/investigations/260427_mcp_vanta_synthesized_done_after_tasklist.md
  describe('bookkeeping-only ends do NOT trigger graceful degradation', () => {
    it.each(['MissionSet', 'TaskList', 'TaskCreate', 'TaskUpdate', 'TaskGet', 'TodoWrite'] as const)(
      'falls through to generic error path when only %s ran',
      async (toolName) => {
        registryMocks.getContextAccumulator.mockReturnValue({
          messages: [],
          eventsByTurn: {
            'test-turn-id': [
              { type: 'tool', toolName, stage: 'start', detail: '{}', timestamp: 1 },
              { type: 'tool', toolName, stage: 'end', detail: 'ok', isError: false, timestamp: 2 },
            ],
          },
          activeTurnId: 'test-turn-id',
          isBusy: false,
          lastError: null,
          lastErrorSource: null,
          terminatedTurnIds: new Set(),
        } as unknown as ConversationStateShape);

        const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
        const ctx = makeContext({
          error: new EmptyResultAnomalyError({
            lastTurnOutputTokens: 50,
            loopTotalOutputTokens: 500,
            model: 'claude-opus-4-7',
            stopReason: 'end_turn',
          }),
        });

        await classifyAndDispatchError(ctx);

        // Recovery path must NOT claim "completed some actions" for bookkeeping-only turns.
        expect(makeSyntheticResultMock).not.toHaveBeenCalledWith(
          'test-turn-id',
          expect.stringContaining('completed some actions'),
          'error',
        );
        expect(completeTurnCleanupMock).not.toHaveBeenCalledWith(
          'test-turn-id',
          'completed-graceful-degradation-from-tools',
        );
      },
    );
  });

  it('does NOT trigger tool-result degradation when only synthetic-origin tool ends are present', async () => {
    // Synthetic plan-seed tool calls (origin: 'synthetic-plan-seed') and pre-turn-context
    // events (origin: 'pre-turn-context') exist purely to inject context into the model.
    // They must be excluded from "real execution" detection — the model never invoked them.
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'notion-fetch', stage: 'start', detail: '{}', timestamp: 1, _origin: 'synthetic-plan-seed' },
          { type: 'tool', toolName: 'notion-fetch', stage: 'end', detail: 'Page content', isError: false, timestamp: 2, _origin: 'synthetic-plan-seed' },
          { type: 'tool', toolName: 'web_search', stage: 'end', detail: 'results', isError: false, timestamp: 3, _origin: 'pre-turn-context' },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
    const ctx = makeContext({
      error: new EmptyResultAnomalyError({
        lastTurnOutputTokens: 50,
        loopTotalOutputTokens: 500,
        model: 'claude-opus-4-7',
        stopReason: 'end_turn',
      }),
    });

    await classifyAndDispatchError(ctx);

    expect(makeSyntheticResultMock).not.toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining('completed some actions'),
      'error',
    );
    expect(completeTurnCleanupMock).not.toHaveBeenCalledWith(
      'test-turn-id',
      'completed-graceful-degradation-from-tools',
    );
  });

  it('still triggers tool-result degradation when a real tool ran alongside bookkeeping/synthetic ends', async () => {
    // The negative gates above should not be over-broad: a turn that mixes
    // bookkeeping or synthetic events with at least one real model-invoked
    // tool end must still degrade gracefully.
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        'test-turn-id': [
          // Bookkeeping (filtered)
          { type: 'tool', toolName: 'TaskUpdate', stage: 'end', detail: 'ok', isError: false, timestamp: 1 },
          // Synthetic (filtered)
          { type: 'tool', toolName: 'notion-fetch', stage: 'end', detail: 'seed', isError: false, timestamp: 2, _origin: 'synthetic-plan-seed' },
          // Real (counts)
          { type: 'tool', toolName: 'web_search', stage: 'end', detail: 'results', isError: false, timestamp: 3 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
    const ctx = makeContext({
      error: new EmptyResultAnomalyError({
        lastTurnOutputTokens: 50,
        loopTotalOutputTokens: 500,
        model: 'claude-opus-4-7',
        stopReason: 'end_turn',
      }),
    });

    await classifyAndDispatchError(ctx);

    expect(makeSyntheticResultMock).toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining('completed some actions'),
      'error',
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith(
      'test-turn-id',
      'completed-graceful-degradation-from-tools',
    );
  });

  it('prefers assistant text over tool-result degradation when both available', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [{ role: 'assistant', text: 'The document says...' }],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'notion-fetch', stage: 'end', detail: 'Page content', isError: false, timestamp: 1 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const ctx = makeContext({
      error: new Error('empty_result_anomaly: empty result with output tokens'),
    });

    await classifyAndDispatchError(ctx);

    // Should use assistant text (first path), not tool-result degradation
    expect(makeSyntheticResultMock).toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining('The document says...'),
      'error',
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-graceful-degradation');
  });

  it('fires tool-result degradation even when messages array is empty (tool-only turn)', async () => {
    // In a real turn, the accumulator may have tool events but no messages entries
    // because tool events don't create messages — only assistant/result/error events do.
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'notion-fetch', stage: 'start', detail: '{}', timestamp: 1 },
          { type: 'tool', toolName: 'notion-fetch', stage: 'end', detail: 'Page content here', isError: false, timestamp: 2 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const ctx = makeContext({
      error: new Error('empty_result_anomaly: empty result with output tokens'),
    });

    await classifyAndDispatchError(ctx);

    expect(makeSyntheticResultMock).toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining('completed some actions'),
      'error',
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-graceful-degradation-from-tools');
  });

  it('does not trigger tool-result degradation for non-empty_result_anomaly errors', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [{ role: 'user', text: 'test' }],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'notion-fetch', stage: 'end', detail: 'content', isError: false, timestamp: 1 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const ctx = makeContext({
      error: new Error('Stream closed unexpectedly'),
    });

    await classifyAndDispatchError(ctx);

    // Generic error, not empty_result_anomaly — tool degradation should not fire
    expect(completeTurnCleanupMock).not.toHaveBeenCalledWith(
      'test-turn-id',
      'completed-graceful-degradation-from-tools',
    );
  });

  // Stage 2 guardrail: if empty_result_anomaly reaches the error recovery path
  // with hasUserQuestionPending=true, that means Stage 1 pause detection missed
  // the pause. Coerce to clean pause and capture the regression.
  // See: docs/plans/260420_user_question_cross_surface_resilience.md Stage 2
  describe('user-question pause guardrail (Stage 2 defense-in-depth)', () => {
    beforeEach(() => {
      registryMocks.hasUserQuestionPending.mockReturnValue(false);
    });

    it('coerces anomaly to clean pause with pause_type=user_question when BOTH flag and event are present', async () => {
      registryMocks.hasUserQuestionPending.mockReturnValue(true);
      registryMocks.getContextAccumulator.mockReturnValue({
        messages: [],
        eventsByTurn: {
          'test-turn-id': [
            // User_question event alongside the pending flag — unambiguous pause.
            { type: 'user_question', batchId: 'b-1', turnId: 'test-turn-id', timestamp: 1, questions: [] },
          ],
        },
        activeTurnId: 'test-turn-id',
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
        terminatedTurnIds: new Set(),
      } as unknown as ConversationStateShape);

      const ctx = makeContext({
        error: new Error('empty_result_anomaly: empty result with output tokens'),
      });

      const handled = await classifyAndDispatchError(ctx);

      expect(handled).toMatchObject({ kind: 'handled' });
      expect(makeSyntheticResultMock).toHaveBeenCalledWith(
        'test-turn-id',
        '',
        'awaiting_user',
      );
      expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-pause-coerced');
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            pause_type: 'user_question',
            regression: 'pause_detection_missed',
          }),
        }),
      );
    });

    it('coerces to pause with pause_type=ambiguous when only the flag is set (event missing)', async () => {
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

      const ctx = makeContext({
        error: new Error('empty_result_anomaly: empty result with output tokens'),
      });

      const handled = await classifyAndDispatchError(ctx);

      expect(handled).toMatchObject({ kind: 'handled' });
      // Still coerced to pause (safer than re-breaking the turn)…
      expect(makeSyntheticResultMock).toHaveBeenCalledWith(
        'test-turn-id',
        '',
        'awaiting_user',
      );
      expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'completed-pause-coerced');
      // …but Sentry tag identifies the signal mismatch so it's observable.
      expect(captureExceptionMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            pause_type: 'ambiguous',
            regression: 'pause_detection_missed',
          }),
          extra: expect.objectContaining({
            hasUserQuestionEvent: false,
          }),
        }),
      );
    });

    it('does NOT coerce when hasUserQuestionPending=false (normal path)', async () => {
      registryMocks.hasUserQuestionPending.mockReturnValue(false);
      registryMocks.getContextAccumulator.mockReturnValue({
        messages: [{ role: 'assistant', text: 'Here is your answer.' }],
        eventsByTurn: { 'test-turn-id': [] },
        activeTurnId: 'test-turn-id',
        isBusy: false,
        lastError: null,
        lastErrorSource: null,
        terminatedTurnIds: new Set(),
      } as unknown as ConversationStateShape);

      const ctx = makeContext({
        error: new Error('empty_result_anomaly: empty result with output tokens'),
      });

      await classifyAndDispatchError(ctx);

      // Normal text-recovery path, not the coerced-pause path
      expect(completeTurnCleanupMock).not.toHaveBeenCalledWith(
        'test-turn-id',
        'completed-pause-coerced',
      );
      expect(completeTurnCleanupMock).toHaveBeenCalledWith(
        'test-turn-id',
        'completed-graceful-degradation',
      );
    });
  });

  // ===========================================================================
  // Zero-output-token anomaly — tool recovery guard
  //
  // When EmptyResultAnomalyError has loopTotalOutputTokens === 0, the model
  // never responded. Any tool events in the accumulator are from framework/setup
  // tools (MissionSet, file_search) — not model-invoked actions. Tool recovery
  // must be skipped to avoid the misleading "completed some actions" message.
  // ===========================================================================

  it('does NOT show "completed some actions" when EmptyResultAnomalyError has loopTotalOutputTokens === 0', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'file_search', stage: 'end', detail: 'results', isError: false, timestamp: 1 },
          { type: 'tool', toolName: 'MissionSet', stage: 'end', detail: 'ok', isError: false, timestamp: 2 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
    const ctx = makeContext({
      error: new EmptyResultAnomalyError({
        lastTurnOutputTokens: 0,
        loopTotalOutputTokens: 0,
        model: 'openai/gpt-5.5',
        stopReason: 'end_turn',
      }),
    });

    await classifyAndDispatchError(ctx);

    // Should NOT use tool-result degradation
    expect(completeTurnCleanupMock).not.toHaveBeenCalledWith(
      'test-turn-id',
      'completed-graceful-degradation-from-tools',
    );
    // Should show the zero-output specific message
    expect(makeSyntheticResultMock).toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining("couldn't complete that thought"),
      'error',
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith(
      'test-turn-id',
      'completed-zero-output-no-recovery',
    );
  });

  it('still shows "completed some actions" when EmptyResultAnomalyError has loopTotalOutputTokens > 0', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'notion-fetch', stage: 'end', detail: 'Page content', isError: false, timestamp: 1 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
    const ctx = makeContext({
      error: new EmptyResultAnomalyError({
        lastTurnOutputTokens: 50,
        loopTotalOutputTokens: 500,
        model: 'claude-opus-4-7',
        stopReason: 'end_turn',
      }),
    });

    await classifyAndDispatchError(ctx);

    // Should use tool-result degradation (model DID produce output)
    expect(makeSyntheticResultMock).toHaveBeenCalledWith(
      'test-turn-id',
      expect.stringContaining('completed some actions'),
      'error',
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith(
      'test-turn-id',
      'completed-graceful-degradation-from-tools',
    );
  });
});

// ===========================================================================
// classifyAndDispatchError — Sentry capture for empty_result_anomaly
//
// Verifies that the new empty_result_classification tag and typed token
// diagnostics from EmptyResultAnomalyError flow through to captureException.
// See: docs/plans/260417_empty_result_anomaly_resilience.md
// ===========================================================================

describe('classifyAndDispatchError — empty_result_anomaly Sentry observability', () => {
  it('tags text_recovery path with empty_result_classification and token diagnostics', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [{ role: 'assistant', text: 'Here is your summary.' }],
      eventsByTurn: { 'test-turn-id': [] },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
    const anomalyError = new EmptyResultAnomalyError({
      lastTurnOutputTokens: 0,
      loopTotalOutputTokens: 250,
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });

    const ctx = makeContext({ error: anomalyError });
    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledWith(
      anomalyError,
      expect.objectContaining({
        tags: expect.objectContaining({
          sdk_error_category: 'empty_result_anomaly',
          empty_result_classification: 'text_recovery',
          degradation_type: 'text_recovery',
        }),
        extra: expect.objectContaining({
          last_turn_output_tokens: 0,
          loop_total_output_tokens: 250,
          stop_reason: 'end_turn',
        }),
      }),
    );
  });

  it('tags tool_recovery path with empty_result_classification and token diagnostics', async () => {
    registryMocks.getContextAccumulator.mockReturnValue({
      messages: [{ role: 'user', text: 'Do the thing' }],
      eventsByTurn: {
        'test-turn-id': [
          { type: 'tool', toolName: 'web-search', stage: 'end', detail: 'results', isError: false, timestamp: 1 },
        ],
      },
      activeTurnId: 'test-turn-id',
      isBusy: false,
      lastError: null,
      lastErrorSource: null,
      terminatedTurnIds: new Set(),
    } as unknown as ConversationStateShape);

    const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
    const anomalyError = new EmptyResultAnomalyError({
      lastTurnOutputTokens: 0,
      loopTotalOutputTokens: 500,
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });

    const ctx = makeContext({ error: anomalyError });
    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledWith(
      anomalyError,
      expect.objectContaining({
        tags: expect.objectContaining({
          sdk_error_category: 'empty_result_anomaly',
          empty_result_classification: 'tool_recovery',
          degradation_type: 'tool_recovery',
        }),
        extra: expect.objectContaining({
          last_turn_output_tokens: 0,
          loop_total_output_tokens: 500,
          stop_reason: 'end_turn',
        }),
      }),
    );
  });

  it('tags retry_failed_no_recovery with sdk_error_category: empty_result_anomaly', async () => {
    // No accumulator — neither text nor tool recovery can fire, so the user
    // gets friendly retry copy and Sentry is captured only after retry failure.
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    getErrorKindMock.mockReturnValue('unknown');
    registryMocks.getRetryCount.mockReturnValue(1);

    const { EmptyResultAnomalyError } = await import('@shared/utils/emptyResultAnomalyError');
    const anomalyError = new EmptyResultAnomalyError({
      lastTurnOutputTokens: 75,
      loopTotalOutputTokens: 300,
      model: 'claude-opus-4-7',
      stopReason: 'end_turn',
    });

    const ctx = makeContext({ error: anomalyError });
    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledWith(
      anomalyError,
      expect.objectContaining({
        tags: expect.objectContaining({
          sdk_error_category: 'empty_result_anomaly',
          empty_result_classification: 'retry_failed_no_recovery',
          empty_result_retry_attempted: 'true',
          model: 'claude-sonnet-4-5',
        }),
        extra: expect.objectContaining({
          last_turn_output_tokens: 75,
          loop_total_output_tokens: 300,
          stop_reason: 'end_turn',
        }),
      }),
    );
  });

  it('does not include anomaly diagnostics for non-EmptyResultAnomalyError errors in no-recovery path', async () => {
    // A generic error in the fallthrough — should NOT get empty_result_classification
    registryMocks.getContextAccumulator.mockReturnValue(undefined);
    getErrorKindMock.mockReturnValue('unknown');

    const genericError = new Error('something else went wrong');
    const ctx = makeContext({ error: genericError });
    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledWith(
      genericError,
      expect.objectContaining({
        tags: expect.not.objectContaining({
          empty_result_classification: expect.anything(),
        }),
      }),
    );
  });
});

describe('classifyAndDispatchError — message timeout diagnostics', () => {
  const makeTimeoutError = () => {
    const err = new Error('The response stalled and timed out');
    err.name = 'MessageTimeoutError';
    return err;
  };

  beforeEach(() => {
    diagnoseTimeoutMock.mockResolvedValue({ kind: 'transient_stall' });
  });

  it('dispatches anthropic_issue message when diagnoseTimeout detects Anthropic outage', async () => {
    diagnoseTimeoutMock.mockResolvedValue({
      kind: 'anthropic_issue',
      indicator: 'major',
      description: 'Elevated error rates',
    });
    const ctx = makeContext({ error: makeTimeoutError() });

    await classifyAndDispatchError(ctx);

    expect(diagnoseTimeoutMock).toHaveBeenCalled();
    const event = dispatchAgentEventMock.mock.calls[0][2];
    expect(event.error).toContain('Claude seems to be having a moment');
    expect(event.error).toContain('status: major');
    expect(event.timeoutDiagnostic).toEqual({
      kind: 'anthropic_issue',
      indicator: 'major',
      description: 'Elevated error rates',
    });
    expect(event.isTransient).toBe(true);
    expect(event.errorKind).toBe('message_timeout');
  });

  it('dispatches internet_unreachable message', async () => {
    diagnoseTimeoutMock.mockResolvedValue({ kind: 'internet_unreachable' });
    const ctx = makeContext({ error: makeTimeoutError() });

    await classifyAndDispatchError(ctx);

    const event = dispatchAgentEventMock.mock.calls[0][2];
    expect(event.error).toContain("couldn't reach the internet");
    expect(event.timeoutDiagnostic).toEqual({ kind: 'internet_unreachable' });
  });

  it('dispatches transient_stall message', async () => {
    diagnoseTimeoutMock.mockResolvedValue({ kind: 'transient_stall' });
    const ctx = makeContext({ error: makeTimeoutError() });

    await classifyAndDispatchError(ctx);

    const event = dispatchAgentEventMock.mock.calls[0][2];
    expect(event.error).toContain("Rebel was thinking but didn't respond for 10 minutes");
    expect(event.error).toContain('Your message is safe');
  });

  it('falls back to transient_stall when diagnoseTimeout throws', async () => {
    diagnoseTimeoutMock.mockRejectedValue(new Error('probe failure'));
    const ctx = makeContext({ error: makeTimeoutError() });

    await classifyAndDispatchError(ctx);

    expect(mockTurnLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('diagnostics failed'),
    );
    const event = dispatchAgentEventMock.mock.calls[0][2];
    expect(event.error).toContain("Rebel was thinking but didn't respond for 10 minutes");
  });

  it('appends post-tool suffix when messageCount > 0', async () => {
    diagnoseTimeoutMock.mockResolvedValue({ kind: 'transient_stall' });
    const ctx = makeContext({ error: makeTimeoutError(), messageCount: 5 });

    await classifyAndDispatchError(ctx);

    const event = dispatchAgentEventMock.mock.calls[0][2];
    expect(event.error).toContain('review anything it changed');
  });

  it('captures only the first message timeout per renderer session', async () => {
    diagnoseTimeoutMock.mockResolvedValue({ kind: 'transient_stall' });
    const first = makeContext({
      error: makeTimeoutError(),
      rendererSessionId: 'timeout-dedupe-session',
    });
    const second = makeContext({
      error: makeTimeoutError(),
      rendererSessionId: 'timeout-dedupe-session',
      turnId: 'second-timeout-turn',
    });

    await classifyAndDispatchError(first);
    await classifyAndDispatchError(second);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        fallthroughCategory: 'message_timeout',
        rendererSessionId: 'timeout-dedupe-session',
      }),
      expect.stringContaining('suppressing duplicate Sentry capture'),
    );
  });

  it('skips Anthropic probes for non-Claude turns (isDirectRoleProfile)', async () => {
    const ctx = makeContext({
      error: makeTimeoutError(),
      isDirectRoleProfile: true,
    });

    await classifyAndDispatchError(ctx);

    expect(diagnoseTimeoutMock).not.toHaveBeenCalled();
    const event = dispatchAgentEventMock.mock.calls[0][2];
    expect(event.error).not.toContain('Claude');
    expect(event.error).toContain("Rebel was thinking but didn't respond for 10 minutes");
    expect(event.timeoutDiagnostic).toEqual({ kind: 'transient_stall' });
  });

  it('skips Anthropic probes for non-Claude turns (isDirectRoleProfile via role)', async () => {
    const ctx = makeContext({
      error: makeTimeoutError(),
      isDirectRoleProfile: true,
    });

    await classifyAndDispatchError(ctx);

    expect(diagnoseTimeoutMock).not.toHaveBeenCalled();
    const event = dispatchAgentEventMock.mock.calls[0][2];
    expect(event.error).not.toContain('Claude');
  });
});

// ===========================================================================
// classifyAndDispatchError — getErrorKind() fallback for sdk_error_category (REBEL-1AR Stage 2)
// ===========================================================================

describe('classifyAndDispatchError — sdk_error_category uses getErrorKind() fallback', () => {
  it('tags billing error as sdk_error_category: billing via getErrorKind() fallback', async () => {
    // Simulate a billing ModelError that doesn't match any fine-grained heuristic
    getErrorKindMock.mockReturnValue('billing');
    const billingError = new Error('Your credit balance is too low to access the Anthropic API.');

    const ctx = makeContext({ error: billingError });

    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledWith(
      billingError,
      expect.objectContaining({
        tags: expect.objectContaining({
          sdk_error_category: 'billing',
        }),
      }),
    );
  });

  it('tags auth error as sdk_error_category: auth via getErrorKind() fallback', async () => {
    getErrorKindMock.mockReturnValue('auth');
    const authError = new Error('Invalid API key');

    const ctx = makeContext({ error: authError });

    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledWith(
      authError,
      expect.objectContaining({
        tags: expect.objectContaining({
          sdk_error_category: 'auth',
        }),
      }),
    );
  });

  it('keeps sdk_error_category: unknown when getErrorKind() also returns unknown', async () => {
    getErrorKindMock.mockReturnValue('unknown');
    const genericError = new Error('Something weird happened');

    const ctx = makeContext({ error: genericError });

    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledWith(
      genericError,
      expect.objectContaining({
        tags: expect.objectContaining({
          sdk_error_category: 'unknown',
        }),
      }),
    );
  });

  it('preserves fine-grained heuristic over getErrorKind() (stream_closed wins)', async () => {
    // getErrorKind returns something, but the heuristic already matched
    getErrorKindMock.mockReturnValue('server_error');
    const streamError = new Error('Stream closed unexpectedly');

    const ctx = makeContext({ error: streamError });

    await classifyAndDispatchError(ctx);

    // Fine-grained heuristic should win — stream_closed, not server_error
    expect(captureExceptionMock).toHaveBeenCalledWith(
      streamError,
      expect.objectContaining({
        tags: expect.objectContaining({
          sdk_error_category: 'stream_closed',
        }),
      }),
    );
  });
});

// ===========================================================================
// classifyAndDispatchError — ModelError + non-ModelError fingerprint coverage
// ===========================================================================
//
// Stage 4 (260503_sentry_capture_contract): ModelError captures route through
// captureKnownCondition('model_error', ...). The wrapper owns the fingerprint
// shape ['model-error', kind, provider ?? 'unknown', upstreamProvider ?? 'none']
// so it stays consistent across all capture sites and survives future drift.
//
// Stage 5 (260526_hotspot-refactor-roadmap): non-ModelError captures at the
// generic fallthrough now route through captureKnownCondition('recovery_unknown_error', ...)
// with a static fingerprint ['recovery-unknown-error']. This closes cluster 3
// (Sentry observability calibration; PMs 260424 / 260427).
// ===========================================================================
describe('classifyAndDispatchError — ModelError fingerprint preservation (Stage 4)', () => {
  it('captures ModelError with the registry-derived fingerprint shape and preserves rich tags/extra', async () => {
    getErrorKindMock.mockReturnValue('rate_limit');
    const error = new ModelError('rate_limit', 'rate limited', 429, 'anthropic', {
      upstreamProvider: 'aws-bedrock',
    });

    const ctx = makeContext({ error });
    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedError, capturedContext] = captureExceptionMock.mock.calls[0];
    expect(capturedError).toBe(error);
    expect(capturedContext).toMatchObject({
      fingerprint: ['model-error', 'rate_limit', 'anthropic', 'aws-bedrock'],
      level: 'warning',
      _knownConditionWrapped: true,
      tags: expect.objectContaining({
        source: 'rebel-core-runtime',
        sdk_error_category: 'rate_limit',
      }),
      extra: expect.objectContaining({
        turnId: 'test-turn-id',
      }),
    });
  });

  it('applies dynamic fingerprint defaults when provider/upstreamProvider are absent', async () => {
    getErrorKindMock.mockReturnValue('auth');
    const error = new ModelError('auth', 'auth failed');

    const ctx = makeContext({ error });
    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [, capturedContext] = captureExceptionMock.mock.calls[0];
    expect(capturedContext).toMatchObject({
      fingerprint: ['model-error', 'auth', 'unknown', 'none'],
      level: 'warning',
      _knownConditionWrapped: true,
    });
  });

  it('routes non-ModelError fallthrough captures via recovery_unknown_error with the registry fingerprint', async () => {
    getErrorKindMock.mockReturnValue('unknown');
    const error = new Error('not a model error');

    const ctx = makeContext({ error });
    await classifyAndDispatchError(ctx);

    expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    const [capturedError, capturedContext] = captureExceptionMock.mock.calls[0];
    expect(capturedError).toBe(error);
    expect(capturedContext).toMatchObject({
      fingerprint: ['recovery-unknown-error'],
      level: 'error',
      _knownConditionWrapped: true,
    });
  });
});

describe('roleFromDecisionRole', () => {
  it('maps execution → working', () => {
    expect(roleFromDecisionRole('execution')).toBe('working');
  });
  it('maps planning → thinking', () => {
    expect(roleFromDecisionRole('planning')).toBe('thinking');
  });
  it('maps bts → background', () => {
    expect(roleFromDecisionRole('bts')).toBe('background');
  });
  it('maps subagent → working', () => {
    expect(roleFromDecisionRole('subagent')).toBe('working');
  });
  it('maps undefined → background', () => {
    expect(roleFromDecisionRole(undefined)).toBe('background');
  });
});

// ===========================================================================
// Refusal stop_reason handling (Fable 5 Stage 6)
//
// Provider safety classifiers (always-on-thinking models like Fable 5) can
// refuse a request with stop_reason: 'refusal'. A pre-output refusal surfaces
// as an EmptyResultAnomalyError whose typed `stopReason` field is 'refusal'.
// The recovery pipeline must: (a) skip the guaranteed-futile auto-retry,
// (b) show an honest refusal message instead of "Try asking again", and
// (c) classify the capture as 'refusal' so the class is countable in Sentry.
// Branching is on the typed field ONLY — the `empty_result_anomaly` message
// substring and template are invariant (source-text-assertion class).
// ===========================================================================

describe('refusal stop_reason handling (Fable 5 Stage 6)', () => {
  describe('handleTransientAndProcessExitRetry — refusal retry gate', () => {
    it('skips the empty-result auto-retry when stopReason is refusal', async () => {
      isTransientErrorMock.mockReturnValue(false);
      registryMocks.getRetryCount.mockReturnValue(0);

      const ctx = makeContext({
        error: new EmptyResultAnomalyError({
          lastTurnOutputTokens: 0,
          loopTotalOutputTokens: 0,
          model: 'claude-fable-5',
          stopReason: 'refusal',
        }),
      });

      const result = await handleTransientAndProcessExitRetry(ctx);

      expect(result).toMatchObject({
        kind: 'passthrough',
        reason: 'transient-empty-result-anomaly-refusal-no-retry',
      });
      expect(ctx.retryTurn).not.toHaveBeenCalled();
      expect(registryMocks.incrementRetryCount).not.toHaveBeenCalled();
    });

    // Invariant 5 (Refactor Assessment): non-refusal empty-result anomalies
    // KEEP the retry-once-then-degrade behavior. Typed-error variant of the
    // string-built test above — proves the new typed branch doesn't catch
    // non-refusal stop reasons.
    it('keeps the retry-once behavior for non-refusal EmptyResultAnomalyError (invariant 5)', async () => {
      isTransientErrorMock.mockReturnValue(true);
      isNetworkErrorMock.mockReturnValue(false);
      registryMocks.getRetryCount.mockReturnValue(0);
      registryMocks.incrementRetryCount.mockReturnValue(1);

      const ctx = makeContext({
        error: new EmptyResultAnomalyError({
          lastTurnOutputTokens: 50,
          loopTotalOutputTokens: 50,
          model: 'claude-fable-5',
          stopReason: 'end_turn',
        }),
      });

      const result = await handleTransientAndProcessExitRetry(ctx);

      expect(result).toMatchObject({ kind: 'handled' });
      expect(ctx.retryTurn).toHaveBeenCalledWith({ resetConversation: true });
    });
  });

  describe('classifyAndDispatchError — refusal degradation messaging', () => {
    it('shows the refusal message (not "Try asking again") with refusal classification for a pre-output refusal', async () => {
      registryMocks.getContextAccumulator.mockReturnValue(undefined);

      const ctx = makeContext({
        error: new EmptyResultAnomalyError({
          lastTurnOutputTokens: 0,
          loopTotalOutputTokens: 0,
          model: 'claude-fable-5',
          stopReason: 'refusal',
        }),
        requestedModelForTurn: 'claude-fable-5',
      });

      await classifyAndDispatchError(ctx);

      expect(makeSyntheticResultMock).toHaveBeenCalledWith(
        'test-turn-id',
        expect.stringContaining('safety system declined'),
        'error',
      );
      expect(makeSyntheticResultMock).not.toHaveBeenCalledWith(
        'test-turn-id',
        expect.stringContaining('Try asking again'),
        'error',
      );
      // Real captureKnownCondition runs (not mocked) — the 'refusal'
      // classification must validate against the registry contextSchema and
      // land in the fingerprint, making the class countable in Sentry.
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      const [, capturedContext] = captureExceptionMock.mock.calls[0];
      expect(capturedContext).toMatchObject({
        fingerprint: ['recovery-empty-result-anomaly', 'refusal'],
        tags: expect.objectContaining({
          empty_result_classification: 'refusal',
        }),
      });
      expect(completeTurnCleanupMock).toHaveBeenCalledWith(
        'test-turn-id',
        'completed-zero-output-no-recovery',
      );
    });

    it('shows the refusal message in the generic no-recovery branch (refusal with loop tokens, no recoverable content)', async () => {
      registryMocks.getContextAccumulator.mockReturnValue(undefined);

      const ctx = makeContext({
        error: new EmptyResultAnomalyError({
          lastTurnOutputTokens: 0,
          loopTotalOutputTokens: 200,
          model: 'claude-fable-5',
          stopReason: 'refusal',
        }),
        requestedModelForTurn: 'claude-fable-5',
      });

      await classifyAndDispatchError(ctx);

      expect(makeSyntheticResultMock).toHaveBeenCalledWith(
        'test-turn-id',
        expect.stringContaining('safety system declined'),
        'error',
      );
      const [, capturedContext] = captureExceptionMock.mock.calls[0];
      expect(capturedContext).toMatchObject({
        fingerprint: ['recovery-empty-result-anomaly', 'refusal'],
      });
      expect(completeTurnCleanupMock).toHaveBeenCalledWith(
        'test-turn-id',
        'completed-empty-result-no-recovery',
      );
    });

    // Invariant 5: non-refusal zero-output anomalies keep the existing
    // dedicated retry message and classification.
    it('keeps the "Try asking again" message and zero_output_no_recovery classification for non-refusal zero-output anomalies (invariant 5)', async () => {
      registryMocks.getContextAccumulator.mockReturnValue(undefined);

      const ctx = makeContext({
        error: new EmptyResultAnomalyError({
          lastTurnOutputTokens: 0,
          loopTotalOutputTokens: 0,
          model: 'claude-fable-5',
          stopReason: 'end_turn',
        }),
      });

      await classifyAndDispatchError(ctx);

      expect(makeSyntheticResultMock).toHaveBeenCalledWith(
        'test-turn-id',
        expect.stringContaining('Try asking again'),
        'error',
      );
      const [, capturedContext] = captureExceptionMock.mock.calls[0];
      expect(capturedContext).toMatchObject({
        fingerprint: ['recovery-empty-result-anomaly', 'zero_output_no_recovery'],
      });
    });
  });

  describe('handleThinkingModelFallback — honest unchanged-config logging (piece 4)', () => {
    it('logs "no downgrade path" (not "already on fallback") when the unavailable thinking model is not on the downgrade ladder', async () => {
      isThinkingModelUnavailableErrorMock.mockReturnValue(true);
      // Downgrade returns the same config → configChanged === false
      const sameConfig = {
        model: 'claude-sonnet-4-5',
        envOverrides: { PLANNING_MODEL: 'some-custom-model' },
      } as unknown as ErrorRecoveryContext['modelConfig'];
      downgradeThinkingModelConfigMock.mockReturnValue(sameConfig);

      const ctx = makeContext({
        error: new Error('thinking not supported'),
        modelConfig: sameConfig,
      });

      const result = await handleThinkingModelFallback(ctx);

      expect(result).toMatchObject({ kind: 'soft-failed' });
      expect(mockTurnLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ currentModel: 'some-custom-model' }),
        expect.stringContaining('no downgrade path'),
      );
      expect(mockTurnLogger.error).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('already on fallback'),
      );
    });

    it('keeps the "already on fallback" log when the unavailable thinking model IS the terminal fallback', async () => {
      isThinkingModelUnavailableErrorMock.mockReturnValue(true);
      const sameConfig = {
        model: 'claude-sonnet-4-5',
        envOverrides: { PLANNING_MODEL: 'claude-sonnet-4-6' },
      } as unknown as ErrorRecoveryContext['modelConfig'];
      downgradeThinkingModelConfigMock.mockReturnValue(sameConfig);

      const ctx = makeContext({
        error: new Error('thinking not supported'),
        modelConfig: sameConfig,
      });

      const result = await handleThinkingModelFallback(ctx);

      expect(result).toMatchObject({ kind: 'soft-failed' });
      expect(mockTurnLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ currentModel: 'claude-sonnet-4-6' }),
        'Thinking model unavailable and already on fallback',
      );
    });
  });
});

// ===========================================================================
// handleRateLimitFallback — Stage 4b multi-provider failover branch
// ===========================================================================

describe('handleRateLimitFallback — Stage 4b multi-provider failover', () => {
  // Helper: make a context wired for the multi-provider failover branch.
  // flag=true + resolvedFrom='settings' + two usable credential candidates.
  function makeMultiProviderContext(overrides: Partial<ErrorRecoveryContext> = {}): ErrorRecoveryContext {
    const retryTurnMock = vi.fn(async () => {});
    return makeContext({
      error: new Error('rate limit exceeded'),
      settings: {
        coreDirectory: '/tmp/test',
        models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
        openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
        localModel: { profiles: [], activeProfileId: null },
        experimental: { multiProviderRoutingEnabled: true },
        enabledProviders: ['openrouter', 'anthropic'],
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'openrouter',
          models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
          openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
          localModel: { profiles: [], activeProfileId: null },
          experimental: { multiProviderRoutingEnabled: true },
          enabledProviders: ['openrouter', 'anthropic'],
        },
        model: 'claude-sonnet-4-5',
        codexConnectivity: 'unknown',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'openrouter',
          transport: 'openrouter',
          credentialSource: 'openrouter-oauth-token',
          resolvedFrom: 'settings',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
      ...overrides,
    });
  }

  beforeEach(() => {
    getErrorKindMock.mockReturnValue('rate_limit');
    // Default: two distinct usable candidates (flag on + two providers)
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['openrouter-oauth-token', 'anthropic-api-key']),
    );
  });

  // -------------------------------------------------------------------------
  // (1) Flag OFF — branch not entered; default path unchanged
  // -------------------------------------------------------------------------
  it('flag OFF → branch not entered; default rate-limit path fires (Anthropic)', async () => {
    getFailoverCredentialCandidatesMock.mockReturnValue(new Set()); // should not be called

    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeContext({
      error: new Error('rate limit exceeded'),
      settings: {
        coreDirectory: '/tmp/test',
        models: { apiKey: null, model: 'claude-sonnet-4-5' },
        localModel: { profiles: [], activeProfileId: null },
        // flag is ABSENT (off)
      } as unknown as ErrorRecoveryContext['settings'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    // Default path: handled, error dispatched, no retry
    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (2) Flag ON + resolvedFrom:'explicit-profile' → branch NOT entered
  // -------------------------------------------------------------------------
  it("flag ON + resolvedFrom:'explicit-profile' → branch NOT entered", async () => {
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeMultiProviderContext({
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'openrouter',
          transport: 'openrouter',
          credentialSource: 'openrouter-oauth-token',
          resolvedFrom: 'explicit-profile',  // NOT 'settings'
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    // Default/Codex path handles it (non-Codex → shows error)
    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (2b) Flag ON + resolvedFrom:'working-profile' → branch NOT entered
  // -------------------------------------------------------------------------
  it("flag ON + resolvedFrom:'working-profile' → multi-provider branch NOT entered (falls through to default)", async () => {
    // Why this test: 'working-profile' is a live resolvedFrom value (a user's configured
    // working profile resolves before the provider-choice seam). The multi-provider
    // failover branch MUST NOT auto-failover for profile routes — doing so would bypass the
    // user's explicit profile configuration and silently switch providers mid-session.
    // Red→green: removing the `resolvedFrom === 'settings'` guard in the implementation
    // would cause the branch to fire here (getFailoverCredentialCandidatesMock and
    // providerRecordRateLimitMock would both be called), flipping this test red.
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeMultiProviderContext({
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'openrouter',
          transport: 'openrouter',
          credentialSource: 'openrouter-oauth-token',
          resolvedFrom: 'working-profile',  // Profile route — NOT 'settings'
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    // Default/Codex waterfall handles it; multi-provider-specific side effects must NOT fire.
    expect(result).toMatchObject({ kind: 'handled' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (2c) Abort before multi-provider retry fires → user_stopped dispatched, no retryTurn
  // -------------------------------------------------------------------------
  it('flag ON + settings route + 2 candidates + 429, but abort fires before retry → user_stopped dispatched; no retryTurn; completeTurnCleanup called', async () => {
    // This test exercises the MUST-FIX-2 abort subpath in the multi-provider failover branch:
    // the gate passes (restartSafetyGate.ok=true), remaining > 0, but abortController is
    // already aborted BEFORE the handler fires the retry. The canonical abort pattern must run:
    //   dispatchAgentEvent(...user_stopped...) + completeTurnCleanup('aborted') → handled(activityEmitted:true).
    //
    // Red→green: removing the `ctx.abortController.signal.aborted` check from the implementation
    // would skip the user_stopped dispatch and instead call retryTurn (and not call completeTurnCleanup),
    // flipping this test red on the retryTurn assertion and missing completeTurnCleanup.
    const retryTurnMock = vi.fn(async () => {});
    const abortController = new AbortController();
    abortController.abort(); // already aborted BEFORE handler runs

    const ctx = makeMultiProviderContext({
      retryTurn: retryTurnMock,
      abortController,
    });

    const result = await handleRateLimitFallback(ctx);

    // Per-credential cooldown still recorded (happens before the abort check)
    expect(providerRecordRateLimitMock).toHaveBeenCalledWith('openrouter-oauth-token', undefined);
    // retryTurn must NOT be called (abort guard prevents it)
    expect(retryTurnMock).not.toHaveBeenCalled();
    // The turn ends observably: user_stopped synthetic result dispatched + cleanup called.
    // The mock for makeSyntheticResult returns { type: 'result', turnEndReason: 'user_stopped', ... }.
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'result', turnEndReason: 'user_stopped' }),
    );
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'aborted');
    // activityEmitted:true (user_stopped event was dispatched)
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
  });

  // -------------------------------------------------------------------------
  // (3) FLAG ON + resolvedFrom:'settings' + 2 candidates + first 429
  // -------------------------------------------------------------------------
  it('flag ON + settings route + 2 candidates + first 429 → records per-credential cooldown + calls retryTurn with correct overrides', async () => {
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeMultiProviderContext({ retryTurn: retryTurnMock });

    const result = await handleRateLimitFallback(ctx);

    // Transparent retry — no error event dispatched
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: false });
    // Per-credential cooldown recorded for the failed source
    expect(providerRecordRateLimitMock).toHaveBeenCalledWith('openrouter-oauth-token', undefined);
    // Global cooldown NOT recorded (we're retrying, not terminating)
    expect(recordRateLimitMock).not.toHaveBeenCalled();
    // Error event NOT dispatched (transparent hop)
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
    // retryTurn called with correct overrides
    expect(retryTurnMock).toHaveBeenCalledTimes(1);
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      routeRebuildHint: undefined,
      inFlightProviderRoutePlan: undefined,
      rateLimitAttemptedCredentialSources: expect.arrayContaining(['openrouter-oauth-token']),
    }));
    // Verify the array contains only the one failed source
    const lastCallArg = (retryTurnMock.mock.lastCall as unknown as [{ rateLimitAttemptedCredentialSources?: unknown[] }] | undefined)?.[0];
    expect(lastCallArg?.rateLimitAttemptedCredentialSources).toHaveLength(1);
    // Paid-fallback indicator contract: the write site records a PLACEHOLDER
    // `to: 'auto-failover'` (the real destination is only known on the retry's
    // fresh route resolution). The patch-back in agentTurnExecute keys on exactly
    // this `to` value, so locking it here guards the cross-file contract.
    expect(registryMocks.addTurnFallback).toHaveBeenCalledWith('test-turn-id', expect.objectContaining({
      type: 'provider',
      from: 'openrouter-oauth-token',
      to: 'auto-failover',
      reason: 'multi-provider-rate-limit-failover',
    }));
  });

  // -------------------------------------------------------------------------
  // (4) All usable candidates already in rateLimitAttemptedCredentialSources
  // -------------------------------------------------------------------------
  it('flag ON + all candidates already attempted → terminal: no retryTurn, records global cooldown, dispatches error with failoverReason', async () => {
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeMultiProviderContext({
      // Both candidates are already in the attempted set
      turnOptions: {
        rateLimitAttemptedCredentialSources: ['openrouter-oauth-token', 'anthropic-api-key'],
      },
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'anthropic',
          transport: 'anthropic-direct',
          credentialSource: 'anthropic-api-key',
          resolvedFrom: 'settings',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
    // Global cooldown IS recorded (we're terminating)
    expect(recordRateLimitMock).toHaveBeenCalled();
    // Error event dispatched with failoverReason
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.anything(),
      expect.objectContaining({
        rateLimitProvider: 'anthropic-api-key',
        failoverReason: 'all-providers-rate-limited',
      }),
    );
    // retryTurn NOT called
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'rate-limit');
  });

  // -------------------------------------------------------------------------
  // (5) Single usable candidate → terminal after first 429
  // -------------------------------------------------------------------------
  it('flag ON + single usable candidate → terminal after first 429 (no failover possible)', async () => {
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['openrouter-oauth-token']),  // only one candidate
    );
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeMultiProviderContext({ retryTurn: retryTurnMock });

    const result = await handleRateLimitFallback(ctx);

    // After recording the one candidate in attempted, remaining is empty → terminal
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(recordRateLimitMock).toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.anything(),
      expect.objectContaining({
        failoverReason: 'all-providers-rate-limited',
      }),
    );
  });

  // -------------------------------------------------------------------------
  // (6) restartSafetyGate blocked (partial output) → no retryTurn, failoverReason:'partial-output'
  // -------------------------------------------------------------------------
  it('restartSafetyGate blocked (partial output) → no retryTurn; error shown with failoverReason:partial-output', async () => {
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeMultiProviderContext({
      messageCount: 1,  // partial output → gate blocks
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.anything(),
      expect.objectContaining({
        failoverReason: 'partial-output',
      }),
    );
    expect(recordRateLimitMock).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (7) turnLogger.info traces are emitted on successful hop
  // -------------------------------------------------------------------------
  it('successful hop emits a structured info trace log', async () => {
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeMultiProviderContext({ retryTurn: retryTurnMock });

    await handleRateLimitFallback(ctx);

    expect(mockTurnLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'openrouter-oauth-token',
        attempted: expect.arrayContaining(['openrouter-oauth-token']),
        remaining: expect.any(Array),
      }),
      expect.stringContaining('Multi-provider rate-limit failover'),
    );
  });

  // -------------------------------------------------------------------------
  // (8) Loop-termination regression: head credential re-picked after cooldown expiry
  // -------------------------------------------------------------------------
  it('loop-termination: head credential already in priorAttempted → terminal immediately (hard-stop, no retry)', async () => {
    // Scenario: the head credential (openrouter-oauth-token) was already attempted in a prior hop.
    // Without MUST-FIX-1(b), the handler would retry (remaining.length > 0, gate ok).
    // With the fix, alreadyTriedThisCredential=true → terminal path immediately.
    // Logically: without the `!alreadyTriedThisCredential` guard, remaining=['anthropic-api-key'] and
    // failoverGate.ok=true → the handler would call retryTurn. With the guard, it terminates.
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeMultiProviderContext({
      // Prior hop already tried openrouter-oauth-token
      turnOptions: {
        rateLimitAttemptedCredentialSources: ['openrouter-oauth-token'],
      },
      // Current plan also resolves to openrouter-oauth-token (simulating cooldown expiry re-pick)
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'openrouter',
          transport: 'openrouter',
          credentialSource: 'openrouter-oauth-token',
          resolvedFrom: 'settings',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleRateLimitFallback(ctx);

    // Must terminate — not retry
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
    // Error event dispatched (terminal path)
    expect(dispatchAgentErrorEventMock).toHaveBeenCalled();
    // failoverReason reflects exhaustion (not partial-output — gate is ok)
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.anything(),
      expect.objectContaining({
        failoverReason: 'all-providers-rate-limited',
      }),
    );
    // Global cooldown recorded (terminal)
    expect(recordRateLimitMock).toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (9) Multi-hop accumulation: 3 providers, 3 hops → attempted grows correctly
  // -------------------------------------------------------------------------
  it('multi-hop N=3: attempted accumulates across hops {A}→{A,B}→{A,B,C}→terminal', async () => {
    // Set up 3 candidates
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['openrouter-oauth-token', 'anthropic-api-key', 'codex-subscription']),
    );

    // Hop 1: no prior attempted, openrouter-oauth-token fires 429
    const retryTurnMock1 = vi.fn(async () => {});
    const ctx1 = makeMultiProviderContext({ retryTurn: retryTurnMock1 });
    await handleRateLimitFallback(ctx1);
    expect(retryTurnMock1).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitAttemptedCredentialSources: expect.arrayContaining(['openrouter-oauth-token']),
      }),
    );
    const hop1Arg = (retryTurnMock1.mock.lastCall as unknown as [TurnRetryOverrides])[0];
    expect(hop1Arg.rateLimitAttemptedCredentialSources).toHaveLength(1);

    // Hop 2: anthropic-api-key fires 429, prior attempted = ['openrouter-oauth-token']
    const retryTurnMock2 = vi.fn(async () => {});
    const ctx2 = makeMultiProviderContext({
      turnOptions: { rateLimitAttemptedCredentialSources: hop1Arg.rateLimitAttemptedCredentialSources },
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'anthropic',
          transport: 'anthropic-direct',
          credentialSource: 'anthropic-api-key',
          resolvedFrom: 'settings',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock2,
    });
    await handleRateLimitFallback(ctx2);
    expect(retryTurnMock2).toHaveBeenCalledWith(
      expect.objectContaining({
        rateLimitAttemptedCredentialSources: expect.arrayContaining(['openrouter-oauth-token', 'anthropic-api-key']),
      }),
    );
    const hop2Arg = (retryTurnMock2.mock.lastCall as unknown as [TurnRetryOverrides])[0];
    expect(hop2Arg.rateLimitAttemptedCredentialSources).toHaveLength(2);

    // Hop 3: codex-subscription fires 429, prior = ['openrouter-oauth-token', 'anthropic-api-key']
    const retryTurnMock3 = vi.fn(async () => {});
    const ctx3 = makeMultiProviderContext({
      turnOptions: { rateLimitAttemptedCredentialSources: hop2Arg.rateLimitAttemptedCredentialSources },
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'codex',
          transport: 'codex',
          credentialSource: 'codex-subscription',
          resolvedFrom: 'settings',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock3,
    });
    await handleRateLimitFallback(ctx3);
    // All 3 attempted → terminal
    expect(retryTurnMock3).not.toHaveBeenCalled();
    expect(dispatchAgentErrorEventMock).toHaveBeenCalledWith(
      null, 'test-turn-id', expect.anything(),
      expect.objectContaining({ failoverReason: 'all-providers-rate-limited' }),
    );
  });

  // -------------------------------------------------------------------------
  // (F1 regression) Codex→Claude divert: 429 on Anthropic adds BOTH
  //   anthropic-api-key AND codex-subscription to the attempted set.
  // -------------------------------------------------------------------------
  it('F1 regression — Codex→Claude divert: Anthropic 429 adds BOTH anthropic-api-key AND codex-subscription to attempted set', async () => {
    // Scenario: Codex is the picked provider mode (Codex connected), model is native Claude.
    // The router diverts Codex→Anthropic: final decision has provider='anthropic',
    // credentialSource='anthropic-api-key', codexConnectivity='connected'.
    // After the 429, the F1 fix must add BOTH 'anthropic-api-key' AND 'codex-subscription'
    // to the attempted set so the router skips Codex on the next hop.
    //
    // Red→green: without the isCodexDivertedToAnthropic helper, only 'anthropic-api-key'
    // is added → rateLimitAttemptedCredentialSources has length 1, not 2.
    // Confirm by temporarily removing the helper call to observe the test fail.

    const retryTurnMock = vi.fn(async () => {});
    // Three usable candidates: codex-subscription, openrouter-oauth-token, anthropic-api-key
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['codex-subscription', 'openrouter-oauth-token', 'anthropic-api-key']),
    );

    const ctx = makeMultiProviderContext({
      retryTurn: retryTurnMock,
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          kind: 'dispatchable',
          provider: 'anthropic',
          transport: 'anthropic-direct',
          credentialSource: 'anthropic-api-key',
          resolvedFrom: 'settings',
          // codexConnectivity='connected' is the key signal: Codex was the picked provider
          // mode, diverted to Anthropic because the model is a native Claude.
          codexConnectivity: 'connected',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
          openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
          localModel: { profiles: [], activeProfileId: null },
          experimental: { multiProviderRoutingEnabled: true },
          enabledProviders: ['codex', 'openrouter', 'anthropic'],
        },
        model: 'claude-sonnet-4-5',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
    });

    const result = await handleRateLimitFallback(ctx);

    // Transparent retry should fire (3 candidates, only 1 attempted initially)
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: false });
    expect(retryTurnMock).toHaveBeenCalledTimes(1);

    // The discriminating F1 assertion: BOTH 'anthropic-api-key' AND 'codex-subscription'
    // must be in the rateLimitAttemptedCredentialSources passed to retryTurn.
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      rateLimitAttemptedCredentialSources: expect.arrayContaining([
        'anthropic-api-key',
        'codex-subscription',
      ]),
    }));
    const callArg = (retryTurnMock.mock.lastCall as unknown as [{ rateLimitAttemptedCredentialSources?: unknown[] }] | undefined)?.[0];
    // Must be exactly 2 (not 1 — that's the pre-fix behaviour)
    expect(callArg?.rateLimitAttemptedCredentialSources).toHaveLength(2);
  });
});

// ===========================================================================
// Stage 3 — handleProviderChainRecoveryFallback (provider-agnostic recovery "C")
// ===========================================================================

// The server/transient alt-model-owned kinds the new handler targets. `network`
// is excluded — it is bypassed by isNetworkFailure (routes to transient retry).
const SERVER_TRANSIENT_KINDS = [
  'server_error',
  'process_exit',
  'message_timeout',
  'user_action',
  'unknown',
] as const;

describe('dispatchErrorRecovery — Stage 3 flag-OFF parity pin (byte-for-byte invariant)', () => {
  // MANDATORY invariant pin: with the flag OFF (but enabledProviders non-empty, so
  // the only difference from "flagged-on" is the flag itself), every server/transient
  // alt-model-owned kind must route to the EXACT same owner/cleanup as today, and the
  // new handler must NOT enumerate failover candidates (proving the first-statement
  // flag gate returns passthrough before any state read).
  it.each(SERVER_TRANSIENT_KINDS)(
    'flag OFF + %s → legacy alt-model owner unchanged; failover candidates NOT enumerated',
    async (kind) => {
      getErrorKindMock.mockReturnValue(kind);
      isTransientErrorMock.mockReturnValue(kind !== 'server_error');
      // A candidate set that WOULD trip the chain if the gate leaked.
      getFailoverCredentialCandidatesMock.mockReturnValue(
        new Set(['openrouter-oauth-token', 'anthropic-api-key']),
      );

      const ctx = makeContext({
        error: new Error(`synthetic-${kind}`),
        isDirectRoleProfile: true,
        messageCount: 3, // exhaust fast-retry → legacy alt-model dispatches terminal
        settings: {
          coreDirectory: '/tmp/test',
          models: { apiKey: 'fake-ant-test-key', model: 'claude-sonnet-4-5' },
          localModel: { profiles: [], activeProfileId: null },
          // flag ABSENT (OFF) but providers configured — only the flag differs
          enabledProviders: ['openrouter', 'anthropic'],
        } as unknown as ErrorRecoveryContext['settings'],
      });

      await dispatchErrorRecovery(ctx);

      // Legacy alt-model handler owns it — cleanup + owner unchanged from today.
      expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'alt-model-error');
      const call = dispatchAgentErrorEventMock.mock.calls.at(-1);
      const opts = call?.[3] as { recoveryOwner?: RecoveryOwner } | undefined;
      expect(opts?.recoveryOwner).toBe(
        kind === 'server_error'
          ? 'alt_model_then_server_error_retry'
          : 'alt_model_then_transient_retry',
      );
      // The flag-OFF first-statement gate must prevent any candidate enumeration.
      expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
      // No server/transient telemetry or provider fallback recorded.
      expect(registryMocks.addTurnFallback).not.toHaveBeenCalledWith(
        'test-turn-id',
        expect.objectContaining({ reason: 'multi-provider-server-error-failover' }),
      );
    },
  );
});

describe('handleProviderChainRecoveryFallback', () => {
  // Helper: a context wired for the flag-ON provider-chain recovery branch.
  // flag=true + direct-role + resolvedFrom='settings' + two usable candidates.
  function makeChainRecoveryContext(overrides: Partial<ErrorRecoveryContext> = {}): ErrorRecoveryContext {
    const retryTurnMock = vi.fn(async () => {});
    return makeContext({
      error: new Error('server error'),
      isDirectRoleProfile: true,
      settings: {
        coreDirectory: '/tmp/test',
        models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
        openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
        localModel: { profiles: [], activeProfileId: null },
        experimental: { multiProviderRoutingEnabled: true },
        enabledProviders: ['openrouter', 'anthropic'],
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'openrouter',
          models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
          openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
          localModel: { profiles: [], activeProfileId: null },
          experimental: { multiProviderRoutingEnabled: true },
          enabledProviders: ['openrouter', 'anthropic'],
        },
        model: 'claude-sonnet-4-5',
        codexConnectivity: 'unknown',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'openrouter',
          transport: 'openrouter',
          credentialSource: 'openrouter-oauth-token',
          resolvedFrom: 'settings',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
      ...overrides,
    });
  }

  beforeEach(() => {
    getErrorKindMock.mockReturnValue('server_error');
    // Two distinct usable candidates (flag on + two providers).
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['openrouter-oauth-token', 'anthropic-api-key']),
    );
  });

  // (1) First failure preserves the same-model fast retry (no provider switch).
  it('retryCount 0 + server_error → one fast retry, no provider switch', async () => {
    registryMocks.getRetryCount.mockReturnValue(0);
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeChainRecoveryContext({ retryTurn: retryTurnMock, messageCount: 0 });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled', activityEmitted: false });
    // Fast retry — no overrides (same model, same provider).
    expect(retryTurnMock).toHaveBeenCalledTimes(1);
    expect(retryTurnMock).toHaveBeenCalledWith();
    // "Hit a snag" status dispatched.
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'status', message: 'Hit a snag. Retrying...' }),
    );
    // No provider fallback recorded yet.
    expect(registryMocks.addTurnFallback).not.toHaveBeenCalled();
    // NEVER record a rate-limit cooldown.
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
    expect(recordRateLimitMock).not.toHaveBeenCalled();
  });

  // (2) Second failure → provider-chain re-drive with the new field + type:'provider'.
  it('retryCount 1 + 2 candidates + server_error → chain re-drive with serverTransientAttemptedCredentialSources; NO recordRateLimit', async () => {
    registryMocks.getRetryCount.mockReturnValue(1); // fast retry already used
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeChainRecoveryContext({ retryTurn: retryTurnMock, messageCount: 0 });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled', activityEmitted: false });
    // Transparent provider switch — status + provider fallback recorded.
    expect(dispatchAgentEventMock).toHaveBeenCalledWith(
      null,
      'test-turn-id',
      expect.objectContaining({ type: 'status', message: 'Provider had trouble — switching providers...' }),
    );
    expect(registryMocks.addTurnFallback).toHaveBeenCalledWith('test-turn-id', expect.objectContaining({
      type: 'provider',
      from: 'openrouter-oauth-token',
      to: 'auto-failover',
      reason: 'multi-provider-server-error-failover',
    }));
    // retryTurn called with the NEW field (not rateLimitAttemptedCredentialSources).
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      routeRebuildHint: undefined,
      inFlightProviderRoutePlan: undefined,
      serverTransientAttemptedCredentialSources: expect.arrayContaining(['openrouter-oauth-token']),
    }));
    const lastArg = (retryTurnMock.mock.lastCall as unknown as [Record<string, unknown>] | undefined)?.[0];
    expect(lastArg?.rateLimitAttemptedCredentialSources).toBeUndefined();
    // CRITICAL: server/transient are NOT rate limits — no cooldown writes.
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
    expect(recordRateLimitMock).not.toHaveBeenCalled();
    // No error event on a transparent hop.
    expect(dispatchAgentErrorEventMock).not.toHaveBeenCalled();
  });

  // (3) Configured-role fallback wins — provider chain not consulted.
  it('configured working fallback returns handled → returned; provider chain not driven', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(1); // skip fast retry → reach configured-role path
    // Two usable candidates so the Q1 passthrough does NOT short-circuit before the
    // configured-role fallback runs.
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['openrouter-oauth-token', 'anthropic-api-key']),
    );
    const retryTurnMock = vi.fn(async () => {});
    const primaryProfile = {
      id: 'primary-profile',
      model: 'gpt-5.5',
      providerType: 'openai',
      serverUrl: 'https://primary.example.com/v1',
      name: 'OpenAI profile',
    } as unknown as ModelProfile;
    const ctx = makeChainRecoveryContext({
      error: new ModelError('server_error', 'profile overloaded', 503, 'OpenAI'),
      activeProfile: primaryProfile as unknown as ErrorRecoveryContext['activeProfile'],
      workingProfile: primaryProfile,
      requestedModelForTurn: 'gpt-5.5',
      messageCount: 0,
      settings: {
        activeProvider: 'openrouter',
        coreDirectory: '/tmp/test',
        models: { model: 'gpt-5.5', workingFallback: 'model:claude-haiku-4-5', apiKey: 'fake-ant-test-key' },
        localModel: { profiles: [primaryProfile], activeProfileId: 'primary-profile' },
        experimental: { multiProviderRoutingEnabled: true },
        enabledProviders: ['openrouter', 'anthropic'],
      } as unknown as ErrorRecoveryContext['settings'],
      routeInput: {
        settings: {
          activeProvider: 'openrouter',
          models: { model: 'gpt-5.5', workingFallback: 'model:claude-haiku-4-5', apiKey: 'fake-ant-test-key' },
          localModel: { profiles: [primaryProfile], activeProfileId: 'primary-profile' },
          experimental: { multiProviderRoutingEnabled: true },
          enabledProviders: ['openrouter', 'anthropic'],
        },
        model: 'gpt-5.5',
        profile: primaryProfile,
        codexConnectivity: 'unknown',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'openrouter',
          transport: 'openrouter',
          credentialSource: 'openrouter-oauth-token',
          resolvedFrom: 'settings',
          wireModelId: 'gpt-5.5',
          profileId: 'primary-profile',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      retryTurn: retryTurnMock,
    });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled' });
    // Configured-role fallback drove the retry (not the provider chain).
    expect(retryTurnMock).toHaveBeenCalledWith(expect.objectContaining({
      modelOverride: 'claude-haiku-4-5',
      configuredRoleFallbackAttempted: { working: true },
      routeRebuildHint: expect.objectContaining({ kind: 'configured-role-fallback', role: 'working' }),
    }));
    // The chain re-drive's provider fallback marker must NOT have fired.
    expect(registryMocks.addTurnFallback).not.toHaveBeenCalledWith(
      'test-turn-id',
      expect.objectContaining({ reason: 'multi-provider-server-error-failover' }),
    );
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
  });

  // (4) Exhaustion → non-429 terminal (NOT failoverReason:'all-providers-rate-limited').
  it('all candidates already attempted → terminal with non-429 exhaustion copy; NO recordRateLimit', async () => {
    registryMocks.getRetryCount.mockReturnValue(1);
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeChainRecoveryContext({
      retryTurn: retryTurnMock,
      messageCount: 0,
      turnOptions: {
        // Both candidates already attempted this turn.
        serverTransientAttemptedCredentialSources: ['openrouter-oauth-token', 'anthropic-api-key'],
      } as unknown as ErrorRecoveryContext['turnOptions'],
    });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
    expect(retryTurnMock).not.toHaveBeenCalled();
    // Terminal error dispatched with the new non-429 exhaustion copy.
    expect(dispatchAgentErrorEventMock).toHaveBeenCalled();
    const call = dispatchAgentErrorEventMock.mock.calls.at(-1);
    const opts = call?.[3] as { humanizedOverride?: string; failoverReason?: string; recoveryOwner?: RecoveryOwner } | undefined;
    expect(opts?.humanizedOverride).toContain('Every connected provider');
    // MUST NOT use 429-only vocab.
    expect(opts?.failoverReason).toBeUndefined();
    expect(opts?.recoveryOwner).toBe('alt_model_then_server_error_retry');
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'error');
    // No rate-limit cooldown writes (server/transient, not 429).
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
    expect(recordRateLimitMock).not.toHaveBeenCalled();
  });

  // (5) Partial-output gate → terminal, no re-drive (Q2: raw error, NO humanizedOverride).
  it('partial output (messageCount > 0) + retryCount 1 → recoverable terminal via raw error, no re-drive', async () => {
    registryMocks.getRetryCount.mockReturnValue(1); // fast retry already used
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeChainRecoveryContext({
      retryTurn: retryTurnMock,
      messageCount: 5, // partial output → restartSafetyGate blocks the re-drive
    });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
    // No transparent re-drive (gate blocked it).
    expect(retryTurnMock).not.toHaveBeenCalled();
    // Q2: recoverable-terminal sub-case dispatches the RAW error (no humanizedOverride).
    const call = dispatchAgentErrorEventMock.mock.calls.at(-1);
    const opts = call?.[3] as { humanizedOverride?: string; failoverReason?: string } | undefined;
    expect(opts?.humanizedOverride).toBeUndefined();
    expect(opts?.failoverReason).toBeUndefined();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'error');
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
  });

  // (6) resolvedFrom:'explicit-profile' → branch NOT entered.
  it("resolvedFrom:'explicit-profile' → passthrough (profile routes never auto-failover)", async () => {
    registryMocks.getRetryCount.mockReturnValue(1);
    const ctx = makeChainRecoveryContext({
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'openrouter',
          transport: 'openrouter',
          credentialSource: 'openrouter-oauth-token',
          resolvedFrom: 'explicit-profile', // NOT 'settings'
        },
      } as unknown as ErrorRecoveryContext['plan'],
    });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
  });

  // (7) Flag ON but NOT direct-role → branch NOT entered.
  it('flag ON but isDirectRoleProfile=false → passthrough', async () => {
    registryMocks.getRetryCount.mockReturnValue(1);
    const ctx = makeChainRecoveryContext({ isDirectRoleProfile: false });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
  });

  // (7b) Flag OFF → passthrough as the very first statement (no state read).
  it('flag OFF → passthrough before any candidate enumeration', async () => {
    const ctx = makeChainRecoveryContext({
      settings: {
        coreDirectory: '/tmp/test',
        models: { apiKey: 'fake-ant-test-key', model: 'claude-sonnet-4-5' },
        localModel: { profiles: [], activeProfileId: null },
        // experimental flag ABSENT (OFF)
        enabledProviders: ['openrouter', 'anthropic'],
      } as unknown as ErrorRecoveryContext['settings'],
    });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
  });

  // (8a) Abort during the fast-retry delay → aborted cleanup; no retryTurn.
  it('abort during fast-retry delay → completeTurnCleanup(aborted); no retryTurn', async () => {
    registryMocks.getRetryCount.mockReturnValue(0); // fast retry path
    delayWithAbortMock.mockResolvedValue(true); // delay reports aborted
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeChainRecoveryContext({ retryTurn: retryTurnMock, messageCount: 0 });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled', activityEmitted: false });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(completeTurnCleanupMock).toHaveBeenCalledWith('test-turn-id', 'aborted');
  });

  // (8b) Already-aborted at entry → passthrough (handler declines an aborted turn;
  // the dispatcher's terminal aborted-state gate runs cleanup).
  it('already aborted at entry → passthrough; no retryTurn, no candidate enumeration', async () => {
    registryMocks.getRetryCount.mockReturnValue(1);
    const retryTurnMock = vi.fn(async () => {});
    const abortController = new AbortController();
    abortController.abort();
    const ctx = makeChainRecoveryContext({ retryTurn: retryTurnMock, messageCount: 0, abortController });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
  });

  // (Q1) ≤1 usable candidate → passthrough (single-provider users keep legacy behaviour).
  it('1 usable candidate → passthrough (single-provider strict-superset invariant)', async () => {
    registryMocks.getRetryCount.mockReturnValue(1);
    getFailoverCredentialCandidatesMock.mockReturnValue(new Set(['openrouter-oauth-token']));
    const retryTurnMock = vi.fn(async () => {});
    const ctx = makeChainRecoveryContext({ retryTurn: retryTurnMock, messageCount: 0 });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(retryTurnMock).not.toHaveBeenCalled();
    expect(registryMocks.addTurnFallback).not.toHaveBeenCalled();
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
  });

  // (extra) Network error → branch NOT entered (bypassed by isNetworkFailure).
  it('network error → passthrough (bypassed, routes to transient retry)', async () => {
    registryMocks.getRetryCount.mockReturnValue(1);
    getErrorKindMock.mockReturnValue('network');
    isNetworkErrorMock.mockReturnValue(true);
    const ctx = makeChainRecoveryContext({});

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'passthrough' });
    expect(getFailoverCredentialCandidatesMock).not.toHaveBeenCalled();
  });

  // (FIX-1) Mixed episode: A 429'd earlier (in rateLimitAttempted), now B (the
  // current credential) server_errors. The hard-stop/exhaustion logic must READ the
  // UNION so it terminates instead of re-driving back into the already-429'd A — even
  // though only B is in the server/transient set. We still WRITE only the
  // server/transient field (A must NOT be copied into it).
  it('mixed episode (A 429 prior, B server_error now) → terminates, does NOT re-pick A; writes only B into server/transient field', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(1); // skip fast retry → chain logic
    const retryTurnMock = vi.fn(async () => {});
    // Exactly two usable candidates: A (already 429'd) and B (failing now).
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['openrouter-oauth-token', 'anthropic-api-key']),
    );
    const ctx = makeChainRecoveryContext({
      retryTurn: retryTurnMock,
      messageCount: 0,
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'anthropic',
          transport: 'anthropic-direct',
          credentialSource: 'anthropic-api-key', // B = the credential failing now
          resolvedFrom: 'settings',
        },
      } as unknown as ErrorRecoveryContext['plan'],
      turnOptions: {
        // A already 429'd this turn (rate-limit field). B fails now (server_error).
        rateLimitAttemptedCredentialSources: ['openrouter-oauth-token'],
        // server/transient field is empty so far.
      } as unknown as ErrorRecoveryContext['turnOptions'],
    });

    const result = await handleProviderChainRecoveryFallback(ctx);

    // UNION attempted = {anthropic-api-key (B, now), openrouter-oauth-token (A, 429)}
    // → remaining is empty → terminal. The bug (server/transient-set-only) would have
    // computed remaining = {openrouter-oauth-token} and re-driven into the 429'd A.
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: true });
    expect(retryTurnMock).not.toHaveBeenCalled();
    // No rate-limit cooldown writes from this handler.
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
    expect(recordRateLimitMock).not.toHaveBeenCalled();
    // Terminal exhaustion copy (genuine all-providers-exhausted).
    const call = dispatchAgentErrorEventMock.mock.calls.at(-1);
    const opts = call?.[3] as { humanizedOverride?: string; failoverReason?: string } | undefined;
    expect(opts?.humanizedOverride).toContain('Every connected provider');
    expect(opts?.failoverReason).toBeUndefined();
  });

  // (FIX-1 cont.) Mixed episode where the union still leaves a usable candidate →
  // re-drives, and the WRITTEN server/transient field contains ONLY the server/transient
  // credentials (the rate-limit credential must NOT be folded in).
  it('mixed episode with a remaining candidate → re-drives; server/transient write excludes the rate-limit credential', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(1);
    const retryTurnMock = vi.fn(async () => {});
    // Three candidates: A (429'd), B (failing now), C (still usable).
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['openrouter-oauth-token', 'anthropic-api-key', 'codex-subscription']),
    );
    const ctx = makeChainRecoveryContext({
      retryTurn: retryTurnMock,
      messageCount: 0,
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
          openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
          localModel: { profiles: [], activeProfileId: null },
          experimental: { multiProviderRoutingEnabled: true },
          enabledProviders: ['codex', 'openrouter', 'anthropic'],
        },
        model: 'claude-sonnet-4-5',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          provider: 'anthropic',
          transport: 'anthropic-direct',
          credentialSource: 'anthropic-api-key', // B fails now
          resolvedFrom: 'settings',
          codexConnectivity: 'disconnected', // NOT a codex divert (keep FIX-2 out of this case)
        },
      } as unknown as ErrorRecoveryContext['plan'],
      turnOptions: {
        rateLimitAttemptedCredentialSources: ['openrouter-oauth-token'], // A 429'd
      } as unknown as ErrorRecoveryContext['turnOptions'],
    });

    const result = await handleProviderChainRecoveryFallback(ctx);

    expect(result).toMatchObject({ kind: 'handled', activityEmitted: false });
    expect(retryTurnMock).toHaveBeenCalledTimes(1);
    const lastArg = (retryTurnMock.mock.lastCall as unknown as [Record<string, unknown>] | undefined)?.[0];
    const written = lastArg?.serverTransientAttemptedCredentialSources as string[] | undefined;
    // B is in the written server/transient set; A (the 429'd credential) is NOT.
    expect(written).toContain('anthropic-api-key');
    expect(written).not.toContain('openrouter-oauth-token');
    // The rate-limit field is NOT written by this handler (rides along via spread).
    expect(lastArg?.rateLimitAttemptedCredentialSources).toBeUndefined();
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
  });

  // (FIX-2) Codex-divert: a Codex+Anthropic native-Claude user hits server_error on the
  // diverted anthropic-api-key. The handler must mark codex-subscription attempted too,
  // so it does NOT do a doomed re-drive into Codex (which would re-divert to the same
  // just-failed anthropic-api-key). Mirror of the rate-limit analog.
  it('Codex-diverted native-Claude server_error → codex-subscription marked attempted (no doomed re-drive)', async () => {
    getErrorKindMock.mockReturnValue('server_error');
    registryMocks.getRetryCount.mockReturnValue(1);
    const retryTurnMock = vi.fn(async () => {});
    // Three usable candidates incl. codex-subscription.
    getFailoverCredentialCandidatesMock.mockReturnValue(
      new Set(['codex-subscription', 'openrouter-oauth-token', 'anthropic-api-key']),
    );
    const ctx = makeChainRecoveryContext({
      retryTurn: retryTurnMock,
      messageCount: 0,
      routeInput: {
        settings: {
          activeProvider: 'anthropic',
          models: { apiKey: 'fake-anthropic-key', model: 'claude-sonnet-4-5', authMethod: 'api-key' },
          openRouter: { enabled: true, oauthToken: 'or-token', selectedModel: 'anthropic/claude-sonnet-4.6' },
          localModel: { profiles: [], activeProfileId: null },
          experimental: { multiProviderRoutingEnabled: true },
          enabledProviders: ['codex', 'openrouter', 'anthropic'],
        },
        model: 'claude-sonnet-4-5',
        codexConnectivity: 'connected',
        routeScope: 'normal-turn',
        role: 'execution',
      } as unknown as ErrorRecoveryContext['routeInput'],
      plan: {
        ...makeContext().plan,
        decision: {
          ...makeContext().plan.decision,
          kind: 'dispatchable',
          provider: 'anthropic',
          transport: 'anthropic-direct',
          credentialSource: 'anthropic-api-key',
          resolvedFrom: 'settings',
          // codexConnectivity='connected' + Anthropic credential = the Codex→Anthropic divert signal.
          codexConnectivity: 'connected',
        },
      } as unknown as ErrorRecoveryContext['plan'],
    });

    const result = await handleProviderChainRecoveryFallback(ctx);

    // Re-drive fires (openrouter-oauth-token still usable), but BOTH anthropic-api-key
    // AND codex-subscription must be in the written server/transient attempted set.
    expect(result).toMatchObject({ kind: 'handled', activityEmitted: false });
    expect(retryTurnMock).toHaveBeenCalledTimes(1);
    const lastArg = (retryTurnMock.mock.lastCall as unknown as [Record<string, unknown>] | undefined)?.[0];
    const written = lastArg?.serverTransientAttemptedCredentialSources as string[] | undefined;
    expect(written).toEqual(expect.arrayContaining(['anthropic-api-key', 'codex-subscription']));
    expect(providerRecordRateLimitMock).not.toHaveBeenCalled();
  });
});
