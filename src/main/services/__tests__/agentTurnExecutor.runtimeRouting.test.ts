/**
 * Agent Turn Executor — Runtime Routing Tests
 *
 * Thin test file verifying the executor correctly wires routerContext
 * when calling the query router via runAgentQuery. Tests that:
 * - routerContext.sessionId maps from the turn's renderer session ID
 * - routerContext.onMcpError is always defined (callback is wired)
 *
 * Stage 5 of the agentTurnExecutor decomposition plan.
 * See: docs/plans/260402_agentTurnExecutor_decomposition_and_tests.md
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  /* createMockFactories removed */
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

// NOTE: resolveCapabilities is NOT mocked — runs as a real pure function

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

// ---------------------------------------------------------------------------
// Import under test (AFTER all vi.mock calls)
// ---------------------------------------------------------------------------
import { executeAgentTurn } from '../agentTurnExecutor';
import type { AgentQueryConfig } from '../agentQueryRunner';
import { reportMcpError } from '../mcpService';
import type { McpErrorInfo } from '@core/rebelCore/types';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeAgentTurn runtime routing (routerContext wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock returns
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

    // Council/proxy defaults: no council, no ad-hoc, no Claude subagents
    buildCouncilConfigMock.mockReturnValue(null);
    resolveCouncilLeadModelMock.mockReturnValue('claude-sonnet-4-5');
    detectModelReferencesMock.mockReturnValue([]);
    buildAdHocAgentConfigMock.mockReturnValue(null);
    detectClaudeModelReferencesMock.mockReturnValue([]);
    buildClaudeSubagentConfigMock.mockReturnValue(null);

    // Profile defaults: no non-Claude profiles
    getThinkingProfileMock.mockReturnValue(null);
    getWorkingProfileMock.mockReturnValue(null);
    getWorkingModelProfileMock.mockReturnValue(null);

    // Proxy defaults
    addRoutesMock.mockResolvedValue(undefined);
    getAndResetTurnStatsMock.mockReturnValue(new Map());
    removeRoutesMock.mockReturnValue(undefined);
    getUrlMock.mockReturnValue('http://proxy.local');
    getAuthTokenMock.mockReturnValue('proxy-auth-token');

    // Super-MCP default: not running
    superMcpGetStateMock.mockReturnValue({ isRunning: false, url: '' });

    // runAgentQuery mock: resolve immediately with a successful result
    runAgentQueryMock.mockResolvedValue({
      abortedByUser: false,
      terminatedByHandler: false,
    });
  });

  /** Extract the routerContext from the first runAgentQuery call. */
  function captureRouterContext(): AgentQueryConfig['routerContext'] {
    expect(runAgentQueryMock).toHaveBeenCalled();
    const config = runAgentQueryMock.mock.calls[0][0] as AgentQueryConfig;
    return config.routerContext;
  }

  // -------------------------------------------------------------------------
  // Test 6: routerContext.sessionId wired from turn's renderer session ID
  // -------------------------------------------------------------------------
  it('wires routerContext.sessionId from the turn session ID', async () => {
    await executeAgentTurn(null, 'turn-route-sid', 'Hello', {
      sessionId: 'renderer-session-42',
      resetConversation: false,
    });

    const routerContext = captureRouterContext();
    expect(routerContext).toBeDefined();
    expect(routerContext!.sessionId).toBe('renderer-session-42');
  });

  // -------------------------------------------------------------------------
  // Test 7: routerContext.onMcpError is defined (callback is wired)
  // -------------------------------------------------------------------------
  it('wires routerContext.onMcpError as a defined callback', async () => {
    await executeAgentTurn(null, 'turn-route-mcp', 'Hello', {
      sessionId: 'renderer-session-mcp',
      resetConversation: false,
    });

    const routerContext = captureRouterContext();
    expect(routerContext).toBeDefined();
    expect(routerContext!.onMcpError).toBeDefined();
    expect(typeof routerContext!.onMcpError).toBe('function');
  });

  it('treats routerContext tool dispatch as active tool work before assistant tracking lands', async () => {
    const observedToolInFlight: boolean[] = [];

    runAgentQueryMock.mockImplementationOnce(async (config: AgentQueryConfig) => {
      observedToolInFlight.push(config.isToolInFlight?.() ?? false);

      const controller = new AbortController();
      config.routerContext?.onToolDispatch?.('toolu_bash_orphan', controller);
      observedToolInFlight.push(config.isToolInFlight?.() ?? false);

      config.routerContext?.onToolSettle?.('toolu_bash_orphan');
      observedToolInFlight.push(config.isToolInFlight?.() ?? false);

      return {
        abortedByUser: false,
        terminatedByHandler: false,
      };
    });

    await executeAgentTurn(null, 'turn-route-tool-liveness', 'Hello', {
      sessionId: 'renderer-session-tool-liveness',
      resetConversation: false,
    });

    expect(observedToolInFlight).toEqual([false, true, false]);
  });

  it('suppresses MCP reporting only when requestSignalAborted is true', async () => {
    await executeAgentTurn(null, 'turn-route-local-abort', 'Hello', {
      sessionId: 'renderer-session-local-abort',
      resetConversation: false,
    });

    const routerContext = captureRouterContext();
    const onMcpError = routerContext!.onMcpError;
    expect(onMcpError).toBeDefined();

    const errorInfo: McpErrorInfo = {
      operation: 'execute_tool',
      toolName: 'list_workspace_calendar_events',
      code: -32001,
      message: 'The operation was aborted',
      rawError: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      errorKind: 'unknown',
      requestSignalAborted: true,
    };
    onMcpError!(errorInfo);

    expect(vi.mocked(reportMcpError)).not.toHaveBeenCalled();
  });

  it('still reports AbortError-shaped upstream failures when local signal is not aborted', async () => {
    await executeAgentTurn(null, 'turn-route-upstream-abort', 'Hello', {
      sessionId: 'renderer-session-upstream-abort',
      resetConversation: false,
    });

    const routerContext = captureRouterContext();
    const onMcpError = routerContext!.onMcpError;
    expect(onMcpError).toBeDefined();

    const errorInfo: McpErrorInfo = {
      operation: 'execute_tool',
      toolName: 'rebel_inbox_update',
      code: -32001,
      message: 'The operation was aborted',
      rawError: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
      errorKind: 'mcp_error',
      requestSignalAborted: false,
    };
    onMcpError!(errorInfo);

    expect(vi.mocked(reportMcpError)).toHaveBeenCalledOnce();
    expect(vi.mocked(reportMcpError)).toHaveBeenCalledWith(
      expect.any(Error),
      'execute_tool',
      expect.objectContaining({
        level: 'warning',
        fingerprintDiscriminators: ['kind:mcp_error', 'code:-32001'],
      }),
    );
  });

  it('applies labelled fingerprint discriminators for list_tools errors as well', async () => {
    await executeAgentTurn(null, 'turn-route-list-tools', 'Hello', {
      sessionId: 'renderer-session-list-tools',
      resetConversation: false,
    });

    const routerContext = captureRouterContext();
    const onMcpError = routerContext!.onMcpError;
    expect(onMcpError).toBeDefined();

    const errorInfo: McpErrorInfo = {
      operation: 'list_tools',
      code: -33003,
      message: 'Invalid arguments',
      rawError: new Error('Invalid arguments'),
      errorKind: 'mcp_error',
      requestSignalAborted: false,
    };
    onMcpError!(errorInfo);

    expect(vi.mocked(reportMcpError)).toHaveBeenCalledOnce();
    expect(vi.mocked(reportMcpError)).toHaveBeenCalledWith(
      expect.any(Error),
      'list_tools',
      expect.objectContaining({
        fingerprintDiscriminators: ['kind:mcp_error', 'code:-33003'],
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 8: routerContext.superMcpUrl wired when Super-MCP is running
  // -------------------------------------------------------------------------
  it('wires routerContext.superMcpUrl when Super-MCP is running', async () => {
    superMcpGetStateMock.mockReturnValue({ isRunning: true, url: 'http://localhost:18765' });

    await executeAgentTurn(null, 'turn-route-smcp', 'Hello', {
      sessionId: 'renderer-session-smcp',
      resetConversation: false,
    });

    const routerContext = captureRouterContext();
    expect(routerContext).toBeDefined();
    expect(routerContext!.superMcpUrl).toBe('http://localhost:18765');
  });

  // -------------------------------------------------------------------------
  // Test 9: routerContext.superMcpUrl is null when Super-MCP is NOT running
  // -------------------------------------------------------------------------
  it('sets routerContext.superMcpUrl to null when Super-MCP is not running', async () => {
    superMcpGetStateMock.mockReturnValue({ isRunning: false, url: '' });

    await executeAgentTurn(null, 'turn-route-no-smcp', 'Hello', {
      sessionId: 'renderer-session-no-smcp',
      resetConversation: false,
    });

    const routerContext = captureRouterContext();
    expect(routerContext).toBeDefined();
    expect(routerContext!.superMcpUrl).toBeFalsy();
  });
});
