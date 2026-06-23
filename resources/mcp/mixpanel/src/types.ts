/**
 * Shared types and constants for the Mixpanel MCP server.
 *
 * Plan: docs/plans/260515_mixpanel_mcp.md
 * Region handling per DL-3, error codes per DL-14, endpoint allowlist per DL-13.
 */

export type MixpanelRegion = 'us' | 'eu';

export interface MixpanelHosts {
  query: string;
  export: string;
}

export const MIXPANEL_REGIONS: Record<MixpanelRegion, MixpanelHosts> = {
  us: { query: 'https://mixpanel.com', export: 'https://data.mixpanel.com' },
  eu: { query: 'https://eu.mixpanel.com', export: 'https://data-eu.mixpanel.com' },
};

export const MIXPANEL_REGION_KEYS: MixpanelRegion[] = ['us', 'eu'];

/**
 * Endpoint allowlist (DL-13). Every request must target one of these paths.
 * `family` determines which timeout default applies (DL-11).
 */
export type MixpanelEndpointFamily = 'query' | 'export';

export interface MixpanelEndpoint {
  path: string;
  family: MixpanelEndpointFamily;
  /** Human-friendly endpoint name for structured logging (DL-14). */
  label: string;
}

export const ENDPOINT_ALLOWLIST = {
  export: { path: '/api/2.0/export', family: 'export', label: 'export' },
  eventsNames: { path: '/api/2.0/events/names', family: 'query', label: 'events_names' },
  eventsPropertiesValues: { path: '/api/2.0/events/properties/values', family: 'query', label: 'events_properties_values' },
  cohortsList: { path: '/api/2.0/cohorts/list', family: 'query', label: 'cohorts_list' },
  retention: { path: '/api/2.0/retention', family: 'query', label: 'retention' },
  funnels: { path: '/api/2.0/funnels', family: 'query', label: 'funnels' },
  insights: { path: '/api/2.0/insights', family: 'query', label: 'insights' },
  engage: { path: '/api/2.0/engage', family: 'query', label: 'engage' },
} as const satisfies Record<string, MixpanelEndpoint>;

export type MixpanelEndpointKey = keyof typeof ENDPOINT_ALLOWLIST;

export type MixpanelErrorCode =
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID_REGION'
  | 'CONFIG_INVALID_FILTER'
  | 'CONFIG_INVALID_TIMEOUT'
  | 'AUTH'
  | 'RATE_LIMIT'
  | 'TIMEOUT'
  | 'NOT_FOUND'
  | 'API_ERROR'
  | 'NETWORK'
  | 'RESPONSE_INVALID'
  | 'RESPONSE_TOO_LARGE'
  | 'WINDOW_TOO_WIDE';

export interface MixpanelErrorContext {
  /** HTTP status, when applicable. */
  status?: number;
  /** Endpoint label per DL-14. */
  endpoint?: string;
  /** Retry-After seconds (when 429). */
  retryAfterSeconds?: number;
  /** Timeout duration in ms (when TIMEOUT). */
  timeoutMs?: number;
  /** Position in NDJSON stream (when RESPONSE_INVALID parsing). */
  parsePosition?: number;
  /** Suggested narrower date ranges (when WINDOW_TOO_WIDE / oversized response). */
  suggestedRanges?: Array<{ from_date: string; to_date: string }>;
}

export class MixpanelError extends Error {
  readonly code: MixpanelErrorCode;
  readonly resolution: string;
  readonly context: MixpanelErrorContext;

  constructor(code: MixpanelErrorCode, message: string, resolution: string, context: MixpanelErrorContext = {}) {
    super(message);
    this.name = 'MixpanelError';
    this.code = code;
    this.resolution = resolution;
    this.context = context;
  }
}

/**
 * Structured filter clause (DL-17). v1 is constrained: top-level AND only,
 * enum operators, typed values. No raw `where` strings.
 */
export type MixpanelFilterOp = '==' | '!=' | 'in' | 'not_in' | 'is_set' | 'is_not_set';

export interface MixpanelFilter {
  property: string;
  op: MixpanelFilterOp;
  value?: string | number | boolean | Array<string | number | boolean>;
}

/** Default timeouts per DL-11. */
export const DEFAULT_TIMEOUTS_MS: Record<MixpanelEndpointFamily, number> = {
  query: 60_000,
  export: 180_000,
};

/** Allowed env-override ranges per DL-11. */
export const TIMEOUT_RANGES_MS: Record<MixpanelEndpointFamily, { min: number; max: number; envVar: string }> = {
  query: { min: 5_000, max: 300_000, envVar: 'MIXPANEL_REQUEST_TIMEOUT_MS' },
  export: { min: 30_000, max: 600_000, envVar: 'MIXPANEL_EXPORT_TIMEOUT_MS' },
};

/** Hard caps per DL-5. */
export const RESPONSE_SIZE_CAP_BYTES = 25 * 1024;
export const PRE_PARSE_SIZE_CAP_BYTES = 4 * 1024 * 1024; // safety net before JSON parse
export const NDJSON_EVENT_HARD_CAP = 500;
export const PER_USER_EVENT_HARD_CAP = 100;
export const QUERY_WINDOW_MAX_DAYS = 90;

/** Rate limit budgets per DL-7. */
export const RATE_LIMITS = {
  query: { maxPerHour: 60, maxConcurrent: 5 },
  export: { maxPerHour: 30, maxConcurrent: 2 },
} as const;

export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const RETRY_AFTER_FAIL_FAST_THRESHOLD_S = 30;

/** URL token redaction key pattern per DL-18. */
export const URL_TOKEN_REDACT_PATTERN = /(token|key|secret|session|auth|password|code|api_key|access_token|refresh_token)/i;

/** Filter property name validation pattern (DL-17). */
export const FILTER_PROPERTY_PATTERN = /^[a-zA-Z0-9_$.\-]+$/;
export const FILTER_PROPERTY_MAX_LENGTH = 100;

/** Structured log level per DL-14. */
export type LogLevel = 'error' | 'warn' | 'info';

export interface StructuredLogEntry {
  level: LogLevel;
  code?: MixpanelErrorCode | string;
  endpoint?: string;
  region?: MixpanelRegion;
  http_status?: number;
  duration_ms?: number;
  attempt?: number;
  retry_after_seconds?: number;
  bytes_read?: number;
  ndjson_lines_parsed?: number;
  parse_position?: number;
  msg: string;
}
