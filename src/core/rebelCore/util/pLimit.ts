export type LimitedTask<T> = (signal: AbortSignal | undefined) => Promise<T>;

export interface PLimitOptions {
  signal?: AbortSignal;
}

export type PLimitResult<T> =
  | { status: 'fulfilled'; index: number; value: T }
  | { status: 'rejected'; index: number; reason: unknown };

const toAbortError = (reason: unknown): Error => {
  if (reason instanceof Error) {
    if (reason.name === 'AbortError') {
      return reason;
    }

    const error = new Error(reason.message);
    error.name = 'AbortError';
    return error;
  }

  const message = typeof reason === 'string' && reason.trim().length > 0
    ? reason
    : 'Operation was aborted';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
};

export async function runWithLimit<T>(
  limit: number,
  tasks: ReadonlyArray<LimitedTask<T>>,
  options: PLimitOptions = {},
): Promise<ReadonlyArray<PLimitResult<T>>> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`runWithLimit requires a limit >= 1. Received: ${limit}`);
  }

  if (tasks.length === 0) {
    return [];
  }

  const signal = options.signal;
  const results: Array<PLimitResult<T> | undefined> = Array.from({ length: tasks.length });
  let nextIndex = 0;
  let inFlight = 0;
  let settledCount = 0;
  let aborted = signal?.aborted ?? false;

  const markQueuedAsAborted = (): void => {
    while (nextIndex < tasks.length) {
      results[nextIndex] = {
        status: 'rejected',
        index: nextIndex,
        reason: toAbortError(signal?.reason),
      };
      nextIndex += 1;
      settledCount += 1;
    }
  };

  if (aborted) {
    markQueuedAsAborted();
    return results as ReadonlyArray<PLimitResult<T>>;
  }

  await new Promise<void>((resolve) => {
    const maybeResolve = (): void => {
      if (settledCount !== tasks.length) return;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };

    const startNext = (): void => {
      if (aborted) {
        maybeResolve();
        return;
      }

      while (inFlight < limit && nextIndex < tasks.length && !aborted) {
        const taskIndex = nextIndex;
        nextIndex += 1;
        inFlight += 1;

        const taskPromise = Promise.resolve().then(() => tasks[taskIndex](signal));
        void taskPromise
          .then((value) => {
            results[taskIndex] = {
              status: 'fulfilled',
              index: taskIndex,
              value,
            };
          })
          .catch((reason: unknown) => {
            results[taskIndex] = {
              status: 'rejected',
              index: taskIndex,
              reason,
            };
          })
          .finally(() => {
            inFlight -= 1;
            settledCount += 1;
            startNext();
            maybeResolve();
          });
      }

      maybeResolve();
    };

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      markQueuedAsAborted();
      maybeResolve();
    };

    signal?.addEventListener('abort', onAbort, { once: true });
    startNext();
  });

  const unresolvedIndex = results.findIndex((entry) => entry === undefined);
  if (unresolvedIndex >= 0) {
    throw new Error(`runWithLimit missing result for task index ${unresolvedIndex}`);
  }

  return results as ReadonlyArray<PLimitResult<T>>;
}
