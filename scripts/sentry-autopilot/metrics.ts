/**
 * Sentry Autopilot observability emitters.
 *
 * `emitCounter` writes a one-line JSON counter to stdout. This is a deliberately
 * minimal "log-stream-as-metric-interface" mechanism — the cheapest available
 * shape that lets operators grep cron.log today and lets a future P2 backend
 * (Prometheus, OTLP, Datadog, etc.) scrape from the same log stream.
 *
 * Cardinality contract:
 *   - Tag values may be unbounded (e.g. `sentry_id`). This is FINE for the
 *     log-stream interface, where grep/jq queries don't care about cardinality.
 *   - Before P2 swaps in a real metric backend, every emission site must be
 *     re-audited: high-cardinality tags (sentry_id, error messages, etc.) must
 *     be moved off the metric and into a separate log line, or P2 must pick a
 *     backend that tolerates unbounded label cardinality (some OTLP/loki shapes do).
 *   - Tag value types are intentionally restricted to `string | number`. Booleans
 *     and undefined are NOT allowed at the type level so callers must be explicit
 *     about encoding ('true'/'false' string, or omit the tag entirely).
 *
 * `errorLog` writes a one-line JSON error log to stderr, tagged with a closed
 * `log_discriminator` enum. The discriminator partitions autopilot errors by
 * observation site (schema_fail = ingest, supervisor_fail = run-level,
 * bugfixer_fail = harvested-from-bugfixer, reporter_fail = post-harvest reporter).
 * Adding a fifth discriminator value requires a deliberate code change, not a
 * string-literal addition — this is a typing decision to keep the operator's
 * vocabulary closed.
 */

export const LOG_DISCRIMINATORS = [
  'schema_fail',
  'supervisor_fail',
  'bugfixer_fail',
  'reporter_fail',
] as const;

export type LogDiscriminator = (typeof LOG_DISCRIMINATORS)[number];

export type CounterTags = Record<string, string | number>;

export function emitCounter(name: string, tags: CounterTags = {}): void {
  console.log(
    JSON.stringify({
      level: 'info',
      component: 'sentry-autopilot-metrics',
      metric: true,
      name,
      value: 1,
      ...tags,
    }),
  );
}

export function errorLog(
  discriminator: LogDiscriminator,
  data: Record<string, unknown>,
  message: string,
): void {
  console.error(
    JSON.stringify({
      level: 'error',
      component: 'sentry-autopilot',
      log_discriminator: discriminator,
      message,
      ...data,
    }),
  );
}
