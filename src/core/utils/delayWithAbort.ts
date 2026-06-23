/**
 * Abort-aware delay. Resolves after `ms` milliseconds, or resolves early
 * (returning `true`) if the signal is aborted before the timer fires.
 *
 * @returns `true` if aborted, `false` if the delay completed normally.
 */
export function delayWithAbort(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve(true);
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
