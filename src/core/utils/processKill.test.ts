import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExec = vi.fn();

vi.mock('node:child_process', () => ({
  exec: (...args: unknown[]) => mockExec(...args),
}));

vi.mock('@core/logger', () => ({
  createScopedLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { killProcessTreeGracefully } from './processKill';

describe.skipIf(process.platform === 'win32')('killProcessTreeGracefully', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockExec.mockReset();
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    processKillSpy.mockRestore();
    vi.useRealTimers();
  });

  it('resolves after the grace window when escalation succeeds', async () => {
    const onEscalated = vi.fn();
    mockExec.mockImplementation((_command: string, callback: (error: Error | null) => void) => {
      callback(null);
      return {};
    });

    const result = killProcessTreeGracefully(12_345, { gracePeriodMs: 250, onEscalated });

    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toBeUndefined();
    expect(onEscalated).toHaveBeenCalledTimes(1);
    expect(processKillSpy).toHaveBeenCalledWith(-12_345, 'SIGTERM');
    expect(processKillSpy).toHaveBeenCalledWith(-12_345, 'SIGKILL');
    expect(processKillSpy).toHaveBeenCalledWith(12_345, 'SIGKILL');
  });

  it('rejects after the grace window when escalation fails instead of hanging', async () => {
    const escalationFailure = new Error('pkill spawn failed');
    mockExec.mockImplementation(() => {
      throw escalationFailure;
    });

    const result = killProcessTreeGracefully(12_345, { gracePeriodMs: 250 });
    const rejectionExpectation = expect(result).rejects.toThrow('pkill spawn failed');

    await vi.advanceTimersByTimeAsync(250);

    await rejectionExpectation;
  });
});
