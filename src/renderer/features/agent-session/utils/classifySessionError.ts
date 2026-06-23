import type { AgentErrorKind } from '@rebel/shared';

export type SessionErrorCategory =
  | 'billing'
  | 'moderation'
  | 'rate_limit'
  | 'user_action'
  | 'api_error'
  | 'invalid_request'
  | 'watchdog'
  | 'mcp_error'
  | 'workspace_error'
  | 'auth_error'
  | 'context_overflow'
  | 'unknown';

/**
 * Maps every structural AgentErrorKind to its Sentry telemetry category.
 *
 * Why exhaustive:
 *  - The `satisfies Record<AgentErrorKind, SessionErrorCategory>` clause makes
 *    adding a new AgentErrorKind a compile-time error here — you cannot forget
 *    to classify a new kind for Sentry fingerprinting.
 *  - Prior to this map, App.tsx had a chained-ternary ladder that had silently
 *    drifted (omitted `moderation`, then `routing`), causing structural events
 *    to fall through to string-based `classifySessionError(lowerError)` and
 *    collapse under the wrong Sentry issue.
 *
 * Consumers: use this lookup when a structural `errorKind` is available on the
 * agent event. Fall back to `classifySessionError(lowerError)` only when no
 * structural kind is present (legacy/stale events). Note that `rate_limit` may
 * also be inferred from `rateLimitMeta` independent of kind — apply that
 * override BEFORE consulting this map.
 */
export const AGENT_ERROR_KIND_TO_SESSION_CATEGORY = {
  rate_limit: 'rate_limit',
  auth: 'auth_error',
  'connection-not-configured': 'auth_error',
  billing: 'billing',
  moderation: 'moderation',
  server_error: 'api_error',
  network: 'api_error',
  invalid_request: 'invalid_request',
  routing: 'api_error',
  context_overflow: 'context_overflow',
  session_not_found: 'workspace_error',
  tool_name_corrupt: 'mcp_error',
  model_unavailable: 'api_error',
  unsupported_model: 'api_error',
  image_input_unsupported: 'api_error',
  managed_model_not_allowed: 'auth_error',
  process_exit: 'api_error',
  mcp_error: 'mcp_error',
  message_timeout: 'api_error',
  user_action: 'user_action',
  // 260622 Stage 3: Chief-of-Staff instructions unreadable at admission — a
  // workspace/configuration problem (dead drive, unreadable/missing README).
  'chief-of-staff-unavailable': 'workspace_error',
  unknown: 'unknown',
} as const satisfies Record<AgentErrorKind, SessionErrorCategory>;

/**
 * Maps a lower-cased renderer-side error message to a {@link SessionErrorCategory} via
 * ordered substring matching. Used as the fallback when no structural `AgentErrorKind`
 * is available on the originating event (see {@link AGENT_ERROR_KIND_TO_SESSION_CATEGORY}
 * for the preferred structural path).
 *
 * Classification order matters: more specific patterns must come before broader ones.
 * e.g. auth_error ("api key") must precede workspace_error ("not configured") to avoid
 * misclassifying "API key not configured" as a workspace error.
 *
 * @param lowerError - The error message, already lowercased by the caller.
 */
export const classifySessionError = (lowerError: string): SessionErrorCategory => {
  // Billing / credits (user needs to fix their account)
  if (
    lowerError.includes('billing attention') ||
    lowerError.includes('credit balance') ||
    lowerError.includes('insufficient credit') ||
    lowerError.includes('add credits') ||
    lowerError.includes('quota limit') ||
    lowerError.includes('spending limit') ||
    // Provider-aware billing humanizer phrases (humanizeAgentError.ts)
    lowerError.includes('run out of credits') ||
    lowerError.includes('negative balance') ||
    lowerError.includes('free-tier allowance')
  ) {
    return 'billing';
  }

  if (
    lowerError.includes('moderation') ||
    lowerError.includes('safety filter') ||
    lowerError.includes('flagged by the model') ||
    lowerError.includes('flagged by the moderation')
  ) {
    return 'moderation';
  }

  // Rate limits (user-actionable: wait or add API key)
  // Includes Claude Max synthetic phrases ("hit your limit", "usage limit")
  if (
    lowerError.includes('rate limit') ||
    lowerError.includes("provider's rate limit") ||
    lowerError.includes('taking a quick breather') ||
    lowerError.includes('rate_limit') ||
    lowerError.includes('hit your limit') ||
    lowerError.includes('usage limit')
  ) {
    return 'rate_limit';
  }

  // User-intentional actions (not errors at all)
  if (
    lowerError.includes('stopped by user') ||
    lowerError.includes('cancelled by user') ||
    lowerError.includes('canceled by user')
  ) {
    return 'user_action';
  }

  // Watchdog / unresponsive turn
  if (
    lowerError.includes('unresponsive') ||
    lowerError.includes('watchdog') ||
    lowerError.includes('stopped automatically')
  ) {
    return 'watchdog';
  }

  // MCP / tool errors
  if (
    lowerError.includes('tool connection failed') ||
    lowerError.includes('tool name') ||
    lowerError.includes('mcp') ||
    lowerError.includes('tool configuration')
  ) {
    return 'mcp_error';
  }

  // Auth errors (must be before workspace_error to avoid "api key not configured" misclassification)
  if (
    lowerError.includes('api key') ||
    lowerError.includes('unauthorized') ||
    lowerError.includes('authentication')
  ) {
    return 'auth_error';
  }

  // Workspace / configuration errors (narrowed to workspace-specific phrases)
  if (
    lowerError.includes('core directory') ||
    lowerError.includes('library isn\'t set up') ||
    (lowerError.includes('not accessible') && lowerError.includes('directory'))
  ) {
    return 'workspace_error';
  }

  // Context overflow (Anthropic + non-Claude provider phrasings for multi-model turns)
  if (
    (lowerError.includes('context') && (lowerError.includes('overflow') || lowerError.includes('too long') || lowerError.includes('length'))) ||
    (lowerError.includes('token') && (lowerError.includes('exceed') || lowerError.includes('maximum')))
  ) {
    return 'context_overflow';
  }

  // Invalid request (user needs to rephrase or fix input)
  if (
    lowerError.includes('request was invalid') ||
    lowerError.includes('invalid request')
  ) {
    return 'invalid_request';
  }

  // API / server errors (transient) — match service-specific signals and
  // our own user-friendly error phrases from turnErrorRecovery + friendlyErrors.
  // Anchor phrases here are coupled to humanizer copy via
  // rebel-system/skills/ux/error-copy/SKILL.md § Classifier-substring coupling.
  if (
    lowerError.includes('api service') ||
    lowerError.includes('ai service') ||
    lowerError.includes('server error') ||
    lowerError.includes('something went wrong') ||
    lowerError.includes('something went sideways') ||
    lowerError.includes('something unexpected') ||
    lowerError.includes('rough patch') ||
    lowerError.includes('mid-conversation') ||
    lowerError.includes('mid-thought') ||
    lowerError.includes('hit a snag') ||
    lowerError.includes('took too long to respond') ||
    lowerError.includes('multi-model setup') ||
    lowerError.includes('having a moment') ||
    // humanizeProviderServerError variants (server_error → api_error via structural map)
    lowerError.includes('had a moment') ||
    lowerError.includes('response stalled and timed out') ||
    lowerError.includes('temporary hiccup') ||
    lowerError.includes("couldn't reach the internet") ||
    // Network humanizer phrases from friendlyErrors.ts (humanizeError)
    lowerError.includes('taking longer than usual') ||
    lowerError.includes('trouble connecting') ||
    lowerError.includes('connection dropped mid-sentence') ||
    lowerError.includes('network just stepped out')
  ) {
    return 'api_error';
  }

  // Tool connection errors (from turnErrorRecovery process exit handling)
  if (
    lowerError.includes('tool connection dropped') ||
    lowerError.includes('caused a hiccup')
  ) {
    return 'mcp_error';
  }

  return 'unknown';
};

/**
 * Build the Sentry `fingerprint` tuple for a renderer-side AgentSessionError capture.
 *
 * Policy summary (see the App.tsx capture useEffect for the live call site):
 *  - `errorCategory` is the primary discriminator; well-grouped Sentry issues stay grouped.
 *  - When present, `structuralKind` (an {@link AgentErrorKind}) is added as a secondary
 *    discriminator so historical catch-all buckets (e.g. REBEL-T4's coarse `api_error`)
 *    split into per-kind issues for triage.
 *  - The `'unknown'` branch is checked first. When a MEANINGFUL `structuralKind` is
 *    present (i.e. not the literal `'unknown'` kind), use it as the tertiary
 *    discriminator (`['AgentSessionError','unknown', structuralKind]`) so
 *    kind-present unknown events coalesce structurally instead of fragmenting on
 *    volatile message text (REBEL-T4 secondary-structural-discriminator template).
 *    Otherwise (absent `structuralKind`, or `structuralKind === 'unknown'`), preserve
 *    the 80-char message-prefix fallback — that polymorphic bucket still benefits from
 *    message-level granularity (the kind is still surfaced via `extra` on the capture
 *    when present, see the App.tsx capture useEffect).
 *  - When `structuralKind` is absent and the category is non-`unknown`, the original
 *    2-tuple is preserved — no regression, no orphan singletons.
 *
 * Pure function; safe to unit-test directly.
 */
export function buildAgentSessionErrorFingerprint(input: {
  errorCategory: SessionErrorCategory;
  structuralKind: AgentErrorKind | undefined;
  lowerError: string;
}): string[] {
  const { errorCategory, structuralKind, lowerError } = input;
  if (errorCategory === 'unknown') {
    if (structuralKind && structuralKind !== 'unknown') {
      return ['AgentSessionError', 'unknown', structuralKind];
    }
    return ['AgentSessionError', 'unknown', lowerError.slice(0, 80)];
  }
  if (structuralKind) {
    return ['AgentSessionError', errorCategory, structuralKind];
  }
  return ['AgentSessionError', errorCategory];
}
