import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared enum schemas — single source of truth for repeated enums
// ---------------------------------------------------------------------------

/** Thinking / reasoning effort levels used across agent turns, sessions, settings, and model profiles */
export const ThinkingEffortSchema = z.enum(['xhigh', 'high', 'medium', 'low']);

/** Session origin — how a conversation was initiated */
export const SessionOriginSchema = z.enum([
  'manual', 'automation', 'role', 'mcp-tool', 'inbound-trigger', 'plugin', 'focus', 'browser-extension', 'operator-personalisation',
]);

/** Safe Mode error categories — privacy-safe, structured failure buckets. */
export const SafeModeErrorCategorySchema = z.enum([
  'port_conflict',
  'config_parse',
  'network',
  'permission',
  'process_crash',
  'timeout',
  'missing_bundle',
  'spawn_missing_executable',
  'fs_exhaustion',
  'health_timeout',
  'unknown',
]);
export type SafeModeErrorCategoryIpc = z.infer<typeof SafeModeErrorCategorySchema>;

// ---------------------------------------------------------------------------
// Shared IPC response schemas — canonical shapes for common responses
// ---------------------------------------------------------------------------

/** Standard success-only response (no error field) */
export const IpcSuccessResponseSchema = z.object({
  success: z.boolean(),
});

/** Standard success response with optional error message */
export const IpcSuccessWithErrorResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

/**
 * Structured OAuth setup-guidance payload for connectors that are broken-by-default because no
 * OAuth client credentials are configured. Mirrors the core `OAuthCredentialsNotConfigured`
 * interface in `src/core/services/oauthConnectorSetup.ts` EXACTLY — the core type stays the
 * canonical single source of truth; a parity unit test
 * (`schemas/__tests__/oauthSetupGuidance.parity.test.ts`) asserts a fresh
 * `describeMissingOAuthCredentials(...)` value parses cleanly here so the two cannot drift.
 *
 * Start-auth handlers (Stage 3) populate this on the discriminated `code` so it survives the
 * Zod IPC + preload bridge and the renderer (Stage 5) can branch on it instead of parsing
 * ad-hoc error strings. Carries only env var NAMES and public setup URLs — never secret values.
 */
export const OAuthSetupGuidanceSchema = z.object({
  code: z.literal('oauth-credentials-not-configured'),
  provider: z.string(),
  displayName: z.string(),
  message: z.string(),
  selfServe: z.boolean(),
  setupUrl: z.string(),
  envVars: z.array(z.string()),
  redirectUris: z.array(z.string()),
  redirectNote: z.string().optional(),
});

/**
 * Renderer-facing structured OAuth setup-guidance payload. Inferred from the canonical
 * {@link OAuthSetupGuidanceSchema} so consumers (the `ConnectorSetupDialog` + the
 * `useConnectorSetupGuidance` helper) import the shape from the shared IPC schema rather than
 * reaching into `@core`. Mirrors core `OAuthCredentialsNotConfigured` (parity-tested).
 */
export type OAuthSetupGuidance = z.infer<typeof OAuthSetupGuidanceSchema>;

/** The `code` discriminant identifying a not-configured OAuth setup-guidance result. */
export const OAUTH_CREDENTIALS_NOT_CONFIGURED_CODE =
  'oauth-credentials-not-configured' as const;

/**
 * Success-with-error response that can additionally carry structured OAuth setup guidance when a
 * start-auth flow fails because the connector has no OAuth client credentials configured.
 */
export const IpcSuccessWithErrorAndSetupGuidanceSchema =
  IpcSuccessWithErrorResponseSchema.extend({
    setupGuidance: OAuthSetupGuidanceSchema.optional(),
  });

// ---------------------------------------------------------------------------
// Misc shared schemas
// ---------------------------------------------------------------------------

/** Electron file filter for dialogs */
export const ElectronFileFilterSchema = z.object({
  name: z.string(),
  extensions: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// JSON value — strictly-typed alternative to an untyped escape-hatch for IPC
// payloads that are intentionally heterogeneous but must be JSON-serialisable
// (e.g. observability metadata bags, structured-logging field maps). Prefer
// this over `unknown` whenever the field crosses an IPC boundary.
// ---------------------------------------------------------------------------

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    jsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/**
 * Defines a request/response IPC channel (uses ipcRenderer.invoke)
 */
export interface InvokeChannelDef<
  TRequest extends z.ZodTypeAny,
  TResponse extends z.ZodTypeAny,
> {
  type: 'invoke';
  channel: string;
  request: TRequest;
  response: TResponse;
  /** Optional description for documentation */
  description?: string;
}

/**
 * Helper to create a typed invoke channel definition
 */
export function defineInvokeChannel<
  TRequest extends z.ZodTypeAny,
  TResponse extends z.ZodTypeAny,
>(config: {
  channel: string;
  request: TRequest;
  response: TResponse;
  description?: string;
}): InvokeChannelDef<TRequest, TResponse> {
  return {
    type: 'invoke',
    ...config,
  };
}

/**
 * Defines a synchronous IPC channel (uses ipcRenderer.sendSync)
 * Use sparingly - only for cases where async invoke won't complete (e.g., beforeunload)
 */
export interface SyncChannelDef<TRequest extends z.ZodTypeAny, TResponse extends z.ZodTypeAny> {
  type: 'sync';
  channel: string;
  request: TRequest;
  response: TResponse;
  description?: string;
}

/**
 * Helper to create a typed sync channel definition.
 * WARNING: Sync IPC blocks the renderer. Only use when async is impossible.
 */
export function defineSyncChannel<TRequest extends z.ZodTypeAny, TResponse extends z.ZodTypeAny>(config: {
  channel: string;
  request: TRequest;
  response: TResponse;
  description?: string;
}): SyncChannelDef<TRequest, TResponse> {
  return {
    type: 'sync',
    ...config,
  };
}
