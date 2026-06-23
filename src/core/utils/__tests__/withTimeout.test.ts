import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWithTimeout } from '../withTimeout';

describe('runWithTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves the work value when it settles before the deadline', async () => {
    const promise = runWithTimeout({
      timeoutMs: 1000,
      work: async () => 'done',
      onTimeout: () => 'sentinel',
    });
    await vi.advanceTimersByTimeAsync(0);
    const result = await promise;
    expect(result.value).toBe('done');
    expect(result.timedOut).toBe(false);
  });

  it('resolves to the sentinel (never throws) when the work never resolves', async () => {
    const neverResolves = new Promise<string>(() => {
      /* intentionally never settles */
    });
    const promise = runWithTimeout({
      timeoutMs: 500,
      work: () => neverResolves,
      onTimeout: () => 'sentinel',
    });
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;
    expect(result.value).toBe('sentinel');
    expect(result.timedOut).toBe(true);
  });

  it('aborts the work signal when the deadline fires (cancellable I/O can stop)', async () => {
    let observedAborted = false;
    const promise = runWithTimeout({
      timeoutMs: 300,
      work: (signal) =>
        new Promise<string>(() => {
          signal.addEventListener('abort', () => {
            observedAborted = true;
          });
        }),
      onTimeout: () => 'sentinel',
    });
    await vi.advanceTimersByTimeAsync(300);
    await promise;
    expect(observedAborted).toBe(true);
  });

  it('propagates a rejection from the work (caller keeps its own try/catch)', async () => {
    const promise = runWithTimeout({
      timeoutMs: 1000,
      work: async () => {
        throw new Error('boom');
      },
      onTimeout: () => 'sentinel',
    });
    const assertion = expect(promise).rejects.toThrow('boom');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });

  it('propagates a synchronous throw from the work as a rejection', async () => {
    const promise = runWithTimeout({
      timeoutMs: 1000,
      work: () => {
        throw new Error('sync-boom');
      },
      onTimeout: () => 'sentinel',
    });
    const assertion = expect(promise).rejects.toThrow('sync-boom');
    await vi.advanceTimersByTimeAsync(0);
    await assertion;
  });
});
