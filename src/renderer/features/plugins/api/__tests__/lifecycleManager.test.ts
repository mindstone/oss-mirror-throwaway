import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLifecycleManager } from '../lifecycleManager';

describe('lifecycleManager', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers and cleans up intervals', () => {
    vi.useFakeTimers();
    const lm = createLifecycleManager();
    const cb = vi.fn();

    lm.registerInterval(cb, 100);
    vi.advanceTimersByTime(350);
    expect(cb).toHaveBeenCalledTimes(3);

    lm.cleanup();
    vi.advanceTimersByTime(300);
    expect(cb).toHaveBeenCalledTimes(3);
  });

  it('registers and cleans up timeouts', () => {
    vi.useFakeTimers();
    const lm = createLifecycleManager();
    const cb = vi.fn();

    lm.registerTimeout(cb, 100);
    lm.cleanup();
    vi.advanceTimersByTime(200);
    expect(cb).not.toHaveBeenCalled();
  });

  it('removes naturally executed timeouts from cleanup tracking', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    const lm = createLifecycleManager();
    const cb = vi.fn();

    lm.registerTimeout(cb, 100);
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledTimes(1);

    clearTimeoutSpy.mockClear();
    lm.cleanup();
    expect(clearTimeoutSpy).not.toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('registers and cleans up subscriptions', () => {
    const lm = createLifecycleManager();
    const unsub = vi.fn();

    lm.registerSubscription(unsub);
    lm.cleanup();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it('handles subscription cleanup errors gracefully', () => {
    const lm = createLifecycleManager();
    const badUnsub = vi.fn(() => { throw new Error('boom'); });
    const goodUnsub = vi.fn();

    lm.registerSubscription(badUnsub);
    lm.registerSubscription(goodUnsub);

    expect(() => lm.cleanup()).not.toThrow();
    expect(badUnsub).toHaveBeenCalledTimes(1);
    expect(goodUnsub).toHaveBeenCalledTimes(1);
  });

  it('is safe to call cleanup multiple times', () => {
    const lm = createLifecycleManager();
    const unsub = vi.fn();
    lm.registerSubscription(unsub);

    lm.cleanup();
    lm.cleanup();
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
