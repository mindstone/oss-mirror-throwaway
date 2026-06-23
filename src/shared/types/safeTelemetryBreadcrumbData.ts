/**
 * Branded type for Sentry log-breadcrumb `data` after deny-by-default scrubbing.
 *
 * Raw Pino/logger binding objects must not reach Sentry breadcrumb `data` without
 * passing through `redactLogBreadcrumbData()` (or the mobile copy). Values typed as
 * `SafeTelemetryBreadcrumbData` have been sanitized; assign them via
 * `attachLogBreadcrumbData()` at the breadcrumb-attachment seam.
 *
 * @see `redactLogBreadcrumbData()` in `@core/utils/logFieldFilter`
 * @see docs-private/postmortems/260607_allowlist_log_breadcrumbs_scrub_server_name_4c77a28_postmortem.md
 */
export type SafeTelemetryBreadcrumbData = Record<string, unknown> & {
  readonly __brand: 'SafeTelemetryBreadcrumbData';
};
