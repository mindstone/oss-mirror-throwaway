import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setErrorReporter } from '@core/errorReporter';
import {
  getSessionMutex,
  resetSessionMutexForTests,
  SessionMutexDeadlockError,
} from '../sessionMutex';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type PromiseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

type TestKeyState = {
  locked: boolean;
  ownerToken: number | null;
  ownerLabel: string | null;
  ownerAcquiredAt: number | null;
  queue: unknown[];
};

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function captureOutcome<T>(promise: Promise<T>): Promise<PromiseOutcome<T>> {
  return promise
    .then((value) => ({ ok: true as const, value }))
    .catch((error: unknown) => ({ ok: false as const, error }));
}

function getTestState(key: string): TestKeyState | undefined {
  const mutex = getSessionMutex();
  return (mutex as unknown as { states: Map<string, TestKeyState> }).states.get(key);
}

const breadcrumbs: Array<{ message: string; level?: string; data?: Record<string, unknown> }> = [];
const capturedMessages: Array<{ message: string; context?: Record<string, unknown> }> = [];

describe('sessionMutex', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSessionMutexForTests();
    breadcrumbs.length = 0;
    capturedMessages.length = 0;

    setErrorReporter({
      captureException: () => {},
      captureMessage: (message, context) => {
        capturedMessages.push({ message, context });
      },
      addBreadcrumb: (breadcrumb) => {
        breadcrumbs.push({
          message: breadcrumb.message,
          level: breadcrumb.level,
          data: breadcrumb.data,
        });
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSessionMutexForTests();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {},
    });
  });

  it('serializes calls on the same key', async () => {
    const mutex = getSessionMutex();
    const firstGate = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    let secondStarted = false;

    const first = mutex.withLock('s1', async () => {
      firstEntered.resolve();
      await firstGate.promise;
    });

    await firstEntered.promise;

    const second = mutex.withLock('s1', async () => {
      secondStarted = true;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(false);

    firstGate.resolve();
    await Promise.all([first, second]);
    expect(secondStarted).toBe(true);
  });

  it('allows different keys to proceed in parallel', async () => {
    const mutex = getSessionMutex();
    const firstGate = createDeferred<void>();
    const firstEntered = createDeferred<void>();
    let secondStarted = false;

    const first = mutex.withLock('s1', async () => {
      firstEntered.resolve();
      await firstGate.promise;
    });
    await firstEntered.promise;

    const second = mutex.withLock('s2', async () => {
      secondStarted = true;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(true);

    firstGate.resolve();
    await Promise.all([first, second]);
  });

  it('releases the lock when fn throws', async () => {
    const mutex = getSessionMutex();

    await expect(
      mutex.withLock('s1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(
      mutex.withLock('s1', async () => 'ok'),
    ).resolves.toBe('ok');
  });

  it('emits contention breadcrumb when wait exceeds threshold', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();
    const firstGate = createDeferred<void>();

    const first = mutex.withLock('s1', async () => {
      await firstGate.promise;
    });
    await Promise.resolve();

    const second = mutex.withLock('s1', async () => 'done', {
      label: 'contention-test',
    });

    await vi.advanceTimersByTimeAsync(250);
    firstGate.resolve();
    await first;
    await second;

    const contention = breadcrumbs.find((breadcrumb) => breadcrumb.message === 'session-mutex-contention');
    expect(contention).toBeDefined();
    expect(contention?.data).toMatchObject({
      kind: 'session-mutex-contention',
      reason: 'session-mutex-contention',
      label: 'contention-test',
      waitedMs: expect.any(Number),
      sessionIdHash: expect.any(String),
    });
    expect((contention?.data?.waitedMs as number) > 200).toBe(true);
  });

  it('does not evict a live holder on waiter timeout or overlap critical sections', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    let subsequentEntered = false;

    const enter = (): void => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    };
    const exit = (): void => {
      inFlight -= 1;
    };

    const holder = mutex.withLock('s-live-holder', async () => {
      enter();
      holderEntered.resolve();
      try {
        await holderGate.promise;
        return 'holder';
      } finally {
        exit();
      }
    }, {
      label: 'holder-A',
    });
    await holderEntered.promise;

    const timedOutWaiter = mutex.withLock('s-live-holder', async () => {
      enter();
      try {
        return 'waiter';
      } finally {
        exit();
      }
    }, {
      deadlockTimeoutMs: 10,
      label: 'waiter-B',
    });
    const timedOutWaiterOutcome = captureOutcome(timedOutWaiter);

    await vi.advanceTimersByTimeAsync(11);
    const outcome = await timedOutWaiterOutcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(SessionMutexDeadlockError);
    }

    const subsequent = mutex.withLock('s-live-holder', async () => {
      subsequentEntered = true;
      enter();
      try {
        return 'subsequent';
      } finally {
        exit();
      }
    }, {
      deadlockTimeoutMs: 0,
      label: 'waiter-C',
    });
    await Promise.resolve();

    // This is a real regression guard: the pre-fix timeout stole the lock, so
    // this subsequent waiter would enter here while the holder gate was closed.
    expect(subsequentEntered).toBe(false);
    expect(maxInFlight).toBe(1);

    holderGate.resolve();
    await expect(holder).resolves.toBe('holder');
    await expect(subsequent).resolves.toBe('subsequent');
    expect(maxInFlight).toBe(1);
  });

  it('removes only the timed-out waiter and preserves FIFO queue integrity', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();
    let inFlight = 0;
    let maxInFlight = 0;
    let cEntered = false;

    const enter = (): void => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
    };
    const exit = (): void => {
      inFlight -= 1;
    };

    const holder = mutex.withLock('s-queue', async () => {
      enter();
      holderEntered.resolve();
      try {
        await holderGate.promise;
        return 'A';
      } finally {
        exit();
      }
    }, {
      label: 'holder-A',
    });
    await holderEntered.promise;

    const timedOut = mutex.withLock('s-queue', async () => {
      enter();
      try {
        return 'B';
      } finally {
        exit();
      }
    }, {
      deadlockTimeoutMs: 10,
      label: 'waiter-B',
    });
    const timedOutOutcome = captureOutcome(timedOut);

    const remaining = mutex.withLock('s-queue', async () => {
      cEntered = true;
      enter();
      try {
        return 'C';
      } finally {
        exit();
      }
    }, {
      deadlockTimeoutMs: 0,
      label: 'waiter-C',
    });

    await vi.advanceTimersByTimeAsync(11);
    const outcome = await timedOutOutcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(SessionMutexDeadlockError);
    }

    expect(cEntered).toBe(false);
    expect(maxInFlight).toBe(1);
    expect(getTestState('s-queue')?.queue).toHaveLength(1);

    holderGate.resolve();
    await expect(holder).resolves.toBe('A');
    await expect(remaining).resolves.toBe('C');
    expect(maxInFlight).toBe(1);
    expect(getTestState('s-queue')).toBeUndefined();
  });

  it('preserves the holder owner token when a waiter times out', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();

    const holder = mutex.withLock('s-token', async () => {
      holderEntered.resolve();
      await holderGate.promise;
      return 'holder';
    }, {
      label: 'holder-A',
    });
    await holderEntered.promise;

    const tokenBeforeTimeout = getTestState('s-token')?.ownerToken;
    expect(tokenBeforeTimeout).toEqual(expect.any(Number));

    const timedOut = mutex.withLock('s-token', async () => 'waiter', {
      deadlockTimeoutMs: 10,
      label: 'waiter-B',
    });
    const timedOutOutcome = captureOutcome(timedOut);

    await vi.advanceTimersByTimeAsync(11);
    const outcome = await timedOutOutcome;
    expect(outcome.ok).toBe(false);
    expect(getTestState('s-token')).toMatchObject({
      locked: true,
      ownerToken: tokenBeforeTimeout,
      ownerLabel: 'holder-A',
    });

    holderGate.resolve();
    await expect(holder).resolves.toBe('holder');
    expect(getTestState('s-token')).toBeUndefined();
  });

  it('disables waiter timeout when deadlockTimeoutMs is zero or negative', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();
    let waiterEntered = false;
    let waiterSettled = false;

    const holder = mutex.withLock('s-timeout-disabled', async () => {
      holderEntered.resolve();
      await holderGate.promise;
      return 'holder';
    });
    await holderEntered.promise;

    const waiter = mutex.withLock('s-timeout-disabled', async () => {
      waiterEntered = true;
      return 'waiter';
    }, {
      deadlockTimeoutMs: 0,
      label: 'disabled-timeout',
    });
    waiter.then(
      () => {
        waiterSettled = true;
      },
      () => {
        waiterSettled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    expect(waiterEntered).toBe(false);
    expect(waiterSettled).toBe(false);

    holderGate.resolve();
    await expect(holder).resolves.toBe('holder');
    await expect(waiter).resolves.toBe('waiter');
    expect(waiterEntered).toBe(true);
  });

  it('emits deadlock breadcrumb and capture with distinct holder attribution', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();
    const firstGate = createDeferred<void>();
    const firstEntered = createDeferred<void>();

    const first = mutex.withLock('s1', async () => {
      firstEntered.resolve();
      await firstGate.promise;
      return 'first';
    }, {
      label: 'holder-label',
    });
    await firstEntered.promise;

    const second = mutex.withLock('s1', async () => 'second', {
      deadlockTimeoutMs: 10,
      label: 'waiter-label',
    });
    const secondHandled = captureOutcome(second);

    await vi.advanceTimersByTimeAsync(11);

    const secondOutcome = await secondHandled;
    expect(secondOutcome.ok).toBe(false);
    if (!secondOutcome.ok) {
      expect(secondOutcome.error).toBeInstanceOf(SessionMutexDeadlockError);
      expect(secondOutcome.error).toMatchObject({
        key: 's1',
        deadlockTimeoutMs: 10,
        label: 'waiter-label',
      });
    }

    const deadlock = breadcrumbs.find((breadcrumb) => breadcrumb.message === 'session-mutex-deadlock');
    expect(deadlock).toBeDefined();
    expect(deadlock?.level).toBe('error');
    expect(deadlock?.data).toMatchObject({
      kind: 'session-mutex-deadlock',
      reason: 'session-mutex-deadlock',
      label: 'waiter-label',
      holderLabel: 'holder-label',
      heldMs: expect.any(Number),
      queueDepth: 0,
      waitedMs: expect.any(Number),
      sessionIdHash: expect.any(String),
    });
    expect(deadlock?.data?.label).not.toBe(deadlock?.data?.holderLabel);
    expect((deadlock?.data?.heldMs as number) > 0).toBe(true);

    expect(capturedMessages.length).toBeGreaterThan(0);
    expect(capturedMessages[0]?.message).toBe('Session mutex deadlock detected');
    expect(capturedMessages[0]?.context).toMatchObject({
      level: 'error',
      tags: {
        continuity_event: 'continuity-state:session-mutex-deadlock',
      },
      extra: {
        label: 'waiter-label',
        holderLabel: 'holder-label',
        heldMs: expect.any(Number),
        queueDepth: 0,
      },
    });
    const extra = capturedMessages[0]?.context?.extra as Record<string, unknown> | undefined;
    expect((extra?.heldMs as number) > 0).toBe(true);

    firstGate.resolve();
    await expect(first).resolves.toBe('first');
  });

  it('clears holder metadata before a later contention episode on the same key', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();

    await expect(
      mutex.withLock('s-metadata-cleanup', async () => 'first', {
        label: 'first-holder',
      }),
    ).resolves.toBe('first');
    expect(getTestState('s-metadata-cleanup')).toBeUndefined();

    const secondHolderGate = createDeferred<void>();
    const secondHolderEntered = createDeferred<void>();
    const secondHolder = mutex.withLock('s-metadata-cleanup', async () => {
      secondHolderEntered.resolve();
      await secondHolderGate.promise;
      return 'second-holder';
    });
    await secondHolderEntered.promise;

    const timedOut = mutex.withLock('s-metadata-cleanup', async () => 'waiter', {
      deadlockTimeoutMs: 10,
      label: 'second-waiter',
    });
    const timedOutOutcome = captureOutcome(timedOut);

    await vi.advanceTimersByTimeAsync(11);
    const outcome = await timedOutOutcome;
    expect(outcome.ok).toBe(false);

    const extra = capturedMessages[0]?.context?.extra as Record<string, unknown> | undefined;
    expect(extra?.label).toBe('second-waiter');
    expect(extra?.holderLabel).toBeNull();
    expect(extra?.holderLabel).not.toBe('first-holder');

    secondHolderGate.resolve();
    await expect(secondHolder).resolves.toBe('second-holder');
  });

  it('keeps subsequent waiters pending after a timeout until the holder releases', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();
    let subsequentEntered = false;

    const holder = mutex.withLock('s-subsequent', async () => {
      holderEntered.resolve();
      await holderGate.promise;
      return 'holder';
    });
    await holderEntered.promise;

    const timedOut = mutex.withLock('s-subsequent', async () => 'timed-out', {
      deadlockTimeoutMs: 10,
      label: 'timed-out-waiter',
    });
    const timedOutOutcome = captureOutcome(timedOut);

    await vi.advanceTimersByTimeAsync(11);
    const outcome = await timedOutOutcome;
    expect(outcome.ok).toBe(false);

    const subsequent = mutex.withLock('s-subsequent', async () => {
      subsequentEntered = true;
      return 'subsequent';
    }, {
      deadlockTimeoutMs: 0,
    });
    await Promise.resolve();
    expect(subsequentEntered).toBe(false);

    holderGate.resolve();
    await expect(holder).resolves.toBe('holder');
    await expect(subsequent).resolves.toBe('subsequent');
    expect(subsequentEntered).toBe(true);
  });

  it('runs 100 concurrent calls for the same key in FIFO order', async () => {
    const mutex = getSessionMutex();
    const order: number[] = [];

    const promises = Array.from({ length: 100 }, (_, i) =>
      mutex.withLock('s1', async () => {
        order.push(i);
        await Promise.resolve();
        return i;
      }),
    );

    const results = await Promise.all(promises);
    expect(order).toEqual([...Array(100).keys()]);
    expect(results).toEqual([...Array(100).keys()]);
  });

  it('releases the lock even if contention telemetry throws (liveness independent of observability)', async () => {
    vi.useFakeTimers();
    // A reporter whose breadcrumb emit throws. Pre-fix, the contention emit ran
    // outside withLock's try/finally, so a throw here skipped release() and left
    // the key locked forever though fn() never ran.
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {},
      addBreadcrumb: () => {
        throw new Error('telemetry boom');
      },
    });
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();

    const holder = mutex.withLock('s-tele-contention', async () => {
      holderEntered.resolve();
      await holderGate.promise;
      return 'holder';
    });
    await holderEntered.promise;

    // Second waiter will wait > the contention threshold, so its acquire emits a
    // (throwing) contention breadcrumb.
    const second = mutex.withLock('s-tele-contention', async () => 'second', {
      label: 'contention-waiter',
    });
    await vi.advanceTimersByTimeAsync(300);

    holderGate.resolve();
    await expect(holder).resolves.toBe('holder');
    // If the throw had escaped, `second` would never run fn nor release.
    await expect(second).resolves.toBe('second');
    // Lock fully drained — a fresh acquire succeeds.
    await expect(mutex.withLock('s-tele-contention', async () => 'third')).resolves.toBe('third');
    expect(getTestState('s-tele-contention')).toBeUndefined();
  });

  it('rejects the timed-out waiter even if deadlock telemetry throws (no hang)', async () => {
    vi.useFakeTimers();
    setErrorReporter({
      captureException: () => {},
      captureMessage: () => {
        throw new Error('capture boom');
      },
      addBreadcrumb: () => {
        throw new Error('breadcrumb boom');
      },
    });
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();

    const holder = mutex.withLock('s-tele-timeout', async () => {
      holderEntered.resolve();
      await holderGate.promise;
      return 'holder';
    });
    await holderEntered.promise;

    const waiter = mutex.withLock('s-tele-timeout', async () => 'waiter', {
      deadlockTimeoutMs: 10,
      label: 'timeout-waiter',
    });
    const waiterOutcome = captureOutcome(waiter);

    await vi.advanceTimersByTimeAsync(11);
    // Pre-fix (telemetry before reject), a throw here left the waiter promise
    // forever pending — this await would hang the test.
    const outcome = await waiterOutcome;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(SessionMutexDeadlockError);
    }
    // Holder is untouched and still completes normally.
    holderGate.resolve();
    await expect(holder).resolves.toBe('holder');
  });

  it('disables waiter timeout when deadlockTimeoutMs is negative', async () => {
    vi.useFakeTimers();
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();
    let waiterEntered = false;
    let waiterSettled = false;

    const holder = mutex.withLock('s-negative-timeout', async () => {
      holderEntered.resolve();
      await holderGate.promise;
      return 'holder';
    });
    await holderEntered.promise;

    const waiter = mutex.withLock('s-negative-timeout', async () => {
      waiterEntered = true;
      return 'waiter';
    }, {
      deadlockTimeoutMs: -5,
      label: 'negative-timeout',
    });
    waiter.then(() => { waiterSettled = true; }, () => { waiterSettled = true; });

    await vi.advanceTimersByTimeAsync(60_000);
    await Promise.resolve();
    expect(waiterEntered).toBe(false);
    expect(waiterSettled).toBe(false);

    holderGate.resolve();
    await expect(holder).resolves.toBe('holder');
    await expect(waiter).resolves.toBe('waiter');
    expect(waiterEntered).toBe(true);
  });

  it('grants the lock to a queued waiter when the holder fn throws', async () => {
    const mutex = getSessionMutex();
    const holderGate = createDeferred<void>();
    const holderEntered = createDeferred<void>();
    let waiterRan = false;

    const holder = mutex.withLock('s-holder-throws', async () => {
      holderEntered.resolve();
      await holderGate.promise;
      throw new Error('holder boom');
    });
    await holderEntered.promise;

    const waiter = mutex.withLock('s-holder-throws', async () => {
      waiterRan = true;
      return 'waiter';
    });
    await Promise.resolve();
    expect(waiterRan).toBe(false);

    holderGate.resolve();
    await expect(holder).rejects.toThrow('holder boom');
    await expect(waiter).resolves.toBe('waiter');
    expect(waiterRan).toBe(true);
    expect(getTestState('s-holder-throws')).toBeUndefined();
  });
});
