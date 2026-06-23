import { AnthropicError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { KnownStructuredError } from '@core/sentry/knownStructuredError';
import {
  isAuthErrorMessage,
  isBillingMessage,
  isModerationMessage,
  isNetworkError,
  isTransientError,
} from '@shared/utils/friendlyErrors';
import { getErrorKind } from '@shared/utils/agentErrorCatalog';
import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';
import type { RoleResolutionFailure } from './modelRoleResolver';
import {
  humanizeRoleResolutionFailure,
  serializeRoleResolutionFailureRawError,
} from './modelRoleResolver';

/**
 * The canonical, ordered set of `ModelErrorKind` values. `ModelErrorKind` is
 * derived FROM this tuple (`typeof MODEL_ERROR_KINDS[number]`) so the union and
 * any kind-exhaustive consumer (e.g. the `model_error` Sentry fingerprint
 * stability test) read from one source — a new kind cannot be added to the
 * union without appearing here, where exhaustiveness tests iterate.
 *
 * Per-kind notes that used to live as union-member JSDoc:
 * - `image_input_unsupported`: provider rejected image input for a text-only
 *   model (OpenRouter 404 "No endpoints found that support image input").
 *   Backstop for models the catalog doesn't mark (fail-open capability policy)
 *   — incl. the route-table SUB-AGENT leg, which streams a route-table alias
 *   (e.g. 'working') as the body model so the per-model capability gate fails
 *   open BY DESIGN there and this kind is its only protection. Non-transient:
 *   retry re-sends the same image-bearing history. See
 *   docs/plans/260610_image-unsupported-by-model/PLAN.md Stage 4.
 * - `managed_model_not_allowed`: managed (Mindstone) plan rejected the
 *   requested model because it is not in the tier's allowlist. Carries
 *   `managedModelNotAllowed` details (`requested`, `allowed`) on
 *   `ModelErrorDetails`. Non-transient: retry with the same model hits the same
 *   gate.
 * - `tool_input_too_large`: streaming provider emitted a `tool_use`
 *   input_json_delta sequence whose accumulated bytes exceeded our local
 *   per-block cap. Raised client-side to prevent the provider stall class
 *   documented in `260423_agent_to_tool_file_ref_sentinel.md`. Non-transient:
 *   auto-retry will just hit the cap again.
 */
export const MODEL_ERROR_KINDS = [
  'rate_limit',
  'auth',
  'billing',
  'moderation',
  'server_error',
  'network',
  'invalid_request',
  'context_overflow',
  'model_unavailable',
  'image_input_unsupported',
  'managed_model_not_allowed',
  'tool_input_too_large',
  'abort',
  'unknown',
] as const;

export type ModelErrorKind = (typeof MODEL_ERROR_KINDS)[number];

export type ModelErrorLimitScope = 'provider' | 'plan' | 'account';

const TRANSIENT_KINDS = new Set<ModelErrorKind>(['rate_limit', 'server_error', 'network']);

/**
 * Structured metadata for `tool_input_too_large` errors. Surfaced via the
 * `details` property on the thrown `ModelError` so recovery handlers and
 * Sentry captures can report which tool and how many bytes were involved.
 */
export interface ToolInputTooLargeDetails {
  toolName: string;
  toolUseId: string;
  bytesAccumulated: number;
  capBytes: number;
  blockIndex: number;
}

export interface ManagedModelNotAllowedDetails {
  requested?: string;
  allowed?: string[];
}

export interface ModelErrorDetails {
  toolInputTooLarge?: ToolInputTooLargeDetails;
  roleResolutionFailure?: RoleResolutionFailure;
  contextOverflow?: unknown;
  outputCap?: number;
  managedModelNotAllowed?: ManagedModelNotAllowedDetails;
  /**
   * Set by the shared fail-fast-offline gate (`offlineFailFast.ts`, used by both
   * the Anthropic and OpenAI clients' `runWithRetry`) when an
   * independent reachability probe confirmed the machine is offline and we
   * stopped retrying early instead of churning. Recovery recognises this
   * structural marker (NOT a string match) and routes the error straight to
   * the existing retryable `message_timeout` terminal with honest offline copy.
   * See `turnErrorRecovery.handleOfflineFailFast` and
   * docs/plans/260618_arthur-offline-resilience/PLAN.md (Stage 2).
   */
  offlineFailFast?: boolean;
  [key: string]: unknown;
}

export interface ModelErrorOptions {
  rawMessage?: string;
  upstreamProvider?: string;
  resetAtMs?: number;
  limitScope?: ModelErrorLimitScope;
  details?: ModelErrorDetails;
}

export class ModelError extends KnownStructuredError {
  readonly kind: ModelErrorKind;
  readonly status?: number;
  readonly provider?: string;
  readonly upstreamProvider?: string;
  readonly isTransient: boolean;
  readonly isAbort: boolean;
  /** Absolute reset timestamp in ms (from Codex `resets_at` or `resets_in_seconds`). */
  readonly resetAtMs?: number;
  readonly limitScope?: ModelErrorLimitScope;

  /** Backward compat: consumed by agentErrorCatalog.ts getErrorKind() */
  readonly __agentErrorKind: AgentErrorKind;
  /** Backward compat: raw message before sentinel prefix */
  readonly __rawMessage: string;
  /**
   * Kind-specific structured metadata. Populated for errors where the
   * recovery path benefits from machine-readable context (e.g.
   * `tool_input_too_large` carries tool name + accumulated bytes).
   * Kept loosely-typed to avoid burning the shared schema on every new kind.
   */
  readonly details?: ModelErrorDetails;

  constructor(
    kind: ModelErrorKind,
    message: string,
    status?: number,
    provider?: string,
    options?: ModelErrorOptions,
  ) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
    this.provider = provider;
    this.upstreamProvider = options?.upstreamProvider;
    this.resetAtMs = options?.resetAtMs;
    this.limitScope = options?.limitScope;
    this.isAbort = kind === 'abort';
    this.isTransient = TRANSIENT_KINDS.has(kind);
    // `tool_input_too_large` is NOT an AgentErrorKind; fall back to 'unknown'
    // so renderer error catalog doesn't blow up. Recovery copy selection
    // uses `errorKindOverride` in turnErrorRecovery.ts.
    this.__agentErrorKind = (kind === 'abort' || kind === 'tool_input_too_large') ? 'unknown' : kind;
    this.__rawMessage = options?.rawMessage ?? message;
    if (options?.details) this.details = options.details;
  }
}

/**
 * Preserve existing error classification before applying a fallback `ModelError`.
 *
 * This kills the catch-all rewrap anti-pattern where a catch block converts any
 * caught value into a fixed kind such as `ModelError('auth')`, discarding a
 * branded `__agentErrorKind`. The `ModelError` check must run first because
 * some valid ModelError kinds (`abort`, `tool_input_too_large`) intentionally
 * map to catalog kind `unknown`; consulting `getErrorKind()` first would
 * incorrectly reclassify them.
 */
export function reclassifyOrRethrow(
  caught: unknown,
  fallbackKind: ModelErrorKind,
  fallbackMessage?: string,
  status?: number,
  provider?: string,
  options?: ModelErrorOptions,
): never {
  if (caught instanceof ModelError) {
    throw caught;
  }

  if (getErrorKind(caught) !== 'unknown') {
    throw caught;
  }

  const message = fallbackMessage ?? (caught instanceof Error ? caught.message : String(caught));
  throw new ModelError(fallbackKind, message, status, provider, options);
}

export function createRoleResolutionModelError(
  failure: RoleResolutionFailure,
  messageOverride?: string,
): ModelError {
  const message = messageOverride ?? humanizeRoleResolutionFailure(failure);
  return new ModelError('invalid_request', message, 400, undefined, {
    rawMessage: serializeRoleResolutionFailureRawError(failure, message),
    details: { roleResolutionFailure: failure },
  });
}

type HttpErrorMetadata = {
  reasons?: unknown[];
  flagged_input?: unknown;
};

/**
 * Machine-readable fields providers put on error bodies. The HTTP path extracts
 * these from `error.*` first, then top-level fields; the SDK path reads them
 * from the parsed `APIError#error` body. Message/status heuristics are fallback
 * only after this shape has had the first say.
 */
export interface ProviderErrorShape {
  /**
   * OpenAI/Anthropic-style error discriminator, e.g. `authentication_error`,
   * `permission_error`, `rate_limit_error`, `not_found_error`, `stream_error`.
   */
  type?: string;
  /**
   * OpenRouter/OpenAI/proxy code field. OpenRouter commonly uses numeric HTTP
   * codes here; Rebel's managed proxy uses `MANAGED_MODEL_NOT_ALLOWED`; Codex
   * quota rewrites preserve upstream quota codes here.
   */
  code?: string | number;
  /**
   * OpenRouter metadata, including moderation details and upstream provider
   * name. Only classification-relevant moderation fields are modelled here.
   */
  metadata?: HttpErrorMetadata;
  provider?: string;
}

const AUTH_ERROR_SIGNALS = new Set([
  'authentication_error',
  'invalid_api_key',
  'invalid_authentication',
  'auth_error',
  'unauthorized',
]);

const RATE_LIMIT_ERROR_SIGNALS = new Set([
  'rate_limit_error',
  'rate_limit_exceeded',
  'rate_limit',
]);

const SERVER_ERROR_SIGNALS = new Set([
  'overloaded_error',
]);

const MODEL_UNAVAILABLE_ERROR_SIGNALS = new Set([
  'not_found_error',
]);

const INVALID_REQUEST_ERROR_CODES = new Set([
  'invalid_prompt',
]);

/**
 * Quota-exhaustion signals that distinguish billing / quota-cap errors from
 * transient 429 rate limits. These are RECLASSIFIED to `billing` so they
 * skip both the rate-limit auto-retry and the rate-limit cooldown — a
 * `usage_limit_reached` from ChatGPT Team plan resets on a multi-hour
 * cadence, so retrying or auto-falling-back to OpenRouter just compounds
 * the burn against an already-depleted quota. See REBEL-4GH / FOX-3152.
 *
 * - `insufficient_quota` / `insufficient_funds` — provider's wallet is empty.
 * - `usage_limit_reached` — ChatGPT Team / Pro plan usage cap hit. Carries
 *   `resets_at` (Unix seconds) which is propagated via `ModelError.resetAtMs`.
 */
const QUOTA_EXHAUSTION_TYPES = new Set([
  'insufficient_quota',
  'insufficient_funds',
  'usage_limit_reached',
]);

function normalizeProviderSignal(value: string | number | undefined): string | undefined {
  if (typeof value === 'number') return String(value);
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function messageIndicatesModelAccessIssue(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    (lower.includes("don't have access") || lower.includes('do not have access')) &&
    lower.includes('model')
  );
}

function classifyByStructuredProviderError(
  status: number,
  message: string,
  rawError?: ProviderErrorShape,
): { kind: ModelErrorKind; } | undefined {
  const type = normalizeProviderSignal(rawError?.type);
  const code = normalizeProviderSignal(rawError?.code);
  const signals = [type, code].filter((signal): signal is string => Boolean(signal));

  if (code === 'managed_model_not_allowed') {
    return { kind: 'managed_model_not_allowed' };
  }

  if (rawError?.metadata?.reasons?.length || rawError?.metadata?.flagged_input) {
    return { kind: 'moderation' };
  }

  if (signals.some(signal => AUTH_ERROR_SIGNALS.has(signal))) {
    return { kind: 'auth' };
  }

  if (signals.some(signal => QUOTA_EXHAUSTION_TYPES.has(signal))) {
    return { kind: 'billing' };
  }

  if (code === '401') return { kind: 'auth' };
  if (code === '402') return { kind: 'billing' };
  if (code === '429') return { kind: 'rate_limit' };

  if (type === 'permission_error') {
    return { kind: messageIndicatesModelAccessIssue(message) ? 'model_unavailable' : 'auth' };
  }

  if (signals.some(signal => MODEL_UNAVAILABLE_ERROR_SIGNALS.has(signal))) {
    return { kind: 'model_unavailable' };
  }

  if (signals.some(signal => RATE_LIMIT_ERROR_SIGNALS.has(signal))) {
    return { kind: 'rate_limit' };
  }

  if (signals.some(signal => SERVER_ERROR_SIGNALS.has(signal))) {
    return { kind: 'server_error' };
  }

  // Stream-lifecycle errors: the local proxy emits an SSE `error` frame with a
  // `stream_error` body type, which the Anthropic SDK surfaces as an APIError
  // with `status === undefined` (the frame arrives after a 200 stream opened).
  // These are transient stream hiccups -> retryable `server_error`, keyed on
  // type rather than message text (the JSON envelope defeats isTransientError's
  // exact-match guards). Scoped to the absent-status SSE shape so a real HTTP
  // status (e.g. an external provider that happens to put `type:"stream_error"`
  // in a 4xx body) is NOT overridden. Type-gated and narrow: generic
  // `api_error` remains a fallback concern. REBEL-5M4/561.
  if (!status && type === 'stream_error') return { kind: 'server_error' };

  if (signals.some(signal => INVALID_REQUEST_ERROR_CODES.has(signal))) {
    return { kind: 'invalid_request' };
  }

  return undefined;
}

function classifyByStatusHeuristics(
  status: number,
  message: string,
): { kind: ModelErrorKind; } {
  switch (status) {
    case 429:
      return { kind: 'rate_limit' };
    case 402:
      return { kind: 'billing' };
    case 403:
      if (isModerationMessage(message)) {
        return { kind: 'moderation' };
      }
      // Containment layer for providers that omit structured auth fields.
      // Structured `type`/`code` wins before this fallback runs; this predicate
      // remains as the conservative code-less 403 carve-out for REBEL-66J/65G.
      if (isAuthErrorMessage(message)) {
        return { kind: 'auth' };
      }
      return { kind: 'billing' };
    case 401:
      return { kind: 'auth' };
    case 413:
      return { kind: 'context_overflow' };
    case 400: {
      const lower = message.toLowerCase();
      // Billing errors: some providers (Anthropic, OpenRouter) return billing/credit
      // issues as 400 instead of 402/403. Uses shared isBillingMessage() predicate.
      if (isBillingMessage(message) || lower.includes('api usage limits')) return { kind: 'billing' };
      // Context overflow patterns across providers:
      // - Anthropic: "prompt is too long", "request too large", "request_too_large"
      // - OpenAI: "maximum context length is X tokens"
      // - Google: "input token count exceeds the maximum number of tokens"
      // - Various: "context limit exceeded", "context window exceeded", "context overflow"
      // Note: "token" patterns require "token count" / "input token" / "number of tokens"
      // to avoid false positives on max_tokens parameter errors like "max_tokens exceeds limit".
      const isContextOverflow =
        (lower.includes('context') && (lower.includes('too long') || lower.includes('exceed') || lower.includes('maximum context length') || lower.includes('limit') || lower.includes('length') || lower.includes('overflow') || lower.includes('reduction'))) ||
        (lower.includes('prompt') && (lower.includes('too long') || lower.includes('too large') || lower.includes('exceed'))) ||
        ((lower.includes('token count') || lower.includes('input token') || lower.includes('number of tokens')) && (lower.includes('exceed') || lower.includes('maximum'))) ||
        lower.includes('request too large') || lower.includes('request_too_large');
      if (isContextOverflow) return { kind: 'context_overflow' };
      return { kind: 'invalid_request' };
    }
    case 404: {
      const lower = message.toLowerCase();
      if (
        lower.includes('does not exist')
        || lower.includes('model not found')
        || lower.includes('do not have access')
        // OpenAI: "This is not a chat model and thus not supported in the
        // v1/chat/completions endpoint." (BYOK users configuring non-chat models
        // like gpt-5.5-pro). The model exists but is incompatible with the
        // chat completions endpoint -> semantically model_unavailable.
        || lower.includes('not a chat model')
        || (lower.includes('not supported') && lower.includes('chat/completions'))
      ) {
        return { kind: 'model_unavailable' };
      }
      return { kind: 'unknown' };
    }
  }

  if (status >= 500) return { kind: 'server_error' };
  return { kind: 'unknown' };
}

export function classifyStatus(
  status: number,
  message: string,
  rawError?: ProviderErrorShape,
): { kind: ModelErrorKind; } {
  // OpenRouter rejects image input for text-only models with 404
  // "No endpoints found that support image input" (260610 incident:
  // deepseek/deepseek-v4-flash + Read-produced image). Deliberately checked
  // BEFORE the structured phase: the body's not_found-shaped signals would
  // map to model_unavailable, which triggers the thinking-model downgrade
  // handler and says "pick another model" with no mention of images.
  // Requires BOTH substrings (narrow, OpenRouter-literal — must not swallow
  // other "No endpoints found" routing 404s; broadening to other providers'
  // phrasings is a deliberate non-goal here). DESIGNED CONSUMER: the
  // route-table sub-agent leg streams a route-table alias (e.g. 'working')
  // as the body model, so the per-model image-capability gate fails open
  // by design on that leg and this classifier is its only protection.
  // eslint-disable-next-line no-restricted-syntax -- provider-error-fallback-justified: OpenRouter's image-input 404 body carries not_found-shaped structured signals that would map to model_unavailable; this narrow both-substring check must pre-empt the structured phase (260610 image-input postmortem).
  if (status === 404) {
    const lower = message.toLowerCase();
    if (lower.includes('no endpoints') && lower.includes('image input')) {
      return { kind: 'image_input_unsupported' };
    }
  }
  const structuredClassification = classifyByStructuredProviderError(status, message, rawError);
  return structuredClassification ?? classifyByStatusHeuristics(status, message);
}

/**
 * Walk a parsed error body to find the nested error object (Anthropic SDK
 * convention nests under `error`). Returns the nested object if present,
 * else the top-level body, else undefined.
 */
function getParsedBodySource(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const nested = obj.error && typeof obj.error === 'object'
    ? (obj.error as Record<string, unknown>)
    : undefined;
  return nested ?? obj;
}

/**
 * Extract `type` from a parsed error body, looking at the nested error object
 * first, then the top level. Shared by HTTP and SDK classification paths.
 */
function extractParsedBodyType(body: unknown): string | undefined {
  const src = getParsedBodySource(body);
  return typeof src?.type === 'string' ? src.type : undefined;
}

/**
 * Extract `code` from a parsed error body, looking at the nested error object
 * first, then the top level. Shared by HTTP and SDK classification paths.
 */
function extractParsedBodyCode(body: unknown): string | number | undefined {
  const src = getParsedBodySource(body);
  return typeof src?.code === 'string' || typeof src?.code === 'number'
    ? src.code
    : undefined;
}

/**
 * Extract `resets_at` / `resets_in_seconds` from a parsed error body object.
 * Used by both `extractHttpErrorMessage` (HTTP path) and `classifyError` (SDK path)
 * to keep reset-field extraction in sync across all error classification routes.
 */
function extractResetFromParsedBody(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  // Check nested error object first, then top-level
  const nested = obj.error && typeof obj.error === 'object'
    ? obj.error as Record<string, unknown>
    : undefined;
  const src = nested ?? obj;
  const resetsAt = typeof src.resets_at === 'number' ? src.resets_at : undefined;
  const resetsInSeconds = typeof src.resets_in_seconds === 'number' ? src.resets_in_seconds : undefined;
  if (resetsAt && resetsAt > 1_000_000_000 && resetsAt < 10_000_000_000) {
    return resetsAt * 1000;
  }
  if (resetsInSeconds && resetsInSeconds > 0 && resetsInSeconds < 604_800) {
    return Date.now() + resetsInSeconds * 1000;
  }
  return undefined;
}

/** Structured data extracted from an HTTP error body. */
interface ExtractedError {
  message: string;
  type?: string;  // e.g., 'insufficient_quota', 'rate_limit_exceeded', 'usage_limit_reached'
  code?: string | number;  // e.g., 'insufficient_quota', 402, 'MANAGED_MODEL_NOT_ALLOWED'
  upstreamProvider?: string;
  metadata?: HttpErrorMetadata;
  /** Absolute reset timestamp in ms — from Codex `resets_at` (unix seconds) or `resets_in_seconds`. */
  resetAtMs?: number;
  /** Managed-allowlist 403: model the client requested. */
  requested?: string;
  /** Managed-allowlist 403: tier's allowed model list (may be empty). */
  allowed?: string[];
}

// Recover a clean provider message from a body that ISN'T top-level JSON — e.g. a
// provider error JSON embedded inside a wrapper string. litellm does this:
// `litellm.BadRequestError: Vertex_aiException BadRequestError - b'{"error":{"message":
// "..."}}'…`. We pull the first JSON-style `"message":"…"` (handling escaped quotes) and
// unescape it, so the user sees the real reason instead of the wrapper noise (REBEL-5RJ).
function extractEmbeddedMessage(body: string): string | undefined {
  const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replace(/\\(["\\/])/g, '$1');
  }
}

function extractHttpErrorMessage(body: string): ExtractedError {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nestedError = parsed.error as Record<string, unknown> | undefined;
    const metadata = (
      (nestedError?.metadata as Record<string, unknown> | undefined)
      ?? (parsed.metadata as Record<string, unknown> | undefined)
    );

    // Extract type/code from whichever level has them (nested error takes precedence).
    // These are extracted independently of message so quota/billing signals survive
    // even when the message field is absent or at a different nesting level.
    const type = (typeof nestedError?.type === 'string' ? nestedError.type : undefined)
      ?? (typeof parsed.type === 'string' ? parsed.type : undefined);
    const code = (
      typeof nestedError?.code === 'string' || typeof nestedError?.code === 'number'
        ? nestedError.code
        : undefined
    ) ?? (
      typeof parsed.code === 'string' || typeof parsed.code === 'number'
        ? parsed.code
        : undefined
    );

    // Extract message: prefer nested error.message, then top-level message, then raw body.
    const message = (typeof nestedError?.message === 'string' ? nestedError.message : undefined)
      ?? (typeof parsed.message === 'string' ? parsed.message : undefined)
      ?? extractEmbeddedMessage(body)
      ?? body;
    const upstreamProvider = typeof metadata?.provider_name === 'string'
      ? metadata.provider_name
      : undefined;
    const reasons = Array.isArray(metadata?.reasons) ? metadata.reasons : undefined;
    const flaggedInput = metadata && 'flagged_input' in metadata
      ? metadata.flagged_input
      : undefined;

    // Extract Codex usage-limit reset timestamp via shared helper.
    const resetAtMs = extractResetFromParsedBody(parsed);

    // Managed-allowlist 403 payload carries `requested` (string) and
    // `allowed` (string[]) — see localModelProxyServer.ts § 403 branch.
    // Nested error.* takes precedence over top-level for consistency with
    // type/code/message handling above.
    const requested = (typeof nestedError?.requested === 'string' ? nestedError.requested : undefined)
      ?? (typeof parsed.requested === 'string' ? parsed.requested : undefined);
    const allowedRaw = nestedError?.allowed ?? parsed.allowed;
    const allowed = Array.isArray(allowedRaw)
      ? allowedRaw.filter((v): v is string => typeof v === 'string')
      : undefined;

    return {
      message,
      type,
      code,
      upstreamProvider,
      ...(resetAtMs ? { resetAtMs } : {}),
      ...(requested ? { requested } : {}),
      ...(allowed ? { allowed } : {}),
      ...((reasons?.length || flaggedInput)
        ? {
            metadata: {
              ...(reasons?.length ? { reasons } : {}),
              ...(flaggedInput ? { flagged_input: flaggedInput } : {}),
            },
          }
        : {}),
    };
  } catch {
    // Body wasn't top-level JSON (e.g. a litellm/proxy wrapper around the provider's
    // JSON error). Recover the embedded provider message rather than surfacing the wrapper.
    return { message: extractEmbeddedMessage(body) ?? body };
  }
}

function isQuotaExhaustionSignal(value: string | number | undefined): boolean {
  const normalized = normalizeProviderSignal(value);
  return Boolean(normalized && QUOTA_EXHAUSTION_TYPES.has(normalized));
}

function inferLimitScope(params: {
  kind: ModelErrorKind;
  status?: number;
  type?: string | number;
  code?: string | number;
}): ModelErrorLimitScope | undefined {
  if (params.kind === 'rate_limit') {
    return 'provider';
  }
  if (params.kind !== 'billing') {
    return undefined;
  }

  const normalizedType = normalizeProviderSignal(params.type);
  const normalizedCode = normalizeProviderSignal(params.code);
  const hasPlanCapSignal =
    normalizedType === 'usage_limit_reached' || normalizedCode === 'usage_limit_reached';
  const hasQuotaSignal = isQuotaExhaustionSignal(params.type) || isQuotaExhaustionSignal(params.code);

  if (hasQuotaSignal && !hasPlanCapSignal) {
    return 'account';
  }

  if ((params.code === 402 || params.code === 403 || params.code === '402' || params.code === '403')
    && (params.status === 429 || params.status === 403)) {
    return 'account';
  }

  if (params.status === 402) {
    return 'account';
  }

  return undefined;
}

function parsePositiveInt(raw: string): number | undefined {
  const normalized = raw.replace(/[,_]/g, '');
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function readNetworkSignal(value: unknown, key: 'code' | 'message'): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const signal = (value as Record<string, unknown>)[key];
  return typeof signal === 'string' || typeof signal === 'number' ? String(signal) : undefined;
}

function readCause(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>).cause;
}

function hasNetworkErrorSignal(error: unknown, messageOverride?: string): boolean {
  const cause = readCause(error);
  const nestedCause = readCause(cause);
  const signals = [
    messageOverride,
    readNetworkSignal(error, 'message'),
    readNetworkSignal(error, 'code'),
    readNetworkSignal(cause, 'message'),
    readNetworkSignal(cause, 'code'),
    readNetworkSignal(nestedCause, 'message'),
    readNetworkSignal(nestedCause, 'code'),
  ];

  return signals.some((signal) => Boolean(signal && isNetworkError(signal)));
}

/**
 * Parse provider-reported max-output cap from 400 invalid-request text.
 *
 * Conservative by design: only returns a value when the message clearly
 * references a `max_tokens` parameter ceiling.
 */
export function parseOutputCapFrom400(message: string): number | undefined {
  if (!message) return undefined;

  const patterns: readonly RegExp[] = [
    // Anthropic / OpenRouter passthrough:
    // "max_tokens: 1000000 > maximum allowed value 8192"
    /max_tokens\s*:\s*[\d,_]+\s*>\s*maximum allowed value\s*([\d,_]+)/i,
    // OpenAI variants:
    // "max_tokens: 20000 exceeds maximum of 4096"
    /max_tokens\s*:\s*[\d,_]+\s*exceeds(?:\s+the)?\s+maximum(?:\s+of)?\s*([\d,_]+)/i,
    // "max_tokens is too large: 20000. This model supports at most 4096 completion tokens."
    /max_tokens(?:\s+is)?\s+too\s+large[:\s]*[\d,_]+(?:\.\d+)?[\s\S]*?\bsupports?\s+at\s+most\s*([\d,_]+)/i,
    // Generic envelope fallback:
    // "... max_tokens ... maximum ... 4096"
    /max_tokens[\s\S]*?\bmaximum(?:\s+allowed)?(?:\s+value)?(?:\s+of)?\s*([\d,_]+)/i,
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (!match?.[1]) continue;
    const parsed = parsePositiveInt(match[1]);
    if (parsed) return parsed;
  }
  return undefined;
}

export function classifyHttpError(status: number, body: string, provider?: string): ModelError {
  const extracted = extractHttpErrorMessage(body);
  let { kind } = classifyStatus(status, extracted.message, { ...extracted, provider });

  // 429 + quota/billing body → billing (non-retryable), not rate_limit.
  // Checks structured type/code fields first (QUOTA_EXHAUSTION_TYPES), then falls back
  // to message-text patterns via isBillingMessage() for providers that use 429 for
  // billing errors without standard type/code fields (e.g., OpenRouter "key limit exceeded").
  if (status === 429 && kind === 'rate_limit') {
    if (isQuotaExhaustionSignal(extracted.type) || isQuotaExhaustionSignal(extracted.code) || isBillingMessage(extracted.message)) {
      kind = 'billing';
    }
  }

  if (kind === 'unknown' && (isTransientError(extracted.message) || hasNetworkErrorSignal({ message: extracted.message, code: extracted.code }))) {
    // Invariant: network/transport errnos MUST mint `network` (never
    // server_error/unknown). See the "lossy-collapse guard for network transport
    // classification" tests in modelErrors.test.ts.
    kind = hasNetworkErrorSignal({ message: extracted.message, code: extracted.code })
      ? 'network'
      : 'server_error';
  }
  // Diagnostic: log the full raw error response body when a billing error is
  // detected so we can debug why managed-key users see "billing issue" copy.
  // Body is bounded (truncate to 2KB) to avoid log blowup. Never logs API keys.
  if (kind === 'billing') {
    try {
      console.warn('[modelErrors] classifyHttpError detected billing error', {
        status,
        provider,
        upstreamProvider: extracted.upstreamProvider,
        type: extracted.type,
        code: extracted.code,
        message: extracted.message?.slice(0, 500),
        rawBody: typeof body === 'string' ? body.slice(0, 2000) : '(non-string body)',
      });
    } catch {
      // never throw from diagnostic logging
    }
  }

  const outputCap = status === 400 && kind === 'invalid_request'
    ? (parseOutputCapFrom400(extracted.message) ?? parseOutputCapFrom400(body))
    : undefined;

  const managedModelNotAllowed: ManagedModelNotAllowedDetails | undefined =
    kind === 'managed_model_not_allowed'
      ? {
          ...(extracted.requested ? { requested: extracted.requested } : {}),
          ...(extracted.allowed ? { allowed: extracted.allowed } : {}),
        }
      : undefined;

  const details: ModelErrorDetails | undefined = (outputCap || managedModelNotAllowed)
    ? {
        ...(outputCap ? { outputCap } : {}),
        ...(managedModelNotAllowed ? { managedModelNotAllowed } : {}),
      }
    : undefined;
  const limitScope = inferLimitScope({
    kind,
    status,
    type: extracted.type,
    code: extracted.code,
  });

  return new ModelError(kind, extracted.message, status, provider, {
    rawMessage: body,
    upstreamProvider: extracted.upstreamProvider,
    resetAtMs: extracted.resetAtMs,
    ...(limitScope ? { limitScope } : {}),
    ...(details ? { details } : {}),
  });
}

/**
 * Detect chat-completions incompatibility errors from any error shape.
 * Centralised predicate — used by test handler, error recovery, and fail-fast checks.
 * Matches OpenAI's "not a chat model" pattern and variant wording.
 */
export function isChatIncompatibilityError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return msg.includes('not a chat model')
    || (msg.includes('not supported') && msg.includes('chat/completions'));
}

/**
 * Detect tool-use incompatibility errors — a model (typically Gemini behind an
 * OpenAI-compatible gateway) that can't round-trip the tool-call data it needs
 * across steps, surfacing as "Function call is missing a thought_signature in
 * functionCall parts...". Sentry REBEL-5RJ variant 2. Centralised predicate —
 * used by error recovery to auto-mark the profile `toolUseCompatibility:
 * 'incompatible'`, mirroring {@link isChatIncompatibilityError}. The OpenAI wire
 * shape CAN carry the signature (litellm via the `tool_call.id` / `provider_specific_fields`,
 * Google via `extra_content`); the live failure is convention-mismatch + a
 * litellm streaming-drop bug + gateway-version dependence — i.e. gateway/version-side,
 * not a generic-OpenAI-client limitation. A diagnostic now measures which convention
 * a gateway surfaces (`Gateway Tool Signature Observed`), so for now this stays
 * detect-and-record. See docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md §2.
 */
export function isToolUseIncompatibilityError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // Match only the specific `thought_signature` signal (same token classifyErrorUx
  // keys its banner on). A broader "function call … missing" match would
  // false-positive on transient/fixable argument errors — and auto-marking a profile
  // `toolUseCompatibility: 'incompatible'` is a persistent state change, so fail narrow.
  return /thought[\s_-]?signature/.test(msg);
}

export function classifyError(error: unknown, signal?: AbortSignal, provider?: string): ModelError {
  if (error instanceof ModelError) return error;

  if (signal?.aborted || error instanceof APIUserAbortError) {
    const msg = error instanceof Error ? error.message : 'Operation was aborted';
    return new ModelError('abort', msg, undefined, provider);
  }

  if (error instanceof APIError) {
    // Forward parsed nested `type` and `code` into classifyStatus so the SDK
    // path consumes structured fields symmetrically with classifyHttpError().
    // `type` covers stream_error / not_found_error; `code` covers upstream quota
    // rewrites and any provider auth codes exposed only on the parsed body.
    const sdkErrorBody = (error as unknown as { error?: unknown }).error;
    const sdkBodyType = extractParsedBodyType(sdkErrorBody);
    const sdkBodyCode = extractParsedBodyCode(sdkErrorBody);
    let { kind } = classifyStatus(error.status, error.message, {
      type: sdkBodyType,
      code: sdkBodyCode,
      provider,
    });
    // APIConnectionError and similar subclasses may have undefined status.
    // Fall back to message-based transient detection (matches old agentLoop behavior).
    if (kind === 'unknown' && (isTransientError(error.message) || hasNetworkErrorSignal(error))) {
      // Invariant: network/transport errnos MUST mint `network` (never
      // server_error/unknown). See the "lossy-collapse guard for network transport
      // classification" tests in modelErrors.test.ts.
      kind = hasNetworkErrorSignal(error)
        ? 'network'
        : 'server_error';
    }
    // 429 with billing / quota-exhaustion signal in the parsed error body →
    // billing, not rate_limit. Symmetric with classifyHttpError() — covers:
    // (a) OpenRouter, which returns 429 for quota/billing through the SDK,
    // (b) Codex passthrough proxy, which forwards upstream `usage_limit_reached`
    //     as the rewritten error's `code` field (see REBEL-4GH / FOX-3152).
    // The SDK exposes the parsed JSON body on `error.error` (Anthropic SDK
    // convention), which we inspect for both type/code AND the human-readable
    // message text.
    if (error.status === 429 && kind === 'rate_limit') {
      const parsedBody = sdkErrorBody;
      const bodyType = extractParsedBodyType(parsedBody);
      const bodyCode = extractParsedBodyCode(parsedBody);
      if (
        isQuotaExhaustionSignal(bodyType) ||
        isQuotaExhaustionSignal(bodyCode) ||
        isBillingMessage(error.message)
      ) {
        kind = 'billing';
      }
    }
    // Extract reset timing from the parsed error body (Codex 429s forward
    // resets_at/resets_in_seconds through the proxy → SDK path).
    const resetAtMs = error.status === 429 && (kind === 'rate_limit' || kind === 'billing')
      ? extractResetFromParsedBody(sdkErrorBody)
      : undefined;
    // Diagnostic: log the full SDK error details when a billing error is
    // detected so we can debug why managed-key users see "billing issue".
    if (kind === 'billing') {
      try {
        console.warn('[modelErrors] classifyError (SDK) detected billing error', {
          status: error.status,
          provider,
          message: error.message?.slice(0, 500),
          sdkErrorBody:
            typeof sdkErrorBody === 'string'
              ? sdkErrorBody.slice(0, 2000)
              : sdkErrorBody && typeof sdkErrorBody === 'object'
                ? JSON.stringify(sdkErrorBody).slice(0, 2000)
                : undefined,
        });
      } catch {
        // never throw from diagnostic logging
      }
    }

    const outputCap = error.status === 400 && kind === 'invalid_request'
      ? parseOutputCapFrom400(error.message)
      : undefined;
    const limitScope = inferLimitScope({
      kind,
      status: error.status,
      type: sdkBodyType,
      code: sdkBodyCode,
    });
    const modelError = new ModelError(
      kind,
      error.message,
      error.status,
      provider,
      (resetAtMs || outputCap || limitScope)
        ? {
            ...(resetAtMs ? { resetAtMs } : {}),
            ...(limitScope ? { limitScope } : {}),
            ...(outputCap ? { details: { outputCap } } : {}),
          }
        : undefined,
    );
    modelError.stack = error.stack;
    return modelError;
  }

  // SDK stream-lifecycle errors: AnthropicError (not APIError) thrown by
  // MessageStream when the connection drops before completing — e.g.
  // "request ended without sending any chunks", "stream ended without
  // producing a Message". These are always transient server-side hiccups.
  if (error instanceof AnthropicError && !(error instanceof APIError)) {
    return new ModelError('server_error', error.message, undefined, provider);
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return new ModelError('abort', error.message, undefined, provider);
    }
    if (isTransientError(error.message) || hasNetworkErrorSignal(error)) {
      // Invariant: network/transport errnos MUST mint `network` (never
      // server_error/unknown). See the "lossy-collapse guard for network transport
      // classification" tests in modelErrors.test.ts.
      return new ModelError(
        hasNetworkErrorSignal(error) ? 'network' : 'server_error',
        error.message,
        undefined,
        provider,
      );
    }
    return new ModelError('unknown', error.message, undefined, provider);
  }

  return new ModelError('unknown', String(error), undefined, provider);
}
