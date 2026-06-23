import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withRendererTimeout, type LateSettleOutcome } from '../withRendererTimeout';

/**
 * Behavioral contract tests for the renderer timeout utility extracted in
 * Stage 1 of `docs/plans/260427_di_a_di_c_renderer_timeout_utility_and_telemetry.md`.
 *
 * Integration test coverage for the AutoLoadImage adoption lives in
 * `src/renderer/components/__tests__/MessageMarkdown.test.tsx` (T21/T21a/T21b).
 */

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const createDeferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('withRendererTimeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('WT-1 resolves with the inner value when inner settles before timeout', async () => {
    const inner = createDeferred<string>();
    const onLateSettle = vi.fn();
    const wrapped = withRendererTimeout(inner.promise, { timeoutMs: 1000, onLateSettle });

    inner.resolve('happy');
    await expect(wrapped).resolves.toBe('happy');

    // Advance past the timeout to confirm late-settle observer is NOT invoked
    // and the timer no longer fires.
    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    expect(onLateSettle).not.toHaveBeenCalled();
  });

  it('WT-2 rejects with errorFactory output on timeout (default factory: Error("timeout"))', async () => {
    const inner = createDeferred<string>();
    const wrapped = withRendererTimeout(inner.promise, { timeoutMs: 100 });
    // Pre-attach the rejection handler BEFORE advancing the timer, so the
    // synchronous timer-fire reject doesn't surface as an unhandled rejection.
    const assertion = expect(wrapped).rejects.toThrow('timeout');

    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    await expect(wrapped).rejects.toBeInstanceOf(Error);
  });

  it('WT-2b rejects with errorFactory output on timeout (custom factory receives timeoutMs)', async () => {
    class CustomTimeoutError extends Error {
      constructor(public readonly ms: number) {
        super(`custom timeout after ${ms}ms`);
        this.name = 'CustomTimeoutError';
      }
    }

    const inner = createDeferred<string>();
    const wrapped = withRendererTimeout(inner.promise, {
      timeoutMs: 250,
      errorFactory: (ms) => new CustomTimeoutError(ms),
    });
    const assertion = expect(wrapped).rejects.toBeInstanceOf(CustomTimeoutError);

    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    await expect(wrapped).rejects.toMatchObject({ ms: 250, message: 'custom timeout after 250ms' });
  });

  it('WT-3 rejects with the inner error when inner rejects before timeout', async () => {
    const inner = createDeferred<string>();
    const onLateSettle = vi.fn();
    const wrapped = withRendererTimeout(inner.promise, { timeoutMs: 1000, onLateSettle });

    const innerError = new Error('inner failure');
    inner.reject(innerError);

    await expect(wrapped).rejects.toBe(innerError);

    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    expect(onLateSettle).not.toHaveBeenCalled();
  });

  it('WT-4 onLateSettle fires once with kind:success when inner resolves AFTER timer fired', async () => {
    const inner = createDeferred<string>();
    const onLateSettle = vi.fn();
    const wrapped = withRendererTimeout(inner.promise, { timeoutMs: 100, onLateSettle });
    const assertion = expect(wrapped).rejects.toThrow('timeout');

    // Trigger the timeout first.
    await vi.advanceTimersByTimeAsync(150);
    await assertion;

    expect(onLateSettle).not.toHaveBeenCalled();

    // Now the inner promise settles late.
    inner.resolve('late');
    await flushMicrotasks();

    expect(onLateSettle).toHaveBeenCalledTimes(1);
    expect(onLateSettle).toHaveBeenCalledWith({ kind: 'success' } satisfies LateSettleOutcome);
  });

  it('WT-5 onLateSettle fires once with kind:error preserving error identity when inner late-rejects', async () => {
    const inner = createDeferred<string>();
    const onLateSettle = vi.fn();
    const wrapped = withRendererTimeout(inner.promise, { timeoutMs: 100, onLateSettle });
    const assertion = expect(wrapped).rejects.toThrow('timeout');

    await vi.advanceTimersByTimeAsync(150);
    await assertion;

    const lateError = new Error('late inner failure');
    inner.reject(lateError);
    await flushMicrotasks();

    expect(onLateSettle).toHaveBeenCalledTimes(1);
    const arg = onLateSettle.mock.calls[0]?.[0] as LateSettleOutcome;
    expect(arg.kind).toBe('error');
    if (arg.kind === 'error') {
      expect(arg.error).toBe(lateError); // identity preserved
    }
  });

  it('WT-6 onLateSettle does NOT fire when inner settles before timer (success)', async () => {
    const inner = createDeferred<string>();
    const onLateSettle = vi.fn();
    const wrapped = withRendererTimeout(inner.promise, { timeoutMs: 1000, onLateSettle });

    inner.resolve('early');
    await expect(wrapped).resolves.toBe('early');

    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    expect(onLateSettle).not.toHaveBeenCalled();
  });

  it('WT-6b onLateSettle does NOT fire when inner settles before timer (error)', async () => {
    const inner = createDeferred<string>();
    const onLateSettle = vi.fn();
    const wrapped = withRendererTimeout(inner.promise, { timeoutMs: 1000, onLateSettle });

    inner.reject(new Error('early failure'));
    await expect(wrapped).rejects.toThrow('early failure');

    await vi.advanceTimersByTimeAsync(2000);
    await flushMicrotasks();

    expect(onLateSettle).not.toHaveBeenCalled();
  });

  it('WT-7 throwing inside onLateSettle is caught and logged, no unhandled rejection', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const unhandledRejections: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => {
      unhandledRejections.push(event.reason);
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('unhandledrejection', onUnhandled);
    }

    try {
      const inner = createDeferred<string>();
      const wrapped = withRendererTimeout(inner.promise, {
        timeoutMs: 100,
        onLateSettle: () => {
          throw new Error('boom from observer');
        },
      });
      const assertion = expect(wrapped).rejects.toThrow('timeout');

      await vi.advanceTimersByTimeAsync(150);
      await assertion;

      inner.resolve('late');
      await flushMicrotasks();

      // Defensive log fired with the kind + error message.
      const warnCall = consoleWarnSpy.mock.calls.find(
        (call) => call[0] === '[withRendererTimeout] late-settle observer threw',
      );
      expect(warnCall).toBeDefined();
      expect(warnCall?.[1]).toEqual(expect.objectContaining({
        kind: 'success',
        err: 'boom from observer',
      }));
      expect(unhandledRejections).toHaveLength(0);
    } finally {
      if (typeof window !== 'undefined') {
        window.removeEventListener('unhandledrejection', onUnhandled);
      }
    }
  });
});
