import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@shared/types';
import type { HookCallback, SyncHookJSONOutput } from '@core/agentRuntimeTypes';
import { createToolSafetyHook } from '../toolSafetyService';

const {
  mockApprovalHandler,
  mockRecordSecurityDenial,
  mockAddPendingApproval,
  mockSendToAllWindows,
  mockEvaluateSafetyPrompt,
  mockShouldAllow,
} = vi.hoisted(() => ({
  mockApprovalHandler: vi.fn(),
  mockRecordSecurityDenial: vi.fn(),
  mockAddPendingApproval: vi.fn(),
  mockSendToAllWindows: vi.fn(),
  mockEvaluateSafetyPrompt: vi.fn(),
  mockShouldAllow: vi.fn(),
}));

vi.mock('@core/services/agentTurnRegistry', () => ({
  agentTurnRegistry: {
    getApprovalHandler: vi.fn((turnId: string) =>
      turnId === 'turn-with-handler' ? mockApprovalHandler : undefined,
    ),
    recordSecurityDenial: mockRecordSecurityDenial,
    recordToolCall: vi.fn(),
    incrementAutomationSafetyBlock: vi.fn(),
    getAutomationSafetyBlockCount: vi.fn().mockReturnValue(0),
  },
}));

vi.mock('@main/services/safety', () => ({
  addPendingApproval: mockAddPendingApproval,
  removePendingApproval: vi.fn(),
  getPendingApprovals: vi.fn().mockReturnValue([]),
  clearPendingApprovalsForSession: vi.fn().mockReturnValue([]),
  storeSingleUseApproval: vi.fn(),
  consumeSingleUseApproval: vi.fn().mockReturnValue(false),
  clearSessionSingleUseApprovals: vi.fn(),
}));

vi.mock('@main/services/safety/stagedToolCallsService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/services/safety/stagedToolCallsService')>();
  return {
    ...actual,
    getPendingStagedCalls: vi.fn().mockReturnValue([]),
  };
});

vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: mockEvaluateSafetyPrompt,
  shouldAllow: mockShouldAllow,
  clearCache: vi.fn(),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPrompt: vi.fn().mockReturnValue('safety prompt'),
  getSafetyPromptVersion: vi.fn().mockReturnValue(1),
  isMigrationComplete: vi.fn().mockReturnValue(true),
}));

vi.mock('@core/safetyActivityLogStore', () => ({
  addEvaluationEntry: vi.fn(),
}));

vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: mockSendToAllWindows });
});

vi.mock('@core/services/toolAliasCache', () => ({
  resolveAlias: vi.fn((_packageId: string, toolId: string) => toolId),
  updateAliases: vi.fn(),
  clearAliases: vi.fn(),
}));

const settings = {
  claude: { apiKey: 'test-key' },
} as AppSettings;

function makeHook(turnId: string): HookCallback {
  return createToolSafetyHook(
    'please send the message',
    settings,
    'balanced',
    undefined,
    [],
    undefined,
    null,
    turnId,
    'cli-session-test',
  );
}

describe('tool safety CLI approval routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEvaluateSafetyPrompt.mockResolvedValue({
      decision: 'block',
      confidence: 'high',
      reason: 'External side effect',
    });
    mockShouldAllow.mockReturnValue(false);
  });

  it('routes blocked tool safety through the registered handler and approves in-place', async () => {
    mockApprovalHandler.mockResolvedValue({ approved: true });
    const hook = makeHook('turn-with-handler');

    const result = await hook(
      {
        tool_name: 'send_email',
        tool_input: { to: 'team@example.com' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal },
    ) as SyncHookJSONOutput;

    expect(mockApprovalHandler).toHaveBeenCalledWith(
      {
        kind: 'tool_safety',
        toolName: 'send_email',
        toolInput: { to: 'team@example.com' },
        reason: 'Safety Rules blocked: External side effect',
      },
      expect.any(AbortSignal),
    );
    expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(mockAddPendingApproval).not.toHaveBeenCalled();
    expect(mockRecordSecurityDenial).not.toHaveBeenCalled();
    expect(mockSendToAllWindows).not.toHaveBeenCalledWith(
      'tool-safety:approval-request',
      expect.anything(),
    );
  });

  it('denies and ends the turn when the registered handler declines', async () => {
    mockApprovalHandler.mockResolvedValue({ approved: false, reason: 'declined' });
    const hook = makeHook('turn-with-handler');

    const result = await hook(
      {
        tool_name: 'send_email',
        tool_input: { to: 'team@example.com' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal },
    ) as SyncHookJSONOutput;

    expect(result.continue).toBe(false);
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput?.permissionDecisionReason).toBe('declined');
    expect(mockAddPendingApproval).not.toHaveBeenCalled();
  });

  it('fails closed (deny) when the registered handler throws', async () => {
    mockApprovalHandler.mockRejectedValue(new Error('stdin reader exploded'));
    const hook = makeHook('turn-with-handler');

    const result = await hook(
      {
        tool_name: 'send_email',
        tool_input: { to: 'team@example.com' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal },
    ) as SyncHookJSONOutput;

    expect(result.continue).toBe(false);
    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(String(result.hookSpecificOutput?.permissionDecisionReason)).toContain('stdin reader exploded');
    expect(mockRecordSecurityDenial).toHaveBeenCalledWith(
      'turn-with-handler',
      'send_email',
      expect.stringContaining('approval_handler_error'),
    );
    expect(mockAddPendingApproval).not.toHaveBeenCalled();
    expect(mockSendToAllWindows).not.toHaveBeenCalledWith(
      'tool-safety:approval-request',
      expect.anything(),
    );
  });

  it('approves in-place without staging a pending approval or broadcasting a request (one-turn invariant)', async () => {
    mockApprovalHandler.mockResolvedValue({ approved: true });
    const hook = makeHook('turn-with-handler');

    const result = await hook(
      {
        tool_name: 'send_email',
        tool_input: { to: 'team@example.com' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal },
    ) as SyncHookJSONOutput;

    expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
    expect(mockAddPendingApproval).not.toHaveBeenCalled();
    const broadcastCalls = mockSendToAllWindows.mock.calls.map((call) => call[0]);
    expect(broadcastCalls).not.toContain('tool-safety:approval-request');
    expect(broadcastCalls).not.toContain('tool-safety:approval-required');
  });

  it('falls through to the existing approval request path when no handler is registered', async () => {
    const hook = makeHook('turn-without-handler');

    const result = await hook(
      {
        tool_name: 'send_email',
        tool_input: { to: 'team@example.com' },
        tool_use_id: 'tool-1',
      },
      'tool-1',
      { signal: new AbortController().signal },
    ) as SyncHookJSONOutput;

    expect(result.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(mockAddPendingApproval).toHaveBeenCalledTimes(1);
    expect(mockSendToAllWindows).toHaveBeenCalledWith(
      'tool-safety:approval-request',
      expect.objectContaining({ toolUseID: 'tool-1' }),
    );
  });
});
