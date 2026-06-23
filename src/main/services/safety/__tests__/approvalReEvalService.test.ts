import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { reEvaluatePendingApprovals } from '../approvalReEvalService';

// --- Mocks ---

const mockSendToAllWindows = vi.hoisted(() => vi.fn());
vi.mock('@core/broadcastService', async () => {
  const { createBroadcastServiceMock } = await import('@shared/__tests__/testModuleMocks');
  return createBroadcastServiceMock({ sendToAllWindows: mockSendToAllWindows });
});

vi.mock('@core/safetyPromptLogic', () => ({
  evaluateSafetyPrompt: vi.fn(),
  shouldAllow: vi.fn(),
}));

vi.mock('@core/safetyPromptStore', () => ({
  getSafetyPromptVersion: vi.fn().mockReturnValue(1),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@shared/utils/stagedExecutionSummary', () => ({
  summarizeStagedExecutionResult: vi.fn().mockReturnValue('Result summary'),
}));

const mockExecuteAgentTurn = vi.fn().mockResolvedValue(undefined);
vi.mock('../../agentTurnExecutor', () => ({
  executeAgentTurn: (...args: unknown[]) => mockExecuteAgentTurn(...args),
}));

vi.mock('../automationPendingItemsTracker', () => ({
  resolveItem: vi.fn(),
}));

const mockHandleMemoryWriteApprovalResponse = vi.fn();
vi.mock('../memoryWriteHook', () => ({
  handleMemoryWriteApprovalResponse: (...args: unknown[]) =>
    mockHandleMemoryWriteApprovalResponse(...args),
}));

const mockGetPendingApprovals = vi.fn().mockReturnValue([]);
const mockGetPendingMemoryApprovals = vi.fn().mockReturnValue([]);
const mockRemovePendingApproval = vi.fn();
vi.mock('../pendingApprovalsStore', () => ({
  getPendingApprovals: () => mockGetPendingApprovals(),
  getPendingMemoryApprovals: () => mockGetPendingMemoryApprovals(),
  removePendingApproval: (...args: unknown[]) => mockRemovePendingApproval(...args),
}));

const mockStoreSingleUseApproval = vi.fn();
vi.mock('../sessionApprovals', () => ({
  storeSingleUseApproval: (...args: unknown[]) => mockStoreSingleUseApproval(...args),
}));

const mockGetPendingStagedCalls = vi.fn().mockReturnValue([]);
const mockExecuteStagedCall = vi.fn();
vi.mock('../stagedToolCallsService', () => ({
  getPendingStagedCalls: () => mockGetPendingStagedCalls(),
  executeStagedCall: (...args: unknown[]) => mockExecuteStagedCall(...args),
}));

// --- Import mocked modules for assertions ---

import { evaluateSafetyPrompt, shouldAllow } from '@core/safetyPromptLogic';
import { getSafetyPromptVersion } from '@core/safetyPromptStore';

const mockEvaluate = evaluateSafetyPrompt as Mock;
const mockShouldAllow = shouldAllow as Mock;
const mockGetVersion = getSafetyPromptVersion as Mock;

// --- Test helpers ---

function makeToolApproval(overrides: Record<string, unknown> = {}) {
  return {
    toolUseID: 'tool-1',
    turnId: 'turn-1',
    sessionId: 'session-1',
    toolName: 'slack_send_message',
    input: { channel: '#ops', message: 'update' },
    effectiveToolId: 'slack_send_message',
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMemoryApproval(overrides: Record<string, unknown> = {}) {
  return {
    toolUseId: 'mem-1',
    originalSessionId: 'session-1',
    spaceName: 'Product Team',
    filePath: '/notes/meeting.md',
    content: 'Meeting notes content',
    sharing: 'shared',
    blockedBy: 'safety_prompt' as const,
    timestamp: Date.now(),
    ...overrides,
  };
}

const ALLOW_HIGH = { decision: 'allow' as const, confidence: 'high' as const, reason: 'Allowed' };
const BLOCK_RESULT = { decision: 'block' as const, confidence: 'high' as const, reason: 'Blocked' };

describe('approvalReEvalService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVersion.mockReturnValue(1);
    mockGetPendingApprovals.mockReturnValue([]);
    mockGetPendingStagedCalls.mockReturnValue([]);
    mockGetPendingMemoryApprovals.mockReturnValue([]);
  });

  describe('no candidates', () => {
    it('returns immediately without calling evaluateSafetyPrompt', async () => {
      await reEvaluatePendingApprovals('# Safety Rules', 1);
      expect(mockEvaluate).not.toHaveBeenCalled();
    });
  });

  describe('tool approval auto-resolution', () => {
    it('auto-resolves when eval returns allow/high', async () => {
      const approval = makeToolApproval();
      mockGetPendingApprovals.mockReturnValue([approval]);
      mockEvaluate.mockResolvedValue(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      // expectExecution: this path sends an "Approved. Please retry" continuation,
      // so it opts into the approval-execution guard (FOX-2771 Stage 2).
      expect(mockStoreSingleUseApproval).toHaveBeenCalledWith('tool', 'session-1', 'slack_send_message', { expectExecution: true });
      expect(mockRemovePendingApproval).toHaveBeenCalledWith('tool-1');
      expect(mockSendToAllWindows).toHaveBeenCalledWith('tool-safety:approval-resolved', {
        toolUseID: 'tool-1',
        sessionId: 'session-1',
        approved: true,
      });
      expect(mockExecuteAgentTurn).toHaveBeenCalled();
      expect(mockExecuteAgentTurn.mock.calls[0]?.[3]).toEqual(expect.objectContaining({
        sessionId: 'session-1',
        resetConversation: false,
        modelOverride: undefined,
        workingProfileOverrideId: undefined,
        thinkingModelOverride: undefined,
      }));
    });

    it('does NOT resolve when eval returns block', async () => {
      const approval = makeToolApproval();
      mockGetPendingApprovals.mockReturnValue([approval]);
      mockEvaluate.mockResolvedValue(BLOCK_RESULT);
      mockShouldAllow.mockReturnValue(false);

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      expect(mockStoreSingleUseApproval).not.toHaveBeenCalled();
      expect(mockRemovePendingApproval).not.toHaveBeenCalled();
      expect(mockExecuteAgentTurn).not.toHaveBeenCalled();
    });

    it('skips approval without sessionId', async () => {
      const approval = makeToolApproval({ sessionId: undefined });
      mockGetPendingApprovals.mockReturnValue([approval]);
      mockEvaluate.mockResolvedValue(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      expect(mockStoreSingleUseApproval).not.toHaveBeenCalled();
      expect(mockRemovePendingApproval).not.toHaveBeenCalled();
    });
  });

  describe('version guard', () => {
    it('stops processing when prompt version changes mid-re-eval', async () => {
      const approval1 = makeToolApproval({ toolUseID: 'tool-1' });
      const approval2 = makeToolApproval({ toolUseID: 'tool-2' });
      mockGetPendingApprovals.mockReturnValue([approval1, approval2]);
      mockEvaluate.mockResolvedValue(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);
      // Version changes after first resolution
      mockGetVersion.mockReturnValueOnce(1).mockReturnValue(2);

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      // First approval resolved, second skipped due to version change
      expect(mockRemovePendingApproval).toHaveBeenCalledTimes(1);
      expect(mockRemovePendingApproval).toHaveBeenCalledWith('tool-1');
    });
  });

  describe('error isolation', () => {
    it('continues processing remaining approvals when one eval throws', async () => {
      const approval1 = makeToolApproval({ toolUseID: 'tool-1' });
      const approval2 = makeToolApproval({ toolUseID: 'tool-2' });
      mockGetPendingApprovals.mockReturnValue([approval1, approval2]);
      mockEvaluate
        .mockRejectedValueOnce(new Error('API timeout'))
        .mockResolvedValueOnce(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      // First left pending (threw), second resolved
      expect(mockRemovePendingApproval).toHaveBeenCalledTimes(1);
      expect(mockRemovePendingApproval).toHaveBeenCalledWith('tool-2');
    });
  });

  describe('memory approval auto-resolution', () => {
    it('auto-resolves safety_prompt memory approvals', async () => {
      const memApproval = makeMemoryApproval();
      mockGetPendingMemoryApprovals.mockReturnValue([memApproval]);
      mockEvaluate.mockResolvedValue(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);
      mockHandleMemoryWriteApprovalResponse.mockReturnValue({
        success: true,
        originalSessionId: 'session-1',
        filePath: '/notes/meeting.md',
        spaceName: 'Product Team',
        content: 'Meeting notes content',
      });

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      expect(mockHandleMemoryWriteApprovalResponse).toHaveBeenCalledWith('mem-1', true);
      expect(mockSendToAllWindows).toHaveBeenCalledWith('memory:write-approval-resolved', expect.objectContaining({
        toolUseId: 'mem-1',
        approved: true,
      }));
      expect(mockExecuteAgentTurn).toHaveBeenCalled();
    });

    it('only re-evaluates safety_prompt memory approvals, not structural_policy', async () => {
      const safetyApproval = makeMemoryApproval({ toolUseId: 'mem-1', blockedBy: 'safety_prompt' });
      const structApproval = makeMemoryApproval({ toolUseId: 'mem-2', blockedBy: 'structural_policy' });
      mockGetPendingMemoryApprovals.mockReturnValue([safetyApproval, structApproval]);
      mockEvaluate.mockResolvedValue(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);
      mockHandleMemoryWriteApprovalResponse.mockReturnValue({
        success: true,
        originalSessionId: 'session-1',
      });

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      // Only safety_prompt approval should be re-evaluated (structural_policy is filtered)
      expect(mockEvaluate).toHaveBeenCalledTimes(1);
    });

    it('also re-evaluates eval_error memory approvals', async () => {
      const evalErrorApproval = makeMemoryApproval({ toolUseId: 'mem-3', blockedBy: 'eval_error' });
      mockGetPendingMemoryApprovals.mockReturnValue([evalErrorApproval]);
      mockEvaluate.mockResolvedValue(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);
      mockHandleMemoryWriteApprovalResponse.mockReturnValue({
        success: true,
        originalSessionId: 'session-1',
      });

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      expect(mockEvaluate).toHaveBeenCalledTimes(1);
      expect(mockHandleMemoryWriteApprovalResponse).toHaveBeenCalledWith('mem-3', true);
    });
  });

  describe('grouped continuations', () => {
    it('sends grouped continuation for multiple approvals in same session', async () => {
      const approval1 = makeToolApproval({ toolUseID: 'tool-1', sessionId: 'session-1' });
      const approval2 = makeToolApproval({ toolUseID: 'tool-2', sessionId: 'session-1', toolName: 'send_email' });
      mockGetPendingApprovals.mockReturnValue([approval1, approval2]);
      mockEvaluate.mockResolvedValue(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      // Should batch into a single executeAgentTurn call for session-1
      expect(mockExecuteAgentTurn).toHaveBeenCalledTimes(1);
      const callArgs = mockExecuteAgentTurn.mock.calls[0];
      expect(callArgs[3]).toEqual(expect.objectContaining({ sessionId: 'session-1' }));
      expect(callArgs[3]).toEqual(expect.objectContaining({
        modelOverride: undefined,
        workingProfileOverrideId: undefined,
        thinkingModelOverride: undefined,
      }));
    });
  });

  describe('staged calls', () => {
    it('re-evaluates staged calls with Safety Rules block prefix', async () => {
      const stagedCall = {
        id: 'staged-1',
        sessionId: 'session-1',
        displayName: 'gmail.send_email',
        reason: 'Safety Rules blocked: sending email to external',
        mcpPayload: {
          packageId: 'gmail',
          toolId: 'send_email',
          args: { to: 'test@example.com' },
        },
      };
      mockGetPendingStagedCalls.mockReturnValue([stagedCall]);
      mockEvaluate.mockResolvedValue(ALLOW_HIGH);
      mockShouldAllow.mockReturnValue(true);
      mockExecuteStagedCall.mockResolvedValue({
        status: 'executed',
        result: { content: 'Email sent' },
      });

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      expect(mockExecuteStagedCall).toHaveBeenCalledWith('staged-1');
      expect(mockSendToAllWindows).toHaveBeenCalledWith('tool-safety:staged-call-updated', expect.objectContaining({
        id: 'staged-1',
        status: 'executed',
      }));
    });

    it('skips staged calls without Safety Rules block prefix', async () => {
      const stagedCall = {
        id: 'staged-1',
        sessionId: 'session-1',
        displayName: 'gmail.send_email',
        reason: 'User confirmation required',
        mcpPayload: {
          packageId: 'gmail',
          toolId: 'send_email',
          args: {},
        },
      };
      mockGetPendingStagedCalls.mockReturnValue([stagedCall]);

      await reEvaluatePendingApprovals('# Safety Rules', 1);

      // Staged call filtered out (doesn't start with safety rules prefix)
      expect(mockEvaluate).not.toHaveBeenCalled();
    });
  });
});
