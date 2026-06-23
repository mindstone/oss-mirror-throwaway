/**
 * executeAgentTurn — plan-mode integration regression for the REBEL-655 kill.
 *
 * Incident (REBEL-655 / 260603_plan_mode_synthetic_claude_planning_sentinel_creds):
 * a Codex-only user (activeProvider: 'codex', Codex connected, working profile is a
 * Codex subscription profile) with NO Anthropic key enters plan mode. Pre-fix a
 * synthetic `claude-opus` planning sentinel was substituted → native Claude
 * force-routed Anthropic-direct under the Codex provider (the proxy can't serve
 * Claude) → no Anthropic key → a misleading "credentials rejected" /
 * connection-not-configured toast.
 *
 * Post-fix (what we assert end-to-end through the REAL executor + REAL routing
 * engine): plan mode does NOT force an unservable Anthropic-direct route. Either it
 * collapses to single-model mode OR surfaces a coherent typed degrade — with NO
 * misleading auth/credentials error mislabeling the provider.
 *
 * What makes this test special (vs. the unit/router-level coverage):
 *   This harness leaves `providerRouting` / `clientFactory` /
 *   `createDirectPreflightClient` / `providerRoutePlan` REAL (they are absent from
 *   the `vi.mock` list below). So a turn here drives the real routing engine + real
 *   preflight composition for the incident scenario — the integration coverage the
 *   kill lacked (it was covered at the unit/router/eligibility level, not end-to-end
 *   through the executor). `@shared/utils/modelNormalization` is mocked, but the mock
 *   faithfully mirrors production (incl. the typed `resolvePlanModeTarget` /
 *   `planModeTargetFromThinkingModel` accessors).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings, ModelProfile } from '@shared/types';
import { setBroadcastService } from '@core/broadcastService';
import {
  createAgentEventDispatcherMock,
  createLocalModelProxyServerMock,
  createCouncilServiceMock,
  createAdHocAgentServiceMock,
  createClaudeMentionAgentServiceMock,
  createMcpServiceMock,
  createToolSafetyServiceMock,
  createMemoryWriteHookMock,
  createStagedReadHookMock,
  createFileConversationTrackingHookMock,
  createAutoContinueHookMock,
  createAutoContinueCacheMock,
  createPendingApprovalsStoreMock,
  createAgentMessageHandlerMock,
  createSystemUtilsMock,
  createAuthEnvUtilsMock,
  createModelNormalizationMock,
  createSettingsUtilsMock,
  createSemanticContextServiceMock,
  createConversationContextServiceMock,
  createConversationHistoryServiceMock,
  createBuildContinuationContextMock,
  createAgentTurnFormattersMock,
  createConversationIndexServiceMock,
  createToolIndexServiceMock,
  createTrackingMock,
  createErrorReporterMock,
  createIncrementalSessionStoreMock,
  createConstantsMock,
  createPromptCacheWarmupServiceMock,
  createMcpServerAliasMock,
  createFriendlyErrorsMock,
  createAgentErrorCatalogMock,
  createToolNameValidationMock,
  createDelayWithAbortMock,
  createApiRateLimitCooldownMock,
  createCostLedgerServiceMock,
  createPricingCalculatorMock,
  createAgentTurnUtilsMock,
} from './agentTurnExecutor.testHarness';
import type { AgentQueryConfig } from '../agentQueryRunner';
import type { MockFactories } from './agentTurnExecutor.testHarness';

const getSettingsMock = vi.hoisted(() => vi.fn());
const isCodexConnectedMock = vi.hoisted(() => vi.fn());
const getCodexAccessTokenMock = vi.hoisted(() => vi.fn(async () => 'codex-token'));
const getCodexAccountIdMock = vi.hoisted(() => vi.fn(() => 'org_123'));
const forceRefreshCodexAccessTokenMock = vi.hoisted(() => vi.fn(async () => 'codex-token-refreshed'));
const getCodexStatusMock = vi.hoisted(() => vi.fn(() => ({ connected: true })));
const sendToAllWindowsMock = vi.hoisted(() => vi.fn());

const factories = vi.hoisted((): MockFactories => {
  const mockTurnLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    flushSessionLogs: vi.fn(async () => {}),
    sessionLogPath: '/tmp/test-turn.log',
  };
  return {
    queryMock: vi.fn(),
    dispatchAgentEventMock: vi.fn(),
    dispatchAgentErrorEventMock: vi.fn(),
    mockTurnLogger,
    resolveModelConfigMock: vi.fn(),
    buildCouncilConfigMock: vi.fn(),
    resolveCouncilLeadModelMock: vi.fn(),
    detectModelReferencesMock: vi.fn(),
    buildAdHocAgentConfigMock: vi.fn(),
    detectClaudeModelReferencesMock: vi.fn(),
    buildClaudeSubagentConfigMock: vi.fn(),
    getThinkingProfileMock: vi.fn(),
    getWorkingProfileMock: vi.fn(),
    addRoutesMock: vi.fn(),
    getAndResetTurnStatsMock: vi.fn(),
    removeRoutesMock: vi.fn(),
    getUrlMock: vi.fn(),
    getAuthTokenMock: vi.fn(),
    getWorkingModelProfileMock: vi.fn(),
    resolveMcpServersMock: vi.fn(),
    resolveSystemPromptMock: vi.fn(),
    buildConnectedPackagesMock: vi.fn(),
    getAuthEnvVarsMock: vi.fn(),
    runAgentQueryMock: vi.fn(),
    superMcpGetStateMock: vi.fn(),
  };
});

const agentTurnRegistryModule = vi.hoisted(() => ({
  agentTurnRegistry: {
    setActiveTurnController: vi.fn(),
    setRendererSession: vi.fn(),
    getRendererSession: vi.fn(() => null),
    clearExtendedContextFailed: vi.fn(),
    hasExtendedContextFailed: vi.fn(() => false),
    setTurnPrivateMode: vi.fn(),
    setTurnCategory: vi.fn(),
    setTurnLogger: vi.fn(),
    getTurnLogger: vi.fn(() => factories.mockTurnLogger),
    deleteTurnLogger: vi.fn(),
    deleteContextAccumulator: vi.fn(),
    cleanupTurn: vi.fn(),
    setTurnPrompt: vi.fn(),
    getTurnPrompt: vi.fn(() => undefined),
    setTurnExtendedContext: vi.fn(),
    setTurnThinkingEffort: vi.fn(),
    setTurnAuthMethod: vi.fn(),
    setTurnPlanningModel: vi.fn(),
    setTurnFastModel: vi.fn(),
    getActiveTurnCount: vi.fn(() => 1),
    setTurnSpawnDelayed: vi.fn(),
    getTurnSpawnDelayed: vi.fn(() => false),
    getTurnModel: vi.fn(() => null),
    getTurnActiveProvider: vi.fn(() => undefined),
    setTurnActiveProvider: vi.fn(),
    setTurnModel: vi.fn(),
    addTurnFallback: vi.fn(),
    cleanupForRetry: vi.fn(),
    hasContextOverflowDispatched: vi.fn(() => false),
    markContextOverflowDispatched: vi.fn(),
    markExtendedContextFailed: vi.fn(),
    hasActionableErrorDispatched: vi.fn(() => false),
    getRetryCount: vi.fn(() => 0),
    incrementRetryCount: vi.fn(() => 1),
    deleteRetryCount: vi.fn(),
    getContextAccumulator: vi.fn(() => ''),
    getTurnExtendedContext: vi.fn(() => false),
    getTurnContextWindow: vi.fn(() => null),
    setTurnContextWindow: vi.fn(),
    getActiveTurnController: vi.fn(() => null),
    setTurnCloseCallback: vi.fn(),
    getTurnCloseCallback: vi.fn(() => undefined),
    deleteTurnCloseCallback: vi.fn(),
    hasSuccessResultDispatched: vi.fn(() => false),
    hasCostRecorded: vi.fn(() => false),
    markCostRecorded: vi.fn(),
    hasOutputCapRetryAttempted: vi.fn(() => false),
    markOutputCapRetryAttempted: vi.fn(),
    clearOutputCapRetryAttempts: vi.fn(),
    recordSessionTurn: vi.fn(),
    hasSessionHadTurns: vi.fn(() => false),
    hasUserQuestionPending: vi.fn(() => false),
    hasCodexProfileDriftWarningEmitted: vi.fn(() => false),
    markCodexProfileDriftWarningEmitted: vi.fn(),
  },
  cleanupTurnAggregator: vi.fn(),
  cleanupPendingApprovals: vi.fn(),
}));

vi.mock('../agentQueryRunner', () => ({ runAgentQuery: factories.runAgentQueryMock }));
vi.mock('@core/rebelCore/queryRouter', () => ({ queryWithRuntime: vi.fn() }));
vi.mock('../agentEventDispatcher', () => createAgentEventDispatcherMock(factories));
vi.mock('@core/services/settingsStore', () => ({
  setSettingsStoreAdapter: vi.fn(),
  getSettings: getSettingsMock,
}));
vi.mock('../agentTurnRegistry', () => agentTurnRegistryModule);
vi.mock('../localModelProxyServer', () => createLocalModelProxyServerMock(factories));
vi.mock('../superMcpHttpManager', () => ({ superMcpHttpManager: { getState: factories.superMcpGetStateMock } }));
vi.mock('../councilService', () => createCouncilServiceMock(factories));
vi.mock('../adHocAgentService', () => createAdHocAgentServiceMock(factories));
vi.mock('../claudeMentionAgentService', () => createClaudeMentionAgentServiceMock(factories));
vi.mock('../mcpService', () => createMcpServiceMock(factories));
vi.mock('../toolSafetyService', () => createToolSafetyServiceMock());
vi.mock('../safety/memoryWriteHook', () => createMemoryWriteHookMock());
vi.mock('../safety/stagedReadHook', () => createStagedReadHookMock());
vi.mock('../fileConversationTrackingHook', () => createFileConversationTrackingHookMock());
vi.mock('../autoContinueHook', () => createAutoContinueHookMock());
vi.mock('../autoContinueCache', () => createAutoContinueCacheMock());
vi.mock('../safety/pendingApprovalsStore', () => createPendingApprovalsStoreMock());
vi.mock('../agentMessageHandler', () => createAgentMessageHandlerMock());
vi.mock('../../utils/systemUtils', () => createSystemUtilsMock());
vi.mock('../utils/authEnvUtils', () => createAuthEnvUtilsMock(factories));
vi.mock('@shared/utils/modelNormalization', () => createModelNormalizationMock(factories));
vi.mock('@core/rebelCore/modelLimits', () => ({
  shouldSuppressProfileReasoning: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => profile?.thinkingCompatibility === 'incompatible',
  resolveProfileReasoningEffort: (profile?: { thinkingCompatibility?: string; reasoningEffort?: string }) => (profile?.thinkingCompatibility === 'incompatible' ? undefined : profile?.reasoningEffort),
  resolveModelLimits: vi.fn(() => ({ contextWindow: 200_000, maxOutputTokens: 8192 })),
}));

vi.mock('@shared/utils/settingsUtils', () => createSettingsUtilsMock(factories));
vi.mock('@shared/types', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('@shared/types');
  return { ...actual, getWorkingModelProfile: factories.getWorkingModelProfileMock };
});
vi.mock('../semanticContextService', () => createSemanticContextServiceMock());
vi.mock('../conversationContextService', () => createConversationContextServiceMock());
vi.mock('../conversationHistoryService', () => createConversationHistoryServiceMock());
vi.mock('@core/services/buildContinuationContext', () => createBuildContinuationContextMock());
vi.mock('../../utils/agentTurnFormatters', () => createAgentTurnFormattersMock());
vi.mock('../conversationIndexService', () => createConversationIndexServiceMock());
vi.mock('../toolIndexService', () => createToolIndexServiceMock());
vi.mock('../../tracking', () => createTrackingMock());
vi.mock('@core/errorReporter', () => createErrorReporterMock());
vi.mock('../incrementalSessionStore', () => createIncrementalSessionStoreMock());
vi.mock('../../constants', () => createConstantsMock());
vi.mock('../promptCacheWarmupService', () => createPromptCacheWarmupServiceMock());
vi.mock('../mcpServerAlias', () => createMcpServerAliasMock());
vi.mock('@shared/utils/friendlyErrors', () => createFriendlyErrorsMock());
vi.mock('@shared/utils/agentErrorCatalog', async (importOriginal) => createAgentErrorCatalogMock(importOriginal));
vi.mock('@shared/utils/toolNameValidation', () => createToolNameValidationMock());
vi.mock('@core/utils/delayWithAbort', () => createDelayWithAbortMock());
vi.mock('@core/services/apiRateLimitCooldown', () => createApiRateLimitCooldownMock());
vi.mock('../costLedgerService', () => createCostLedgerServiceMock());
vi.mock('@shared/utils/pricingCalculator', () => createPricingCalculatorMock());
vi.mock('../../utils/agentTurnUtils', async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import('../../utils/agentTurnUtils');
  return createAgentTurnUtilsMock(actual);
});
vi.mock('@core/codexAuth', () => ({
  getCodexAuthProvider: vi.fn(() => ({
    isConnected: isCodexConnectedMock,
    getAccessToken: getCodexAccessTokenMock,
    getAccountId: getCodexAccountIdMock,
    forceRefreshToken: forceRefreshCodexAccessTokenMock,
    getStatus: getCodexStatusMock,
  })),
  CODEX_ENDPOINT_URL: 'https://chatgpt.com/backend-api/codex',
}));

// NOTE (the whole point of this file): providerRouting / clientFactory /
// createDirectPreflightClient / providerRoutePlan are intentionally NOT mocked —
// the real routing engine + real preflight composition run end-to-end.

import { executeAgentTurn } from '../agentTurnExecutor';

const runAgentQueryMock = factories.runAgentQueryMock!;
const superMcpGetStateMock = factories.superMcpGetStateMock!;

const CODEX_WORKING_MODEL = 'gpt-5.5';

/**
 * Codex subscription working profile (execution role). Same shape the
 * codexSubscription harness uses — a route the proxy CAN serve.
 */
function makeCodexProfile(): ModelProfile {
  return {
    id: 'codex-gpt-5.5',
    name: 'GPT-5.5 (ChatGPT Pro)',
    authSource: 'codex-subscription',
    model: CODEX_WORKING_MODEL,
    providerType: 'openai',
    serverUrl: 'https://api.openai.com/v1',
    routeSurface: 'subscription',
    createdAt: 0,
  } as unknown as ModelProfile;
}

/**
 * Codex-only user, NO Anthropic key, plan mode ON. Two distinct shapes:
 *   - Tests 1/2 (bare-SETTING shape): `thinkingProfileId` left null, `thinkingModel`
 *     a bare model string (e.g. a native `claude-*`). Plan mode is driven purely by
 *     the `claude.thinkingModel` SETTING, with no Thinking *profile* configured.
 *   - New case (same-PROFILE incident shape): `thinkingProfileId === workingProfileId`
 *     (both the Codex profile) — a Thinking profile is present and equal to the
 *     working profile. This is the literal REBEL-655 snapshot; the caller also wires
 *     `getThinkingProfileMock` to return that same profile.
 * `workingModel` controls whether plan mode would engage at all (the typed
 * resolvePlanModeTarget collapses to null when thinking == working).
 */
function createCodexPlanModeSettings(opts: {
  thinkingModel: string | undefined;
  workingModel?: string;
  thinkingProfileId?: string | null;
}): AppSettings {
  const profile = makeCodexProfile();
  const workingModel = opts.workingModel ?? CODEX_WORKING_MODEL;
  return {
    coreDirectory: process.cwd(),
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'codex',
    models: {
      // Working model the Codex proxy CAN serve.
      model: workingModel,
      workingProfileId: profile.id,
      // Tests 1/2 seed a bare thinking model string (e.g. a native Claude model);
      // the same-profile case seeds the Codex working model so it collapses.
      thinkingModel: opts.thinkingModel,
      thinkingProfileId: opts.thinkingProfileId ?? null,
      oauthToken: null,
      authMethod: 'api-key',
      permissionMode: 'plan',
      executablePath: null,
      // Plan mode enabled.
      planMode: true,
      extendedContext: false,
      thinkingEffort: 'medium',
      // CRITICAL: no Anthropic credentials.
      apiKey: null,
      longContextFallbackModel: undefined,
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: 'Alt+Space',
      activationHotkeyVoiceMode: true,
    },
    providerKeys: {},
    localModel: { profiles: [profile], activeProfileId: profile.id },
  } as unknown as AppSettings;
}

/**
 * Anthropic user with a DISTINCT Claude thinking model (servable). Control case:
 * plan mode genuinely engages here, proving the kill assertions discriminate.
 */
function createAnthropicPlanModeSettings(): AppSettings {
  return {
    coreDirectory: process.cwd(),
    mcpConfigFile: null,
    onboardingCompleted: true,
    userEmail: null,
    onboardingFirstCompletedAt: null,
    activeProvider: 'anthropic',
    models: {
      model: 'claude-sonnet-4-5',
      workingProfileId: null,
      thinkingModel: 'claude-opus-4-7',
      thinkingProfileId: null,
      oauthToken: null,
      authMethod: 'api-key',
      permissionMode: 'plan',
      executablePath: null,
      planMode: true,
      extendedContext: false,
      thinkingEffort: 'medium',
      // HAS an Anthropic key — the Claude planning route is servable.
      apiKey: 'fake-ant-test',
      longContextFallbackModel: undefined,
    },
    diagnostics: { debugBreadcrumbsUntil: null },
    voice: {
      provider: 'openai-whisper',
      openaiApiKey: null,
      elevenlabsApiKey: null,
      model: 'whisper-1',
      ttsVoice: null,
      activationHotkey: 'Alt+Space',
      activationHotkeyVoiceMode: true,
    },
    providerKeys: {},
    localModel: { profiles: [], activeProfileId: null },
  } as unknown as AppSettings;
}

/** Substrings of the misleading auth/credentials toast the bug produced. */
const MISLEADING_AUTH_PATTERNS = [
  /credentials? need attention/i,
  /rejected the credentials/i,
  /Anthropic needs an API key/i,
  /connection.{0,3}not.{0,3}configured/i,
];

function dispatchedTextChunks(): string[] {
  const chunks: string[] = [];
  const collect = (calls: unknown[][]) => {
    for (const call of calls) {
      for (const arg of call) {
        if (typeof arg === 'string') {
          chunks.push(arg);
        } else if (arg && typeof arg === 'object') {
          const obj = arg as Record<string, unknown>;
          for (const key of ['message', 'humanizedOverride', 'humanized', '__rawMessage']) {
            const v = obj[key];
            if (typeof v === 'string') chunks.push(v);
          }
        }
      }
    }
  };
  collect(factories.dispatchAgentErrorEventMock.mock.calls);
  collect(factories.dispatchAgentEventMock.mock.calls);
  return chunks;
}

function expectNoMisleadingAuthError() {
  const chunks = dispatchedTextChunks();
  for (const pattern of MISLEADING_AUTH_PATTERNS) {
    const offending = chunks.find((c) => pattern.test(c));
    expect(
      offending,
      `Expected NO misleading auth/credentials toast, but dispatched: ${JSON.stringify(offending)}`,
    ).toBeUndefined();
  }
}

/**
 * F2: stronger than the string-scan above for the degrade/collapse paths — assert no
 * error event was dispatched at all. On both the SETTING degrade and the same-profile
 * collapse the turn must reach the query cleanly; any dispatched error means plan mode
 * failed closed (the regression signature) rather than degrading/collapsing.
 */
function expectNoErrorEventDispatched() {
  expect(
    factories.dispatchAgentErrorEventMock,
    `Expected NO error event on the plan-mode degrade/collapse path, but dispatchAgentErrorEvent was called ${factories.dispatchAgentErrorEventMock.mock.calls.length} time(s): ${JSON.stringify(factories.dispatchAgentErrorEventMock.mock.calls)}`,
  ).not.toHaveBeenCalled();
}

describe('executeAgentTurn — REBEL-655 plan-mode kill (real routing engine)', () => {
  // The real clientFactory.getAuthForDirectUse reads process.env.ANTHROPIC_API_KEY
  // (and the SDK honours CLAUDE_CODE_OAUTH_TOKEN). Because this test deliberately
  // exercises the no-Anthropic-credentials path through the REAL routing engine,
  // scrub these env vars so the test is deterministic in any environment (a dev/CI
  // shell with a real key set would otherwise make the Claude planning route
  // servable and silently change the kill behaviour under test).
  const savedAnthropicEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const) {
      savedAnthropicEnv[key] = process.env[key];
      delete process.env[key];
    }

    vi.clearAllMocks();

    setBroadcastService({
      sendToAllWindows: sendToAllWindowsMock,
      sendToFocusedWindow: vi.fn(),
    });

    const codexProfile = makeCodexProfile();
    // Default: the incident scenario (Codex-only, claude-* thinkingModel, no key).
    getSettingsMock.mockReturnValue(
      createCodexPlanModeSettings({ thinkingModel: 'claude-opus-4-7' }),
    );
    // Codex connected at turn start (admission reads isConnected() once).
    isCodexConnectedMock.mockReturnValue(true);

    // Faithfully mirror production resolveModelConfig (modelNormalization.ts:295):
    // a non-null PlanModeTarget yields the 'planner' alias + PLANNING_MODEL /
    // EXECUTION_MODEL env overrides; a null target yields single-model mode. This is
    // the seam that, pre-fix, leaked PLANNING_MODEL=claude-opus when a synthetic
    // sentinel was substituted as the target.
    factories.resolveModelConfigMock.mockImplementation(
      (workingModel: string, planMode: { thinkingModel: string } | null) => {
        if (planMode) {
          return {
            model: 'planner',
            envOverrides: {
              PLANNING_MODEL: planMode.thinkingModel,
              EXECUTION_MODEL: workingModel,
            },
          };
        }
        return { model: workingModel };
      },
    );
    factories.resolveSystemPromptMock.mockResolvedValue('You are Rebel.');
    factories.resolveMcpServersMock.mockResolvedValue({
      servers: undefined,
      mode: 'unavailable',
      upstreamCount: 0,
      configPath: undefined,
    });
    factories.buildConnectedPackagesMock.mockResolvedValue([]);
    factories.getAuthEnvVarsMock.mockReturnValue({});
    factories.buildCouncilConfigMock.mockReturnValue(null);
    factories.resolveCouncilLeadModelMock.mockReturnValue('claude-sonnet-4-5');
    factories.detectModelReferencesMock.mockReturnValue([]);
    factories.buildAdHocAgentConfigMock.mockReturnValue(null);
    factories.detectClaudeModelReferencesMock.mockReturnValue([]);
    factories.buildClaudeSubagentConfigMock.mockReturnValue(null);
    // Default (used by Tests 1/2): NO Thinking *profile* — plan mode is driven purely
    // by the bare claude.thinkingModel SETTING. Working profile is the Codex
    // subscription profile (execution role). The same-PROFILE incident case below
    // overrides getThinkingProfileMock to return that same Codex profile.
    factories.getThinkingProfileMock.mockReturnValue(null);
    factories.getWorkingProfileMock.mockReturnValue(codexProfile);
    factories.getWorkingModelProfileMock.mockReturnValue(codexProfile);
    factories.addRoutesMock.mockResolvedValue(undefined);
    factories.getAndResetTurnStatsMock.mockReturnValue(new Map());
    factories.removeRoutesMock.mockReturnValue(undefined);
    factories.getUrlMock.mockReturnValue('http://proxy.local');
    factories.getAuthTokenMock.mockReturnValue('proxy-auth-token');
    superMcpGetStateMock.mockReturnValue({ isRunning: false, url: '' });
    runAgentQueryMock.mockResolvedValue({
      abortedByUser: false,
      terminatedByHandler: false,
    });
  });

  afterEach(() => {
    for (const key of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'] as const) {
      if (savedAnthropicEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedAnthropicEnv[key];
      }
    }
  });

  function captureAgentQueryConfig(): AgentQueryConfig {
    expect(runAgentQueryMock).toHaveBeenCalled();
    return runAgentQueryMock.mock.calls[0][0] as AgentQueryConfig;
  }

  // ---------------------------------------------------------------------------
  // Test 1 — bare-SETTING degrade path: Codex-only + a DISTINCT `claude-*`
  // thinkingModel SETTING (no Thinking profile) + no Anthropic key.
  //
  // The thinking model (claude-opus-4-7) differs from the Codex working model
  // (gpt-5.5), so the typed plan-mode target is non-null and plan mode engages. The
  // bare-Claude planning preflight then runs the REAL routing engine, finds no
  // Anthropic credentials, and DEGRADES plan mode (status event) rather than
  // force-routing Anthropic-direct. We assert it NEVER produces the misleading
  // credentials toast and NEVER hands a Claude Anthropic-direct route to the query.
  // NOTE: this is the SETTING-driven degrade, NOT the literal same-profile incident
  // (that is the dedicated case further below).
  // ---------------------------------------------------------------------------
  it('Codex-only + claude-* thinkingModel + no Anthropic key → degrades plan mode, no misleading auth toast, no Anthropic-direct Claude route', async () => {
    await executeAgentTurn(null, 'turn-planmode-codex-nokey', 'Plan this', {
      sessionId: 'renderer-session-planmode-codex',
      resetConversation: false,
    });

    // (1) The turn drove the real routing engine to completion (reached the query)
    // rather than failing closed with a misleading credentials error.
    const config = captureAgentQueryConfig();

    // (2) NO misleading auth / credentials / connection-not-configured toast, and
    // more strongly: no error event dispatched at all (it degraded, didn't fail).
    expectNoMisleadingAuthError();
    expectNoErrorEventDispatched();

    // (3) Plan mode did NOT force an unservable Anthropic-direct Claude route.
    // The model handed to the query must be the servable Codex working model — never
    // a silent Claude Anthropic-direct route under the Codex provider. The degrade
    // rebuilds modelConfig WITHOUT plan mode → effective model is the Codex working
    // model, NOT 'planner', and NEVER a claude-* model.
    const queriedModel = config.queryOptions.model;
    expect(queriedModel).toBeDefined();
    expect(queriedModel).not.toMatch(/^claude-/);
    expect(queriedModel).toBe(CODEX_WORKING_MODEL);
    // No PLANNING_MODEL env override leaked (plan mode was dropped, not silently
    // routed) and crucially no Claude planning model was injected.
    const env = config.queryOptions.env as Record<string, unknown> | undefined;
    expect(env?.PLANNING_MODEL).toBeUndefined();

    // (4) A coherent degrade status event fired (single-model fallback), NOT an error.
    const statusMessages = factories.dispatchAgentEventMock.mock.calls
      .map((call) => call.find((a) => a && typeof a === 'object' && 'message' in (a as object)) as { message?: string } | undefined)
      .map((evt) => evt?.message)
      .filter((m): m is string => typeof m === 'string');
    const degradeStatus = statusMessages.find((m) => /single model for this turn/i.test(m));
    expect(
      degradeStatus,
      `Expected a plan-mode degrade status event; status messages were: ${JSON.stringify(statusMessages)}`,
    ).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Test 2 — bare-SETTING collapse path: thinkingModel SETTING == workingModel (both
  // gpt-5.5), still NO Thinking profile. The typed resolvePlanModeTarget collapses to
  // null → plan mode never engages → single model. No degrade event needed (it was
  // never on); still no auth toast and the query runs the Codex working model.
  // (The same-PROFILE incident shape — thinking profile present & equal to working —
  // is the dedicated case below; this one exercises the SETTING collapse.)
  // ---------------------------------------------------------------------------
  it('Codex-only + thinkingModel == workingModel → plan mode collapses to single-model, no Anthropic-direct route, no auth toast', async () => {
    getSettingsMock.mockReturnValue(
      createCodexPlanModeSettings({
        thinkingModel: CODEX_WORKING_MODEL,
        workingModel: CODEX_WORKING_MODEL,
      }),
    );

    await executeAgentTurn(null, 'turn-planmode-codex-collapse', 'Plan this', {
      sessionId: 'renderer-session-planmode-collapse',
      resetConversation: false,
    });

    const config = captureAgentQueryConfig();
    expectNoMisleadingAuthError();
    expectNoErrorEventDispatched();

    // Single-model mode: no PLANNING_MODEL env override leaked, model is the Codex
    // working model (never a Claude sentinel).
    expect(config.queryOptions.model).toBe(CODEX_WORKING_MODEL);
    const env = config.queryOptions.env as Record<string, unknown> | undefined;
    expect(env?.PLANNING_MODEL).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // The LITERAL REBEL-655 incident shape — same Thinking and Working PROFILE.
  //
  // This is the exact snapshot that triggered the original sentinel substitution:
  // a Codex-only user whose Thinking profile *and* Working profile are the SAME
  // Codex subscription profile (codex-gpt-5.5, model gpt-5.5), no Anthropic key.
  // The OLD bug substituted PREFERRED_PLANNING_MODEL (claude-opus-*) into the
  // planning target *because a thinking profile existed at all* — regardless of
  // whether it equalled the working profile — and force-routed Anthropic-direct
  // under the Codex provider, producing the misleading credentials toast.
  //
  // Post-fix the typed resolvePlanModeTarget is fed the profile's REAL model
  // (thinkingProfileModel = 'gpt-5.5') which equals the working model → collapses
  // to null → single-model mode. So: query runs gpt-5.5 (NEVER claude-*/planner),
  // no PLANNING_MODEL leak, no misleading toast, and — because it collapses BEFORE
  // the bare-Claude preflight — no degrade status fires (plan mode was never on).
  //
  // NON-VACUOUS for the profile branch (see report): if the sentinel substitution
  // regressed, the thinking model fed to resolvePlanModeTarget would become
  // claude-opus-* ≠ gpt-5.5 → target non-null → plan mode engages → planner alias +
  // PLANNING_MODEL=claude-opus-* (the Anthropic-direct route), flipping EVERY
  // assertion below red. Tests 1/2 cannot catch this: they set getThinkingProfile→
  // null, so a regression scoped to the thinkingProfile branch would slip past them.
  // ---------------------------------------------------------------------------
  it('LITERAL incident: thinking PROFILE == working PROFILE (both codex-gpt-5.5) + no key → collapses to single-model, no Anthropic-direct route, no auth toast', async () => {
    const codexProfile = makeCodexProfile();
    // Thinking profile present AND equal to the working profile — the exact incident
    // shape (workingProfileId === thinkingProfileId === codex-gpt-5.5).
    getSettingsMock.mockReturnValue(
      createCodexPlanModeSettings({
        // thinkingModel SETTING is irrelevant here — the profile branch drives it.
        thinkingModel: undefined,
        workingModel: CODEX_WORKING_MODEL,
        thinkingProfileId: codexProfile.id,
      }),
    );
    // The literal incident: getThinkingProfile resolves to the SAME Codex profile as
    // the working profile (NOT null, unlike Tests 1/2).
    factories.getThinkingProfileMock.mockReturnValue(codexProfile);
    factories.getWorkingProfileMock.mockReturnValue(codexProfile);
    factories.getWorkingModelProfileMock.mockReturnValue(codexProfile);

    await executeAgentTurn(null, 'turn-planmode-codex-sameprofile', 'Plan this', {
      sessionId: 'renderer-session-planmode-sameprofile',
      resetConversation: false,
    });

    const config = captureAgentQueryConfig();
    // No misleading toast, and no error event at all — it collapsed cleanly.
    expectNoMisleadingAuthError();
    expectNoErrorEventDispatched();

    // The typed target collapsed (thinking profile model == working model) → single
    // model. The query runs the servable Codex working model — NEVER a Claude
    // sentinel and NEVER the planner alias.
    const queriedModel = config.queryOptions.model;
    expect(queriedModel).toBe(CODEX_WORKING_MODEL);
    expect(queriedModel).not.toMatch(/^claude-/);
    expect(queriedModel).not.toBe('planner');
    // No PLANNING_MODEL env leak (the sentinel-substitution signature).
    const env = config.queryOptions.env as Record<string, unknown> | undefined;
    expect(env?.PLANNING_MODEL).toBeUndefined();

    // Collapse happens before the bare-Claude preflight, so NO degrade status fires
    // (plan mode was never engaged). Asserting its absence keeps the case honest about
    // which path it exercises (collapse, not degrade).
    const statusMessages = factories.dispatchAgentEventMock.mock.calls
      .map((call) => call.find((a) => a && typeof a === 'object' && 'message' in (a as object)) as { message?: string } | undefined)
      .map((evt) => evt?.message)
      .filter((m): m is string => typeof m === 'string');
    expect(statusMessages.find((m) => /single model for this turn/i.test(m))).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // CONTROL / CONTRAST: Anthropic user with a DISTINCT servable Claude thinking
  // model still engages plan mode. Proves the kill assertions are discriminating —
  // the test is NOT just "plan mode never engages / no claude model ever".
  // ---------------------------------------------------------------------------
  it('CONTROL: Anthropic user with distinct servable Claude thinking model still engages plan mode', async () => {
    getSettingsMock.mockReturnValue(createAnthropicPlanModeSettings());
    isCodexConnectedMock.mockReturnValue(false);
    factories.getWorkingProfileMock.mockReturnValue(null);
    factories.getWorkingModelProfileMock.mockReturnValue(null);

    await executeAgentTurn(null, 'turn-planmode-anthropic-control', 'Plan this', {
      sessionId: 'renderer-session-planmode-control',
      resetConversation: false,
    });

    const config = captureAgentQueryConfig();
    // Plan mode genuinely engaged: planner alias + PLANNING_MODEL names the Claude
    // thinking model (servable here — the user HAS an Anthropic key).
    expect(config.queryOptions.model).toBe('planner');
    const env = config.queryOptions.env as Record<string, unknown> | undefined;
    expect(env?.PLANNING_MODEL).toBe('claude-opus-4-7');
    // And it did so WITHOUT the degrade status (plan mode was not dropped).
    const statusMessages = factories.dispatchAgentEventMock.mock.calls
      .map((call) => call.find((a) => a && typeof a === 'object' && 'message' in (a as object)) as { message?: string } | undefined)
      .map((evt) => evt?.message)
      .filter((m): m is string => typeof m === 'string');
    expect(statusMessages.find((m) => /single model for this turn/i.test(m))).toBeUndefined();
  });
});
