/**
 * Friendly Error Messages
 *
 * Transform technical error messages into user-friendly copy.
 *
 * Design principles:
 * - Never expose error codes to users
 * - Frame issues as temporary and recoverable
 * - Reassure that work is not lost
 * - Use calm, confident tone
 */

import type { AgentErrorKind } from './agentErrorCatalog';
import { categoryForKind } from './classifyErrorUx';

/**
 * Error message for when Anthropic's third-party OAuth block is detected.
 * Since April 2026, Anthropic blocks all third-party apps from using Claude subscription
 * OAuth tokens. The 429 response looks like a normal rate limit but is actually permanent.
 * Detection: rate_limit error + Claude OAuth auth (not OpenRouter) + no API key configured.
 */
export const CLAUDE_MAX_BLOCKED_ERROR = "Your Claude subscription login is restricted by Anthropic for third-party apps. Add an API key to continue.";

/**
 * Check if an error message indicates a rate limit, including non-standard
 * phrasings from the API (e.g. "Taking a quick breather").
 * Used across main process detection points to ensure consistent handling.
 */
export const isRateLimitMessage = (msg: string): boolean => {
  const lower = msg.toLowerCase();
  return (
    lower.includes('rate_limit') ||
    lower.includes('rate limit') ||
    lower.includes('429') ||
    lower.includes('too many requests') ||
    lower.includes('taking a quick breather') ||
    lower.includes('hit your limit') ||
    lower.includes('usage limit') ||
    lower.includes('resource_exhausted')
  );
};

const isProviderRoutingUnavailableError = (lower: string): boolean => (
  lower.includes('no endpoints') &&
  (lower.includes('provider.only') || lower.includes('provider')) &&
  // Exclude OpenRouter cache_control errors — those are handled by proxy retry,
  // not provider routing constraints. Without this exclusion, the 'provider' substring
  // in docs URLs within cache_control error bodies causes false matches.
  !lower.includes('cache_control') &&
  !lower.includes('automatic caching')
);

export type BillingSubtype =
  | 'credits'
  | 'key_limit'
  | 'spend_limit'
  | 'free_tier_exhausted'
  | 'negative_balance'
  | 'unknown';

/**
 * Check if an error message indicates a billing or credit issue.
 * These errors won't resolve with retries or model switching — the user
 * needs to fix their account (add credits, upgrade plan, etc.).
 *
 * Canonical source of raw billing-message patterns for classification and transience checks. Used by:
 * - modelErrors.ts classifyStatus() — to classify 400 billing errors
 * - isTransientError() below — to exclude billing from transient retry
 */
export const isBillingMessage = (msg: string): boolean => {
  const lower = msg.toLowerCase();
  return (
    lower.includes('credit balance') ||
    lower.includes('insufficient credit') ||
    lower.includes('billing error') ||
    lower.includes('insufficient_quota') ||
    // OpenRouter billing/credit patterns (402/403 responses).
    // These indicate the user needs to add credits or raise limits — non-retryable.
    lower.includes('more credits') ||
    lower.includes('can only afford') ||
    lower.includes('key limit') ||
    lower.includes('daily limit') ||
    lower.includes('monthly limit') ||
    // OpenAI bare-quota / plan-and-billing patterns (429 insufficient_quota body).
    // The OpenAI 429 body for a depleted plan reads literally:
    //   "You exceeded your current quota, please check your plan and billing details."
    // Before these patterns landed, the error fell through to the generic `exceed`
    // substring branch in humanizeError and was mis-copy'd as "That request was
    // too large." See conversation 82d61626-3d3c-4ea2-b369-f2ec7c9531de and
    // docs/plans/260421_classification_driven_error_humanizer.md (Stage 3).
    //
    // False-positive discipline: these substrings MUST NOT collide with
    // `isRateLimitMessage` (which uses `rate_limit`, `rate limit`, `429`, etc.).
    // `deriveErrorKind` in agentEventDispatcher runs `isBillingMessage` BEFORE
    // `isRateLimitMessage`, so any false positive here would silently misclassify
    // rate-limit errors as billing — see the explicit negative test matrix in
    // friendlyErrors.test.ts.
    lower.includes('exceeded your current quota') ||
    lower.includes('check your plan and billing') ||
    // Bare `quota` with billing-adjacent context. Keeps the predicate resilient
    // to future OpenAI phrasings ("your quota for this plan", etc.) WITHOUT
    // matching Google Gemini's canonical 429 format:
    //   "Quota exceeded for quota metric '<...>/generate_content_requests' and
    //    limit '<GenerateContent requests per minute>' ..."
    // which is a RATE LIMIT, not billing — the `per minute` / `per second` /
    // `per hour` phrasing marks it. Deliberately NO bare `quota exceeded`
    // substring: that regressed Google rate-limit to never-retry billing.
    // See Stage 3 Round 1 review (Opus 88% / Gemini 85% / GPT5.4 93% convergent).
    (lower.includes('quota') &&
      (lower.includes('plan') ||
        lower.includes('billing') ||
        lower.includes('credit') ||
        lower.includes('payment') ||
        lower.includes('account')) &&
      // Extra belt-and-braces guard: if the message ALSO contains "per minute" /
      // "per second" / "per hour" / "per day" quota-window phrasing, it's a
      // rate limit even if a billing-adjacent token happens to co-occur (e.g.,
      // "Quota exceeded for quota metric 'requests per minute' — check your
      // plan" would otherwise slip through).
      !(
        lower.includes('per minute') ||
        lower.includes('per second') ||
        lower.includes('per hour') ||
        lower.includes('per day')
      ))
  );
};

export const classifyBillingSubtype = (
  rawMessage: string,
  opts?: { modelId?: string },
): BillingSubtype => {
  const msg = rawMessage.toLowerCase();
  if (msg.includes('negative balance') || /balance[^a-z]+-\d/i.test(rawMessage)) return 'negative_balance';
  // Spend-cap / key-limit conditions MUST be tested BEFORE the generic credits
  // branch. OpenRouter's period spend-cap 402 body reads e.g. "This request
  // requires more credits, or fewer max_tokens … but can only afford N … create
  // a key with a higher monthly limit" — it contains BOTH affordability phrasing
  // AND the cap marker. The user has credit; they merely hit a per-key spending
  // cap, so it should surface as a spend/key-limit ("raise your limit"), NOT
  // "out of credits". Checking credits first collapsed both into the credits
  // copy (REBEL-5YW). See docs/plans/260419_openrouter_credits_error_ux.md.
  if (msg.includes('daily limit') || msg.includes('monthly limit') || msg.includes('key limit')) {
    return 'key_limit';
  }
  if (msg.includes('api usage limits') || msg.includes('spending limit')) {
    return 'spend_limit';
  }
  // Genuine zero-/low-credit conditions. Tightened to the affordability /
  // explicit-credit-balance phrasings rather than a bare `credits` substring:
  // the bare substring matched spend-cap messages that merely mention credits
  // (handled above) and any URL like .../settings/credits.
  if (
    msg.includes('more credits') ||
    msg.includes('can only afford') ||
    msg.includes('credit balance') ||
    msg.includes('insufficient credit')
  ) {
    return 'credits';
  }
  if (opts?.modelId?.includes(':free')) return 'free_tier_exhausted';
  return 'unknown';
};

/**
 * Check if an error message indicates a genuine authentication/credential
 * rejection (invalid/revoked key or OAuth token), as opposed to a billing,
 * quota, or moderation rejection.
 *
 * Conservative by design: keyed on positive auth markers, NOT on bare status
 * codes or the loose `api key` substring (which co-occurs with "api key not
 * configured" workspace-setup copy). Used by:
 * - modelErrors.ts classifyStatus() — to carve genuine-auth 403s out of the
 *   403→billing default so they reach the re-authenticate UX (REBEL-66J/65G).
 *   OpenRouter returns `403 "Invalid authentication"` / `"No auth credentials
 *   found"` for a revoked/invalid key; OpenAI uses `"Invalid API key"` /
 *   `"invalid x-api-key"` / `"authentication_error"`.
 *
 * False-positive discipline: these markers MUST NOT collide with genuine
 * billing-403 shapes ("Account suspended for non-payment", "insufficient
 * credits") so the existing 403→billing regression tests stay green.
 */
export const isAuthErrorMessage = (msg: string): boolean => {
  const lower = msg.toLowerCase();
  return (
    lower.includes('invalid authentication') ||
    lower.includes('no auth credentials') ||
    lower.includes('invalid api key') ||
    lower.includes('invalid x-api-key') ||
    lower.includes('invalid_api_key') ||
    lower.includes('authentication_error') ||
    lower.includes('authentication failed') ||
    lower.includes('unauthorized')
  );
};

export const isModerationMessage = (msg: string): boolean => {
  const lower = msg.toLowerCase();
  return (
    lower.includes('moderation') ||
    lower.includes('flagged') ||
    lower.includes('safety filter')
  );
};

/**
 * Check if an error is a network/connection-level failure where switching
 * providers cannot help (the user's connection is down, not the provider).
 * Used by turnErrorRecovery to bypass alt-model fallback for network errors.
 *
 * This is a SUBSET of isTransientError() — all network errors are transient,
 * but not all transient errors are network errors. The distinction matters
 * for routing: network errors skip alt-model fallback (switching providers
 * is useless when connectivity is down) and get longer backoff delays.
 */
export const isNetworkError = (error: string): boolean => {
  const lower = error.toLowerCase();
  if (isProviderRoutingUnavailableError(lower)) {
    return false;
  }

  return (
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('enetunreach') ||
    lower.includes('ehostunreach') ||
    lower.includes('epipe') ||
    lower.includes('und_err_socket') ||
    lower.includes('und_err_connect_timeout') ||
    lower.includes('connecttimeouterror') ||
    lower.includes('connect timeout error') ||
    lower.includes('socket hang up') ||
    lower.includes('network error') ||
    // Anthropic SDK's APIConnectionError default message when HTTP request fails entirely
    lower === 'connection error.' ||
    lower === 'fetch failed' ||
    lower.includes('typeerror: fetch failed')
  );
};

/**
 * Extract a retry-after duration in milliseconds from error text.
 * Handles simple relative durations like "retry after 30 seconds", "try again in 5 minutes",
 * "wait 60 seconds". Returns undefined if no parseable duration is found.
 *
 * Used for apiRateLimitCooldown accuracy only — NOT for UI display.
 */
export const extractRetryAfterMs = (text: string): number | undefined => {
  if (!text) return undefined;
  const lower = text.toLowerCase();

  // Match patterns like "retry after 30 seconds", "try again in 5 minutes", "wait 60 seconds"
  const match = lower.match(
    /(?:retry\s+after|try\s+again\s+in|wait(?:\s+for)?)\s+(\d+)\s*(seconds?|minutes?|mins?|secs?|s|m)\b/
  );
  if (!match) return undefined;

  const value = parseInt(match[1], 10);
  if (isNaN(value) || value <= 0) return undefined;

  const unit = match[2];
  if (unit.startsWith('m')) {
    return value * 60 * 1000;
  }
  // Default to seconds
  return value * 1000;
};

/**
 * Transform a technical error message into user-friendly copy.
 * The original error should still be logged for debugging.
 *
 * @deprecated Prefer `humanizeAgentError({kind: 'classified' | 'unclassified', ...})`
 * from `@rebel/shared` (`./humanizeAgentError`). `humanizeError` is retained for
 * backward compatibility and as the internal delegation target for the
 * `unclassified` / `unknown` branch of the new humanizer — do not add new call
 * sites. See docs/plans/260421_classification_driven_error_humanizer.md.
 */
export const humanizeProviderServerError = (provider?: string): string => {
  const providerLower = provider?.toLowerCase() ?? '';
  if (providerLower.includes('openai') || providerLower.includes('codex')) {
    return 'OpenAI Codex had a moment. Retry — your work so far is saved.';
  }
  if (providerLower.includes('anthropic')) {
    return 'Anthropic had a moment. Retry — your work so far is saved.';
  }
  return 'The model service had a moment. Retry — your work so far is saved.';
};

export const humanizeNetworkError = (): string =>
  "Can't reach the AI service. Rebel got as far as your network and stopped — usually a connection issue on this device (a dropped wifi, a VPN, or a protective corporate network). Your message is safe.";

export const humanizeError = (error: string, options?: { provider?: string; errorKind?: string }): string => {
  if (options?.errorKind === 'network') {
    return humanizeNetworkError();
  }
  if (options?.errorKind === 'server_error') {
    return humanizeProviderServerError(options.provider);
  }

  // Strip internal sentinel prefixes that should never reach users.
  // These are used for control flow in agentTurnExecutor and should be
  // caught by their respective handlers, but sanitize as a safety net.
  const sanitized = error
    .replace(/^SERVER_ERROR_RETRY:\s*/i, '')
    .replace(/^RATE_LIMIT_RETRY:\s*/i, '')
    .replace(/^SESSION_NOT_FOUND_RETRY:\s*/i, '')
    .replace(/^API_ERROR_INTERCEPT:\s*/i, '')
    .replace(/^TOOL_NAME_CORRUPT_RETRY:\s*/i, '');
  const lower = sanitized.toLowerCase();

  // Network/Connection errors
  if (lower.includes('etimedout') || lower.includes('timeout')) {
    return "This is taking longer than usual. Still on it.";
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('econnreset') ||
    lower.includes('enetunreach') ||
    lower.includes('ehostunreach')
  ) {
    return 'Having trouble connecting — your message is safe.';
  }
  if (lower.includes('socket hang up') || lower.includes('network error')) {
    return 'Connection dropped mid-sentence. Reconnecting...';
  }
  if (lower.includes('eai_again')) {
    return 'The network just stepped out. Retrying in a moment.';
  }
  // Node.js TypeError: fetch failed — bare network failure (DNS, TLS, connection dropped)
  if (lower === 'fetch failed' || lower.includes('typeerror: fetch failed')) {
    return 'Having trouble connecting — your message is safe.';
  }
  // Anthropic SDK APIConnectionError default message — HTTP request failed entirely
  if (lower === 'connection error.') {
    return 'Having trouble connecting — your message is safe.';
  }

  // OpenRouter provider routing failures (provider.only constraints)
  if (isProviderRoutingUnavailableError(lower)) {
    return "This model isn't available from our preferred providers right now. Try a different model, or try again later.";
  }

  if (isModerationMessage(sanitized)) {
    return "Your message was flagged by the model's safety filter. Try rephrasing — a less direct framing or more context usually helps.";
  }

  // Billing/Credits - user-actionable, not bugs (MUST be before 429 check)
  // These indicate the user needs to add funds or fix their billing.
  // Note: isBillingMessage() is the canonical predicate for classification/retry,
  // but humanization uses explicit patterns for different user-facing copy.
  if (
    lower.includes('credit balance') ||
    lower.includes('insufficient credit') ||
    lower.includes('billing error') ||
    lower.includes('more credits') ||
    lower.includes('can only afford')
  ) {
    return "Your API account needs billing attention. Add credits at your provider's console. If you're using OpenRouter, you can also set up auto top-up to avoid running out.";
  }

  // Quota/limit exhaustion — different from rate limiting (MUST be before 429 check)
  // Key limits, daily/monthly limits, plan quotas: the user hit a usage cap that may reset.
  if (lower.includes('insufficient_quota') || lower.includes('quota exceeded') ||
      lower.includes('key limit') || lower.includes('daily limit') ||
      lower.includes('monthly limit')) {
    return "You've reached your usage limit. Check your plan or billing details, or wait for the limit to reset.";
  }

  // API spend limits - user-configured monthly cap in Anthropic Console (MUST be before 429 check)
  // Different from rate limits (429) or credit balance issues - this is a budget cap
  if (lower.includes('api usage limits')) {
    // Try to extract the reset date from the error message
    const limitMatch = sanitized.match(/regain access .*?(\d{4}-\d{2}-\d{2})/i);
    const dateHint = limitMatch ? ` You'll regain access on ${limitMatch[1]} (UTC).` : '';
    return `You've reached your API spending limit.${dateHint} Raise your limit at console.anthropic.com.`;
  }

  // OpenAI invalid_request_error about missing tool output — proxy/SDK conversation
  // assembly bug. Must be before generic 500/api_error checks since these errors
  // arrive wrapped in 500 JSON responses.
  if (lower.includes('no tool output found') || lower.includes('tool_use_id')) {
    return 'Something went wrong mid-conversation. Your work so far is saved — send your message again to pick up where I left off.';
  }

  // API errors
  if (lower.includes('503') || lower.includes('502') || lower.includes('529') || lower.includes('overloaded')) {
    return "The AI service is momentarily busy. Hold tight — retrying.";
  }
  if (lower.includes('504')) {
    return 'That took longer than the model was prepared to wait. Going around again...';
  }

  // 500 / API errors — compound matching to avoid "500 words" false positives
  if (lower.includes('internal server error') || lower.includes('api_error') ||
      (lower.includes('500') && (lower.includes('"type":"error"') || lower.includes('api error')))) {
    return "The AI service had a hiccup. Your message is safe — try again.";
  }

  // Empty response anomaly — API returned 200 but no content (MUST be before 429 check
  // because the error text often contains "possible rate limit")
  if (lower.includes('200 ok') && lower.includes('empty')) {
    return 'The AI returned empty pages — try again, your message is safe.';
  }

  if (isRateLimitMessage(sanitized)) {
    const isOpenAI = options?.provider && /openai|chatgpt|codex/i.test(options.provider);
    return isOpenAI
      ? "Your AI provider's rate limit was reached. OpenAI limits reset on a rolling window that can take up to a few hours — try again later or switch to a backup provider."
      : "Your AI provider's rate limit was reached. This usually resets within a few minutes — try again shortly.";
  }
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return "There's an issue with your API key. Hop into Settings to update it.";
  }
  if (lower.includes('api key')) {
    return "Something's off with your API key. Check Settings.";
  }

  // Context/size errors (should be rare - compaction handles most)
  // "context reduction is suggested" is Anthropic's alternative phrasing for context overflow.
  // `length` / `window` / `too long` catch variants like "maximum context length exceeded" and
  // "your input exceeds the model's context window" so they are humanized as context overflow
  // (the correct "too long — let me summarize" UX) rather than falling through to the generic
  // size-overflow branch below. See docs/plans/260421_classification_driven_error_humanizer.md.
  if (
    lower.includes('context') &&
    (lower.includes('overflow') ||
      lower.includes('limit') ||
      lower.includes('reduction') ||
      lower.includes('length') ||
      lower.includes('window') ||
      lower.includes('too long'))
  ) {
    return 'This conversation got too long. Let me summarize and continue.';
  }
  // Narrowed from bare `exceed` to protect unmigrated callers from false-
  // positives (e.g. OpenAI "exceeded your current quota" / "exceeded your spending limit"
  // are billing errors, not size overflows). The `exceed` branch now requires co-occurrence
  // with an explicit size-ish qualifier. `limit` was deliberately EXCLUDED from the qualifier
  // set because it matches billing phrases ("spending limit", "monthly limit"); context-window
  // phrasings go through the context branch above. Bare `too large` / `too long` are kept
  // as direct matches (they almost always indicate a size overflow in practice, and the
  // target bug was in the broader `exceed` chain, not in these shorter substrings). See
  // docs/plans/260421_classification_driven_error_humanizer.md.
  if (
    lower.includes('too large') ||
    lower.includes('too long') ||
    (lower.includes('exceed') &&
      (lower.includes('request') ||
        lower.includes('prompt') ||
        lower.includes('token') ||
        lower.includes('size')))
  ) {
    return 'That request was too large. Try breaking it into smaller parts.';
  }

  // Configuration errors
  if (lower.includes('core directory')) {
    return "Your Library isn't set up yet. Hop into Settings and we'll have one in a moment.";
  }
  if (lower.includes('not configured')) {
    return 'A few settings are still blank. Open Settings to fill them in.';
  }

  // Model endpoint incompatibility (REBEL-1D9: BYOK users configuring non-chat models,
  // e.g. gpt-5.5-pro, hit the chat/completions endpoint and get a 404).
  if (lower.includes('not a chat model') || (lower.includes('not supported') && lower.includes('chat/completions'))) {
    return "This model isn't built for chat. Pick a different model in Settings.";
  }

  // Process spawn errors (REBEL-P8: e.g., EBADF from port conflicts, ENOENT from missing binaries)
  if (lower.includes('spawn') && /\b(ebadf|enoent|eacces|emfile|enfile|eperm)\b/i.test(sanitized)) {
    return "Something went wrong starting the AI agent. Try a restart, or check Settings → Diagnose for details.";
  }

  // File descriptor exhaustion / local file access pressure.
  // These can surface as raw Node/Electron errors like:
  // - "EMFILE: too many open files, open '...'"
  // - "ENFILE: file table overflow"
  if (/\b(emfile|enfile)\b/i.test(sanitized) || lower.includes('too many open files')) {
    return "Rebel ran out of file handles. Restart Rebel. If it keeps happening, restart your computer. If it still keeps happening, send diagnostics so we can investigate. Your files are still there.";
  }

  // SDK stream-lifecycle errors — the API connected but the stream dropped before
  // completing (e.g. "request ended without sending any chunks", "stream ended
  // without producing a Message", "stream has ended", "stream closed").
  // Catch the whole category rather than individual messages.
  if (
    (lower.includes('stream') || lower.includes('request')) &&
    (lower.includes('ended without') || lower.includes('has ended'))
  ) {
    return 'The connection was interrupted mid-thought — try again, your message is safe.';
  }

  // MCP/Tool errors
  if (lower.includes('mcp') && lower.includes('race')) {
    return 'Two tools tried to talk at once — try again.';
  }
  if (lower.includes('stream closed')) {
    return 'The connection was interrupted mid-thought — try again, your message is safe.';
  }

  // Empty result anomaly - API returned tokens but no content.
  // Note: turnErrorRecovery does NOT retry this — it uses graceful degradation
  // to recover from accumulated content instead.
  if (lower.includes('empty_result_anomaly')) {
    return 'The response was interrupted — your work is saved.';
  }

  // Legacy "encountered an error" messages (from older builds or cached sessions)
  // that still contain model names. Strip them to something user-friendly.
  if (lower.includes('encountered an error')) {
    return 'The AI service ran into trouble. Your message is safe — try again.';
  }

  // Model not found — user has an invalid model configured
  if (lower.includes('not_found_error') && lower.includes('model')) {
    const modelMatch = sanitized.match(/model:\s*([^\s"'}]+)/);
    const modelName = modelMatch?.[1] || 'the configured model';
    return `The model '${modelName}' wasn't found. Open Settings → Models to pick a different one, or turn off Plan Mode to keep going.`;
  }

  // Detect API error format and strip JSON before showing to users
  const apiErrorMatch = sanitized.match(/^API Error: \d+/);
  if (apiErrorMatch) {
    return "The AI service ran into trouble. Your message is safe — try again.";
  }

  // If the error contains JSON objects, don't show raw JSON to users
  if (sanitized.includes('{"type"') || sanitized.includes('"error":{')) {
    return "Something went sideways. Your message is safe — try again, or check Settings → Diagnose.";
  }

  // Generic fallback - show the actual error so users can report it
  return sanitized;
};

/**
 * Check if an error is transient and should trigger silent retry.
 * Billing/quota errors are NOT transient - they won't resolve with retries.
 */
export type TransientErrorFallbackLogger = {
  info: (bindings: Record<string, unknown>, message: string) => void;
};

export const isTransientError = (
  error: string,
  kind?: AgentErrorKind,
  options?: { logger?: TransientErrorFallbackLogger },
): boolean => {
  if (kind && kind !== 'unknown') {
    return categoryForKind(kind) === 'transient';
  }

  const lower = error.toLowerCase();

  // Billing/quota/spend-limit errors are NOT transient - don't retry, user needs to fix.
  // Core billing patterns via shared isBillingMessage(); api usage limits is supplementary.
  if (isBillingMessage(error) || lower.includes('api usage limits')) {
    logTransientErrorSubstringFallback(error, kind, false, options?.logger);
    return false;
  }

  if (isProviderRoutingUnavailableError(lower)) {
    logTransientErrorSubstringFallback(error, kind, false, options?.logger);
    return false;
  }

  const matched = (
    lower.includes('etimedout') ||
    // Connection-timeout MESSAGES (in addition to the Node `etimedout` code above).
    // The Anthropic SDK governs the executor->localhost-proxy hop; a connection
    // timeout there throws APIConnectionTimeoutError with message 'Request timed
    // out.' (no `ETIMEDOUT` code), and other transports surface "Connection timed
    // out" / "Connection timeout". A timeout is inherently retryable. This is
    // narrow by construction in TWO ways: (1) the billing/quota (`isBillingMessage`
    // + `api usage limits`) and provider-routing guards run BEFORE this block and
    // return early, so a non-retryable error that merely mentions a timeout stays
    // non-transient; (2) we match 'timed out' and the QUALIFIED phrase 'connection
    // timeout' — NOT the bare word 'timeout' — so a generic, contextless 'timeout'
    // stays unclassified (unknown). That preserves the network-transport
    // lossy-collapse guard ("keeps bare timeout unclassified") in modelErrors.test.ts.
    // Mirrors the humanizeError() network branch which already treats connection
    // timeouts as a "still on it" condition. See docs/plans/260621_ws4-transport-rewrite
    // (WS4 Component 2 — the confirmed turn-hang trap).
    lower.includes('timed out') ||
    lower.includes('connection timeout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eai_again') ||
    lower.includes('enetunreach') ||
    lower.includes('ehostunreach') ||
    lower.includes('epipe') ||
    lower.includes('und_err_socket') ||
    lower.includes('und_err_connect_timeout') ||
    lower.includes('connecttimeouterror') ||
    lower.includes('connect timeout error') ||
    lower.includes('socket hang up') ||
    lower.includes('network error') ||
    // Anthropic SDK's APIConnectionError default message when HTTP request fails entirely
    lower === 'connection error.' ||
    lower === 'fetch failed' ||
    lower.includes('typeerror: fetch failed') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('504') ||
    lower.includes('529') ||
    lower.includes('overloaded') ||
    lower.includes('429') ||
    // SDK stream-lifecycle errors: catch the whole category of stream/request
    // drop errors rather than individual messages from the SDK.
    ((lower.includes('stream') || lower.includes('request')) &&
      (lower.includes('ended without') || lower.includes('has ended'))) ||
    lower.includes('empty_result_anomaly') ||
    lower.includes('internal server error') ||
    lower.includes('api_error') ||
    (lower.includes('200 ok') && lower.includes('empty')) ||
    // OpenAI Responses API: server-side termination of a response mid-stream.
    // Retryable — the model was interrupted, not permanently broken.
    lower === 'terminated'
  );

  logTransientErrorSubstringFallback(error, kind, matched, options?.logger);
  return matched;
};

const logTransientErrorSubstringFallback = (
  error: string,
  kind: AgentErrorKind | undefined,
  matchedTransient: boolean,
  logger: TransientErrorFallbackLogger | undefined,
): void => {
  if (!logger) {
    return;
  }

  try {
    logger.info(
      {
        errorKind: kind ?? 'omitted',
        matchedTransient,
        errorMessage: error,
      },
      'isTransientError substring fallback used'
    );
  } catch {
    // Observability must not affect retry classification.
  }
};

/**
 * Check if an error should suppress the error banner during silent retry.
 * These are errors we're confident will resolve with retry.
 */
export const shouldSuppressErrorDuringRetry = (error: string): boolean => {
  // TODO(FOX-3267 Stage 4): Keep this substring-only for this PR; migrate it
  // to the kind-first classifier in docs/plans/260514_fox-3267_actionable_error_ux_and_kind_first_classifier.md.
  const lower = error.toLowerCase();
  return (
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('eai_again') ||
    lower.includes('enetunreach') ||
    lower.includes('ehostunreach') ||
    lower.includes('socket hang up') ||
    // Anthropic SDK's APIConnectionError default message
    lower === 'connection error.' ||
    lower === 'fetch failed' ||
    lower.includes('typeerror: fetch failed') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('529') ||
    lower.includes('overloaded') ||
    // SDK stream-lifecycle errors (connection dropped before completing)
    ((lower.includes('stream') || lower.includes('request')) &&
      (lower.includes('ended without') || lower.includes('has ended'))) ||
    lower.includes('empty_result_anomaly') ||
    lower.includes('internal server error') ||
    lower.includes('api_error')
  );
};
