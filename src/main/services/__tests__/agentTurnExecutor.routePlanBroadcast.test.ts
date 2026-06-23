import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRoutePlanResolvedEvent } from '@shared/agentEvents';
import { AGENT_ROUTE_PLAN_RESOLVED_CHANNEL } from '@shared/ipc/broadcasts';
import { setBroadcastService } from '@core/broadcastService';
import {
  createAgentEventDispatcherMock,
  createLoggerMock,
  createSettingsStoreMock,
  createAgentTurnRegistryMock,
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
import type { MockFactories } from './agentTurnExecutor.testHarness';

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

vi.mock('../agentQueryRunner', () => ({ runAgentQuery: factories.runAgentQueryMock }));
vi.mock('@core/rebelCore/queryRouter', () => ({ queryWithRuntime: vi.fn() }));
vi.mock('@core/logger', () => createLoggerMock(factories));
vi.mock('../agentEventDispatcher', () => createAgentEventDispatcherMock(factories));
vi.mock('@core/services/settingsStore', () => createSettingsStoreMock());
vi.mock('../agentTurnRegistry', () => createAgentTurnRegistryMock(factories));
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

const {
  runAgentQueryMock: runAgentQueryMockMaybe,
  resolveModelConfigMock,
  buildCouncilConfigMock,
  resolveCouncilLeadModelMock,
  detectModelReferencesMock,
  buildAdHocAgentConfigMock,
  detectClaudeModelReferencesMock,
  buildClaudeSubagentConfigMock,
  getThinkingProfileMock,
  getWorkingProfileMock,
  addRoutesMock,
  getAndResetTurnStatsMock,
  removeRoutesMock,
  getUrlMock,
  getAuthTokenMock,
  getWorkingModelProfileMock,
  resolveMcpServersMock,
  resolveSystemPromptMock,
  buildConnectedPackagesMock,
  getAuthEnvVarsMock,
  superMcpGetStateMock: superMcpGetStateMockMaybe,
} = factories;

const runAgentQueryMock = runAgentQueryMockMaybe!;
const superMcpGetStateMock = superMcpGetStateMockMaybe!;

import { executeAgentTurn } from '../agentTurnExecutor';

describe('executeAgentTurn route-plan broadcast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setBroadcastService({
      sendToAllWindows: sendToAllWindowsMock,
      sendToFocusedWindow: vi.fn(),
    });

    resolveModelConfigMock.mockImplementation((model: string) => ({
      model,
      envOverrides: undefined,
    }));
    resolveSystemPromptMock.mockResolvedValue('You are Rebel.');
    resolveMcpServersMock.mockResolvedValue({
      servers: undefined,
      mode: 'unavailable',
      upstreamCount: 0,
      configPath: undefined,
    });
    buildConnectedPackagesMock.mockResolvedValue([]);
    getAuthEnvVarsMock.mockReturnValue({});

    buildCouncilConfigMock.mockReturnValue(null);
    resolveCouncilLeadModelMock.mockReturnValue('claude-sonnet-4-5');
    detectModelReferencesMock.mockReturnValue([]);
    buildAdHocAgentConfigMock.mockReturnValue(null);
    detectClaudeModelReferencesMock.mockReturnValue([]);
    buildClaudeSubagentConfigMock.mockReturnValue(null);

    getThinkingProfileMock.mockReturnValue(null);
    getWorkingProfileMock.mockReturnValue(null);
    getWorkingModelProfileMock.mockReturnValue(null);

    addRoutesMock.mockResolvedValue(undefined);
    getAndResetTurnStatsMock.mockReturnValue(new Map());
    removeRoutesMock.mockReturnValue(undefined);
    getUrlMock.mockReturnValue('http://proxy.local');
    getAuthTokenMock.mockReturnValue('proxy-auth-token');

    superMcpGetStateMock.mockReturnValue({ isRunning: false, url: '' });

    runAgentQueryMock.mockResolvedValue({
      abortedByUser: false,
      terminatedByHandler: false,
    });
  });

  it('broadcasts one canonical TurnAuthLabel payload per turn', async () => {
    // NOTE: under NODE_ENV=test the broadcast contract sink-seam
    // (broadcastContractSeam.ts) wraps the injected service, so
    // getBroadcastService().sendToAllWindows is the wrapper, not our mock by
    // reference. The wrapper forwards every emit to the underlying mock, so the
    // behavioural assertions below (sendToAllWindowsMock.mock.calls) still hold;
    // a `.toBe(mock)` identity pre-check would (correctly) fail. Assert wiring
    // behaviourally instead.

    await executeAgentTurn(null, 'turn-route-plan-broadcast', 'Hello', {
      sessionId: 'session-route-plan-broadcast',
      resetConversation: false,
    });
    expect(runAgentQueryMock).toHaveBeenCalled();

    const routePlanBroadcastCalls = sendToAllWindowsMock.mock.calls.filter(
      ([channel]) => channel === AGENT_ROUTE_PLAN_RESOLVED_CHANNEL,
    );
    expect(routePlanBroadcastCalls).toHaveLength(1);

    const payload = routePlanBroadcastCalls[0]?.[1] as AgentRoutePlanResolvedEvent;
    expect(payload.sessionId).toBe('session-route-plan-broadcast');
    expect(payload.turnAuthLabel).toBe('api-key');
    expect(typeof payload.resolvedAt).toBe('number');
  });
});
