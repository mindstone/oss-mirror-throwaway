import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllPendingApprovals,
  clearSessionSingleUseApprovals,
  addPendingApproval,
  consumeSingleUseApproval,
  getPendingApprovals,
} from '../index';
import {
  clearPendingApprovalMetadata,
  getPendingToolApprovalMetadata,
  handleApprovalResponse,
  registerCloudApprovalMetadata,
} from '../../toolSafetyService';

describe('tool safety approval recovery', () => {
  beforeEach(() => {
    clearAllPendingApprovals();
    clearSessionSingleUseApprovals('session-1');
    clearSessionSingleUseApprovals('session-2');
    clearPendingApprovalMetadata(['tool-1', 'tool-2', 'tool-3', 'tool-4', 'tool-5']);
  });

  it('uses persisted effectiveToolId when recovering approval metadata', () => {
    addPendingApproval({
      toolUseID: 'tool-1',
      turnId: 'turn-1',
      sessionId: 'session-1',
      toolName: 'mcp__super-mcp-router__use_tool',
      input: {},
      effectiveToolId: 'gmail.send_email',
      timestamp: Date.now(),
    });

    const metadata = getPendingToolApprovalMetadata('tool-1');

    expect(metadata).toEqual({
      sessionId: 'session-1',
      toolIdentifier: 'gmail.send_email',
    });
  });

  it('stores single-use approval using persisted effectiveToolId after restart-style recovery', () => {
    addPendingApproval({
      toolUseID: 'tool-2',
      turnId: 'turn-2',
      sessionId: 'session-1',
      toolName: 'mcp__super-mcp-router__use_tool',
      input: {},
      effectiveToolId: 'gmail.send_email',
      timestamp: Date.now(),
    });

    handleApprovalResponse('tool-2', true, {});

    expect(consumeSingleUseApproval('tool', 'session-1', 'gmail.send_email')).toBe(true);
  });

  it('preserves cloud-provided effectiveToolId across local persistence recovery', () => {
    registerCloudApprovalMetadata({
      toolUseID: 'tool-3',
      turnId: 'turn-3',
      sessionId: 'session-2',
      toolName: 'mcp__super-mcp-router__use_tool',
      input: {
        attachments: [
          { name: 'file.pdf', data: 'A'.repeat(2000) },
        ],
      },
      effectiveToolId: 'gmail.send_email',
      timestamp: Date.now(),
    });

    clearPendingApprovalMetadata(['tool-3']);

    const metadata = getPendingToolApprovalMetadata('tool-3');

    expect(metadata).toEqual({
      sessionId: 'session-2',
      toolIdentifier: 'gmail.send_email',
    });
  });

  it.each([
    {
      toolUseID: 'tool-4',
      blockedBy: undefined,
    },
    {
      toolUseID: 'tool-5',
      blockedBy: 'eval_error',
    },
  ])(
    'drops fail-closed cloud ingress approval metadata even when blockedBy=$blockedBy',
    ({ toolUseID, blockedBy }) => {
      registerCloudApprovalMetadata({
        toolUseID,
        turnId: 'turn-fc',
        sessionId: 'session-fc',
        toolName: 'Bash',
        input: { command: 'echo hi' },
        reason: 'Safety evaluator unavailable',
        failClosed: true,
        ...(blockedBy ? { blockedBy } : {}),
      });

      expect(getPendingToolApprovalMetadata(toolUseID)).toBeUndefined();
      expect(getPendingApprovals()).toEqual([]);
    },
  );
});
