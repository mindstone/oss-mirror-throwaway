/**
 * Shared transport primitives for the Behind-The-Scenes client.
 *
 * Stage 7 of the hotspot-refactor roadmap extracted the eight copy-pasted
 * transport functions out of `behindTheScenesClient.ts` into per-transport
 * adapter modules under `bts/transports/`. This module holds the helpers,
 * constants, request/response types, and the process-scoped registration state
 * those adapters share — so the extraction does NOT duplicate logic or
 * fragment process-global state across modules.
 *
 * IMPORTANT (process-scoped state preservation — PLAN.md §"Ambient Behaviors"
 * for behindTheScenesClient.ts): `_preOAuthCallHook` and the BTS proxy state
 * (`_btsProxyState`) live here as single module-level singletons. Both the
 * transport adapters and the public `register*` / `getProxy*` /
 * `resolveBtsProxyForTransport` entry points (re-exported from
 * `behindTheScenesClient.ts`) read/write the SAME instances. Do NOT re-declare
 * these in another module — that would silently split the registration surface
 * per-module and reintroduce PM 260327 / 260429-class cross-surface parity gaps.
 *
 * BTS proxy seam (260609 — proxy-resolution-seam hardening): the proxy URL+auth
 * providers are wired as a single atomic `BtsProxyState` discriminated union
 * (`unwired | wired | none`) rather than two independent nullable singletons.
 * This kills the "register the URL provider but forget the auth provider"
 * sub-class by construction, and makes "never wired" (a bootstrap bug)
 * distinguishable from "wired but the proxy is stopped / explicitly absent" (a
 * legitimate runtime state). Wire via `registerBtsProxyProviders({url, auth})`;
 * declare deliberate absence via `declareNoBtsProxy()`. The dispatch
 * plan-builder uses the SOFT getters (`getProxyUrl`/`getProxyAuth` — never throw,
 * unwired ⇒ null). The two proxy transport adapters use the HARD read
 * (`resolveBtsProxyForTransport` — throws `BtsProxyNotWiredError` + emits an
 * `error`-level log with marker `bts-proxy-unwired` if a surface never wired the
 * proxy; this survives a swallowing caller in CI/eval logs).
 *
 * Platform-agnostic by contract: this file lives in `src/core/` and is inherited
 * by cloud + mobile. It MUST NOT import `electron`, `@main/*`, or `@renderer/*`.
 */

import { createScopedLogger } from '@core/logger';
import type { CodexConnectivity, ProviderRouteHeaderTuples } from '@core/rebelCore/providerRouteDecision';
import { isAlwaysOnThinkingModel, isSamplingParamsForbiddenModel } from '@core/rebelCore/modelLimits';
import type { AuxiliaryCostCategory, CostOutcomePolicy } from '../../costLedgerService';

const log = createScopedLogger({ service: 'behindTheScenesClient' });

// ─── Request / response contract types ──────────────────────────────────────

/**
 * Options for tracking costs of behind-the-scenes API calls.
 */
export interface TrackingOptions {
  /** Category of the auxiliary call for cost breakdown */
  category: AuxiliaryCostCategory;
  /** Session ID for attribution when triggered by a turn */
  sessionId?: string;
  /** Turn ID for attribution when triggered by a turn */
  turnId?: string;
  /** Auth method used ('api-key' | 'oauth-token'). String for forward compat. */
  auth?: string;
  /** Whether the cost contributes to a user turn or an auxiliary/background task. */
  outcomePolicy?: CostOutcomePolicy;
}

export interface BehindTheScenesRequestOptions {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** System prompt for the model */
  system?: string;
  maxTokens?: number;
  temperature?: number;
  outputFormat?: {
    type: 'json_schema';
    schema: Record<string, unknown>;
    /**
     * Optional schema name. Forwarded to the upstream as
     * `response_format.json_schema.name` (Codex/OpenAI) or
     * `output_format.name` (Anthropic) when supported. Defaults to
     * `'structured_output'` at the proxy boundary if omitted.
     */
    name?: string;
    /**
     * OpenAI strict-mode opt-in. When `true`, Codex / OpenAI Responses enforce
     * `additionalProperties: false` everywhere and require every property in
     * `required`. Default `false` — many BTS schemas don't satisfy strict mode
     * yet, so callers must opt in deliberately. Anthropic ignores this field.
     * See docs-private/investigations/260509_bts_output_format_dropped_codex_proxy.md
     * § Phase 7 follow-up.
     */
    strict?: boolean;
  };
  timeout?: number;
  signal?: AbortSignal;
  /**
   * Caller-supplied Codex connectivity state.
   * Desktop callers should pass a live or turn-start snapshot; cloud/mobile pass
   * 'unsupported' when Codex auth is not available on that surface.
   */
  codexConnectivity: CodexConnectivity;
}

export interface BehindTheScenesResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  /**
   * Provider `stop_reason` when the transport surfaces it (Anthropic-dialect
   * transports only). Consumed by the dispatch layer's always-on-thinking
   * budget-exhaustion observability (`stop_reason: 'max_tokens'` + zero text
   * blocks ⇒ thinking consumed the whole budget). Underscore-prefixed internal
   * field, same convention as `_exactCostUsd`.
   */
  _stopReason?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  /**
   * Structured output parsed from JSON text when outputFormat is provided.
   * Included for backwards compatibility with callers that prefer this field.
   */
  structured_output?: unknown;
  /**
   * Exact cost in USD from OpenRouter's usage.cost field.
   * Preferred over token-based calculation when available.
   */
  _exactCostUsd?: number;
  /**
   * Legacy fallback for historical SDK responses that only exposed total_cost_usd.
   * New direct API paths should rely on token usage instead.
   */
  _sdkCostUsd?: number;
  /** Actual auth method used for this call ('api-key' | 'oauth-token'). Undefined for profile calls. */
  _resolvedAuth?: string;
  /** Actual model string selected after category-specific BTS routing. */
  _resolvedModel?: string;
  /** OpenRouter upstream provider that served the request (e.g. 'Anthropic', 'Google'). Only present for OpenRouter-routed BTS calls. */
  _openRouterProvider?: string;
}

// ─── Wire-safe options sanitization (sampling-forbidden / always-on models) ──
//
// Sampling-forbidden models reject `temperature`/`top_p`/`top_k` with a 400.
// Always-on-thinking models additionally need a conservative BTS max_tokens
// floor because their thinking tokens count against tiny BTS budgets. BTS
// callers (watchdog temp 0, safety consensus, operator consults temp 0.2) set
// temperature for determinism on models that accept it; the sanitizer strips
// it only for sampling-forbidden models, per dispatch, keyed on that dispatch's
// resolved wire model. Mirrors the `ValidatedChatCompletionsBody` branding
// precedent in chatCompletionsParamCapability.ts.

declare const wireSafeBtsOptionsBrand: unique symbol;

/**
 * Options proven safe for the wire model they were sanitized against.
 * Mintable ONLY by {@link sanitizeBtsOptionsForWireModel} — transports require
 * this type, so an unsanitized dispatch is a compile error.
 */
export type WireSafeBtsOptions = BehindTheScenesRequestOptions & {
  readonly [wireSafeBtsOptionsBrand]: true;
};

/**
 * Minimum `max_tokens` for BTS calls to always-on-thinking models.
 *
 * BTS token budgets are tiny (watchdog 256, consult 1,000, transport default
 * 512) and always-on thinking tokens count against `max_tokens` — a budget
 * consumed entirely by thinking yields zero text blocks, which BTS parsers
 * surface as parse failures (watchdog fail-open, safety fail-closed). 2048
 * leaves headroom for a short adaptive think plus the small JSON/text replies
 * BTS consumers expect, without materially raising cost (output is billed on
 * actual tokens, not the cap). Kept conservative per the Stage 3(f) floor
 * probe: one sample showed thinking NOT exhausting 256, but a single sample of
 * non-deterministic thinking is not proof (PLAN.md Stage 3 results).
 */
export const ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS = 2048;

/**
 * Pure per-dispatch sanitizer: returns a FRESH options object that is
 * wire-safe for `wireModel`.
 *
 * - Sampling-forbidden model: strips `temperature` (and `top_p`/`top_k` if a
 *   caller smuggled them past the type).
 * - Always-on-thinking model: also floors `maxTokens` at
 *   {@link ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS}.
 * - Every other model: identity copy — byte-identical wire behaviour.
 *
 * PURITY IS LOAD-BEARING: `executeBtsPlanWithOperationalFallback` re-dispatches
 * with the caller's SAME options object, and the fallback model may be a
 * non-always-on model (primary Fable → fallback Opus) that NEEDS the caller's
 * original `temperature: 0` for determinism. Mutating in place would poison
 * that re-dispatch. Sanitize per dispatch, never reuse a sanitized copy across
 * models.
 */
export function sanitizeBtsOptionsForWireModel(
  wireModel: string,
  options: BehindTheScenesRequestOptions,
): WireSafeBtsOptions {
  const samplingForbidden = isSamplingParamsForbiddenModel(wireModel);
  const alwaysOn = isAlwaysOnThinkingModel(wireModel);
  if (!samplingForbidden && !alwaysOn) {
    return { ...options } as WireSafeBtsOptions;
  }

  const sanitized: BehindTheScenesRequestOptions = { ...options };
  const strippedParams: string[] = [];
  if (samplingForbidden) {
    if (sanitized.temperature !== undefined) {
      delete sanitized.temperature;
      strippedParams.push('temperature');
    }
    // top_p/top_k are not on the options type, but strip defensively in case a
    // caller widened the object — the wire rejection is unconditional.
    const sanitizedRecord = sanitized as unknown as Record<string, unknown>;
    for (const param of ['top_p', 'top_k'] as const) {
      if (sanitizedRecord[param] !== undefined) {
        delete sanitizedRecord[param];
        strippedParams.push(param);
      }
    }
  }

  const callerMaxTokens = sanitized.maxTokens;
  let raisedMaxTokens: number | undefined;
  if (alwaysOn) {
    const flooredMaxTokens = Math.max(
      callerMaxTokens ?? 0,
      ALWAYS_ON_THINKING_BTS_MIN_MAX_TOKENS,
    );
    raisedMaxTokens = flooredMaxTokens !== (callerMaxTokens ?? 0) ? flooredMaxTokens : undefined;
    sanitized.maxTokens = flooredMaxTokens;
  }

  if (strippedParams.length > 0 || raisedMaxTokens !== undefined) {
    log.info(
      { model: wireModel, strippedParams, raisedMaxTokens, callerMaxTokens },
      'Sanitized BTS options for wire model (sampling params stripped / max_tokens floored when always-on)',
    );
  }

  return sanitized as WireSafeBtsOptions;
}

// ─── Pre-OAuth call hook (registered by main process for token refresh) ─────
/** Called before OAuth API calls to ensure the token is fresh. */
let _preOAuthCallHook: (() => Promise<void>) | null = null;

/**
 * Register a hook to be called before OAuth API calls.
 * Used by main process to wire in `ensureClaudeMaxTokenFresh()` without
 * creating a core → main import dependency.
 */
export function registerPreOAuthCallHook(hook: () => Promise<void>): void {
  _preOAuthCallHook = hook;
}

/**
 * @internal — read by the OAuth transport adapter only.
 *
 * FAIL-SOFT BY DESIGN: unwired ⇒ null, NOT a throw — absence here is a legitimate
 * state, not a wiring bug. The OAuth transport skips the hook when null, and the
 * normal runtime makes `preOAuthCallHook` a required `HeadlessRuntimeConfig` field,
 * so the wiring is guarded at the construction layer rather than by this getter.
 */
export function getPreOAuthCallHook(): (() => Promise<void>) | null {
  return _preOAuthCallHook;
}

// ─── OpenRouter / Codex proxy seam (registered by each bootstrapping surface) ─
//
// See the module doc block above. The proxy URL+auth providers are wired
// atomically as a single discriminated `BtsProxyState`. The mirror precedent is
// `src/core/codexAuth.ts` (NULL sentinel + throw-on-unregistered).

/** A lazily-invoked proxy value provider (sync or async). Returns null when the proxy is transiently unavailable (e.g. stopped). */
type ProxyValueProvider = () => string | null | Promise<string | null>;

/**
 * The three representable wiring states. `unwired` is the bootstrap bug we want
 * to make loud; `wired` is a real proxy; `none` is a deliberate "no proxy on
 * this surface" declaration (teardown / direct-only surfaces).
 */
type BtsProxyState =
  | { kind: 'unwired' }
  | { kind: 'wired'; url: ProxyValueProvider; auth: ProxyValueProvider }
  | { kind: 'none' };

let _btsProxyState: BtsProxyState = { kind: 'unwired' };

/**
 * Thrown by `resolveBtsProxyForTransport()` when a surface routes a BTS call
 * through the proxy but no bootstrap ever wired the proxy providers. This is a
 * wiring bug (forgotten `registerBtsProxyProviders` / `declareNoBtsProxy`), NOT
 * a transient absence. Distinct identity so a swallowing caller can be told apart
 * from a legitimate "proxy stopped" null.
 */
export class BtsProxyNotWiredError extends Error {
  constructor() {
    super(
      'BTS proxy providers were never wired for this surface. A bootstrap forgot to call ' +
        'registerBtsProxyProviders({ url, auth }) (or declareNoBtsProxy() if this surface has no ' +
        'proxy). This is a wiring bug, not a transient absence. Marker: bts-proxy-unwired.',
    );
    this.name = 'BtsProxyNotWiredError';
  }
}

/**
 * Wire the BTS proxy for this surface. `url` + `auth` are atomic — you cannot
 * register one without the other (the "register one, forget the other"
 * sub-class is unrepresentable). Both are stored as functions and invoked
 * lazily on every read, so the URL provider's `ensureRunningForBts()`
 * restart-on-demand semantics (I2/I3) are preserved.
 */
export function registerBtsProxyProviders(providers: { url: ProxyValueProvider; auth: ProxyValueProvider }): void {
  _btsProxyState = { kind: 'wired', url: providers.url, auth: providers.auth };
}

/**
 * Declare that this surface deliberately has no BTS proxy (teardown / direct-only
 * surfaces). Reads return null WITHOUT throwing the unwired error.
 */
export function declareNoBtsProxy(): void {
  _btsProxyState = { kind: 'none' };
}

/** @internal test-only — return to the unwired state (replaces the old register-null reset hack). */
export function __resetBtsProxyProvidersForTesting(): void {
  _btsProxyState = { kind: 'unwired' };
}

// ─── Two read modes ──────────────────────────────────────────────────────────
//
// SOFT read — used by the dispatch plan-builder (createBtsRoutePlan), which runs
// on EVERY BTS dispatch including non-proxy paths. Never throws: unwired AND
// explicit-none both yield null (we're only building a route decision).

export async function getProxyUrl(): Promise<string | null> {
  return _btsProxyState.kind === 'wired' ? (await _btsProxyState.url()) ?? null : null;
}

export async function getProxyAuth(): Promise<string | null> {
  return _btsProxyState.kind === 'wired' ? (await _btsProxyState.auth()) ?? null : null;
}

/**
 * HARD assert (decision-time) — call this on the dispatch path AFTER the route
 * decision is known and ONLY when the selected path is proxy-backed
 * (`isProxyDispatch(decision.dispatchPath)`). It makes a forgotten bootstrap
 * loud on the PRIMARY dispatch path: normal BTS dispatch builds a route *plan*
 * via the SOFT getters and carries the (possibly null) proxy runtime into the
 * adapters, so the adapters' `plan?.proxyBaseURL` branch skips
 * `resolveBtsProxyForTransport()` and an unwired proxy would otherwise surface
 * only as the generic transient guard — never the distinct
 * `BtsProxyNotWiredError` + `bts-proxy-unwired` marker. This assert restores
 * that observability invariant.
 *
 * Side-effect-free aside from log+throw: it does NOT start, resolve, or read the
 * proxy providers (so the URL provider's `ensureRunningForBts()` restart-on-demand
 * is NOT triggered here). It throws ONLY on the `unwired` state. Explicit-`none`
 * and `wired` (incl. wired-but-stopped) are no-ops — those still flow to the
 * adapter's own `if (!url || !auth) throw` transient guard unchanged (I5).
 *
 * Non-proxy dispatch (anthropic-direct / profile-direct) must NEVER call this (I8).
 */
export function assertBtsProxyWired(): void {
  if (_btsProxyState.kind === 'unwired') {
    log.error(
      { marker: 'bts-proxy-unwired' },
      'BTS proxy accessed before any surface wired it — forgotten bootstrap (registerBtsProxyProviders/declareNoBtsProxy)',
    );
    throw new BtsProxyNotWiredError();
  }
}

/**
 * HARD read — used at transport time by the two proxy adapters (replaces the old
 * raw-url-provider + auth-getter pair). Throws
 * `BtsProxyNotWiredError` + emits an `error`-level log with marker
 * `bts-proxy-unwired` on the unwired state, so a forgotten bootstrap is loud and
 * attributable even if the throw is swallowed by a fail-closed caller. Returns
 * `{ url: null, auth: null }` for explicit-`none` and for the wired-but-stopped
 * case (proxy returns null) — both legitimate; the adapter's own
 * `if (!proxyUrl || !proxyAuth) throw` guard handles the transient case
 * unchanged (I5).
 */
export async function resolveBtsProxyForTransport(): Promise<{ url: string | null; auth: string | null }> {
  if (_btsProxyState.kind === 'unwired') {
    log.error(
      { marker: 'bts-proxy-unwired' },
      'BTS proxy accessed before any surface wired it — forgotten bootstrap (registerBtsProxyProviders/declareNoBtsProxy)',
    );
    throw new BtsProxyNotWiredError();
  }
  if (_btsProxyState.kind === 'none') return { url: null, auth: null };
  return { url: (await _btsProxyState.url()) ?? null, auth: (await _btsProxyState.auth()) ?? null };
}

// ─── Header conversion ───────────────────────────────────────────────────────

export function headersRecord(headers: ProviderRouteHeaderTuples): Record<string, string> {
  return Object.fromEntries(headers);
}

// ─── Cooldown signal parsing (symmetry-required behaviour) ───────────────────
//
// Stage 10: the actual `cooldown.record*` call moved to the dispatch layer
// (`executeBtsPlan` in behindTheScenesClient.ts) so every transport is covered
// by construction. The adapters retain only the PROVIDER-SPECIFIC parsing below
// (reading `retry-after` from a fetch header vs. an SDK error) and surface the
// parsed value as a typed signal via `attachCooldownRateLimitSignal` (bts/cooldown.ts).
// They no longer hold an `ApiRateLimitCooldown` reference nor call `record*`.

export function parseRetryAfterHeader(retryAfter: string | null): number | undefined {
  if (!retryAfter) return undefined;
  const numericSeconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
    return numericSeconds * 1000;
  }
  const retryAtMs = Date.parse(retryAfter);
  if (!Number.isFinite(retryAtMs)) return undefined;
  const remainingMs = retryAtMs - Date.now();
  return remainingMs > 0 ? remainingMs : undefined;
}

export function getRetryAfterHeaderFromSdkError(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const headers = (error as { headers?: unknown }).headers;
  if (!headers) return null;

  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (header: string) => string | null }).get('retry-after');
    return typeof value === 'string' ? value : null;
  }

  const headersRecordValue = headers as Record<string, unknown>;
  const value = headersRecordValue['retry-after'] ?? headersRecordValue['Retry-After'];
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return null;
}

// ─── JSON / SSE response parsing (symmetry-required behaviour) ───────────────

/**
 * Extract clean JSON from model output when structured output was requested.
 * Many non-Anthropic providers wrap JSON in markdown fences (```json ... ```)
 * or add preamble text despite being asked for json_object mode. This
 * normalizes the response so all BTS consumers receive parseable JSON.
 * Only applied when outputFormat was requested — free-text responses are untouched.
 * @internal
 */
export function extractJsonFromStructuredResponse(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;

  // Already clean JSON — fast path
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;

  // Strip markdown fences: ```json ... ``` or ``` ... ```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch?.[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{') || inner.startsWith('[')) return inner;
  }

  // Last resort: find the first { ... } or [ ... ] block
  const braceStart = trimmed.indexOf('{');
  const braceEnd = trimmed.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return trimmed.slice(braceStart, braceEnd + 1);
  }

  const bracketStart = trimmed.indexOf('[');
  const bracketEnd = trimmed.lastIndexOf(']');
  if (bracketStart !== -1 && bracketEnd > bracketStart) {
    return trimmed.slice(bracketStart, bracketEnd + 1);
  }

  return trimmed;
}

/**
 * Parse a fetch response as JSON, with SSE detection guard.
 * BTS calls are always non-streaming. If a provider returns SSE (text/event-stream),
 * throw a clear diagnostic error instead of a cryptic JSON parse failure.
 *
 * Exported for unit testing; treat as internal — call sites are within the BTS
 * transport adapters. See docs/plans/260429_bts_sse_parsing_fix.md.
 */
export async function parseJsonResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (contentType.includes('text/event-stream') || (text.length > 0 && text.startsWith('event:'))) {
    log.error(
      { contentType, bodyPreview: text.slice(0, 200), url: response.url },
      'BTS non-streaming call received SSE response — provider returned streaming data to a non-streaming client'
    );
    throw new Error(
      `BTS call received streaming response (content-type: ${contentType}). ` +
      'This indicates the provider or proxy is ignoring stream:false. ' +
      'Check proxy configuration and provider API compatibility.'
    );
  }

  return JSON.parse(text);
}

// ─── Transient network retry ─────────────────────────────────────────────────
const TRANSIENT_RETRY_MAX = 3;
const TRANSIENT_RETRY_BASE_MS = 500;
const TRANSIENT_RETRY_JITTER_MS = 200;

/**
 * @internal
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const status = (err as Error & { status?: unknown }).status;
  if (typeof status === 'number' && [500, 502, 503, 504].includes(status)) {
    return true;
  }
  if ((err as { kind?: unknown }).kind === 'server_error') return true;
  if ((err as { kind?: unknown }).kind === 'network') return true;
  const msg = err.message.toLowerCase();
  if (msg.includes('fetch failed')) return true;
  if (msg.includes('econnrefused') || msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('ehostunreach')) return true;
  if (msg.includes('socket hang up') || msg.includes('econnreset')) return true;
  if (msg.includes('(500)') || msg.includes('(502)') || msg.includes('(503)') || msg.includes('(504)')) return true;
  if (err instanceof AggregateError && err.errors.some((e: unknown) => isTransientNetworkError(e))) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause) return isTransientNetworkError(cause);
  return false;
}

/**
 * Retry a network call on transient errors with exponential backoff + jitter.
 * Respects the caller's AbortSignal and timeout budget — won't start a retry
 * if the signal is already aborted.
 */
export async function withTransientRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransientNetworkError(err) || attempt === TRANSIENT_RETRY_MAX) throw err;
      if (signal?.aborted) throw err;
      const jitter = Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MS);
      const delayMs = TRANSIENT_RETRY_BASE_MS * Math.pow(2, attempt - 1) + jitter;
      log.warn({ attempt, maxRetries: TRANSIENT_RETRY_MAX, delayMs, error: err instanceof Error ? err.message : String(err) }, 'Transient network error, retrying');
      await new Promise((r) => setTimeout(r, delayMs));
      if (signal?.aborted) throw err;
    }
  }
  throw lastError;
}

/**
 * Compose the caller's abort signal with a per-call timeout controller.
 * Returns the composed signal plus the timeout id the caller must clear in a
 * `finally`. Centralises the identical timeout/signal block that every fetch
 * transport repeated verbatim.
 */
export function makeTimeoutSignal(options: BehindTheScenesRequestOptions, defaultTimeoutMs: number): {
  signal: AbortSignal;
  timeoutId: ReturnType<typeof setTimeout>;
} {
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), options.timeout ?? defaultTimeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;
  return { signal, timeoutId };
}

export const BTS_DEFAULT_TIMEOUT_MS = 30000;
