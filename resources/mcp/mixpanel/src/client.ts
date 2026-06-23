/**
 * MixpanelClient — read-only HTTP client for Mixpanel APIs.
 *
 * Plan: docs/plans/260515_mixpanel_mcp.md
 * Implements DL-3 (region), DL-5 (response shaping + streaming abort), DL-7 (rate limits,
 * fast-fail Retry-After), DL-11 (split timeouts), DL-13 (read-only allowlist), DL-14
 * (structured logging), DL-15 (project_id injection), DL-17 (filter encoder), DL-18
 * (URL-token redaction).
 *
 * Exposes only specific typed read methods. No generic request()/post()/put()/delete().
 * To add a write tool a developer would have to add a new method — visible diff.
 */
import {
  DEFAULT_TIMEOUTS_MS,
  ENDPOINT_ALLOWLIST,
  FILTER_PROPERTY_MAX_LENGTH,
  FILTER_PROPERTY_PATTERN,
  MIXPANEL_REGIONS,
  MIXPANEL_REGION_KEYS,
  MixpanelError,
  NDJSON_EVENT_HARD_CAP,
  PRE_PARSE_SIZE_CAP_BYTES,
  RATE_LIMITS,
  RATE_LIMIT_WINDOW_MS,
  RETRY_AFTER_FAIL_FAST_THRESHOLD_S,
  TIMEOUT_RANGES_MS,
  URL_TOKEN_REDACT_PATTERN,
  type MixpanelEndpoint,
  type MixpanelEndpointFamily,
  type MixpanelEndpointKey,
  type MixpanelFilter,
  type MixpanelRegion,
  type StructuredLogEntry,
} from './types.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const resolution = (hint: string): string =>
  `${hint} Check Settings → Connectors → Mixpanel if the problem continues.`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Sliding-window rate limiter. Per DL-7: 60 req/hr for query, 30 req/hr for export.
 * Static (module-level) so multiple client instances in the same process share state.
 */
class RateLimiter {
  private timestamps: Record<MixpanelEndpointFamily, number[]> = { query: [], export: [] };
  private cooldownUntil: Record<MixpanelEndpointFamily, number> = { query: 0, export: 0 };

  cooldownRemainingMs(family: MixpanelEndpointFamily): number {
    return Math.max(0, this.cooldownUntil[family] - Date.now());
  }

  setCooldown(family: MixpanelEndpointFamily, untilEpochMs: number): void {
    this.cooldownUntil[family] = Math.max(this.cooldownUntil[family], untilEpochMs);
  }

  async waitForSlot(family: MixpanelEndpointFamily): Promise<void> {
    const now = Date.now();
    this.timestamps[family] = this.timestamps[family].filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    const max = RATE_LIMITS[family].maxPerHour;
    if (this.timestamps[family].length >= max) {
      const oldest = this.timestamps[family][0] ?? now;
      await sleep(Math.max(0, RATE_LIMIT_WINDOW_MS - (now - oldest)));
    }
    this.timestamps[family].push(Date.now());
  }
}

const sharedLimiter = new RateLimiter();

/**
 * Parse Retry-After header into seconds. Returns null if unparseable.
 * Accepts both `delta-seconds` and `HTTP-date` per RFC 7231.
 */
const parseRetryAfterSeconds = (raw: string | null): number | null => {
  if (!raw) return null;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.floor((dateMs - Date.now()) / 1000));
  }
  return null;
};

/**
 * Resolve region from env. Strict per DL-3: no silent fallback.
 * Empty/missing → 'us'. Non-empty + not in allowlist → throw.
 */
export const resolveRegion = (raw: string | undefined): MixpanelRegion => {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (trimmed === '') return 'us';
  if ((MIXPANEL_REGION_KEYS as readonly string[]).includes(trimmed)) {
    return trimmed as MixpanelRegion;
  }
  throw new MixpanelError(
    'CONFIG_INVALID_REGION',
    `MIXPANEL_REGION must be one of: ${MIXPANEL_REGION_KEYS.join(', ')} (got: ${raw}).`,
    'Set MIXPANEL_REGION to "us" or "eu" in Settings → Connectors → Mixpanel.',
  );
};

/** Parse timeout env override (DL-11). */
const parseTimeoutMs = (raw: string | undefined, family: MixpanelEndpointFamily): number => {
  const cfg = TIMEOUT_RANGES_MS[family];
  if (!raw || raw.trim() === '') return DEFAULT_TIMEOUTS_MS[family];
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < cfg.min || parsed > cfg.max) {
    throw new MixpanelError(
      'CONFIG_INVALID_TIMEOUT',
      `${cfg.envVar} must be an integer in [${cfg.min}, ${cfg.max}] (got: ${raw}).`,
      `Unset ${cfg.envVar} to use the default (${DEFAULT_TIMEOUTS_MS[family]}ms) or set a value in range.`,
    );
  }
  return parsed;
};

/**
 * URL-token redaction per DL-18.
 * Parses URL strings and redacts query parameters whose key matches the secret pattern.
 * Returns the original value if not a valid URL.
 */
export const redactUrlTokens = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0) return value;
  if (!/^https?:\/\//i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  let mutated = false;
  for (const key of [...url.searchParams.keys()]) {
    if (URL_TOKEN_REDACT_PATTERN.test(key)) {
      url.searchParams.set(key, '__REDACTED__');
      mutated = true;
    }
  }
  return mutated ? url.toString() : value;
};

/** Apply redactUrlTokens recursively to all string fields of an object. */
export const redactUrlTokensDeep = <T>(value: T): T => {
  if (typeof value === 'string') {
    return redactUrlTokens(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactUrlTokensDeep(v)) as unknown as T;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactUrlTokensDeep(v);
    }
    return out as unknown as T;
  }
  return value;
};

/**
 * Structured filter encoder per DL-17. Validates each clause, then JSON.stringify's values
 * into a Mixpanel `where` literal. No template literals; no user-supplied text in operator slots.
 */
export const buildWhereClause = (filters: MixpanelFilter[]): string => {
  if (filters.length === 0) return '';
  const clauses: string[] = [];
  for (const [i, f] of filters.entries()) {
    if (typeof f.property !== 'string' || f.property.length === 0) {
      throw new MixpanelError(
        'CONFIG_INVALID_FILTER',
        `filters[${i}].property is required.`,
        'Set property to an event property name (e.g. "$email", "country_code").',
      );
    }
    if (f.property.length > FILTER_PROPERTY_MAX_LENGTH) {
      throw new MixpanelError(
        'CONFIG_INVALID_FILTER',
        `filters[${i}].property exceeds ${FILTER_PROPERTY_MAX_LENGTH} chars.`,
        'Shorten the property name.',
      );
    }
    if (!FILTER_PROPERTY_PATTERN.test(f.property)) {
      throw new MixpanelError(
        'CONFIG_INVALID_FILTER',
        `filters[${i}].property contains disallowed characters (allowed: letters, digits, _$.-).`,
        'Use the literal property name as it appears in Mixpanel.',
      );
    }
    const propLiteral = `properties[${JSON.stringify(f.property)}]`;
    switch (f.op) {
      case '==':
      case '!=': {
        if (f.value === undefined || f.value === null || Array.isArray(f.value)) {
          throw new MixpanelError(
            'CONFIG_INVALID_FILTER',
            `filters[${i}] op ${f.op} requires a scalar value (string | number | boolean).`,
            'Provide a single value for == or !=, or use "in" / "not_in" for arrays.',
          );
        }
        clauses.push(`${propLiteral} ${f.op} ${JSON.stringify(f.value)}`);
        break;
      }
      case 'in':
      case 'not_in': {
        if (!Array.isArray(f.value) || f.value.length === 0) {
          throw new MixpanelError(
            'CONFIG_INVALID_FILTER',
            `filters[${i}] op ${f.op} requires a non-empty array value.`,
            'Provide an array of strings / numbers / booleans.',
          );
        }
        const arrayLiteral = `[${f.value.map((v) => JSON.stringify(v)).join(',')}]`;
        const not = f.op === 'not_in' ? 'not ' : '';
        clauses.push(`${not}(${propLiteral} in ${arrayLiteral})`);
        break;
      }
      case 'is_set':
      case 'is_not_set': {
        if (f.value !== undefined) {
          throw new MixpanelError(
            'CONFIG_INVALID_FILTER',
            `filters[${i}] op ${f.op} must not include a value.`,
            'Remove the value field for existence checks.',
          );
        }
        const defined = `defined(${propLiteral})`;
        clauses.push(f.op === 'is_set' ? defined : `not ${defined}`);
        break;
      }
      default: {
        const exhaustive: never = f.op;
        throw new MixpanelError(
          'CONFIG_INVALID_FILTER',
          `filters[${i}].op is not a supported operator (got: ${String(exhaustive)}).`,
          'Use one of: ==, !=, in, not_in, is_set, is_not_set.',
        );
      }
    }
  }
  return clauses.length === 1 ? clauses[0] : clauses.map((c) => `(${c})`).join(' and ');
};

/** Structured log entry per DL-14. Single-line JSON to stderr. */
export const writeLog = (entry: StructuredLogEntry): void => {
  try {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  } catch {
    // Best-effort logging — never throw from the logger itself.
  }
};

/**
 * Read and parse an NDJSON response stream. Calls `onEvent` for each parsed line.
 * Returns `{ linesParsed, bytesRead, truncated }`. When the caller's `onEvent` returns
 * `false` (caller signalling "stop"), the underlying body is cancelled (DL-5).
 */
const consumeNdjsonStream = async (
  response: Response,
  onEvent: (event: unknown) => boolean,
  endpointLabel: string,
): Promise<{ linesParsed: number; bytesRead: number; truncated: boolean }> => {
  if (!response.body) {
    throw new MixpanelError(
      'RESPONSE_INVALID',
      'Mixpanel response has no body.',
      resolution('Try again. If this repeats, the connector may need an update.'),
      { endpoint: endpointLabel },
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let linesParsed = 0;
  let bytesRead = 0;
  let truncated = false;
  let aborted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > PRE_PARSE_SIZE_CAP_BYTES * 16) {
        // Hard ceiling — even with caller acceptance, never read >64MB.
        truncated = true;
        aborted = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            throw new MixpanelError(
              'RESPONSE_INVALID',
              `Mixpanel returned malformed NDJSON at line ${linesParsed + 1}.`,
              resolution('Try a narrower date range. If this repeats, the connector may need an update.'),
              { endpoint: endpointLabel, parsePosition: linesParsed + 1 },
            );
          }
          linesParsed += 1;
          const cont = onEvent(parsed);
          if (!cont) {
            truncated = true;
            aborted = true;
            break;
          }
        }
        newlineIdx = buffer.indexOf('\n');
      }
      if (aborted) break;
    }

    // Flush remaining buffered line, if any. Mixpanel NDJSON terminates each line with \n,
    // so a non-empty trailing buffer indicates a partial line.
    if (!aborted && buffer.length > 0) {
      const trailing = buffer.trim();
      if (trailing.length > 0) {
        throw new MixpanelError(
          'RESPONSE_INVALID',
          `Mixpanel NDJSON stream ended with a partial line (${trailing.length} bytes unread).`,
          resolution('Retry the request. If this repeats, the connector may need an update.'),
          { endpoint: endpointLabel, parsePosition: linesParsed + 1 },
        );
      }
    }
  } finally {
    if (aborted) {
      try {
        await reader.cancel();
      } catch {
        // ignore — stream may already be closed
      }
    } else {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  return { linesParsed, bytesRead, truncated };
};

interface MixpanelClientOptions {
  /** Override env vars for testing. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

interface MixpanelRequestOptions {
  /** Query params (excluding project_id, which is injected). */
  params?: Record<string, string | number | boolean | undefined>;
  /** Caller-provided AbortSignal — composed with timeout signal. */
  signal?: AbortSignal;
  /** Override the default timeout for this request (rare). */
  timeoutOverrideMs?: number;
}

/**
 * MixpanelClient — read-only Mixpanel API client.
 *
 * Read-only invariant per DL-13: only specific typed read methods are exposed.
 * Adding a write tool requires adding a new method to this class.
 */
export class MixpanelClient {
  private readonly username: string;
  private readonly secret: string;
  private readonly projectId: string;
  private readonly region: MixpanelRegion;
  private readonly hosts: { query: string; export: string };
  private readonly timeouts: Record<MixpanelEndpointFamily, number>;
  private readonly authHeader: string;

  constructor(opts: MixpanelClientOptions = {}) {
    const env = opts.env ?? process.env;
    const username = (env.MIXPANEL_USERNAME ?? '').trim();
    const secret = (env.MIXPANEL_SECRET ?? '').trim();
    const projectId = (env.MIXPANEL_PROJECT_ID ?? '').trim();
    const missing: string[] = [];
    if (!username) missing.push('MIXPANEL_USERNAME');
    if (!secret) missing.push('MIXPANEL_SECRET');
    if (!projectId) missing.push('MIXPANEL_PROJECT_ID');
    if (missing.length > 0) {
      throw new MixpanelError(
        'CONFIG_MISSING',
        `Mixpanel credentials are not configured (missing: ${missing.join(', ')}).`,
        'Open Settings → Connectors → Mixpanel and fill in all four fields (region, project ID, service account username, secret).',
      );
    }

    this.username = username;
    this.secret = secret;
    this.projectId = projectId;
    this.region = resolveRegion(env.MIXPANEL_REGION);
    this.hosts = MIXPANEL_REGIONS[this.region];
    this.timeouts = {
      query: parseTimeoutMs(env.MIXPANEL_REQUEST_TIMEOUT_MS, 'query'),
      export: parseTimeoutMs(env.MIXPANEL_EXPORT_TIMEOUT_MS, 'export'),
    };
    this.authHeader = `Basic ${Buffer.from(`${this.username}:${this.secret}`).toString('base64')}`;
  }

  /** Exposed for diagnostics and tests. */
  getRegion(): MixpanelRegion {
    return this.region;
  }

  // ---- Read-only public surface (DL-13) ----

  /**
   * Stream events from the Raw Export API. Caller-provided `onEvent` decides when to stop.
   * Mixpanel Export uses the project's local timezone for `from_date`/`to_date`.
   */
  async exportEvents(input: {
    fromDate: string;
    toDate: string;
    eventNames?: string[];
    whereClause?: string;
    onEvent: (event: unknown) => boolean;
    signal?: AbortSignal;
  }): Promise<{ linesParsed: number; bytesRead: number; truncated: boolean }> {
    const params: Record<string, string> = {
      from_date: input.fromDate,
      to_date: input.toDate,
    };
    if (input.eventNames && input.eventNames.length > 0) {
      params.event = JSON.stringify(input.eventNames);
    }
    if (input.whereClause && input.whereClause.length > 0) {
      params.where = input.whereClause;
    }
    const { response, endpointLabel } = await this.fetchEndpoint('export', { params, signal: input.signal });
    return consumeNdjsonStream(response, input.onEvent, endpointLabel);
  }

  async listEventNames(input: { type?: 'general' | 'average' | 'unique'; limit?: number } = {}): Promise<unknown> {
    return this.fetchJson('eventsNames', {
      params: {
        type: input.type ?? 'general',
        limit: input.limit,
      },
    });
  }

  async getEventPropertyValues(input: {
    eventName: string;
    propertyName: string;
    fromDate?: string;
    toDate?: string;
    limit?: number;
  }): Promise<unknown> {
    return this.fetchJson('eventsPropertiesValues', {
      params: {
        event: input.eventName,
        name: input.propertyName,
        from_date: input.fromDate,
        to_date: input.toDate,
        limit: input.limit,
      },
    });
  }

  async listCohorts(input: { limit?: number } = {}): Promise<unknown> {
    return this.fetchJson('cohortsList', { params: { limit: input.limit } });
  }

  async getRetention(input: {
    eventName: string;
    retentionEventName?: string;
    fromDate: string;
    toDate: string;
    interval: 'day' | 'week' | 'month';
    cohortId?: number | string;
  }): Promise<unknown> {
    return this.fetchJson('retention', {
      params: {
        event: input.eventName,
        retention_type: 'birth',
        born_event: input.eventName,
        return_event: input.retentionEventName,
        from_date: input.fromDate,
        to_date: input.toDate,
        unit: input.interval,
        born_where: input.cohortId !== undefined ? `cohort_id:${input.cohortId}` : undefined,
      },
    });
  }

  async listInsights(input: { workspaceId?: number | string; bookmarkId?: number | string; limit?: number } = {}): Promise<unknown> {
    return this.fetchJson('insights', {
      params: {
        workspace_id: input.workspaceId,
        bookmark_id: input.bookmarkId,
        limit: input.limit,
      },
    });
  }

  /**
   * Run a saved Mixpanel insight (bookmark) for a date range and return its computed value(s).
   * Same endpoint as listInsights, but with required `bookmark_id` + dates so Mixpanel returns
   * the evaluated series rather than the bookmark list.
   */
  async getInsight(input: {
    bookmarkId: number | string;
    fromDate?: string;
    toDate?: string;
    workspaceId?: number | string;
  }): Promise<unknown> {
    return this.fetchJson('insights', {
      params: {
        bookmark_id: input.bookmarkId,
        from_date: input.fromDate,
        to_date: input.toDate,
        workspace_id: input.workspaceId,
      },
    });
  }

  async getFunnel(input: {
    funnelId: number | string;
    fromDate: string;
    toDate: string;
    interval: 'day' | 'week' | 'month';
  }): Promise<unknown> {
    return this.fetchJson('funnels', {
      params: {
        funnel_id: input.funnelId,
        from_date: input.fromDate,
        to_date: input.toDate,
        unit: input.interval,
      },
    });
  }

  /**
   * Engage profile lookup. Accepts either `distinctId` or `email`. Mixpanel returns
   * paginated profile results in `results[]`.
   */
  async getEngageProfile(input: { distinctId?: string; email?: string }): Promise<unknown> {
    const params: Record<string, string> = {};
    if (input.distinctId) {
      params.distinct_id = input.distinctId;
    } else if (input.email) {
      params.where = `properties["$email"] == ${JSON.stringify(input.email)} or properties["email"] == ${JSON.stringify(input.email)}`;
    } else {
      throw new MixpanelError(
        'CONFIG_MISSING',
        'getEngageProfile requires either distinctId or email.',
        'Pass distinctId or email.',
      );
    }
    return this.fetchJson('engage', { params });
  }

  // ---- Private fetch infrastructure ----

  private endpoint(key: MixpanelEndpointKey): MixpanelEndpoint {
    return ENDPOINT_ALLOWLIST[key];
  }

  private buildUrl(endpoint: MixpanelEndpoint, params: Record<string, string | number | boolean | undefined>): URL {
    const host = endpoint.family === 'export' ? this.hosts.export : this.hosts.query;
    const url = new URL(`${host}${endpoint.path}`);
    // DL-15: project_id injected at the client level for every applicable request.
    url.searchParams.set('project_id', this.projectId);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
    return url;
  }

  private async fetchEndpoint(
    key: MixpanelEndpointKey,
    options: MixpanelRequestOptions = {},
  ): Promise<{ response: Response; endpointLabel: string }> {
    const endpoint = this.endpoint(key);
    const family = endpoint.family;
    const url = this.buildUrl(endpoint, options.params ?? {});
    const timeoutMs = options.timeoutOverrideMs ?? this.timeouts[family];

    // Fast-fail if a long cooldown is in effect (DL-7).
    const cooldownMs = sharedLimiter.cooldownRemainingMs(family);
    if (cooldownMs > 0) {
      throw new MixpanelError(
        'RATE_LIMIT',
        `Mixpanel ${endpoint.label} is in cooldown for another ${Math.ceil(cooldownMs / 1000)}s.`,
        resolution('Wait for the cooldown to expire, or narrow your date range.'),
        { endpoint: endpoint.label, retryAfterSeconds: Math.ceil(cooldownMs / 1000) },
      );
    }

    await sharedLimiter.waitForSlot(family);

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(new Error(`timeout:${timeoutMs}`)), timeoutMs);

    // Compose caller signal with timeout signal so the caller can still cancel.
    const callerAbort = (): void => controller.abort(options.signal?.reason ?? new Error('caller-aborted'));
    options.signal?.addEventListener('abort', callerAbort, { once: true });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: this.authHeader,
          Accept: endpoint.family === 'export' ? 'application/x-ndjson' : 'application/json',
        },
        signal: controller.signal,
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      options.signal?.removeEventListener('abort', callerAbort);
      clearTimeout(timeoutHandle);
      if (err instanceof Error && err.name === 'AbortError') {
        writeLog({
          level: 'error',
          code: 'TIMEOUT',
          endpoint: endpoint.label,
          region: this.region,
          duration_ms: durationMs,
          msg: `Mixpanel ${endpoint.label} timed out after ${timeoutMs}ms`,
        });
        throw new MixpanelError(
          'TIMEOUT',
          `Mixpanel ${endpoint.label} timed out after ${timeoutMs}ms.`,
          `Narrow your date range, or set ${TIMEOUT_RANGES_MS[family].envVar} to a higher value (current: ${timeoutMs}ms, max: ${TIMEOUT_RANGES_MS[family].max}ms).`,
          { endpoint: endpoint.label, timeoutMs },
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      writeLog({
        level: 'error',
        code: 'NETWORK',
        endpoint: endpoint.label,
        region: this.region,
        duration_ms: durationMs,
        msg: `Mixpanel ${endpoint.label} network error: ${msg}`,
      });
      throw new MixpanelError(
        'NETWORK',
        msg,
        resolution('Check your network connection.'),
        { endpoint: endpoint.label },
      );
    }
    options.signal?.removeEventListener('abort', callerAbort);
    clearTimeout(timeoutHandle);

    const durationMs = Date.now() - startedAt;

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('Retry-After'));
      // Best-effort drain so the connection can be reused.
      try { await response.text(); } catch { /* ignore */ }
      if (retryAfterSeconds !== null) {
        sharedLimiter.setCooldown(family, Date.now() + retryAfterSeconds * 1000);
      }
      writeLog({
        level: 'warn',
        code: 'RATE_LIMIT',
        endpoint: endpoint.label,
        region: this.region,
        http_status: 429,
        retry_after_seconds: retryAfterSeconds ?? undefined,
        duration_ms: durationMs,
        msg: `Mixpanel ${endpoint.label} 429 (retry_after=${retryAfterSeconds ?? 'unknown'}s)`,
      });
      throw new MixpanelError(
        'RATE_LIMIT',
        `Mixpanel rate-limited the request${retryAfterSeconds !== null ? ` (Retry-After: ${retryAfterSeconds}s)` : ''}.`,
        retryAfterSeconds !== null && retryAfterSeconds > RETRY_AFTER_FAIL_FAST_THRESHOLD_S
          ? `Mixpanel asked us to wait ${retryAfterSeconds}s; retry later or narrow the date range.`
          : resolution('Try again in a few seconds, or narrow the date range.'),
        { endpoint: endpoint.label, retryAfterSeconds: retryAfterSeconds ?? undefined, status: 429 },
      );
    }

    if (response.status === 401) {
      try { await response.text(); } catch { /* ignore */ }
      writeLog({
        level: 'error',
        code: 'AUTH',
        endpoint: endpoint.label,
        region: this.region,
        http_status: 401,
        duration_ms: durationMs,
        msg: `Mixpanel ${endpoint.label} 401 unauthorized`,
      });
      throw new MixpanelError(
        'AUTH',
        'Mixpanel rejected the credentials (HTTP 401).',
        'Verify your Mixpanel Service Account username and secret in Settings → Connectors → Mixpanel.',
        { endpoint: endpoint.label, status: 401 },
      );
    }

    if (response.status === 403) {
      try { await response.text(); } catch { /* ignore */ }
      writeLog({
        level: 'error',
        code: 'AUTH',
        endpoint: endpoint.label,
        region: this.region,
        http_status: 403,
        duration_ms: durationMs,
        msg: `Mixpanel ${endpoint.label} 403 forbidden`,
      });
      throw new MixpanelError(
        'AUTH',
        'Mixpanel returned 403 forbidden. The Service Account may lack access to this project, or the project_id is wrong.',
        'Verify MIXPANEL_PROJECT_ID and that the Service Account has access to this project (Mixpanel → Project Settings → Service Accounts).',
        { endpoint: endpoint.label, status: 403 },
      );
    }

    if (response.status === 404) {
      try { await response.text(); } catch { /* ignore */ }
      writeLog({
        level: 'warn',
        code: 'NOT_FOUND',
        endpoint: endpoint.label,
        region: this.region,
        http_status: 404,
        duration_ms: durationMs,
        msg: `Mixpanel ${endpoint.label} 404 not found`,
      });
      throw new MixpanelError(
        'NOT_FOUND',
        `Mixpanel returned 404 for ${endpoint.label}.`,
        resolution('Verify the resource ID (cohort_id, funnel_id, etc.) and try again.'),
        { endpoint: endpoint.label, status: 404 },
      );
    }

    if (!response.ok) {
      let bodyText = '';
      try { bodyText = await response.text(); } catch { /* ignore */ }
      writeLog({
        level: 'error',
        code: 'API_ERROR',
        endpoint: endpoint.label,
        region: this.region,
        http_status: response.status,
        duration_ms: durationMs,
        msg: `Mixpanel ${endpoint.label} HTTP ${response.status}`,
      });
      const snippet = bodyText.slice(0, 200);
      throw new MixpanelError(
        'API_ERROR',
        `Mixpanel ${endpoint.label} returned HTTP ${response.status}${snippet ? `: ${snippet}` : ''}.`,
        resolution('Try again with narrower filters or a smaller date range.'),
        { endpoint: endpoint.label, status: response.status },
      );
    }

    writeLog({
      level: 'info',
      endpoint: endpoint.label,
      region: this.region,
      http_status: response.status,
      duration_ms: durationMs,
      msg: `Mixpanel ${endpoint.label} ok`,
    });

    return { response, endpointLabel: endpoint.label };
  }

  private async fetchJson(key: MixpanelEndpointKey, options: MixpanelRequestOptions = {}): Promise<unknown> {
    const { response, endpointLabel } = await this.fetchEndpoint(key, options);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > PRE_PARSE_SIZE_CAP_BYTES) {
      throw new MixpanelError(
        'RESPONSE_TOO_LARGE',
        `Mixpanel ${endpointLabel} response exceeded ${PRE_PARSE_SIZE_CAP_BYTES} bytes.`,
        resolution('Narrow your filters or date range.'),
        { endpoint: endpointLabel },
      );
    }
    try {
      const parsed = JSON.parse(text);
      return redactUrlTokensDeep(parsed);
    } catch {
      throw new MixpanelError(
        'RESPONSE_INVALID',
        `Mixpanel ${endpointLabel} returned a non-JSON response.`,
        resolution('Try again. If this repeats, the connector may need an update.'),
        { endpoint: endpointLabel },
      );
    }
  }
}

// Re-export so tools and tests can introspect without reaching into types.ts directly.
export { ENDPOINT_ALLOWLIST, NDJSON_EVENT_HARD_CAP };
