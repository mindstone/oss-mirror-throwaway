/**
 * Race a promise against a renderer-local timeout.
 *
 * Why this exists:
 * - Three renderer call sites previously had near-duplicate `Promise.race +
 *   setTimeout` blocks (MessageMarkdown image IPC, useOnboardingFlow API
 *   key validation, useCloudProvisioning cloud sync). Two of them did not
 *   clear the timer on early settle — the inner promise still kept the
 *   closure alive for the full timeout duration after success.
 * - The MessageMarkdown variant additionally needs a typed error on
 *   timeout (`ImagePipelineError`) and a late-settle observer that fires
 *   when the inner promise eventually settles AFTER we already gave up
 *   (genuine production telemetry hook for "is the main-side IPC hanging?").
 * - Extracting these into one utility avoids divergent reinvention.
 *
 * Renderer-side utility. Uses the global `setTimeout` (typed via
 * `ReturnType<typeof setTimeout>`) so the same module works in unit-test
 * environments without a DOM. The MessageMarkdown adoption preserves the
 * exact `number`-returning runtime from the browser.
 *
 * Origin: extracted from `src/renderer/components/MessageMarkdown.tsx` (Stage I12,
 * commit 438f2697c) per DI-A in
 * `docs/plans/260427_di_a_di_c_renderer_timeout_utility_and_telemetry.md`.
 */

/**
 * Outcome shape passed to the late-settle observer. Deliberately does NOT
 * include the resolved value: the canonical caller (AutoLoadImage) resolves
 * to base64 image data, and exposing it in the observer signature would
 * invite future accidental logging or retention of user file contents.
 */
export type LateSettleOutcome =
  | { kind: 'success' }
  | { kind: 'error'; error: unknown };

export interface WithRendererTimeoutOptions {
  /** Timeout in milliseconds. */
  timeoutMs: number;
  /**
   * Builds the rejection reason when the timer fires.
   * Defaults to `() => new Error('timeout')`. Receives `timeoutMs` so the
   * message can include the bound (e.g.
   * `(ms) => new ImagePipelineError('ipc-timeout', ms, '...')`).
   */
  errorFactory?: (timeoutMs: number) => Error;
  /**
   * Fires AT MOST ONCE if and only if the inner promise eventually settles
   * AFTER the timer already rejected. Used to instrument silent-failure
   * surfaces — "the IPC took 17s but we already gave up at 15s" is a real
   * signal that should not be lost.
   *
   * The observer is invoked from a detached `.then`; a thrown observer is
   * caught and logged via `console.warn`, never propagating as an unhandled
   * rejection.
   */
  onLateSettle?: (outcome: LateSettleOutcome) => void;
}

/**
 * Race `promise` against a `timeoutMs` bound. On timeout: rejects with
 * `errorFactory(timeoutMs)` (default `new Error('timeout')`). The inner
 * promise is NOT cancelled (renderer cannot cancel IPC); if it eventually
 * settles, `onLateSettle` fires once.
 *
 * On early settle: timer is cleared immediately (memory hygiene); the
 * late-settle observer never fires.
 */
export function withRendererTimeout<T>(
  promise: Promise<T>,
  options: WithRendererTimeoutOptions,
): Promise<T> {
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  if (options.onLateSettle) {
    // Pre-attach the late-settle observer BEFORE the race wrapper. If the
    // timeout wins, the race throws out of the caller's await, and code
    // placed AFTER the await (the natural place to attach a `.then`) would
    // never run for a late settle.
    void promise.then(
      () => {
        if (timedOut) {
          try {
            options.onLateSettle?.({ kind: 'success' });
          } catch (err) {
            // Defensive: a thrown observer in a detached `.then` would
            // surface as an unhandled rejection. Log + swallow.
            console.warn('[withRendererTimeout] late-settle observer threw', {
              kind: 'success',
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
      (error) => {
        if (timedOut) {
          try {
            options.onLateSettle?.({ kind: 'error', error });
          } catch (err) {
            console.warn('[withRendererTimeout] late-settle observer threw', {
              kind: 'error',
              err: err instanceof Error ? err.message : String(err),
            });
          }
        }
      },
    );
  }

  // Manual race wrapper — preserves I12's eager-timer-clear semantics
  // (timer cleared as soon as inner settles, NOT just `.finally` post-race).
  // The `if (!timedOut)` guards are defensive against any hypothetical
  // microtask-ordering race between the timer firing and the inner promise
  // settling on the same tick.
  return new Promise<T>((resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      const factory = options.errorFactory ?? (() => new Error('timeout'));
      reject(factory(options.timeoutMs));
    }, options.timeoutMs);

    promise.then(
      (value) => {
        if (timeoutHandle != null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (!timedOut) resolve(value);
      },
      (error) => {
        if (timeoutHandle != null) {
          clearTimeout(timeoutHandle);
          timeoutHandle = null;
        }
        if (!timedOut) reject(error);
      },
    );
  });
}
