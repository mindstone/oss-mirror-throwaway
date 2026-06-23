import { describe, expect, it } from 'vitest';
import { humanizeAgentError, humanizeError as cloudClientHumanizeError, HUMANIZER_OWNED_KINDS } from '@rebel/shared';
import { humanizeError as desktopHumanizeError } from '@shared/utils/friendlyErrors';
import type { AgentErrorKind } from '@shared/utils/agentErrorCatalog';

const LEGACY_ERROR_PATTERNS: [RegExp, string][] = [
  [/HTTP\s+5\d\d/i, 'Rebel hit a temporary issue. Your work is saved — try again in a moment.'],
  [/HTTP\s+429/i, 'Too many requests right now. Give it a moment and try again.'],
  [/HTTP\s+401|HTTP\s+403|unauthorized|forbidden/i, 'Authentication issue. Try signing out and back in.'],
  [/network|ECONNREFUSED|ETIMEDOUT|fetch failed/i, 'Connection issue. Check your internet and try again.'],
  [/abort|cancel/i, 'Stopped.'],
];

function legacyCloudClientHumanizeError(raw: string): string {
  for (const [pattern, friendly] of LEGACY_ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return friendly;
    }
  }
  return raw;
}

const PARITY_CASES = [
  {
    name: 'OpenRouter credits copy',
    raw: '402 {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 2381. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account","code":402}}',
    expectedFragment: 'billing attention',
  },
  {
    name: 'rate limit copy',
    raw: 'HTTP 429 - Rate limit exceeded',
    expectedFragment: "provider's rate limit",
  },
  {
    name: 'API key copy',
    raw: 'HTTP 401 Unauthorized',
    expectedFragment: 'API key',
  },
  {
    name: 'network copy',
    raw: 'TypeError: fetch failed',
    expectedFragment: 'message is safe',
  },
  {
    name: 'generic 500 copy',
    raw: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_123"}',
    expectedFragment: 'hiccup',
  },
] as const;

const BILLING_ENHANCEMENT_CASES = [
  {
    name: 'more credits',
    raw: '402 {"error":{"message":"This request requires more credits. Add funds in OpenRouter.","code":402}}',
    expectedFragment: 'billing attention',
  },
  {
    name: 'can only afford',
    raw: '402 {"error":{"message":"You requested up to 128000 tokens, but can only afford 82277.","code":402}}',
    expectedFragment: 'billing attention',
  },
  {
    name: 'daily key limit',
    raw: '403 {"error":{"message":"Key limit exceeded (daily limit). Manage it using https://openrouter.ai/settings/keys","code":403}}',
    expectedFragment: 'usage limit',
  },
  {
    name: 'monthly key limit',
    raw: 'Key monthly limit exceeded. Upgrade your plan.',
    expectedFragment: 'usage limit',
  },
  {
    name: 'quota exceeded',
    raw: 'Error: insufficient_quota - you have exceeded your plan limits',
    expectedFragment: 'usage limit',
  },
] as const;

describe('useAgentTurn humanizer parity', () => {
  it.each(PARITY_CASES)('matches desktop humanizeError for $name', ({ raw, expectedFragment }) => {
    const cloudClientMessage = cloudClientHumanizeError(raw);
    const desktopMessage = desktopHumanizeError(raw);

    expect(cloudClientMessage).toBe(desktopMessage);
    expect(cloudClientMessage).toContain(expectedFragment);
  });

  it.each(BILLING_ENHANCEMENT_CASES)('replaces the legacy cloud-client fallback for $name', ({ raw, expectedFragment }) => {
    const legacyMessage = legacyCloudClientHumanizeError(raw);
    const cloudClientMessage = cloudClientHumanizeError(raw);
    const desktopMessage = desktopHumanizeError(raw);

    expect(legacyMessage).toBe(raw);
    expect(cloudClientMessage).toBe(desktopMessage);
    expect(cloudClientMessage).toContain(expectedFragment);
  });
});

// Stage 6 locks classification-first paths used by useAgentTurn's 'error' case branch.
// The hook itself passes the event's `errorKind` + `billingMeta` / `rateLimitMeta` / `provider`
// straight into `humanizeAgentError`, so we assert on the humanizer directly here —
// the hook's integration is covered by parity with the humanizer's own suite.
describe('useAgentTurn humanizer — classification-first (Stage 6)', () => {
  it('billing: OpenRouter credits subtype produces subtype-aware copy with auto top-up hint', () => {
    const copy = humanizeAgentError({
      kind: 'classified',
      errorKind: 'billing',
      rawMessage: 'credits depleted',
      provider: 'OpenRouter',
      billingMeta: { subtype: 'credits' },
    });
    expect(copy).toBe(
      'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
    );
  });

  it('billing: subtype=unknown with OpenAI quota rawMessage renders usage-limit copy', () => {
    const copy = humanizeAgentError({
      kind: 'classified',
      errorKind: 'billing',
      rawMessage: 'You exceeded your current quota, please check your plan and billing details.',
      provider: 'OpenAI',
      billingMeta: { subtype: 'unknown' },
    });
    expect(copy).toBe("You've reached your OpenAI usage limit.");
  });

  it('rate_limit: OpenAI renders the rolling-window copy with backup-provider hint', () => {
    const copy = humanizeAgentError({
      kind: 'classified',
      errorKind: 'rate_limit',
      rawMessage: 'HTTP 429 rate limited',
      provider: 'OpenAI',
    });
    expect(copy).toBe(
      "Your AI provider's rate limit was reached. OpenAI limits reset on a rolling window that can take up to a few hours — try again later or switch to a backup provider.",
    );
  });

  it('rate_limit: non-OpenAI provider renders the generic rolling-window copy', () => {
    const copy = humanizeAgentError({
      kind: 'classified',
      errorKind: 'rate_limit',
      rawMessage: 'HTTP 429 rate limited',
      provider: 'Anthropic',
    });
    expect(copy).toBe(
      "Your AI provider's rate limit was reached. This usually resets within a few minutes — try again shortly.",
    );
  });

  it('auth: renders humanizer-owned API-key copy when the dispatcher classified auth', () => {
    const copy = humanizeAgentError({
      kind: 'classified',
      errorKind: 'auth',
      rawMessage: 'HTTP 401 Unauthorized',
      provider: 'OpenAI',
    });
    expect(copy).toBe("There's an issue with your API key. Hop into Settings to update it.");
  });

  it('moderation: renders safety-filter copy regardless of raw message', () => {
    const copy = humanizeAgentError({
      kind: 'classified',
      errorKind: 'moderation',
      rawMessage: 'content policy violation',
      provider: 'OpenAI',
    });
    expect(copy).toBe(
      "Your message was flagged by the model's safety filter. Try rephrasing — a less direct framing or more context usually helps.",
    );
  });

  it('unclassified: falls back to legacy humanizeError output (parity with pre-Stage-6)', () => {
    const copy = humanizeAgentError({
      kind: 'unclassified',
      rawMessage: 'HTTP 500 Internal Server Error',
    });
    expect(copy).toBe(desktopHumanizeError('HTTP 500 Internal Server Error'));
  });
});

// Stage 6 Round 1 review blocker fix — the cloud-client case 'error' branch now
// mirrors the renderer's HUMANIZER_OWNED_KINDS.has(errorKind) gate. These tests
// simulate the hook's new branching predicate: caller-override kinds and
// unrecognized future kinds MUST NOT be re-humanized — the dispatcher's
// bespoke per-call-site copy in ev.error must pass through unchanged.
describe('useAgentTurn humanizer — HUMANIZER_OWNED_KINDS guard (Stage 6 R1 fix)', () => {
  /**
   * Inline replica of the cloud-client case 'error' branch predicate for
   * assertion. Must stay in sync with useAgentTurn.ts (CLIENT_PASSTHROUGH_ERROR_KINDS
   * + humanizeError gate). When the hook excludes more kinds from re-humanization,
   * mirror that here.
   */
  const CLIENT_PASSTHROUGH_ERROR_KINDS_FIXTURE: ReadonlySet<string> = new Set<string>([
    'auth',
    'connection-not-configured',
  ]);
  function resolveCloudClientBannerCopy(ev: {
    error?: string;
    errorKind?: AgentErrorKind | string;
    billingMeta?: { subtype?: string; upstreamProviderName?: string };
    rateLimitMeta?: unknown;
    provider?: string;
  }): string {
    const rawMessage = ev.error || 'Something went wrong';
    const canHumanize =
      ev.errorKind &&
      HUMANIZER_OWNED_KINDS.has(ev.errorKind as AgentErrorKind) &&
      !CLIENT_PASSTHROUGH_ERROR_KINDS_FIXTURE.has(ev.errorKind);
    if (canHumanize) {
      return humanizeAgentError({
        kind: 'classified',
        errorKind: ev.errorKind as AgentErrorKind,
        billingMeta: ev.billingMeta as never,
        rateLimitMeta: ev.rateLimitMeta as never,
        provider: ev.provider,
        upstreamProviderName: ev.billingMeta?.upstreamProviderName,
        rawMessage,
      });
    }
    if (ev.errorKind) {
      return rawMessage;
    }
    return humanizeAgentError({
      kind: 'unclassified',
      rawMessage,
      provider: ev.provider,
    });
  }

  it('caller-override: message_timeout preserves the dispatcher-authored bespoke copy (no safe-fallback)', () => {
    const bespokeCopy = 'Rebel was thinking for a while with no progress. Try again, or rephrase your question.';
    const copy = resolveCloudClientBannerCopy({
      error: bespokeCopy,
      errorKind: 'message_timeout',
    });
    expect(copy).toBe(bespokeCopy);
    expect(copy).not.toContain('Something went wrong — please try again.');
  });

  it('caller-override: session_not_found preserves the dispatcher-authored bespoke copy', () => {
    const bespokeCopy = 'That conversation is no longer active. Start a new one to continue.';
    const copy = resolveCloudClientBannerCopy({
      error: bespokeCopy,
      errorKind: 'session_not_found',
    });
    expect(copy).toBe(bespokeCopy);
  });

  it('caller-override: mcp_error preserves the dispatcher-authored bespoke copy', () => {
    const bespokeCopy = 'A connector failed unexpectedly. Check Settings → Connectors.';
    const copy = resolveCloudClientBannerCopy({
      error: bespokeCopy,
      errorKind: 'mcp_error',
    });
    expect(copy).toBe(bespokeCopy);
  });

  it('caller-override: tool_name_corrupt preserves the dispatcher-authored bespoke copy', () => {
    const bespokeCopy = 'The model produced a malformed tool call. Try rephrasing your request.';
    const copy = resolveCloudClientBannerCopy({
      error: bespokeCopy,
      errorKind: 'tool_name_corrupt',
    });
    expect(copy).toBe(bespokeCopy);
  });

  it('future/unknown errorKind from a newer server preserves the dispatched copy (cross-version resilience)', () => {
    // The WS payload is only JSON-parsed, not schema-validated. An older client
    // that doesn't yet know errorKind:'some_future_kind' MUST NOT silently
    // collapse to the humanizer's safe fallback — it must trust the dispatched
    // server-authored copy.
    const serverAuthored = 'A new kind of hiccup happened. Try again.';
    const copy = resolveCloudClientBannerCopy({
      error: serverAuthored,
      errorKind: 'some_future_kind_the_client_does_not_know',
    });
    expect(copy).toBe(serverAuthored);
  });

  it('classified humanizer-owned kinds still route to humanizer (positive control)', () => {
    const copy = resolveCloudClientBannerCopy({
      error: 'raw billing text',
      errorKind: 'billing',
      provider: 'OpenAI',
      billingMeta: { subtype: 'unknown' },
    });
    // Billing-unknown with "no recognizable substring" in raw message →
    // humanizeBilling's generic billing-issue copy.
    expect(copy).toContain('OpenAI');
    expect(copy).not.toBe('raw billing text');
  });

  // REBEL-526 / FOX-3182 — Mobile/cloud-client `auth` and `connection-not-configured`
  // events carry a bespoke server-authored copy (mobile-specific guidance such as
  // "Authentication failed on your paired Rebel cloud…"). The hook must NOT
  // re-humanize these via the shared humanizer, which would discard rawMessage
  // and collapse to the desktop-flavored generic "Hop into Settings" copy.
  it('auth pass-through: preserves server-authored bespoke copy (REBEL-526)', () => {
    const bespokeCopy =
      'Authentication failed on your paired Rebel cloud. Reconnect your account on your paired desktop, then try again.';
    const copy = resolveCloudClientBannerCopy({
      error: bespokeCopy,
      errorKind: 'auth',
      provider: 'Anthropic',
    });
    expect(copy).toBe(bespokeCopy);
    // Negative assertion: must not collapse to the shared humanizer's
    // generic API-key copy (which is desktop-flavored and tells mobile users
    // to "Hop into Settings", a surface that doesn't exist on mobile).
    expect(copy).not.toContain('Hop into Settings');
  });

  it('connection-not-configured pass-through: preserves server-authored copy', () => {
    const bespokeCopy =
      'No AI provider is configured on your paired Rebel cloud. Open Rebel on your desktop and connect a provider, then try again.';
    const copy = resolveCloudClientBannerCopy({
      error: bespokeCopy,
      errorKind: 'connection-not-configured',
      provider: 'OpenAI',
    });
    expect(copy).toBe(bespokeCopy);
  });

  it('auth pass-through: dispatcher-humanized rawMessage still passes through (idempotent)', () => {
    // When the dispatcher itself ran the shared humanizer (no override case),
    // the server-emitted `rawMessage` already contains the humanizer output.
    // Re-humanizing on the client would be wasteful but harmless for that case;
    // the pass-through ensures the result is identical to the server's text.
    const dispatcherCopy = "There's an issue with your API key. Hop into Settings to update it.";
    const copy = resolveCloudClientBannerCopy({
      error: dispatcherCopy,
      errorKind: 'auth',
      provider: 'Anthropic',
    });
    expect(copy).toBe(dispatcherCopy);
  });

  it('legacy unclassified (no errorKind) still routes through humanizeAgentError unclassified branch', () => {
    const copy = resolveCloudClientBannerCopy({
      error: 'HTTP 500 Internal Server Error',
    });
    // Matches Stage 1 unclassified branch output.
    expect(copy).toBe(desktopHumanizeError('HTTP 500 Internal Server Error'));
  });
});
