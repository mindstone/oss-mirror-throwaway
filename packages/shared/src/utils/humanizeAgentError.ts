/**
 * humanizeAgentError — classification-first user-facing error humanization.
 *
 * Treats `errorKind` + event metadata (`billingMeta`, `rateLimitMeta`, `provider`,
 * `upstreamProviderName`) as the PRIMARY signal for user-facing copy, and falls back
 * to raw-text substring matching (via legacy `humanizeError`) only when the caller
 * has no classification.
 *
 * The input is a **discriminated union**:
 *   - `{kind: 'classified', errorKind, rawMessage, ...meta}` — caller has classified the error
 *   - `{kind: 'unclassified', rawMessage, provider?}` — caller has only raw text
 *
 * This compile-time enforcement prevents the "classified-but-missing-kind" footgun
 * and forces Stage 2+ migrations to be explicit about whether classification is available.
 *
 * The function is wrapped in a try/catch so that any unexpected internal failure
 * returns a safe fallback string and notifies an optional observer — error events
 * are never dropped because of a humanizer bug.
 *
 * See: docs/plans/260421_classification_driven_error_humanizer.md — Stage 1.
 */

import type { AgentErrorKind } from './agentErrorCatalog';
import { AGENT_ERROR_KINDS } from './agentErrorCatalog';
import {
  CLAUDE_MAX_BLOCKED_ERROR,
  classifyBillingSubtype,
  humanizeError,
  humanizeNetworkError,
  humanizeProviderServerError,
  type BillingSubtype,
} from './friendlyErrors';

export type { BillingSubtype } from './friendlyErrors';

/**
 * Billing metadata propagated with classified billing errors.
 * Mirrors `AgentEvent['billingMeta']` to avoid a parallel type.
 */
export type BillingMeta = {
  subtype: BillingSubtype;
  upstreamProviderName?: string;
  rawError?: string;
  /**
   * Present iff the failing turn routed through Mindstone's managed
   * subscription credential. Carries the active tier so renderer/UI layers
   * can produce tier-aware allowance-exhaustion copy (see
   * docs/plans/260513a_subscription_consumer_audit_gaps.md § E).
   * Absent for BYO-key billing failures.
   */
  managedSubscription?: { tier: string; resetsAt?: string };
};

export function formatHumanizedResetDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Rate-limit metadata; reserved for future copy (retry-after display).
 * Mirrors `AgentEvent['rateLimitMeta']`.
 */
export type RateLimitMeta = {
  rawError?: string;
  retryAfterMs?: number;
  resetAtMs?: number;
};

/**
 * Managed-model-not-allowed metadata propagated with classified
 * `managed_model_not_allowed` errors. Mirrors `AgentEvent['managedModelMeta']`.
 *
 * Fires when a managed-tier user attempts to route through a model that is
 * not in their tier's allow-list (proxy returns 403 with
 * `code === 'MANAGED_MODEL_NOT_ALLOWED'`). The proxy includes the requested
 * model and the allowed model list so the humanizer can produce
 * actionable copy. See docs/plans/260513a_subscription_consumer_audit_gaps.md § G3.
 */
export type ManagedModelNotAllowedMeta = {
  requested?: string;
  allowed?: string[];
  rawError?: string;
};

/**
 * Discriminated-union input to the humanizer.
 *
 * Enforces at compile time that callers who have classification use the
 * `'classified'` branch (which requires `errorKind`) and those who don't
 * use the `'unclassified'` branch (raw-text fallback).
 */
export type HumanizerInput =
  | {
      kind: 'classified';
      errorKind: AgentErrorKind;
      rawMessage: string;
      provider?: string;
      limitScope?: 'provider' | 'plan' | 'account';
      upstreamProviderName?: string;
      billingMeta?: BillingMeta;
      rateLimitMeta?: RateLimitMeta;
      managedModelMeta?: ManagedModelNotAllowedMeta;
    }
  | {
      kind: 'unclassified';
      rawMessage: string;
      provider?: string;
    };

/**
 * Allow-list of `AgentErrorKind`s for which the humanizer owns the copy.
 * Callers should use `humanizeAgentError` freely for these — renderer layers
 * may re-humanize to keep copy consistent.
 *
 * An alignment test (see the test suite) asserts this set plus
 * `CALLER_OVERRIDE_KINDS` cover every `AgentErrorKind` exactly once.
 */
export const HUMANIZER_OWNED_KINDS: ReadonlySet<AgentErrorKind> = new Set<AgentErrorKind>([
  'billing',
  'rate_limit',
  'auth',
  'connection-not-configured',
  'moderation',
  'server_error',
  'network',
  'invalid_request',
  'routing',
  'context_overflow',
  'model_unavailable',
  'managed_model_not_allowed',
  'unsupported_model',
  'image_input_unsupported',
]);

/**
 * Kinds where the dispatcher passes a bespoke `humanizedOverride` produced
 * at the call site (e.g., `message_timeout`'s per-diagnostic copy). The
 * humanizer deliberately returns a safe generic fallback for these — it
 * must NEVER overwrite caller-generated copy at the renderer layer.
 *
 * `'unknown'` is intentionally here too: unclassified errors fall through to
 * the legacy `humanizeError` substring ladder.
 */
export const CALLER_OVERRIDE_KINDS: ReadonlySet<AgentErrorKind> = new Set<AgentErrorKind>([
  'message_timeout',
  'process_exit',
  'mcp_error',
  'session_not_found',
  'tool_name_corrupt',
  'user_action',
  // 260622 Stage 3: the turn-admission gate always passes bespoke per-reason
  // copy via `humanizedOverride`; the humanizer must never overwrite it.
  'chief-of-staff-unavailable',
  'unknown',
]);

/**
 * Safe fallback string returned when the humanizer hits an internal error.
 * Exported so tests can assert on it without relying on copy-diff stability.
 */
export const HUMANIZER_SAFE_FALLBACK = 'Something went wrong — try again.';

// ---------------------------------------------------------------------------
// Failure observer — DI hook for platform-specific logging + tracking.
// ---------------------------------------------------------------------------
//
// `@rebel/shared` is platform-agnostic (no imports from `electron`, `@core/*`
// or `@shared/*`), so we cannot reach a Pino logger or `getTracker()` directly.
// Instead we expose a minimal observer hook that the dispatcher (Stage 2) or
// any host surface can wire up with structured logging + analytics.
//
// If no observer is registered the humanizer still returns the safe fallback —
// we just lose observability on that particular crash. The Stage 2 dispatcher
// has its OWN try/catch + log + tracker around the humanizer call, so a missing
// observer never means a dropped error event.

export interface HumanizerFailureReport {
  err: unknown;
  /** Discriminator of the input that triggered the failure. */
  inputKind: HumanizerInput['kind'];
  /** `errorKind` if the caller was on the `'classified'` branch. */
  errorKind?: AgentErrorKind;
}

export type HumanizerFailureObserver = (report: HumanizerFailureReport) => void;

let _failureObserver: HumanizerFailureObserver | null = null;

/**
 * Register a failure observer. Pass `null` to clear.
 *
 * Call this once during platform bootstrap (main / cloud / renderer) to wire up
 * structured logging + tracker events. The observer is invoked from inside the
 * humanizer's top-level try/catch — it MUST itself not throw (any observer
 * throw is swallowed so we never drop an error event).
 */
export function setHumanizerFailureObserver(
  observer: HumanizerFailureObserver | null,
): void {
  _failureObserver = observer;
}

/**
 * Clear the failure observer. Exposed primarily for test isolation.
 */
export function __clearHumanizerFailureObserverForTests(): void {
  _failureObserver = null;
}

function reportHumanizerFailure(report: HumanizerFailureReport): void {
  const observer = _failureObserver;
  if (!observer) {
    // No observer wired yet (legitimate during early startup before the dispatcher
    // calls `setHumanizerFailureObserver`). Emit a last-ditch diagnostic via
    // `console` so the humanizer failure is at least visible in stdout / devtools.
    // `console` is safe to use in `@rebel/shared` — it is a platform-agnostic global.
    // In renderer builds this is captured via the `[Renderer]` log prefix (see AGENTS.md).
    try {
      console.warn('[humanizeAgentError] failure (no observer wired)', {
        err: report.err instanceof Error ? report.err.message : String(report.err),
        inputKind: report.inputKind,
        errorKind: report.errorKind,
      });
    } catch {
      // `console.warn` is vanishingly unlikely to throw, but even if it does we must
      // not propagate — the safe fallback return path still runs.
    }
    return;
  }
  try {
    observer(report);
  } catch (observerError) {
    // Observer must never cause the humanizer to throw. Emit a last-ditch `console.warn`
    // so observer bugs are discoverable even when the primary log path is broken.
    try {
      console.warn(
        '[humanizeAgentError] observer threw while reporting humanizer failure',
        {
          observerError:
            observerError instanceof Error ? observerError.message : String(observerError),
          originalErr: report.err instanceof Error ? report.err.message : String(report.err),
          inputKind: report.inputKind,
        },
      );
    } catch {
      // `console.warn` is vanishingly unlikely to throw; swallow if it does.
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Classification-first user-facing error humanizer.
 *
 * Returns a non-empty, Brand-Voice-aligned string for every input. Never throws.
 *
 * @param input — discriminated-union input, see `HumanizerInput`.
 * @returns user-facing copy suitable for banner / toast / plugin `Error.message`.
 */
export function humanizeAgentError(input: HumanizerInput): string {
  try {
    return humanizeAgentErrorCore(input);
  } catch (err) {
    reportHumanizerFailure({
      err,
      inputKind: input.kind,
      errorKind: input.kind === 'classified' ? input.errorKind : undefined,
    });
    return HUMANIZER_SAFE_FALLBACK;
  }
}

// ---------------------------------------------------------------------------
// Internal implementation
// ---------------------------------------------------------------------------

function humanizeAgentErrorCore(input: HumanizerInput): string {
  if (input.kind === 'unclassified') {
    return humanizeUnclassified(input.rawMessage, input.provider);
  }

  const { errorKind, rawMessage, provider, limitScope, upstreamProviderName, billingMeta, rateLimitMeta, managedModelMeta } = input;

  // CALLER_OVERRIDE_KINDS: deliberately conservative. Callers should pass
  // `humanizedOverride` at the dispatch layer; the renderer must also guard
  // with `HUMANIZER_OWNED_KINDS.has(errorKind)` before re-humanizing.
  if (CALLER_OVERRIDE_KINDS.has(errorKind)) {
    // 'unknown' falls through to the legacy substring ladder for backward compat.
    if (errorKind === 'unknown') {
      return humanizeUnclassified(rawMessage, provider);
    }
    return HUMANIZER_SAFE_FALLBACK;
  }

  // Exhaustive switch over ALL AgentErrorKinds. Caller-override kinds and
  // 'unknown' are handled above via the CALLER_OVERRIDE_KINDS gate, but
  // TypeScript cannot narrow via `ReadonlySet.has`, so we list them here for
  // compile-time exhaustiveness and defensive runtime coverage.
  switch (errorKind) {
    case 'billing':
      return humanizeBilling(rawMessage, provider, limitScope, upstreamProviderName, billingMeta);
    case 'rate_limit':
      return humanizeRateLimit(provider, limitScope, rateLimitMeta);
    case 'auth':
      return humanizeAuth(rawMessage);
    case 'connection-not-configured':
      return rawMessage || HUMANIZER_SAFE_FALLBACK;
    case 'moderation':
      return humanizeModeration();
    case 'server_error':
      return humanizeServerError(provider);
    case 'network':
      return humanizeNetworkError();
    case 'invalid_request':
      return humanizeInvalidRequest();
    case 'routing':
      return humanizeRouting();
    case 'context_overflow':
      return humanizeContextOverflow();
    case 'model_unavailable':
      return humanizeModelUnavailable(rawMessage);
    case 'managed_model_not_allowed':
      return humanizeManagedModelNotAllowed(managedModelMeta);
    case 'unsupported_model':
      return humanizeUnsupportedModel();
    case 'image_input_unsupported':
      return humanizeImageInputUnsupported();
    // Defensive: these are already routed via the CALLER_OVERRIDE_KINDS gate
    // above, but listing them here gives us a compile-time exhaustiveness
    // guarantee. Any new AgentErrorKind added to the tuple but not placed in
    // HUMANIZER_OWNED_KINDS or CALLER_OVERRIDE_KINDS also fails the alignment
    // test in the test suite.
    case 'message_timeout':
    case 'process_exit':
    case 'mcp_error':
    case 'session_not_found':
    case 'tool_name_corrupt':
    case 'user_action':
    case 'chief-of-staff-unavailable':
      return HUMANIZER_SAFE_FALLBACK;
    case 'unknown':
      return humanizeUnclassified(rawMessage, provider);
    default: {
      const _exhaustive: never = errorKind;
      void _exhaustive;
      return HUMANIZER_SAFE_FALLBACK;
    }
  }
}

// ---------------------------------------------------------------------------
// Branch implementations — copy ported verbatim from humanizeError +
// formatBillingCopy to preserve brand voice and existing behaviour.
// ---------------------------------------------------------------------------

function humanizeUnclassified(rawMessage: string, provider: string | undefined): string {
  // Legacy humanizeError handles the empty-string case by returning ''.
  // We want humanizeAgentError to NEVER return empty — callers rely on this.
  if (!rawMessage) {
    return HUMANIZER_SAFE_FALLBACK;
  }
  const legacy = humanizeError(rawMessage, provider ? { provider } : undefined);
  return legacy || HUMANIZER_SAFE_FALLBACK;
}

function humanizeBilling(
  rawMessage: string,
  provider: string | undefined,
  limitScope: 'provider' | 'plan' | 'account' | undefined,
  upstreamProviderNameInput: string | undefined,
  billingMetaInput: BillingMeta | undefined,
): string {
  const upstreamProviderName =
    billingMetaInput?.upstreamProviderName ?? upstreamProviderNameInput;
  const subtype: BillingSubtype =
    billingMetaInput?.subtype ?? classifyBillingSubtype(rawMessage);
  const managedSubscription = billingMetaInput?.managedSubscription;

  // Diagnostic: surface the billing error inputs so we can debug "billing
  // issue" copy showing up for managed-key users. `console.warn` is safe in
  // platform-agnostic shared code (captured in renderer logs via
  // `[Renderer]` prefix; visible in main-process stdout otherwise).
  try {
    console.warn('[humanizeAgentError] humanizeBilling invoked', {
      provider,
      upstreamProviderName,
      subtype,
      managedTier: managedSubscription?.tier,
      managedResetsAt: managedSubscription?.resetsAt,
      rawMessage: rawMessage?.slice(0, 500),
      billingMetaSubtype: billingMetaInput?.subtype,
      billingMetaUpstream: billingMetaInput?.upstreamProviderName,
      billingMetaRawError: billingMetaInput?.rawError?.slice(0, 500),
    });
  } catch {
    // never throw from diagnostic logging
  }

  // Managed-subscription branch (Stage E3/H2, plan 260513a § E and stage H2).
  //
  // When the failing turn routed through Mindstone's managed key,
  // BYOK-style guidance ("Add credits at your provider's console", "set up
  // auto top-up", "you've hit your daily limit") is wrong: the user doesn't
  // own the key. Their actionable lever is the BYOK overflow path (Stage H2
  // copy, locked via Q7.1) — add a personal OpenRouter or Anthropic key in
  // Settings to keep working until the monthly allowance resets. Subtype
  // distinctions collapse here because they all reduce to the same user
  // action.
  //
  if (managedSubscription?.tier) {
    return humanizeManagedBilling(managedSubscription.resetsAt);
  }

  if (limitScope === 'plan') {
    return "Your subscription plan has hit its usage allowance. Switch providers in Settings, or try again when it resets.";
  }

  // No provider context → fall back to the generic billing copy the legacy
  // humanizer produces. Keeps parity with the current banner experience for
  // pre-classification persisted events / unknown-provider pathways.
  if (!provider) {
    return "Your API account needs billing attention. Add credits at your provider's console. If you're using OpenRouter, you can also set up auto top-up to avoid running out.";
  }

  const providerLabel = formatProviderLabel(provider, upstreamProviderName);
  const autoTopUpHint =
    provider === 'OpenRouter'
      ? ' You can set up auto top-up in your OpenRouter settings to avoid this.'
      : '';

  switch (subtype) {
    case 'credits':
      return `Your ${providerLabel} account has run out of credits.${autoTopUpHint}`;
    case 'negative_balance':
      return `Your ${providerLabel} account has a negative balance — even free models need a positive balance.${autoTopUpHint}`;
    case 'key_limit':
      return `You've reached your ${providerLabel} daily/monthly limit. Usage resets shortly.${autoTopUpHint}`;
    case 'spend_limit':
      return `You've hit your ${providerLabel} spending limit.${autoTopUpHint}`;
    case 'free_tier_exhausted':
      return `You've exhausted today's free-tier allowance on ${providerLabel}.${autoTopUpHint}`;
    case 'unknown':
    default: {
      // Subtype unknown: prefer a usage-limit framing when the raw message
      // reads as quota-exhaustion; otherwise a generic billing-issue copy.
      // This keeps parity with the pre-folding `formatBillingCopy` fallback
      // branch AND matches the "You've reached your OpenAI usage limit" bug-
      // regression expectation.
      const lower = rawMessage.toLowerCase();
      if (
        lower.includes('quota') ||
        lower.includes('insufficient_quota') ||
        lower.includes('usage limit')
      ) {
        return `You've reached your ${providerLabel} usage limit.${autoTopUpHint}`;
      }
      if (lower.includes('spending limit') || lower.includes('api usage limits')) {
        return `You've hit your ${providerLabel} spending limit.${autoTopUpHint}`;
      }
      if (
        lower.includes('credit balance') ||
        lower.includes('credits') ||
        lower.includes('insufficient credit')
      ) {
        return `Your ${providerLabel} account has run out of credits.${autoTopUpHint}`;
      }
      return `Your ${providerLabel} account has a billing issue.${autoTopUpHint}`;
    }
  }
}

function humanizeRateLimit(
  provider: string | undefined,
  limitScope: 'provider' | 'plan' | 'account' | undefined,
  _rateLimitMeta: RateLimitMeta | undefined,
): string {
  if (limitScope === 'plan') {
    return 'Your subscription has hit its usage window. Try again when it resets, or switch providers in Settings.';
  }
  const isOpenAI = Boolean(provider) && /openai|chatgpt|codex/i.test(provider!);
  return isOpenAI
    ? "Your AI provider's rate limit was reached. OpenAI limits reset on a rolling window that can take up to a few hours — try again later or switch to a backup provider."
    : "Your AI provider's rate limit was reached. This usually resets within a few minutes — try again shortly.";
}

function humanizeAuth(rawMessage: string): string {
  // Preserve the Claude-Max OAuth-blocked special case (260417 Stage 1.5).
  if (rawMessage && rawMessage.includes(CLAUDE_MAX_BLOCKED_ERROR)) {
    return CLAUDE_MAX_BLOCKED_ERROR;
  }
  return "There's an issue with your API key. Hop into Settings to update it.";
}

function humanizeModeration(): string {
  return "Your message was flagged by the model's safety filter. Try rephrasing — a less direct framing or more context usually helps.";
}

function humanizeServerError(provider: string | undefined): string {
  return humanizeProviderServerError(provider);
}

function humanizeInvalidRequest(): string {
  return 'The AI service ran into trouble. Your message is safe — try again.';
}

/**
 * Copy for the structured-output schema-rejection branch.
 *
 * Fired when a provider rejects the planner's `response_format` /
 * `output_config.format` schema before any tokens are produced (the
 * `f1b4d44b-…` and `2feaa34a-…` postmortems are the originating incidents).
 * Stays distinct from the generic `invalid_request` copy so a future
 * provider-dialect drift surfaces with actionable framing rather than
 * the catch-all "something went wrong" string.
 *
 * Keep the wording aligned with Rebel brand voice: dry, honest, never
 * blames the user. Call sites pass this string as `humanizedOverride`
 * via `dispatchAgentErrorEvent` (see `turnErrorRecovery.ts`).
 */
export function humanizeStructuredOutputSchemaRejection(): string {
  return 'Plan mode hit an internal error before the assistant could reply. Your message is safe — try again, and let us know if it keeps happening.';
}

/**
 * Routing misconfiguration copy. Fires when a proxy-dialect model ID reaches a
 * native-Anthropic path (or vice versa) — typically a routing bug in our code
 * or a stale proxy/model combination in settings. The `__routingCause`
 * side-channel on the error carries the sub-cause for telemetry; user-facing
 * copy stays generic + actionable. Brand voice: reassure the message is safe,
 * point at Settings → Models as the one user-actionable lever.
 *
 * See: docs/plans/260422_provider_routing_residual.md (R2).
 */
function humanizeRouting(): string {
  return 'Something went wrong while routing your request. Your message is safe — try again, or switch models in Settings if the issue persists.';
}

function humanizeContextOverflow(): string {
  return 'This conversation got too long. Let me summarize and continue.';
}

function humanizeModelUnavailable(rawMessage: string): string {
  // Parity with the `not_found_error` branch in legacy humanizeError.
  //
  // Accept BOTH the raw upstream form (e.g. `{"type":"not_found_error","message":"model: anthropic/claude-opus-4.6"}`)
  // AND the already-humanized form (`The model 'anthropic/claude-opus-4.6' wasn't found...`).
  //
  // The second form matters for idempotency — Stage 6 (plan 260421) re-humanizes
  // AgentEvent error strings at the renderer and cloud-client via the
  // HUMANIZER_OWNED_KINDS guard. For this kind, that means we run on an
  // already-humanized string rather than the raw upstream payload. Without
  // the second regex, the model name is silently dropped when the renderer
  // re-humanizes (Phase 7 R1 finding — GPT5.4 Final Review).
  //
  // NOTE: rawMessage-parsing INSIDE a humanizer is a targeted fix, not a
  // long-term shape. If a SECOND humanizer-owned kind ever needs to extract
  // details from raw text, promote extracted details to structured metadata
  // on AgentEvent (alongside billingMeta/rateLimitMeta) instead of adding
  // another regex here. See plan 260421 § Discovered Improvements #15.
  const modelMatch =
    rawMessage.match(/model:\s*([^\s"'}]+)/) ?? rawMessage.match(/model '([^']+)'/);
  const modelName = modelMatch?.[1];
  if (modelName) {
    return `The model '${modelName}' wasn't found. Open Settings → Models to pick a different one, or turn off Plan Mode to keep going.`;
  }
  return "The model we tried isn't available. Try selecting a different model in Settings.";
}

/**
 * Managed-subscription billing-error copy (Stage E3, plan 260513a § E3).
 *
 * Fires when a billing-classified error (402, quota-exhaustion 429, billing
 * 400) originates on a turn that routed through Mindstone's managed key.
 * Distinct from BYOK billing copy: the user can't top up the company-owned
 * managed key; their actionable lever is the BYOK overflow path — add a
 * personal OpenRouter or Anthropic key in Settings to keep working until
 * the monthly allowance resets. Subtype is intentionally not propagated
 * into the copy: credits / spend_limit / key_limit / free_tier_exhausted /
 * negative_balance all collapse to the same user action for managed users.
 *
 */
function humanizeManagedBilling(resetsAt?: string): string {
  const formattedResetDate = formatHumanizedResetDate(resetsAt);
  if (formattedResetDate) {
    return `You've used your monthly Mindstone AI allowance. It resets on ${formattedResetDate}. To keep working until then, switch to your own OpenRouter or Anthropic key.`;
  }
  return "You've used your monthly Mindstone AI allowance. To keep working, switch to your own OpenRouter or Anthropic key.";
}

/**
 * Managed-model-not-allowed copy. Fires when a managed-tier user attempts to
 * route through a model outside their tier's allow-list (proxy returns 403
 * with `code === 'MANAGED_MODEL_NOT_ALLOWED'`). The proxy carries the
 * requested model and the allow-list via `managedModelMeta`, but the
 * primary user-facing copy stays generic + actionable: point to the plan
 * defaults or the personal-key escape hatch.
 *
 * See: docs/plans/260513a_subscription_consumer_audit_gaps.md § G3.
 */
function humanizeManagedModelNotAllowed(meta?: ManagedModelNotAllowedMeta): string {
  const requested = meta?.requested?.trim();
  if (requested) {
    return `The model '${requested}' isn't included in your Mindstone plan. Switch to one of your plan defaults, or add a personal OpenRouter key in Settings to use it.`;
  }
  return "That model isn't included in your Mindstone plan. Switch to one of your plan defaults, or add a personal OpenRouter key in Settings to use it.";
}

function humanizeUnsupportedModel(): string {
  // FOX-3267 Stage 1: placeholder for unsupported_model — copy locked in Stage 5.
  return "This model isn't available on your current subscription. Pick a supported model in Settings to keep going.";
}

function humanizeImageInputUnsupported(): string {
  // 260610 image-unsupported-by-model Stage 4. LEADS with switch-model (DA F2):
  // when the image came from a tool result it is baked into history, so
  // "remove the image" is impossible and retry loops forever. Constant copy —
  // trivially idempotent under renderer/cloud-client re-humanization (T5).
  return "This model can't view images. Switch to a vision-capable model in Settings to continue this conversation.";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalizeFirst(value: string): string {
  if (!value) return value;
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function formatProviderLabel(
  provider: string,
  upstreamProviderName: string | undefined,
): string {
  const trimmedUpstream = upstreamProviderName?.trim();
  if (!trimmedUpstream) return provider;

  const formattedUpstream = capitalizeFirst(trimmedUpstream);
  if (formattedUpstream.toLowerCase() === provider.toLowerCase()) {
    return provider;
  }
  return `${provider} (via ${formattedUpstream})`;
}

// ---------------------------------------------------------------------------
// Internals exposed for tests — the alignment test needs access to the kind
// tuple to assert the partition is exhaustive. Re-export for convenience.
// ---------------------------------------------------------------------------

export { AGENT_ERROR_KINDS };
