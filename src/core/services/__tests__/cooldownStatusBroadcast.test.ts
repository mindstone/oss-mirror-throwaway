import { beforeEach, describe, expect, it, vi } from 'vitest';

 
vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

 
vi.mock('@core/broadcastService', () => ({
  getBroadcastService: vi.fn(),
}));

const { getBroadcastService } = await import('@core/broadcastService');
const { broadcastCooldownStatus, COOLDOWN_STATUS_CHANNEL } = await import('../cooldownStatusBroadcast');

const mockGetBroadcastService = vi.mocked(getBroadcastService);

describe('broadcastCooldownStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('broadcasts cooldown status payloads to all windows', () => {
    const sendToAllWindows = vi.fn();
    mockGetBroadcastService.mockReturnValue({
      sendToAllWindows,
      sendToFocusedWindow: vi.fn(),
    });
    const payload = {
      scope: 'api' as const,
      state: 'entered' as const,
      untilMs: 1_800_000_000_000,
      durationMs: 60_000,
    };

    broadcastCooldownStatus(payload);

    expect(sendToAllWindows).toHaveBeenCalledOnce();
    expect(sendToAllWindows).toHaveBeenCalledWith(COOLDOWN_STATUS_CHANNEL, payload);
  });

  it('silently no-ops when the broadcast service is not initialized', () => {
    mockGetBroadcastService.mockImplementation(() => {
      throw new Error('BroadcastService not initialized');
    });

    expect(() => {
      broadcastCooldownStatus({ scope: 'api', state: 'exited' });
    }).not.toThrow();
  });
});
