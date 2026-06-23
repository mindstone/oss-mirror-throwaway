import { describe, expect, it } from 'vitest';
import type { PendingApprovalItem } from '../../../hooks/usePendingApprovals';
import { getApprovalDecisionState } from '../approvalDecisionState';

function toolApproval(overrides: Partial<PendingApprovalItem['toolApproval']> = {}): PendingApprovalItem {
  return {
    id: 'tool:approval-1',
    type: 'tool',
    title: 'Session A',
    description: 'Review action',
    timestamp: Date.UTC(2026, 3, 18),
    sessionId: 'session-a',
    toolApproval: {
      toolUseID: 'tool-use-1',
      turnId: 'turn-1',
      toolName: 'send_message',
      input: {},
      ...overrides,
    },
  };
}

describe('getApprovalDecisionState', () => {
  it('classifies typed safety_prompt tool approvals without a safety-prefixed reason', () => {
    expect(getApprovalDecisionState(toolApproval({
      reason: 'Outbound message needs review',
      blockedBy: 'safety_prompt',
    }))).toEqual({ isSafetyBlock: true, isEvalError: false });
  });

  it('classifies legacy-shaped tool approvals once blockedBy has been backfilled', () => {
    expect(getApprovalDecisionState(toolApproval({
      reason: 'Safety Rules blocked: outbound message needs review',
      blockedBy: 'safety_prompt',
    }))).toEqual({ isSafetyBlock: true, isEvalError: false });
  });

  it('does not classify safety-prefixed tool reasons without blockedBy', () => {
    expect(getApprovalDecisionState(toolApproval({
      reason: 'Safety Rules blocked: outbound message needs review',
      blockedBy: undefined,
    }))).toEqual({ isSafetyBlock: false, isEvalError: false });
  });
});
