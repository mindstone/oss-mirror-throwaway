import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { HookJSONOutput } from '@core/agentRuntimeTypes';
import { createToolSafetyHook as createProductionToolSafetyHook } from '../toolSafetyService';
import {
  expectBinaryHookDecision,
  getHookSpecificOutput,
} from '../safety/__tests__/safetyVerdictConformance.helpers';

function createMockSettings(): AppSettings {
  return {
    claude: { apiKey: 'test-api-key' },
    safetyEvalUserIntentFence: false,
  } as AppSettings;
}

type ToolSafetyHookInput = {
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
};

type ToolSafetyHook = (
  input: ToolSafetyHookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

const createToolSafetyHook = (
  ...args: Parameters<typeof createProductionToolSafetyHook>
): ToolSafetyHook => createProductionToolSafetyHook(...args) as unknown as ToolSafetyHook;

const {
  mockAddPendingApproval,
  mockRemovePendingApproval,
  mockGetPendingApprovals,
  mockConsumeSingleUseApproval,
  mockStoreSingleUseApproval,
  mockClearSessionSingleUseApprovals,
  mockStageToolCall,
  mockGetPendingStagedCalls,
  mockEvaluateSafetyPrompt,
  mockShouldAllow,
  mockRecordToolCall,
  mockRecordSecurityDenial,
  mockIncrementAutomationSafetyBlock,
  mockGetAutomationSafetyBlockCount,
  mockGetApprovalHandler,
  mockResolveAlias,
  mockGetCachedAuthConfig,
  mockTrackItem,
} = vi.hoisted(() => ({
  mockAddPendingApproval: vi.fn(),
  mockRemovePendingApproval: vi.fn(),
  mockGetPendingApprovals: vi.fn<() => unknown[]>(() => []),
  mockConsumeSingleUseApproval: vi.fn(() => false),
  mockStoreSingleUseApproval: vi.fn(),
  mockClearSessionSingleUseApprovals: vi.fn(),
  mockStageToolCall: vi.fn(),
  mockGetPendingStagedCalls: vi.fn<() => unknown[]>(() => []),
  mockEvaluateSafetyPrompt: vi.fn(),
  mockShouldAllow: vi.fn(),
  mockRecordToolCall: vi.fn(),
  mockRecordSecurityDenial: vi.fn(),
  mockIncrementAutomationSafetyBlock: vi.fn(),
  mockGetAutomationSafetyBlockCount: vi.fn(() => 0),
  mockGetApprovalHandler: vi.fn(),
  mockResolveAlias: vi.fn((_packageId: string, toolId: string) => toolId),
  mockGetCachedAuthConfig: vi.fn<() => unknown>(() => null),
  mockTrackItem: vi.fn(),
}));

let broadcastSpy: ReturnType<typeof vi.fn>;

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@main/services/safety', () => ({
  addPendingApproval: mockAddPendingApproval,
  removePendingApproval: mockRemovePendingApproval,
  getPendingApprovals: mockGetPendingApprovals,
  clearPendingApprovalsForTurn: vi.fn(() => []),
  clearPendingApprovalsForSession: vi.fn(() => []),
  clearPendingMemoryApprovalsForSession: vi.fn(),
  storeSingleUseApproval: mockStoreSingleUseApproval,
  consumeSingleUseApproval: mockConsumeSingleUseApproval,
  clearSessionSingleUseApprovals: mockClearSessionSingleUseApprovals,
}));

vi.mock('@main/services/safety/stagedToolCallsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/services/safety/stagedToolCallsService')>();
  return {
    ...actual,
    stageToolCall: mockStageToolCall,
    getPendingStagedCalls: mockGetPendingStagedCalls,
  };
});

vi.mock('@main/services/safety/automationPendingItemsTracker', () => ({
  trackItem: mockTrackItem,
}));

vi.mock('@main/services/safety/automationContextLookup', () => ({
  getAutomationContext: vi.fn(() => ({
    automationId: 'automation-s3',
    automationName: 'S3 Automation',
  })),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    recordToolCall: mockRecordToolCall,
    recordSecurityDenial: mockRecordSecurityDenial,
    incrementAutomationSafetyBlock: mockIncrementAutomationSafetyBlock,
    getAutomationSafetyBlockCount: mockGetAutomationSafetyBlockCount,
    getApprovalHandler: mockGetApprovalHandler,
  },
}));

vi.mock('@core/services/toolAliasCache', () => ({
  resolveAlias: mockResolveAlias,
  updateAliases: vi.fn(),
  clearAliases: vi.fn(),
}));

vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: mockEvaluateSafetyPrompt,
  shouldAllow: mockShouldAllow,
  clearCache: vi.fn(),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: vi.fn(() => 'default safety prompt'),
  getSafetyPromptVersion: vi.fn(() => 1),
  isMigrationComplete: vi.fn(() => true),
}));

vi.mock('@core/safetyActivityLogStore', () => ({
  addEvaluationEntry: vi.fn(),
}));

vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: broadcastSpy, sendToFocusedWindow: vi.fn() }),
}));

vi.mock('@core/rebelAuth', () => ({
  getRebelAuthProvider: () => ({
      getAuthState: vi.fn(() => ({ isAuthenticated: false, user: null, isLoading: false })),
      onAuthStateChange: vi.fn(() => () => {}),
      getAccessToken: vi.fn(async () => null),
      invalidateAccessToken: vi.fn(),
      initializeAuth: vi.fn(async () => ({ isAuthenticated: false, user: null, isLoading: false })),
      setPostLoginCallback: vi.fn(),
      requestAuthConfigRefresh: vi.fn(async () => {}),
      refreshLicenseTier: vi.fn(async () => 'free'),
      clearCachedProviderKey: vi.fn(),
      getSharedDriveConfig: vi.fn(() => null),
      getSubscriptionState: vi.fn(() => null),
      getManagedAllowanceResetsAt: vi.fn(() => undefined),
      getCachedAuthConfig: mockGetCachedAuthConfig,
  }),
  setRebelAuthProvider: vi.fn(),
  NULL_REBEL_AUTH_PROVIDER: {},
}));

vi.mock('../systemSettingsSync', () => ({
  getSystemSettingsPath: () => '/mock/rebel-system',
}));

vi.mock('../behindTheScenesClient', () => ({
  callWithModelAuthAware: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => 'mock prompt template'),
  },
}));

function installStageToolCallMock(): void {
  mockStageToolCall.mockImplementation((input) => ({
    call: {
      id: `staged-${mockStageToolCall.mock.calls.length}`,
      sessionId: input.sessionId,
      turnId: input.turnId,
      timestamp: Date.now(),
      expiresAt: Date.now() + 86_400_000,
      status: 'pending',
      mcpPayload: input.mcpPayload,
      displayName: input.displayName,
      toolCategory: input.toolCategory,
      riskLevel: input.riskLevel,
      reason: input.reason,
      allowPermanentTrust: input.allowPermanentTrust,
      blockedBy: input.blockedBy,
      coalesceKey: input.coalesceKey,
      automationId: input.automationId,
      automationName: input.automationName,
    },
    coalesced: false,
  }));
}

describe('safety verdict conformance - tool hook', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    broadcastSpy = vi.fn();
    mockGetPendingApprovals.mockReturnValue([]);
    mockGetPendingStagedCalls.mockReturnValue([]);
    mockConsumeSingleUseApproval.mockReturnValue(false);
    mockGetAutomationSafetyBlockCount.mockReturnValue(0);
    mockGetApprovalHandler.mockReturnValue(undefined);
    mockResolveAlias.mockImplementation((_packageId: string, toolId: string) => toolId);
    mockGetCachedAuthConfig.mockReturnValue(null);
    installStageToolCallMock();
  });

  it('pins eval_error staged calls bypassing the already-staged guard', async () => {
    // Invariants #1 and #4: locks behavior for S4 verdict refactor.
    mockGetPendingStagedCalls.mockReturnValue([{
      id: 'stale-eval-error-card',
      sessionId: 's3-tool-session',
      turnId: 'old-turn',
      timestamp: Date.now() - 1000,
      expiresAt: Date.now() + 86_400_000,
      status: 'pending',
      mcpPayload: { packageId: 'Twist', toolId: 'post_twist_message', args: { text: 'old' } },
      displayName: 'Twist - post message',
      toolCategory: 'side-effect',
      riskLevel: 'high',
      reason: 'Previous evaluator outage',
      blockedBy: 'eval_error',
      coalesceKey: 'eval_error:post_twist_message:old',
    }]);
    mockEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'block',
      confidence: 'low',
      reason: 'provider unavailable',
      failClosed: true,
      failClosedReason: 'rate-limited',
    });
    mockShouldAllow.mockReturnValue(false);

    const hook = createToolSafetyHook(
      'Post to Twist',
      createMockSettings(),
      'balanced',
      undefined, undefined, undefined, null,
      's3-tool-turn', 's3-tool-session',
    );

    const result = await hook(
      {
        tool_name: 'mcp__super-mcp-router__use_tool',
        tool_input: {
          package_id: 'Twist',
          tool_id: 'post_twist_message',
          args: { text: 'new' },
        },
        tool_use_id: 's3-tool-eval-error-guard',
      },
      's3-tool-eval-error-guard',
      { signal: new AbortController().signal },
    );

    expectBinaryHookDecision(result);
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('allow');
    expect(String(getHookSpecificOutput(result)?.permissionDecisionReason ?? '')).not.toContain('Already queued');
    expect(mockEvaluateSafetyPrompt).toHaveBeenCalledTimes(1);
    expect(mockStageToolCall).toHaveBeenCalledWith(expect.objectContaining({
      blockedBy: 'eval_error',
      coalesceKey: expect.stringMatching(/^eval_error:post_twist_message:/),
    }));
    expect(broadcastSpy).toHaveBeenCalledWith('tool-safety:staged-call', expect.objectContaining({
      id: 'staged-1',
      sessionId: 's3-tool-session',
      packageId: 'Twist',
      toolId: 'post_twist_message',
      riskLevel: 'high',
      allowPermanentTrust: false,
      blockedBy: 'eval_error',
    }));
  });

  it('pins automation MCP needs-approval as allow-staged with blockedBy broadcast', async () => {
    // Invariants #1, #5, #6, #7, and #8: locks behavior for S4 verdict refactor.
    mockEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'block',
      confidence: 'high',
      reason: 'Posting to Twist needs review',
    });
    mockShouldAllow.mockReturnValue(false);

    const hook = createToolSafetyHook(
      'Post automation update',
      createMockSettings(),
      'balanced',
      undefined, undefined, undefined, null,
      's3-auto-mcp-turn', 'automation-s3-mcp-session',
    );

    const result = await hook(
      {
        tool_name: 'mcp__super-mcp-router__use_tool',
        tool_input: {
          package_id: 'Twist',
          tool_id: 'post_twist_message',
          args: { text: 'automation update' },
        },
        tool_use_id: 's3-auto-mcp-tool',
      },
      's3-auto-mcp-tool',
      { signal: new AbortController().signal },
    );

    expectBinaryHookDecision(result);
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('allow');
    expect(getHookSpecificOutput(result)?.updatedInput).toMatchObject({
      _rebel_staged: true,
    });
    expect(mockStageToolCall).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'automation-s3-mcp-session',
      turnId: 's3-auto-mcp-turn',
      mcpPayload: {
        packageId: 'Twist',
        toolId: 'post_twist_message',
        args: { text: 'automation update' },
      },
      riskLevel: 'high',
      reason: 'Safety Rules blocked: Posting to Twist needs review',
      blockedBy: 'safety_prompt',
      automationId: 'automation-s3',
      automationName: 'S3 Automation',
    }));
    expect(broadcastSpy).toHaveBeenCalledWith('tool-safety:staged-call', expect.objectContaining({
      id: 'staged-1',
      sessionId: 'automation-s3-mcp-session',
      displayName: expect.stringContaining('Twist'),
      packageId: 'Twist',
      toolId: 'post_twist_message',
      riskLevel: 'high',
      reason: 'Safety Rules blocked: Posting to Twist needs review',
      timestamp: expect.any(Number),
      allowPermanentTrust: false,
      blockedBy: 'safety_prompt',
      automationId: 'automation-s3',
      automationName: 'S3 Automation',
    }));
    expect(mockIncrementAutomationSafetyBlock).toHaveBeenCalledTimes(1);
    expect(mockRecordSecurityDenial).toHaveBeenCalledTimes(1);
    expect(mockAddPendingApproval).not.toHaveBeenCalled();
  });

  it('pins automation non-MCP needs-approval as deny plus pending approval with blockedBy', async () => {
    // Invariants #1, #6, #7, and #8: locks behavior for S4 verdict refactor.
    mockEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'block',
      confidence: 'high',
      reason: 'External send needs review',
    });
    mockShouldAllow.mockReturnValue(false);

    const hook = createToolSafetyHook(
      'Send automation message',
      createMockSettings(),
      'balanced',
      undefined, undefined, undefined, null,
      's3-auto-non-mcp-turn', 'automation-s3-non-mcp-session',
    );

    const result = await hook(
      {
        tool_name: 'send_message',
        tool_input: { text: 'hello' },
        tool_use_id: 's3-auto-non-mcp-tool',
      },
      's3-auto-non-mcp-tool',
      { signal: new AbortController().signal },
    );

    expectBinaryHookDecision(result);
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(mockAddPendingApproval).toHaveBeenCalledWith(expect.objectContaining({
      toolUseID: 's3-auto-non-mcp-tool',
      turnId: 's3-auto-non-mcp-turn',
      sessionId: 'automation-s3-non-mcp-session',
      toolName: 'send_message',
      input: { text: 'hello' },
      reason: 'Safety Rules blocked: External send needs review',
      timestamp: expect.any(Number),
      riskLevel: 'high',
      allowPermanentTrust: false,
      effectiveToolId: 'send_message',
      blockedBy: 'safety_prompt',
    }));
    expect(broadcastSpy).toHaveBeenCalledWith('tool-safety:approval-request', expect.objectContaining({
      toolUseID: 's3-auto-non-mcp-tool',
      turnId: 's3-auto-non-mcp-turn',
      sessionId: 'automation-s3-non-mcp-session',
      toolName: 'send_message',
      reason: 'Safety Rules blocked: External send needs review',
      riskLevel: 'high',
      allowPermanentTrust: false,
      effectiveToolId: 'send_message',
      blockedBy: 'safety_prompt',
    }));
    expect(mockStageToolCall).not.toHaveBeenCalled();
    expect(mockRecordSecurityDenial).toHaveBeenCalledTimes(1);
  });

  it('pins admin-disabled tools as non-approvable hard denies', async () => {
    // Invariant #9: locks behavior for S4 verdict refactor.
    mockGetCachedAuthConfig.mockReturnValue({
      disabledConnectorTools: {
        workspace: {
          disabledTools: ['send_workspace_email'],
        },
      },
    });

    const hook = createToolSafetyHook(
      'Send workspace email',
      createMockSettings(),
      'balanced',
      undefined, undefined, undefined, null,
      's3-admin-turn', 's3-admin-session',
    );

    const result = await hook(
      {
        tool_name: 'send_workspace_email',
        tool_input: { to: 'person@example.com', body: 'hello' },
        tool_use_id: 's3-admin-tool',
      },
      's3-admin-tool',
      { signal: new AbortController().signal },
    );

    expectBinaryHookDecision(result);
    expect(getHookSpecificOutput(result)?.permissionDecision).toBe('deny');
    expect(getHookSpecificOutput(result)?.permissionDecisionReason).toContain('BLOCKED BY ADMIN');
    expect(mockEvaluateSafetyPrompt).not.toHaveBeenCalled();
    expect(mockAddPendingApproval).not.toHaveBeenCalled();
    expect(mockStageToolCall).not.toHaveBeenCalled();
    expect(broadcastSpy).not.toHaveBeenCalledWith('tool-safety:approval-request', expect.anything());
    expect(broadcastSpy).not.toHaveBeenCalledWith('tool-safety:staged-call', expect.anything());
  });
});
