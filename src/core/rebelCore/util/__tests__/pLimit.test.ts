import { describe, expect, it, vi } from 'vitest';
import { runWithLimit } from '../pLimit';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const isAbortError = (error: unknown): error is Error =>
  error instanceof Error && error.name === 'AbortError';

const createAbortError = (): Error => {
  const error = new Error('Operation was aborted');
  error.name = 'AbortError';
  return error;
};

describe('runWithLimit', () => {
  it('honors the configured concurrency cap', async () => {
    const deferreds = Array.from({ length: 8 }, () => createDeferred<number>());
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = deferreds.map((deferred, index) => async () => {
      started.push(index);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await deferred.promise;
      } finally {
        inFlight -= 1;
      }
    });

    const runPromise = runWithLimit(4, tasks);

    await vi.waitFor(() => {
      expect(started).toHaveLength(4);
    });
    expect(maxInFlight).toBe(4);

    deferreds[0].resolve(0);
    await vi.waitFor(() => {
      expect(started).toHaveLength(5);
    });
    expect(maxInFlight).toBe(4);

    for (let index = 1; index < deferreds.length; index += 1) {
      deferreds[index].resolve(index);
    }

    const results = await runPromise;
    expect(results.every((entry) => entry.status === 'fulfilled')).toBe(true);
    expect(
      results.map((entry) => {
        if (entry.status !== 'fulfilled') {
          throw new Error(`Expected fulfilled result at index ${entry.index}`);
        }
        return entry.value;
      }),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('returns results in input order regardless of completion order', async () => {
    const deferreds = Array.from({ length: 4 }, () => createDeferred<void>());
    const started: number[] = [];
    const completionOrder: number[] = [];

    const tasks = deferreds.map((deferred, index) => async () => {
      started.push(index);
      await deferred.promise;
      completionOrder.push(index);
      return `result-${index}`;
    });

    const runPromise = runWithLimit(4, tasks);

    await vi.waitFor(() => {
      expect(started).toHaveLength(4);
    });

    deferreds[3].resolve();
    deferreds[1].resolve();
    deferreds[0].resolve();
    deferreds[2].resolve();

    const results = await runPromise;

    expect(completionOrder).toEqual([3, 1, 0, 2]);
    expect(results.every((entry) => entry.status === 'fulfilled')).toBe(true);
    expect(
      results.map((entry) => {
        if (entry.status !== 'fulfilled') {
          throw new Error(`Expected fulfilled result at index ${entry.index}`);
        }
        return entry.value;
      }),
    ).toEqual(['result-0', 'result-1', 'result-2', 'result-3']);
  });

  it('propagates abort to in-flight tasks and marks queued tasks as aborted', async () => {
    const controller = new AbortController();
    const started: number[] = [];
    let inFlightAbortSignals = 0;

    const tasks = Array.from({ length: 8 }, (_task, index) => async (signal: AbortSignal | undefined) => {
      started.push(index);

      if (index >= 4) {
        throw new Error(`Queued task ${index} should not start`);
      }

      return await new Promise<number>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('Expected abort signal'));
          return;
        }

        const onAbort = () => {
          inFlightAbortSignals += 1;
          reject(createAbortError());
        };

        if (signal.aborted) {
          onAbort();
          return;
        }

        signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    const runPromise = runWithLimit(4, tasks, { signal: controller.signal });

    await vi.waitFor(() => {
      expect(started).toEqual([0, 1, 2, 3]);
    });

    controller.abort();

    const results = await runPromise;

    expect(started).toEqual([0, 1, 2, 3]);
    expect(inFlightAbortSignals).toBe(4);
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(isAbortError(result.reason)).toBe(true);
      }
    }
  });

  it("keeps dispatching tasks when one task fails", async () => {
    const started: number[] = [];

    const tasks = Array.from({ length: 6 }, (_task, index) => async () => {
      started.push(index);
      await Promise.resolve();
      if (index === 2) {
        throw new Error('task-2-failed');
      }
      return index * 10;
    });

    const results = await runWithLimit(3, tasks);

    expect(started).toHaveLength(6);
    expect(results[0]).toEqual({ status: 'fulfilled', index: 0, value: 0 });
    expect(results[1]).toEqual({ status: 'fulfilled', index: 1, value: 10 });
    expect(results[2].status).toBe('rejected');
    if (results[2].status === 'rejected') {
      expect((results[2].reason as Error).message).toContain('task-2-failed');
    }
    expect(results[3]).toEqual({ status: 'fulfilled', index: 3, value: 30 });
    expect(results[4]).toEqual({ status: 'fulfilled', index: 4, value: 40 });
    expect(results[5]).toEqual({ status: 'fulfilled', index: 5, value: 50 });
  });

  it('captures synchronously-thrown task errors as rejected results and continues dispatching', async () => {
    const started: number[] = [];

    const tasks = [
      () => {
        started.push(0);
        throw new Error('boom');
      },
      async () => {
        started.push(1);
        return 10;
      },
      async () => {
        started.push(2);
        return 20;
      },
    ];

    const results = await runWithLimit(2, tasks);

    expect(started).toEqual([0, 1, 2]);
    expect(results[0].status).toBe('rejected');
    if (results[0].status === 'rejected') {
      expect((results[0].reason as Error).message).toBe('boom');
    }
    expect(results[1]).toEqual({ status: 'fulfilled', index: 1, value: 10 });
    expect(results[2]).toEqual({ status: 'fulfilled', index: 2, value: 20 });
  });

  it('distinguishes reject(undefined) from resolve(undefined)', async () => {
    const tasks = [
      async () => undefined,
      async () => Promise.reject(undefined),
    ];

    const results = await runWithLimit(2, tasks);

    expect(results[0]).toEqual({ status: 'fulfilled', index: 0, value: undefined });
    expect(results[1]).toEqual({ status: 'rejected', index: 1, reason: undefined });
  });

  it('returns an empty array for empty task input', async () => {
    await expect(runWithLimit(4, [])).resolves.toEqual([]);
  });

  it('dispatches all tasks immediately when limit exceeds task count', async () => {
    const deferreds = Array.from({ length: 3 }, () => createDeferred<number>());
    const started: number[] = [];

    const tasks = deferreds.map((deferred, index) => async () => {
      started.push(index);
      return deferred.promise;
    });

    const runPromise = runWithLimit(10, tasks);

    await vi.waitFor(() => {
      expect(started).toHaveLength(3);
    });

    deferreds.forEach((deferred, index) => deferred.resolve(index));

    const results = await runPromise;
    expect(results).toEqual([
      { status: 'fulfilled', index: 0, value: 0 },
      { status: 'fulfilled', index: 1, value: 1 },
      { status: 'fulfilled', index: 2, value: 2 },
    ]);
  });

  it('runs tasks serially when limit is 1', async () => {
    const deferreds = Array.from({ length: 3 }, () => createDeferred<number>());
    const started: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const tasks = deferreds.map((deferred, index) => async () => {
      started.push(index);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await deferred.promise;
      } finally {
        inFlight -= 1;
      }
    });

    const runPromise = runWithLimit(1, tasks);

    await vi.waitFor(() => {
      expect(started).toEqual([0]);
    });

    deferreds[0].resolve(0);
    await vi.waitFor(() => {
      expect(started).toEqual([0, 1]);
    });

    deferreds[1].resolve(1);
    await vi.waitFor(() => {
      expect(started).toEqual([0, 1, 2]);
    });

    deferreds[2].resolve(2);

    const results = await runPromise;
    expect(maxInFlight).toBe(1);
    expect(results).toEqual([
      { status: 'fulfilled', index: 0, value: 0 },
      { status: 'fulfilled', index: 1, value: 1 },
      { status: 'fulfilled', index: 2, value: 2 },
    ]);
  });

  it('throws when limit is less than 1', async () => {
    await expect(runWithLimit(0, [async () => 1])).rejects.toThrow('limit >= 1');
  });
});
