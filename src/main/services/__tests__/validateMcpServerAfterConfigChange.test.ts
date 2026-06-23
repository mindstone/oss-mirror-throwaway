import { beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestPlatformConfig } from '@core/__tests__/testHelpers';

describe('validateMcpServerAfterConfigChange — bounded post-save budget', () => {
  beforeEach(async () => {
    vi.resetModules();
    await initTestPlatformConfig();
  });

  it('returns ok on the first attempt and threads the post-save timeoutMs to the probe', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ health: 'ok' as const });
    const { validateMcpServerAfterConfigChange } = await import('../mcpService');

    const result = await validateMcpServerAfterConfigChange('Gamma', { delayMs: 1, timeoutMs: 250, probe });

    expect(result).toEqual({ status: 'ok' });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith('Gamma', { timeoutMs: 250 });
  });

  it('classifies unavailable after the bounded attempt budget when health stays unknown', async () => {
    const probe = vi.fn().mockResolvedValue({ health: 'unknown' as const });
    const { validateMcpServerAfterConfigChange } = await import('../mcpService');

    const result = await validateMcpServerAfterConfigChange('Gamma', {
      attempts: 3,
      delayMs: 1,
      timeoutMs: 50,
      probe,
    });

    expect(result.status).toBe('unavailable');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('returns error early without exhausting attempts when health reports error', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ health: 'error' as const, error: 'bad creds' });
    const { validateMcpServerAfterConfigChange } = await import('../mcpService');

    const result = await validateMcpServerAfterConfigChange('Gamma', {
      attempts: 5,
      delayMs: 1,
      timeoutMs: 50,
      probe,
    });

    expect(result).toEqual({ status: 'error', error: 'bad creds' });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('uses a tight default timeoutMs (well under the bulk health-check budget)', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ health: 'ok' as const });
    const { validateMcpServerAfterConfigChange } = await import('../mcpService');

    await validateMcpServerAfterConfigChange('Gamma', { delayMs: 1, probe });

    const passedTimeout = probe.mock.calls[0]![1].timeoutMs;
    expect(passedTimeout).toBeLessThanOrEqual(1000);
    expect(passedTimeout).toBeGreaterThan(0);
  });
});
