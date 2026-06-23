import { z } from 'zod';
import {
  EMAIL_ADDRESS_REGEX,
  LINUX_HOME_DIRECTORY_REGEX,
  MACOS_HOME_DIRECTORY_REGEX,
  SENSITIVE_URL_PARAM_PATTERNS,
  WINDOWS_HOME_DIRECTORY_REGEX,
} from '@shared/utils/redactionPatterns';

declare const safeTelemetryTextBrand: unique symbol;
declare const safeKeyedCountsBrand: unique symbol;

export type SafeTelemetryText = string & {
  readonly [safeTelemetryTextBrand]: true;
};

export type SafeKeyedCounts = Readonly<Record<string, number>> & {
  readonly [safeKeyedCountsBrand]: true;
};

const MAX_SAFE_TEXT_LENGTH = 512;
const MAX_KEYED_COUNT_ENTRIES = 100;
const MAX_KEYED_COUNT_KEY_LENGTH = 128;
const REDACTED_EMAIL = '[email]';
const REDACTED_ACCOUNT = '[account]';

export const BUNDLED_SERVER_NAMES = [
  'RebelInbox',
  'RebelMeetings',
  'RebelSearchAndConversations',
  'RebelAutomations',
  'RebelSpaces',
  'RebelSettings',
  'RebelMcpConnectors',
] as const;

export const OAUTH_REFRESH_PROVIDER_BASE_NAMES = [
  'GoogleWorkspace',
  'Microsoft365Calendar',
  'Microsoft365Mail',
  'unknown',
] as const;

export const API_COOLDOWN_SCOPES = ['api'] as const;

export const TOOL_ADVISORY_KINDS = [
  'consecutive_error',
  'global_consecutive_error',
  'soft_budget',
  'hard_budget',
  'unknown',
] as const;

const CONNECTOR_INSTANCE_BASE_NAMES = [
  'GoogleWorkspace',
  'Microsoft365Calendar',
  'Microsoft365Mail',
  'Office365',
  'HubSpot',
  'Salesforce',
  'Zendesk',
  'Slack',
] as const;

function isConnectorSlugChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    char === '-'
  );
}

function scrubKnownConnectorInstanceSlugs(value: string): string {
  let result = value;

  for (const baseName of CONNECTOR_INSTANCE_BASE_NAMES) {
    let searchFrom = 0;
    const prefix = `${baseName}-`;

    while (searchFrom < result.length) {
      const start = result.indexOf(prefix, searchFrom);
      if (start === -1) break;

      let end = start + prefix.length;
      while (end < result.length && isConnectorSlugChar(result[end] ?? '')) {
        end += 1;
      }

      if (end === start + prefix.length) {
        searchFrom = end;
        continue;
      }

      const replacement = `${baseName}-${REDACTED_ACCOUNT}`;
      result = `${result.slice(0, start)}${replacement}${result.slice(end)}`;
      searchFrom = start + replacement.length;
    }
  }

  return result;
}

function redactUrlParams(value: string): string {
  let result = value;
  for (const { pattern, replacement } of SENSITIVE_URL_PARAM_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function redactTelemetryText(value: string): string {
  let result = redactUrlParams(value);
  result = result.replace(MACOS_HOME_DIRECTORY_REGEX, '~');
  result = result.replace(LINUX_HOME_DIRECTORY_REGEX, '~');
  result = result.replace(WINDOWS_HOME_DIRECTORY_REGEX, '~');
  result = result.replace(EMAIL_ADDRESS_REGEX, REDACTED_EMAIL);
  result = scrubKnownConnectorInstanceSlugs(result);

  if (result.length > MAX_SAFE_TEXT_LENGTH) {
    return `${result.slice(0, MAX_SAFE_TEXT_LENGTH - 3)}...`;
  }

  return result;
}

function isRuntimeSafeTelemetryText(value: string): boolean {
  return value.length <= MAX_SAFE_TEXT_LENGTH && redactTelemetryText(value) === value;
}

export function scrubbedTelemetryText(value: string): SafeTelemetryText {
  return redactTelemetryText(value) as SafeTelemetryText;
}

export function safeClosedSet<const T extends readonly string[]>(
  allowedValues: T,
  value: string | null | undefined,
  fallback: T[number],
): SafeTelemetryText {
  return scrubbedTelemetryText(
    value !== undefined && value !== null && (allowedValues as readonly string[]).includes(value)
      ? value
      : fallback,
  );
}

export function safeClosedSetArray<const T extends readonly string[]>(
  allowedValues: T,
  values: readonly string[],
  fallback: T[number],
): readonly SafeTelemetryText[] {
  return values.map((value) => safeClosedSet(allowedValues, value, fallback));
}

export function safeKeyedCounts(counts: Readonly<Record<string, number>>): SafeKeyedCounts {
  const entries = Object.entries(counts);
  if (entries.length > MAX_KEYED_COUNT_ENTRIES) {
    throw new RangeError(`Safe keyed counts exceed ${MAX_KEYED_COUNT_ENTRIES} entries`);
  }

  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > MAX_KEYED_COUNT_KEY_LENGTH) {
      throw new RangeError('Safe keyed count key length is out of range');
    }
    if (!Number.isFinite(value)) {
      throw new TypeError('Safe keyed count value must be finite');
    }
  }

  return { ...counts } as SafeKeyedCounts;
}

export interface SafeCheckDetailsByCheck {
  toolIndexHealth: {
    toolCount?: number;
    byServer?: SafeKeyedCounts;
    isInitialized?: boolean;
    lastRefreshAt?: number | SafeTelemetryText | null;
  };
  bundledServers: {
    present?: readonly SafeTelemetryText[];
    missing?: readonly SafeTelemetryText[];
    diagnostics?: boolean;
  };
  mcpSkippedServers: {
    skippedCount?: number;
  };
  apiCooldownHealth: {
    scope?: SafeTelemetryText;
    remainingMs?: number;
  };
  oauthRefreshHealth: {
    connectorServerNames?: readonly SafeTelemetryText[];
    providerCount?: number;
  };
  mcpRuntimeHealth: {
    consecutiveFailures?: number;
  };
  toolAdvisoryHealth: {
    advisoryKindCounts?: SafeKeyedCounts;
  };
}

type SafeCheckDetailFieldRegistry = {
  readonly [K in keyof SafeCheckDetailsByCheck]: readonly (keyof SafeCheckDetailsByCheck[K])[];
};

export const SAFE_CHECK_DETAIL_FIELDS = {
  toolIndexHealth: ['toolCount', 'byServer', 'isInitialized', 'lastRefreshAt'],
  bundledServers: ['present', 'missing', 'diagnostics'],
  mcpSkippedServers: ['skippedCount'],
  apiCooldownHealth: ['scope', 'remainingMs'],
  oauthRefreshHealth: ['connectorServerNames', 'providerCount'],
  mcpRuntimeHealth: ['consecutiveFailures'],
  toolAdvisoryHealth: ['advisoryKindCounts'],
} as const satisfies SafeCheckDetailFieldRegistry;

export type SafeCheckId = keyof typeof SAFE_CHECK_DETAIL_FIELDS;

type SafeCheckFieldSchemas = {
  readonly [K in SafeCheckId]: {
    readonly [F in keyof SafeCheckDetailsByCheck[K]]: z.ZodType<unknown>;
  };
};

const finiteNumberSchema = z.number().finite();
const nonNegativeFiniteNumberSchema = finiteNumberSchema.nonnegative();
const safeTextSchema = z
  .string()
  .max(MAX_SAFE_TEXT_LENGTH)
  .refine(isRuntimeSafeTelemetryText, 'text must already be scrubbed');
const safeKeyedCountsSchema = z
  .record(z.string().min(1).max(MAX_KEYED_COUNT_KEY_LENGTH), finiteNumberSchema)
  .refine(
    (value) => Object.keys(value).length <= MAX_KEYED_COUNT_ENTRIES,
    `record must have at most ${MAX_KEYED_COUNT_ENTRIES} entries`,
  );
const toolAdvisoryKindSet = new Set<string>(TOOL_ADVISORY_KINDS);
const advisoryKindCountsSchema = safeKeyedCountsSchema.refine(
  (value) => Object.keys(value).every((key) => toolAdvisoryKindSet.has(key)),
  'all keys must be in the closed set',
);

function closedSetSchema(values: readonly string[]): z.ZodType<unknown> {
  return z.string().refine((value) => values.includes(value), 'value must be in the closed set');
}

function closedSetArraySchema(values: readonly string[]): z.ZodType<unknown> {
  return z
    .array(z.string())
    .readonly()
    .refine(
      (items) => items.every((item) => values.includes(item)),
      'all values must be in the closed set',
    );
}

const SAFE_CHECK_DETAIL_FIELD_SCHEMAS = {
  toolIndexHealth: {
    toolCount: nonNegativeFiniteNumberSchema,
    byServer: safeKeyedCountsSchema,
    isInitialized: z.boolean(),
    lastRefreshAt: z.union([finiteNumberSchema, safeTextSchema, z.null()]),
  },
  bundledServers: {
    present: closedSetArraySchema(BUNDLED_SERVER_NAMES),
    missing: closedSetArraySchema(BUNDLED_SERVER_NAMES),
    diagnostics: z.boolean(),
  },
  mcpSkippedServers: {
    skippedCount: nonNegativeFiniteNumberSchema,
  },
  apiCooldownHealth: {
    scope: closedSetSchema(API_COOLDOWN_SCOPES),
    remainingMs: nonNegativeFiniteNumberSchema,
  },
  oauthRefreshHealth: {
    connectorServerNames: closedSetArraySchema(OAUTH_REFRESH_PROVIDER_BASE_NAMES),
    providerCount: nonNegativeFiniteNumberSchema,
  },
  mcpRuntimeHealth: {
    consecutiveFailures: nonNegativeFiniteNumberSchema,
  },
  toolAdvisoryHealth: {
    advisoryKindCounts: advisoryKindCountsSchema,
  },
} as const satisfies SafeCheckFieldSchemas;

export function defineSafeCheckDetails<K extends SafeCheckId>(
  _checkId: K,
  details: Partial<SafeCheckDetailsByCheck[K]>,
): Partial<SafeCheckDetailsByCheck[K]> {
  return details;
}

export function isSafeCheckId(checkId: string): checkId is SafeCheckId {
  return Object.prototype.hasOwnProperty.call(SAFE_CHECK_DETAIL_FIELDS, checkId);
}

export function validateSafeCheckDetailField(
  checkId: SafeCheckId,
  field: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const schema = (SAFE_CHECK_DETAIL_FIELD_SCHEMAS[checkId] as Readonly<Record<string, z.ZodType<unknown>>>)[field];
  if (!schema) {
    return { ok: false, reason: 'field is not registered for safe health-check details' };
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues.map((issue: z.ZodIssue) => issue.message).join('; '),
    };
  }
  return { ok: true, value: result.data };
}

function scrubKeyedCountsForSentry(value: Record<string, number>): Record<string, number> {
  const scrubbed: Record<string, number> = {};

  for (const [key, count] of Object.entries(value)) {
    const safeKey = redactTelemetryText(key);
    scrubbed[safeKey] = (scrubbed[safeKey] ?? 0) + count;
  }

  return scrubbed;
}

export function sanitizeSafeCheckDetailValueForSentry(
  checkId: SafeCheckId,
  field: string,
  value: unknown,
): unknown {
  if (
    (checkId === 'toolIndexHealth' && field === 'byServer') ||
    (checkId === 'toolAdvisoryHealth' && field === 'advisoryKindCounts')
  ) {
    return scrubKeyedCountsForSentry(value as Record<string, number>);
  }

  if (typeof value === 'string') {
    return redactTelemetryText(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? redactTelemetryText(item) : item));
  }

  return value;
}

const msvcStringArraySchema = z.array(safeTextSchema).readonly();
const msvcRuntimeDetailsSchema = z
  .object({
    exeDir: safeTextSchema.optional(),
    nodeBundleDir: safeTextSchema.optional(),
    dlls: msvcStringArraySchema.optional(),
    missingExe: msvcStringArraySchema.optional(),
    missingNodeBundle: msvcStringArraySchema.optional(),
  })
  .strict();

export function extractMsvcRuntimeDetailsForSentry(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;

  const candidate: Record<string, unknown> = {};
  for (const key of ['exeDir', 'nodeBundleDir', 'dlls', 'missingExe', 'missingNodeBundle']) {
    const value = details[key];
    if (typeof value === 'string') {
      candidate[key] = redactTelemetryText(value);
    } else if (Array.isArray(value)) {
      candidate[key] = value.map((item) => (typeof item === 'string' ? redactTelemetryText(item) : item));
    }
  }

  const parsed = msvcRuntimeDetailsSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  return parsed.data;
}
