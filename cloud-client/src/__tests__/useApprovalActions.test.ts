import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useApprovalActions } from '../hooks/useApprovalActions';
import { useApprovalStore } from '../stores/approvalStore';
import type { MemoryWriteApproval } from '../types';
import { asCloudMeetingSessionId } from '../types/liveMeetingIds';

const mockCreateAgentTurnSocket = vi.hoisted(() => vi.fn());
const mockIpcCall = vi.hoisted(() => vi.fn());

vi.mock('../cloudClient', () => ({
  createAgentTurnSocket: (...args: unknown[]) => mockCreateAgentTurnSocket(...args),
  ipcCall: (...args: unknown[]) => mockIpcCall(...args),
}));

function buildMemoryApproval(overrides: Partial<MemoryWriteApproval> = {}): MemoryWriteApproval {
  return {
    toolUseId: 'memory-approval-1',
    originalTurnId: 'turn-1',
    originalSessionId: 'session-fallback',
    spaceName: 'Memory',
    spacePath: 'memory/notes.md',
    filePath: 'memory/notes.md',
    summary: 'Save memory',
    contentPreview: 'Preview',
    timestamp: Date.now(),
    sharing: 'private',
    isNewFile: false,
    blockedBy: 'safety_prompt',
    ...overrides,
  };
}

describe('useApprovalActions continuation metadata', () => {
  beforeEach(() => {
    useApprovalStore.getState().resetStore();
    mockCreateAgentTurnSocket.mockReset();
    mockIpcCall.mockReset();
    mockCreateAgentTurnSocket.mockReturnValue({ close: vi.fn() });
  });

  it('includes meeting fields when active recording session matches continuation target', async () => {
    const getContinuationTurnMetadata = vi.fn((targetSessionId: string) => {
      if (targetSessionId !== 'session-a') return {};
      return {
        meetingSessionId: asCloudMeetingSessionId('cloud-meet-123'),
        recordingActive: true,
      };
    });
    mockIpcCall.mockResolvedValue({
      success: true,
      originalSessionId: 'session-a',
      filePath: 'memory/notes.md',
      spaceName: 'Memory',
      content: 'Approved content',
    });

    const { result } = renderHook(() =>
      useApprovalActions({ getContinuationTurnMetadata }),
    );

    await act(async () => {
      await result.current.approveMemoryWrite(buildMemoryApproval());
    });

    expect(getContinuationTurnMetadata).toHaveBeenCalledWith('session-a');
    const request = mockCreateAgentTurnSocket.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      sessionId: 'session-a',
      isSystemContinuation: true,
      meetingSessionId: 'cloud-meet-123',
      recordingActive: true,
    });
    expect(request.clientTurnId).toEqual(expect.any(String));
  });

  it('omits meeting fields when active recording belongs to a different session', async () => {
    const getContinuationTurnMetadata = vi.fn((targetSessionId: string) => {
      if (targetSessionId !== 'session-a') return {};
      return {
        meetingSessionId: asCloudMeetingSessionId('cloud-meet-123'),
        recordingActive: true,
      };
    });
    mockIpcCall.mockResolvedValue({
      success: true,
      originalSessionId: 'session-b',
      filePath: 'memory/notes.md',
      spaceName: 'Memory',
      content: 'Approved content',
    });

    const { result } = renderHook(() =>
      useApprovalActions({ getContinuationTurnMetadata }),
    );

    await act(async () => {
      await result.current.approveMemoryWrite(buildMemoryApproval());
    });

    expect(getContinuationTurnMetadata).toHaveBeenCalledWith('session-b');
    const request = mockCreateAgentTurnSocket.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      sessionId: 'session-b',
      isSystemContinuation: true,
    });
    expect(request.clientTurnId).toEqual(expect.any(String));
    expect(request).not.toHaveProperty('meetingSessionId');
    expect(request).not.toHaveProperty('recordingActive');
  });

  it('omits meeting fields when no recording metadata supplier is configured', async () => {
    mockIpcCall.mockResolvedValue({
      success: true,
      filePath: 'memory/notes.md',
      spaceName: 'Memory',
      content: 'Approved content',
    });

    const { result } = renderHook(() => useApprovalActions());

    await act(async () => {
      await result.current.approveMemoryWrite(
        buildMemoryApproval({ originalSessionId: 'session-c' }),
      );
    });

    const request = mockCreateAgentTurnSocket.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      sessionId: 'session-c',
      isSystemContinuation: true,
    });
    expect(request.clientTurnId).toEqual(expect.any(String));
    expect(request).not.toHaveProperty('meetingSessionId');
    expect(request).not.toHaveProperty('recordingActive');
  });
});
