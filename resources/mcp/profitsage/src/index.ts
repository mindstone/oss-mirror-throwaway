#!/usr/bin/env node
/**
 * ProfitSage MCP Server
 *
 * Exposes the ProfitSage / ProfitSword Data Portal v3 API as MCP tools.
 * This is a generic connector: the tenant subdomain + API username +
 * API password are supplied per-deployment via env vars.
 *
 * Auth flow (OAuth2 Resource Owner Password Credentials, RFC 6749 §4.3):
 *   POST https://<subdomain>.profitsage.net/PS-Handlers/token
 *     body: grant_type=password&username=...&password=...
 *   -> { access_token, token_type: "bearer", expires_in: 3599 }
 *
 * Data calls (all GET, all append access_token as a query parameter):
 *   https://<subdomain>.profitsage.net/PS-Handlers/api/DataPortalv3/<Endpoint>?access_token=...&...
 *
 * Environment variables:
 *   PROFITSAGE_SUBDOMAIN  Tenant subdomain on profitsage.net (e.g. "acmehotels")
 *   PROFITSAGE_USERNAME   API username
 *   PROFITSAGE_PASSWORD   API password (use a service account, not a human login)
 *
 * See docs/project/mcps/PROFITSAGE.md for the Intent & Design Rationale.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

// ─── Configuration ──────────────────────────────────────────────────────────

const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;
const REQUEST_TIMEOUT_MS = 30_000;
/** Refresh token this many ms before declared expiry to avoid races. */
const TOKEN_REFRESH_SLACK_MS = 60_000;
/** Soft cap on default-response size; tools truncate with a hint when exceeded. */
const SOFT_RESPONSE_CAP_BYTES = 50_000;

const env = {
  subdomain: (process.env.PROFITSAGE_SUBDOMAIN ?? '').trim(),
  username: (process.env.PROFITSAGE_USERNAME ?? '').trim(),
  password: process.env.PROFITSAGE_PASSWORD ?? '',
};

// ─── Error helpers ──────────────────────────────────────────────────────────

class ProfitSageError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'ProfitSageError';
  }
}

function missingConfigError(): ProfitSageError {
  const missing: string[] = [];
  if (!env.subdomain) missing.push('PROFITSAGE_SUBDOMAIN');
  if (!env.username) missing.push('PROFITSAGE_USERNAME');
  if (!env.password) missing.push('PROFITSAGE_PASSWORD');
  return new ProfitSageError(
    `ProfitSage credentials missing: ${missing.join(', ')}`,
    'CONFIG_MISSING',
    'Open Settings → Connectors → ProfitSage and enter the tenant subdomain, API username, and API password.',
  );
}

function invalidSubdomainError(): ProfitSageError {
  return new ProfitSageError(
    `Invalid PROFITSAGE_SUBDOMAIN "${env.subdomain}" — expected a DNS label like "acmehotels".`,
    'CONFIG_INVALID',
    'Enter only the subdomain portion (the part before ".profitsage.net"). Must be letters, digits, and hyphens; no slashes, dots, or spaces.',
  );
}

function formatError(error: unknown): string {
  if (error instanceof ProfitSageError) {
    return JSON.stringify({ ok: false, error: error.message, code: error.code, resolution: error.resolution });
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return JSON.stringify({
      ok: false,
      error: 'Request timed out after 30 seconds',
      code: 'TIMEOUT',
      resolution: 'ProfitSage took too long to respond. Try narrowing your date range or site selection and try again.',
    });
  }
  return JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    resolution: 'Check the subdomain and credentials in Settings → Connectors → ProfitSage.',
  });
}

function errorResolution(status: number, detail?: string): string {
  const msg = (detail || '').toLowerCase();
  if (status === 400 && msg.includes('invalid_grant')) {
    return 'The ProfitSage username or password was rejected. Verify the API credentials in Settings → Connectors → ProfitSage.';
  }
  if (status === 401 || status === 403) {
    return 'ProfitSage rejected the request. Re-enter the API credentials in Settings → Connectors → ProfitSage; the service account may be disabled.';
  }
  if (status === 404) {
    return 'Endpoint not found. Verify the subdomain is correct and that your tenant has Data Portal v3 enabled.';
  }
  if (status === 429) {
    return 'Rate limited by ProfitSage. Wait a moment, then narrow your query (fewer dates, specific site).';
  }
  if (status >= 500) {
    return 'ProfitSage had a server error. Try again shortly; if it persists, contact your ProfitSage administrator.';
  }
  return 'Check the parameters and try again.';
}

// ─── Subdomain & URL helpers ────────────────────────────────────────────────

function assertValidSubdomain(): void {
  if (!env.subdomain) throw missingConfigError();
  if (!SUBDOMAIN_REGEX.test(env.subdomain)) throw invalidSubdomainError();
}

function baseUrl(): string {
  return `https://${env.subdomain}.profitsage.net/PS-Handlers`;
}

// ─── Date helpers ───────────────────────────────────────────────────────────

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const US_DATE_REGEX = /^\d{1,2}\/\d{1,2}\/\d{4}$/;

/**
 * ProfitSage accepts MM/dd/yyyy dates. Accept ISO YYYY-MM-DD from callers
 * and convert — the ISO form is what the rest of Rebel uses consistently,
 * so agents don't need to learn a second format.
 */
function toApiDate(value: string, fieldName: string): string {
  const v = value.trim();
  if (US_DATE_REGEX.test(v)) return v;
  if (!ISO_DATE_REGEX.test(v)) {
    throw new ProfitSageError(
      `Invalid ${fieldName}: "${value}". Expected YYYY-MM-DD (e.g. 2025-03-01).`,
      'VALIDATION',
      `Format ${fieldName} as YYYY-MM-DD.`,
    );
  }
  const [y, m, d] = v.split('-');
  return `${Number(m)}/${Number(d)}/${y}`;
}

// ─── Token cache ────────────────────────────────────────────────────────────

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

let tokenCache: CachedToken | null = null;
/**
 * In-flight token-exchange promise. Concurrent tool calls during expiry must
 * NOT each fire POST /token — we memoize the promise and clear it once settled.
 */
let tokenInflight: Promise<CachedToken> | null = null;

async function fetchNewToken(): Promise<CachedToken> {
  assertValidSubdomain();
  if (!env.username || !env.password) throw missingConfigError();

  const body = new URLSearchParams({
    grant_type: 'password',
    username: env.username,
    password: env.password,
  }).toString();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl()}/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        const j = (await response.json()) as { error_description?: string; error?: string };
        detail = j.error_description || j.error || '';
      } catch {
        /* non-JSON body — ignore */
      }
      throw new ProfitSageError(
        `Token exchange failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
        `HTTP_${response.status}`,
        errorResolution(response.status, detail),
      );
    }

    const json = (await response.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
    };

    if (!json.access_token) {
      throw new ProfitSageError(
        'Token exchange returned no access_token.',
        'AUTH_MALFORMED',
        'Contact your ProfitSage administrator — the /PS-Handlers/token endpoint returned an unexpected response.',
      );
    }

    const expiresInMs = Math.max(0, (json.expires_in ?? 3599) * 1000 - TOKEN_REFRESH_SLACK_MS);
    return { accessToken: json.access_token, expiresAtMs: Date.now() + expiresInMs };
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && tokenCache && tokenCache.expiresAtMs > Date.now()) {
    return tokenCache.accessToken;
  }
  // Dedup concurrent refreshes: first caller starts the exchange, siblings await the same promise.
  if (!tokenInflight) {
    tokenInflight = fetchNewToken().finally(() => {
      tokenInflight = null;
    });
  }
  tokenCache = await tokenInflight;
  return tokenCache.accessToken;
}

// ─── Data-Portal GET wrapper ────────────────────────────────────────────────

type QueryValue = string | number | boolean | null | undefined;

function buildQuery(
  token: string,
  params: Record<string, QueryValue>,
): string {
  const sp = new URLSearchParams();
  sp.set('access_token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

/**
 * Call a Data Portal v3 endpoint with the cached token, refreshing once on 401.
 *
 * Error handling contract:
 *   - Full upstream response bodies are logged to stderr (operator-visible) only.
 *   - The error surfaced to the model contains HTTP status + sanitized short hint,
 *     never raw upstream text (which can contain sensitive SQL snippets, internal
 *     stack traces, or other content we shouldn't leak into the conversation).
 */
async function psGet<T>(endpoint: string, params: Record<string, QueryValue>): Promise<T> {
  assertValidSubdomain();

  const call = async (token: string): Promise<Response> => {
    const url = `${baseUrl()}/api/DataPortalv3/${endpoint}?${buildQuery(token, params)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  let token = await getAccessToken();
  let response = await call(token);
  let retriedAfter401 = false;

  if (response.status === 401) {
    retriedAfter401 = true;
    token = await getAccessToken(true);
    response = await call(token);
  }

  if (!response.ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      /* ignore */
    }

    // Operator-visible: full detail (truncated for log hygiene only).
    const loggedDetail = detail.length > 2000 ? detail.slice(0, 2000) + '…' : detail;
    console.error(
      `[ProfitSage MCP] HTTP ${response.status} on ${endpoint}${retriedAfter401 ? ' (after token refresh)' : ''}: ${loggedDetail}`,
    );

    // Model-visible: status + resolution hint only. No raw body.
    const resolution =
      retriedAfter401 && (response.status === 401 || response.status === 403)
        ? 'Credentials still rejected after a token refresh — the API user may be locked, disabled, or its password was rotated. Re-enter credentials in Settings → Connectors → ProfitSage.'
        : errorResolution(response.status, detail);

    throw new ProfitSageError(
      `ProfitSage ${endpoint} failed (HTTP ${response.status})`,
      `HTTP_${response.status}`,
      resolution,
    );
  }

  if (response.status === 204) return [] as unknown as T;
  return (await response.json()) as T;
}

// ─── Response shaping ──────────────────────────────────────────────────────

function shapeListResponse<T>(endpoint: string, rows: T[]): string {
  const base = { ok: true, endpoint, count: rows.length };
  const full = JSON.stringify({ ...base, rows });
  if (full.length <= SOFT_RESPONSE_CAP_BYTES) return full;

  // Response too large — return first N rows plus a hint. Never silently truncate without flagging it.
  const sample = [] as T[];
  let sampleBytes = 0;
  for (const row of rows) {
    const rowBytes = JSON.stringify(row).length + 1;
    if (sampleBytes + rowBytes > SOFT_RESPONSE_CAP_BYTES / 2) break;
    sample.push(row);
    sampleBytes += rowBytes;
  }
  return JSON.stringify({
    ...base,
    truncated: true,
    returned_rows: sample.length,
    rows: sample,
    hint: `Response was ${full.length} bytes (soft cap ${SOFT_RESPONSE_CAP_BYTES}). Narrow your query: specify a single site_tag or a shorter date range.`,
  });
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const siteParam = {
  site_tag: {
    type: 'string' as const,
    description: 'Property site tag (from list_sites) or company ID. Use "ALL" where the endpoint supports it.',
  },
};

const dateRangeParam = {
  begin_date: {
    type: 'string' as const,
    description: 'Start date in YYYY-MM-DD (converted to MM/dd/yyyy for the API).',
  },
  end_date: {
    type: 'string' as const,
    description: 'End date in YYYY-MM-DD. Set to the same value as begin_date for a single day.',
  },
};

const extendedFilters = {
  data_set_id: {
    type: 'string' as const,
    description: 'Data set ID (from list_data_sets). Required for financial extended endpoints.',
  },
  as_of_date: {
    type: 'string' as const,
    description: 'As-of date for the request in YYYY-MM-DD. Omit for most-current data.',
  },
  item_list_id: {
    type: 'string' as const,
    description: 'Item List ID (provided by ProfitSword). Omit to include all items.',
  },
  item_tag: {
    type: 'string' as const,
    description: 'Specific item tag to return data for.',
  },
  include_zeroes: {
    type: 'boolean' as const,
    description: 'Include rows with zero amounts/stats. Default: false (omit Y to exclude).',
  },
  include_totals: {
    type: 'boolean' as const,
    description: 'Include total rows. Default: false (send Y to include).',
  },
  class: {
    type: 'string' as const,
    description: 'Only return accounts from this department class (from list_account_classes).',
  },
  exclude_class: {
    type: 'string' as const,
    description: 'Exclude accounts from this department class.',
  },
  exclude_special_accounts: {
    type: 'boolean' as const,
    description: 'Exclude ProfitSage IJ-mapping accounts that flow into other GL accounts.',
  },
  local_currency: {
    type: 'boolean' as const,
    description: 'Return data in each property\'s local currency (default). Set false for USD.',
  },
  dept: {
    type: 'string' as const,
    enum: ['GREV', 'GLAB', 'GEXP'] as const,
    description: 'Only return accounts in this department: GREV (Revenue), GLAB (Labor), GEXP (Expense).',
  },
  exclude_dept: {
    type: 'string' as const,
    enum: ['GREV', 'GLAB', 'GEXP'] as const,
    description: 'Exclude accounts in this department.',
  },
};

const tools: Tool[] = [
  // ── Discovery ─────────────────────────────────────────────────────────
  {
    name: 'list_sites',
    description:
      'List the ProfitSage properties (hotels / sites) available to this account. Returns each site\'s siteTag, siteName, and address — use siteTag for all subsequent queries.\n\nWORKFLOW: Almost every other tool needs a site_tag; start here.\n\nRETURNS: { rows: [{ siteTag, siteName, siteAddress1, siteCity, siteState, siteZip, ... }] }',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_data_sets',
    description:
      'List the ProfitSage data sets (e.g. Primary Forecast, Prior Forecast) available for extended reporting.\n\nWORKFLOW: Use before get_daily_extended / get_monthly_extended to find the right data_set_id.\n\nRETURNS: { rows: [{ dataSetID, description }] }',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_account_classes',
    description:
      'List available account class codes (department filters). Use these with the `class` or `exclude_class` parameter on the extended reports.\n\nRETURNS: { rows: [...] }',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ── Labor ─────────────────────────────────────────────────────────────
  {
    name: 'get_daily_labor',
    description:
      'Daily labor detail by employee and account for a site and date range.\n\nREQUIRED: begin_date, end_date, site_tag.\n\nDates accept YYYY-MM-DD. Use "ALL" or a specific siteTag (from list_sites). For a single day, set end_date equal to begin_date.\n\nRETURNS: { rows: [{ siteTag, siteName, personID, date, employee ID, hours, amounts, type, label }] }',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...siteParam,
        ...dateRangeParam,
      },
      required: ['begin_date', 'end_date', 'site_tag'],
    },
  },

  // ── Financial extended ─────────────────────────────────────────────────
  {
    name: 'get_daily_extended',
    description:
      'Daily P&L-style detail: accounts × amounts for a data set across a date range.\n\nREQUIRED: site_tag, data_set_id, begin_date, end_date.\n\nRESPONSE SIZE: can be large. Prefer a single site_tag and a ≤31-day range. Defaults exclude zero rows and totals; set include_zeroes=true / include_totals=true to override.\n\nRETURNS: { rows: [...] }',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...siteParam,
        ...dateRangeParam,
        ...extendedFilters,
      },
      required: ['site_tag', 'data_set_id', 'begin_date', 'end_date'],
    },
  },
  {
    name: 'get_monthly_extended',
    description:
      'Monthly P&L detail for a data set across a month / year range.\n\nREQUIRED: site_tag, data_set_id, year, begin_month, end_month.\n\nMonths are 1-12. end_year is optional; omit to stay within a single year.\n\nRETURNS: { rows: [...] }',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ...siteParam,
        ...extendedFilters,
        year: { type: 'integer', description: 'Begin year (yyyy, e.g. 2025).' },
        end_year: { type: 'integer', description: 'End year (yyyy). Optional; defaults to year.' },
        begin_month: { type: 'integer', description: 'Begin month (1-12).' },
        end_month: { type: 'integer', description: 'End month (1-12). Use same as begin_month for a single month.' },
      },
      required: ['site_tag', 'data_set_id', 'year', 'begin_month', 'end_month'],
    },
  },

  // ── Ledger ────────────────────────────────────────────────────────────
  {
    name: 'get_ledger_batches',
    description:
      'GL ledger batches for a site and date range.\n\nREQUIRED: site_tag, begin_date, end_date, status, type_id.\n\n- status: "E" (Exported), "S" (Submitted), or "ALL".\n- type_id: a specific type or "ALL".\n- site_tag: specific tag, or "ALL" for all sites.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        site_tag: siteParam.site_tag,
        ...dateRangeParam,
        status: { type: 'string', description: 'Batch status: "E", "S", or "ALL".' },
        type_id: { type: 'string', description: 'Batch type ID or "ALL".' },
      },
      required: ['site_tag', 'begin_date', 'end_date', 'status', 'type_id'],
    },
  },

  // ── Sales ─────────────────────────────────────────────────────────────
  {
    name: 'get_sales_bookings',
    description:
      'Sales bookings within a date range. site_tag is optional — omit or leave empty to pull all properties.\n\nRETURNS: { rows: [{ bookingType, bookingID, siteTag, saleSysCode, resName, resAcctName, marketSeg, minDate, maxDate }] }',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        site_tag: siteParam.site_tag,
        ...dateRangeParam,
      },
      required: ['begin_date', 'end_date'],
    },
  },
  {
    name: 'get_sales_pace_events',
    description:
      'Sales pace event-level data for a site and date range.\n\nREQUIRED: as_of_date, begin_date, end_date, site_tag. Use site_tag="ALL" for all properties.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        site_tag: siteParam.site_tag,
        as_of_date: extendedFilters.as_of_date,
        ...dateRangeParam,
      },
      required: ['as_of_date', 'begin_date', 'end_date', 'site_tag'],
    },
  },
  {
    name: 'get_sales_pace_rooms',
    description:
      'Sales pace room-night data for a site and date range.\n\nREQUIRED: as_of_date, begin_date, end_date, site_tag. Use site_tag="ALL" for all properties.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        site_tag: siteParam.site_tag,
        as_of_date: extendedFilters.as_of_date,
        ...dateRangeParam,
      },
      required: ['as_of_date', 'begin_date', 'end_date', 'site_tag'],
    },
  },
  {
    name: 'get_sales_pace_transient',
    description:
      'Sales pace transient (non-group) data for a site and date range.\n\nREQUIRED: as_of_date, begin_date, end_date, site_tag. Use site_tag="ALL" for all properties.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        site_tag: siteParam.site_tag,
        as_of_date: extendedFilters.as_of_date,
        ...dateRangeParam,
      },
      required: ['as_of_date', 'begin_date', 'end_date', 'site_tag'],
    },
  },
];

// ─── Handlers ───────────────────────────────────────────────────────────────

interface ExtendedArgs {
  site_tag?: string;
  data_set_id?: string;
  as_of_date?: string;
  item_list_id?: string;
  item_tag?: string;
  include_zeroes?: boolean;
  include_totals?: boolean;
  class?: string;
  exclude_class?: string;
  exclude_special_accounts?: boolean;
  local_currency?: boolean;
  dept?: string;
  exclude_dept?: string;
}

function extendedQuery(args: ExtendedArgs): Record<string, QueryValue> {
  return {
    siteTag: args.site_tag,
    dataSetID: args.data_set_id,
    asOfDate: args.as_of_date ? toApiDate(args.as_of_date, 'as_of_date') : undefined,
    itemListID: args.item_list_id,
    itemTag: args.item_tag,
    includeZeroes: args.include_zeroes ? 'Y' : 'N',
    includeTotals: args.include_totals ? 'Y' : 'N',
    class: args.class,
    excludeClass: args.exclude_class,
    excludeSpecialAccounts: args.exclude_special_accounts ? 'Y' : undefined,
    localCurrency: args.local_currency === false ? 'N' : 'Y',
    dept: args.dept,
    excludeDept: args.exclude_dept,
  };
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case 'list_sites': {
        const rows = await psGet<unknown[]>('Sites', {});
        return shapeListResponse('Sites', Array.isArray(rows) ? rows : []);
      }
      case 'list_data_sets': {
        const rows = await psGet<unknown[]>('DataSets', {});
        return shapeListResponse('DataSets', Array.isArray(rows) ? rows : []);
      }
      case 'list_account_classes': {
        const rows = await psGet<unknown[]>('AccountClass', {});
        return shapeListResponse('AccountClass', Array.isArray(rows) ? rows : []);
      }

      case 'get_daily_labor': {
        const a = args as { site_tag: string; begin_date: string; end_date: string };
        const rows = await psGet<unknown[]>('DailyLabor', {
          SiteTag: a.site_tag,
          BD: toApiDate(a.begin_date, 'begin_date'),
          ED: toApiDate(a.end_date, 'end_date'),
        });
        return shapeListResponse('DailyLabor', Array.isArray(rows) ? rows : []);
      }

      case 'get_daily_extended': {
        const a = args as unknown as ExtendedArgs & { begin_date: string; end_date: string };
        const rows = await psGet<unknown[]>('DailyExtended', {
          ...extendedQuery(a),
          bd: toApiDate(a.begin_date, 'begin_date'),
          ed: toApiDate(a.end_date, 'end_date'),
        });
        return shapeListResponse('DailyExtended', Array.isArray(rows) ? rows : []);
      }

      case 'get_monthly_extended': {
        const a = args as unknown as ExtendedArgs & {
          year: number;
          end_year?: number;
          begin_month: number;
          end_month: number;
        };
        const rows = await psGet<unknown[]>('MonthlyExtended', {
          ...extendedQuery(a),
          year: a.year,
          eyear: a.end_year,
          begmonth: a.begin_month,
          endmonth: a.end_month,
        });
        return shapeListResponse('MonthlyExtended', Array.isArray(rows) ? rows : []);
      }

      case 'get_ledger_batches': {
        const a = args as { site_tag: string; begin_date: string; end_date: string; status: string; type_id: string };
        const rows = await psGet<unknown[]>('LedgerBatches', {
          siteTag: a.site_tag,
          bd: toApiDate(a.begin_date, 'begin_date'),
          ed: toApiDate(a.end_date, 'end_date'),
          status: a.status,
          typeID: a.type_id,
        });
        return shapeListResponse('LedgerBatches', Array.isArray(rows) ? rows : []);
      }

      case 'get_sales_bookings': {
        const a = args as { site_tag?: string; begin_date: string; end_date: string };
        const rows = await psGet<unknown[]>('SalesBookings', {
          SiteTag: a.site_tag,
          BD: toApiDate(a.begin_date, 'begin_date'),
          ED: toApiDate(a.end_date, 'end_date'),
        });
        return shapeListResponse('SalesBookings', Array.isArray(rows) ? rows : []);
      }

      case 'get_sales_pace_events':
      case 'get_sales_pace_rooms':
      case 'get_sales_pace_transient': {
        const endpointMap: Record<string, string> = {
          get_sales_pace_events: 'SalesPaceEvents',
          get_sales_pace_rooms: 'SalesPaceRooms',
          get_sales_pace_transient: 'SalesPaceTransient',
        };
        const endpoint = endpointMap[name];
        const a = args as { site_tag: string; as_of_date: string; begin_date: string; end_date: string };
        const rows = await psGet<unknown[]>(endpoint, {
          siteTag: a.site_tag,
          AsOfDate: toApiDate(a.as_of_date, 'as_of_date'),
          BD: toApiDate(a.begin_date, 'begin_date'),
          ED: toApiDate(a.end_date, 'end_date'),
        });
        return shapeListResponse(endpoint, Array.isArray(rows) ? rows : []);
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
    }
  } catch (error) {
    return formatError(error);
  }
}

// ─── Server bootstrap ───────────────────────────────────────────────────────

const server = new Server(
  { name: 'profitsage-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await handleToolCall(name, (args as Record<string, unknown>) ?? {});
  return { content: [{ type: 'text', text: result }] };
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[ProfitSage MCP] Server started');
}

process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));

main().catch((err) => {
  console.error('[ProfitSage MCP] Fatal:', err);
  process.exit(1);
});
