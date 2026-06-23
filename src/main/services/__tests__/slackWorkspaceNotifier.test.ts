import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SLACK_WORKSPACE_CHANGED_CHANNEL } from '@shared/ipc/channels/slack';

const { mockSendToAllWindows, mockWarn } = vi.hoisted(() => ({
  mockSendToAllWindows: vi.fn(),
  mockWarn: vi.fn(),
}));

 
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: () => ({ sendToAllWindows: mockSendToAllWindows, sendToFocusedWindow: vi.fn() }),
}));

 
vi.mock('@core/logger', () => ({
  logger: {
    warn: mockWarn,
  },
}));

import { notifySlackWorkspaceConnected } from '../slackWorkspaceNotifier';

describe('notifySlackWorkspaceConnected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts a connected workspace payload', () => {
    const result = notifySlackWorkspaceConnected('T123', 'Mindstone');

    expect(result).toBe(true);
    expect(mockSendToAllWindows).toHaveBeenCalledTimes(1);
    const [channel, payload] = mockSendToAllWindows.mock.calls[0];
    expect(channel).toBe(SLACK_WORKSPACE_CHANGED_CHANNEL);
    expect(payload).toMatchObject({
      teamId: 'T123',
      teamName: 'Mindstone',
      status: 'connected',
    });
    expect(payload.occurredAt).toEqual(expect.any(Number));
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('logs and continues when broadcast fails', () => {
    mockSendToAllWindows.mockImplementationOnce(() => {
      throw new Error('broadcast failed');
    });

    const result = notifySlackWorkspaceConnected('T999', 'Acme');
    expect(result).toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      { err: expect.any(Error), teamId: 'T999', teamName: 'Acme' },
      'Failed to broadcast Slack workspace changed event',
    );
  });
});
