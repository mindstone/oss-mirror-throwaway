/**
 * Per-operation timeout helper modelled on the health-check `safeCheck`
 * (`src/core/services/health/utils.ts`).
 *
 * The motivating bug: the desktop diagnostics bundle ran 13 collectors
 * sequentially, each already `try/catch`-wrapped — so a *throw* was handled,
 * but a collector whose promise **never resolves** (hung `fs`/index read under
 * heap/IO pressure) hung the whole export forever ("stuck on preparing"). A
 * `try/catch` cannot rescue a hanging promise; only a timeout can.
 *
 * `runWithTimeout` races the work against a timer and, on timeout, RESOLVES to
 * a caller-supplied sentinel instead of throwing — the diagnostics call sites
 * already tolerate `undefined`/empty results, so resolving (rather than
 * rejecting) keeps the existing degradation paths intact.
 *
 * IMPORTANT (abandoned-promise residual): `Promise.race` only stops *awaiting*
 * the work; the underlying promise keeps running unless it honours the
 * `AbortSignal` we pass. For cancellable I/O the work should observe the signal
 * so background work stops when the timeout fires; for genuinely non-cancellable
 * reads, one timed-out-but-still-running promise can linger. Callers that wrap a
 * sequence of operations one-at-a-time bound this to at most one lingering
 * promise at a time (see `assembleDesktopBundle`).
 */

export interface WithTimeoutResult<T> {
  /** The work's value, or the `onTimeout` sentinel when the deadline fired. */
  value: T;
  /** True when the timer fired before the work settled. */
  timedOut: boolean;
  /** Wall-clock duration awaited, in ms (bounded by `timeoutMs` on timeout). */
  durationMs: number;
}

export interface RunWithTimeoutOptions<T> {
  /** Milliseconds before the deadline fires. Must be > 0. */
  timeoutMs: number;
  /**
   * Produces the work promise. Receives an `AbortSignal` that is aborted when
   * the deadline fires; cancellable I/O SHOULD forward it so background work
   * stops (mitigates the abandoned-promise residual).
   */
  work: (signal: AbortSignal) => Promise<T> | T;
  /**
   * Sentinel value resolved (never thrown) when the deadline fires. Receives
   * the same reason the signal was aborted with.
   */
  onTimeout: () => T;
  /** Optional clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Race `work` against a `timeoutMs` deadline. On timeout, aborts the work's
 * signal and resolves to `onTimeout()` (does not throw). If `work` itself
 * rejects, the rejection propagates (callers keep their own `try/catch`).
 */
export async function runWithTimeout<T>(options: RunWithTimeoutOptions<T>): Promise<WithTimeoutResult<T>> {
  const { timeoutMs, work, onTimeout, now = Date.now } = options;
  const start = now();
  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutSentinel = Symbol('timeout');

  const timeoutPromise = new Promise<typeof timeoutSentinel>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`Operation timed out after ${timeoutMs}ms`));
      resolve(timeoutSentinel);
    }, timeoutMs);
  });

  try {
    // Wrap the work in Promise.resolve so a synchronous throw is surfaced as a
    // rejection (propagated to the caller), not an uncaught synchronous error.
    const workPromise = Promise.resolve().then(() => work(controller.signal));
    const outcome = await Promise.race([workPromise, timeoutPromise]);
    if (outcome === timeoutSentinel) {
      return { value: onTimeout(), timedOut: true, durationMs: now() - start };
    }
    return { value: outcome as T, timedOut: false, durationMs: now() - start };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
