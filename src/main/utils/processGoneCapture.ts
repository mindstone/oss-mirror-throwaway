/**
 * Helpers for deciding whether a renderer/child process-gone event is worth a
 * Sentry capture, and for throttling repeated child-process crashes.
 *
 * Motivation: `render-process-gone` / `child-process-gone` (and `did-fail-load`)
 * are the literal "app launched but the UI is dead / blank screen" events — the
 * "Rebel won't work at all" / blank-screen class. They were logged to pino only and
 * were invisible to Sentry, so the broken cohort looked healthy on the dashboard.
 * See docs/plans/260621_monitoring-capture-surface/PLAN.md (Stage 1, C1).
 *
 * Kept as a separate, pure module so the decision logic is unit-testable without
 * Electron (src/main/index.ts is a ~8k-line orchestration file).
 */

/**
 * Electron `RenderProcessGoneDetails.reason` / `Details.reason` values that are
 * a NORMAL teardown rather than a crash. 'clean-exit' is the renderer/child
 * shutting down cleanly (e.g. window close); everything else (`crashed`, `oom`,
 * `killed`, `launch-failed`, `integrity-failure`, `abnormal-exit`, …) is a
 * fault worth surfacing. An unknown/absent reason is surfaced (rare, high-signal).
 */
const BENIGN_PROCESS_GONE_REASONS = new Set<string>(['clean-exit']);

export const shouldCaptureProcessGone = (reason: string | undefined | null): boolean => {
  if (!reason) return true;
  return !BENIGN_PROCESS_GONE_REASONS.has(reason);
};

// Throttle repeated child-process-gone captures (e.g. a GPU process that
// crash-loops) so we get the signal without storming Sentry / paging the team
// on the >3×/1h alert rule. One capture per (type+reason) key per window.
const CHILD_PROCESS_GONE_THROTTLE_MS = 5 * 60_000;
const lastChildCaptureByKey = new Map<string, number>();

export const shouldCaptureChildProcessGoneThrottled = (
  key: string,
  now: number = Date.now(),
): boolean => {
  const last = lastChildCaptureByKey.get(key);
  if (last !== undefined && now - last < CHILD_PROCESS_GONE_THROTTLE_MS) {
    return false;
  }
  lastChildCaptureByKey.set(key, now);
  return true;
};

/** Test seam — clears the throttle map between cases. */
export const _resetChildProcessGoneThrottle = (): void => {
  lastChildCaptureByKey.clear();
};

/**
 * Reduce a URL to a telemetry-safe shape before it goes into a Sentry extra.
 * The shared `redactSentryEvent` pattern-matcher strips known secret param
 * names but NOT arbitrary signed-URL query/hash tokens (e.g. `?sig=…`,
 * `#access=…`), so we drop `search` + `hash` unconditionally and keep only
 * scheme + host + path. `data:`/`blob:` URLs (the inline error page) collapse
 * to the scheme only, since their "path" IS the payload. Unparseable inputs
 * never return the raw value. Existing redaction still scrubs `/Users/<name>`
 * out of any `file://` path that survives.
 */
export const toTelemetrySafeUrl = (raw: string | undefined | null): string | undefined => {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol === 'data:' || u.protocol === 'blob:') {
      return `${u.protocol}<omitted>`;
    }
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    const schemeMatch = /^([a-z][a-z0-9+.-]*:)/i.exec(raw);
    return schemeMatch ? `${schemeMatch[1]}<unparseable>` : '<non-url>';
  }
};
