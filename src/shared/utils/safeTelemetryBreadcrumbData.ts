import type { SafeTelemetryBreadcrumbData } from '../types/safeTelemetryBreadcrumbData';

export type { SafeTelemetryBreadcrumbData } from '../types/safeTelemetryBreadcrumbData';

/**
 * Attach already-sanitized log breadcrumb data to a Sentry breadcrumb.
 *
 * The `data` parameter must be produced by `redactLogBreadcrumbData()` (or the
 * mobile equivalent) so raw logger bindings cannot reach Sentry without scrubbing.
 */
export function attachLogBreadcrumbData(
  breadcrumb: { data?: Record<string, unknown> },
  data: SafeTelemetryBreadcrumbData,
): void {
  breadcrumb.data = data;
}

/**
 * Internal brand — only call sites that run the deny-by-default allowlist scrubber
 * should invoke this. Exported for the core + mobile sanitizer modules.
 */
export function brandSanitizedLogBreadcrumbData(
  sanitized: Record<string, unknown>,
): SafeTelemetryBreadcrumbData {
  return sanitized as SafeTelemetryBreadcrumbData;
}
