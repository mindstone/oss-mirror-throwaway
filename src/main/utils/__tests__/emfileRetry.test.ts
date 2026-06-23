import { describe, expect, it, vi } from 'vitest';
import { withRetryOnEmfile } from '../emfileRetry';

describe('withRetryOnEmfile', () => {
  it('retries on EMFILE then succeeds', async () => {
    vi.useFakeTimers();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('too many open files'), { code: 'EMFILE' }))
      .mockRejectedValueOnce(Object.assign(new Error('too many open files'), { code: 'EMFILE' }))
      .mockResolvedValueOnce('ok');

    const promise = withRetryOnEmfile(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10, random: () => 0.5 });
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);

    vi.useRealTimers();
  });

  it('does not retry on non-EMFILE errors', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error('nope'), { code: 'EACCES' }));

    await expect(withRetryOnEmfile(fn, { maxAttempts: 3 })).rejects.toThrow('nope');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
