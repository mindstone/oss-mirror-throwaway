import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT_ERROR_KINDS, type AgentErrorKind } from '../agentErrorCatalog';
import { CLAUDE_MAX_BLOCKED_ERROR, humanizeError } from '../friendlyErrors';
import {
  __clearHumanizerFailureObserverForTests,
  CALLER_OVERRIDE_KINDS,
  HUMANIZER_OWNED_KINDS,
  HUMANIZER_SAFE_FALLBACK,
  humanizeAgentError,
  humanizeStructuredOutputSchemaRejection,
  setHumanizerFailureObserver,
  type HumanizerFailureReport,
  type ManagedModelNotAllowedMeta,
} from '../humanizeAgentError';

afterEach(() => {
  __clearHumanizerFailureObserverForTests();
  vi.restoreAllMocks();
});

describe('humanizeAgentError — alignment & partition', () => {
  it('HUMANIZER_OWNED_KINDS ∪ CALLER_OVERRIDE_KINDS covers every AgentErrorKind', () => {
    for (const kind of AGENT_ERROR_KINDS) {
      const owned = HUMANIZER_OWNED_KINDS.has(kind);
      const override = CALLER_OVERRIDE_KINDS.has(kind);
      expect(
        owned || override,
        `AgentErrorKind '${kind}' missing from both allow-lists — add it to HUMANIZER_OWNED_KINDS or CALLER_OVERRIDE_KINDS in humanizeAgentError.ts`,
      ).toBe(true);
    }
  });

  it('no AgentErrorKind appears in both partitions', () => {
    for (const kind of AGENT_ERROR_KINDS) {
      const owned = HUMANIZER_OWNED_KINDS.has(kind);
      const override = CALLER_OVERRIDE_KINDS.has(kind);
      expect(owned && override, `AgentErrorKind '${kind}' is in BOTH partitions`).toBe(false);
    }
  });

  it('partitions contain only valid AgentErrorKinds', () => {
    const valid = new Set<string>(AGENT_ERROR_KINDS);
    for (const kind of HUMANIZER_OWNED_KINDS) {
      expect(valid.has(kind), `HUMANIZER_OWNED_KINDS contains invalid kind '${kind}'`).toBe(true);
    }
    for (const kind of CALLER_OVERRIDE_KINDS) {
      expect(valid.has(kind), `CALLER_OVERRIDE_KINDS contains invalid kind '${kind}'`).toBe(true);
    }
  });
});

describe('humanizeAgentError — HUMANIZER_OWNED_KINDS (classified branch)', () => {
  describe('billing', () => {
    it('regression: OpenAI insufficient_quota produces correct usage-limit copy (conversation 82d61626)', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenAI',
        rawMessage:
          'You exceeded your current quota, please check your plan and billing details.',
      });
      expect(result).toContain("You've reached your OpenAI usage limit");
      expect(result).not.toContain('too large');
    });

    it('uses billingMeta.subtype credits copy with OpenRouter auto-topup hint', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenRouter',
        rawMessage: 'More credits required',
        billingMeta: { subtype: 'credits' },
      });
      expect(result).toBe(
        'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
      );
    });

    it('formats upstream provider as "OpenRouter (via Anthropic)"', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenRouter',
        rawMessage: 'Credit balance is too low',
        billingMeta: { subtype: 'credits', upstreamProviderName: 'anthropic' },
      });
      expect(result).toBe(
        'Your OpenRouter (via Anthropic) account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
      );
    });

    it('key_limit subtype copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenRouter',
        rawMessage: 'Key limit exceeded (daily limit)',
        billingMeta: { subtype: 'key_limit' },
      });
      expect(result).toContain("You've reached your OpenRouter daily/monthly limit");
    });

    it('spend_limit subtype copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'Anthropic',
        rawMessage: 'spending limit reached',
        billingMeta: { subtype: 'spend_limit' },
      });
      expect(result).toBe("You've hit your Anthropic spending limit.");
    });

    it('free_tier_exhausted subtype copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenRouter',
        rawMessage: 'Free-tier exhausted',
        billingMeta: { subtype: 'free_tier_exhausted' },
      });
      expect(result).toContain("exhausted today's free-tier allowance on OpenRouter");
    });

    it('negative_balance subtype copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenRouter',
        rawMessage: 'negative balance of -$0.01',
        billingMeta: { subtype: 'negative_balance' },
      });
      expect(result).toContain('has a negative balance');
    });

    it('unknown subtype with quota wording → "usage limit" copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenAI',
        rawMessage: 'Your quota is exhausted for this billing period',
        billingMeta: { subtype: 'unknown' },
      });
      expect(result).toContain("You've reached your OpenAI usage limit");
    });

    it('unknown subtype with spending-limit wording → "spending limit" copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'Anthropic',
        rawMessage: 'spending limit hit for the month',
        billingMeta: { subtype: 'unknown' },
      });
      expect(result).toContain("hit your Anthropic spending limit");
    });

    it('derives subtype from rawMessage when billingMeta is absent', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenRouter',
        rawMessage:
          '402 {"error":{"message":"This request requires more credits, or fewer max_tokens.","code":402}}',
      });
      expect(result).toContain('has run out of credits');
    });

    it('empty rawMessage + known billing kind → non-empty provider-aware copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenAI',
        rawMessage: '',
      });
      expect(result).not.toBe('');
      expect(result).toMatch(/OpenAI/);
    });

    it('unknown provider + billing kind falls back to generic copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        rawMessage: 'Insufficient credit',
      });
      expect(result).toContain('billing attention');
    });

    it('Google provider + billing gets usage-limit copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'Google',
        rawMessage: 'quota exhausted',
      });
      expect(result).toContain('Google');
    });

    it('plan-scoped billing uses subscription-plan copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        rawMessage: 'usage_limit_reached',
        provider: 'OpenAI',
        limitScope: 'plan',
      });
      expect(result).toBe(
        'Your subscription plan has hit its usage allowance. Switch providers in Settings, or try again when it resets.',
      );
    });

    it('Cerebras provider + billing gets provider-aware copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'Cerebras',
        rawMessage: 'billing issue',
      });
      expect(result).toContain('Cerebras');
    });

    it('Together provider + billing gets provider-aware copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'Together',
        rawMessage: 'billing issue',
      });
      expect(result).toContain('Together');
    });

    // Stage E3 (plan 260513a § E3) — managed-subscription branch. When the
    // failing turn routed through Mindstone's managed key, billing copy must
    // suppress BYOK-only guidance (auto top-up hints, "add credits at your
    // provider's console") and surface the BYOK overflow path instead. All
    // subtypes collapse to the same managed copy because the user's actionable
    // lever is the same regardless of subtype.
    describe('managed subscription (Stage E3)', () => {
      const MANAGED_COPY_WITH_DATE =
        "You've used your monthly Mindstone AI allowance. It resets on June 1, 2026. To keep working until then, switch to your own OpenRouter or Anthropic key.";
      const MANAGED_COPY_NO_DATE =
        "You've used your monthly Mindstone AI allowance. To keep working, switch to your own OpenRouter or Anthropic key.";

      for (const subtype of [
        'credits',
        'spend_limit',
        'key_limit',
        'free_tier_exhausted',
        'negative_balance',
        'unknown',
      ] as const) {
        it(`dash tier × ${subtype} subtype includes reset date when resetsAt is valid`, () => {
          const result = humanizeAgentError({
            kind: 'classified',
            errorKind: 'billing',
            provider: 'OpenRouter',
            rawMessage: 'managed-key 402 body',
            billingMeta: {
              subtype,
              managedSubscription: {
                tier: 'dash',
                resetsAt: '2026-06-01T00:00:00.000Z',
              },
            },
          });
          expect(result).toBe(MANAGED_COPY_WITH_DATE);
        });

        it(`rogue tier × ${subtype} subtype drops reset-date sentence when resetsAt is missing`, () => {
          const result = humanizeAgentError({
            kind: 'classified',
            errorKind: 'billing',
            provider: 'OpenRouter',
            rawMessage: 'managed-key 402 body',
            billingMeta: {
              subtype,
              managedSubscription: { tier: 'rogue' },
            },
          });
          expect(result).toBe(MANAGED_COPY_NO_DATE);
        });
      }

      it('drops the reset-date sentence when resetsAt is invalid', () => {
        const result = humanizeAgentError({
          kind: 'classified',
          errorKind: 'billing',
          provider: 'OpenRouter',
          rawMessage: 'managed-key 402 body',
          billingMeta: {
            subtype: 'credits',
            managedSubscription: {
              tier: 'dash',
              resetsAt: 'not-a-date',
            },
          },
        });
        expect(result).toBe(MANAGED_COPY_NO_DATE);
      });

      it('suppresses the OpenRouter auto-top-up hint that BYOK billing copy emits', () => {
        const result = humanizeAgentError({
          kind: 'classified',
          errorKind: 'billing',
          provider: 'OpenRouter',
          rawMessage: 'managed-key 402 body',
          billingMeta: {
            subtype: 'credits',
            managedSubscription: { tier: 'dash' },
          },
        });
        expect(result).not.toContain('auto top-up');
        expect(result).not.toContain('OpenRouter settings');
      });

      it('does NOT trigger the managed branch when managedSubscription is absent (BYOK path unchanged)', () => {
        const result = humanizeAgentError({
          kind: 'classified',
          errorKind: 'billing',
          provider: 'OpenRouter',
          rawMessage: 'BYOK 402 body',
          billingMeta: { subtype: 'credits' },
        });
        expect(result).toBe(
          'Your OpenRouter account has run out of credits. You can set up auto top-up in your OpenRouter settings to avoid this.',
        );
      });

      it('takes precedence over the no-provider fallback branch', () => {
        // Even if `provider` is missing (e.g. pre-classification persisted
        // event), the managed branch still fires when billingMeta carries the
        // managedSubscription signal. This guards against a regression where
        // the no-provider early return swallows the managed signal.
        const result = humanizeAgentError({
          kind: 'classified',
          errorKind: 'billing',
          rawMessage: 'managed-key 402 body',
          billingMeta: {
            subtype: 'credits',
            managedSubscription: { tier: 'dash' },
          },
        });
        expect(result).toBe(MANAGED_COPY_NO_DATE);
      });

      it('does not include subtype-specific phrasing (subtypes collapse to one copy)', () => {
        // Smoke test: the managed copy should not leak BYOK-subtype-specific
        // strings like "daily/monthly limit" (key_limit), "negative balance"
        // (negative_balance), "free-tier allowance" (free_tier_exhausted),
        // because they are subtype-conditional guidance that the user can't
        // act on for a company-owned managed key.
        const result = humanizeAgentError({
          kind: 'classified',
          errorKind: 'billing',
          provider: 'OpenRouter',
          rawMessage: 'managed-key 402 body',
          billingMeta: {
            subtype: 'key_limit',
            managedSubscription: { tier: 'dash' },
          },
        });
        expect(result).not.toContain('daily/monthly limit');
        expect(result).not.toContain('negative balance');
        expect(result).not.toContain('free-tier');
        expect(result).toContain('Mindstone AI allowance');
      });
    });
  });

  describe('rate_limit', () => {
    it('OpenAI provider gets "can take a while" hint', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'rate_limit',
        provider: 'OpenAI',
        rawMessage: 'Rate limit exceeded',
      });
      expect(result).toContain('few hours');
      expect(result).not.toContain('few minutes');
    });

    it('Codex provider gets "can take a while" hint', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'rate_limit',
        provider: 'Codex',
        rawMessage: 'Rate limit hit',
      });
      expect(result).toContain('few hours');
    });

    it('ChatGPT Pro provider gets "can take a while" hint', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'rate_limit',
        provider: 'ChatGPT Pro',
        rawMessage: 'Rate limit hit',
      });
      expect(result).toContain('few hours');
    });

    it('Anthropic provider gets "few minutes" hint', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'rate_limit',
        provider: 'Anthropic',
        rawMessage: 'Rate limit hit',
      });
      expect(result).toContain('few minutes');
    });

    it('missing provider falls back to "few minutes" copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'rate_limit',
        rawMessage: 'Rate limit exceeded',
      });
      expect(result).toContain('few minutes');
    });

    it('plan-scoped rate_limit uses subscription-window copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'rate_limit',
        rawMessage: 'usage_limit_reached',
        provider: 'OpenAI',
        limitScope: 'plan',
      });
      expect(result).toBe(
        'Your subscription has hit its usage window. Try again when it resets, or switch providers in Settings.',
      );
    });
  });

  describe('auth', () => {
    it('returns API-key settings copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'auth',
        rawMessage: 'invalid_api_key',
      });
      expect(result).toBe("There's an issue with your API key. Hop into Settings to update it.");
    });

    it('preserves CLAUDE_MAX_BLOCKED_ERROR when present in rawMessage', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'auth',
        rawMessage: CLAUDE_MAX_BLOCKED_ERROR,
      });
      expect(result).toBe(CLAUDE_MAX_BLOCKED_ERROR);
    });
  });

  describe('connection-not-configured', () => {
    it('preserves reconnect guidance exactly', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'connection-not-configured',
        rawMessage: 'Reconnect OpenRouter to use this model',
      });
      expect(result).toBe('Reconnect OpenRouter to use this model');
    });
  });

  describe('moderation', () => {
    it('returns safety-filter rephrase copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'moderation',
        rawMessage: 'Input flagged by safety filter',
      });
      expect(result).toContain("safety filter");
      expect(result).toContain('rephrasing');
    });
  });

  describe('server_error / invalid_request', () => {
    it('server_error returns provider-aware retry copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'server_error',
        rawMessage: 'Internal server error',
        provider: 'OpenAI (Codex)',
      });
      expect(result).toBe('OpenAI Codex had a moment. Retry — your work so far is saved.');
    });

    it('network returns static connection copy without raw transport detail', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'network',
        rawMessage: 'UND_ERR_CONNECT_TIMEOUT chatgpt.com 2606:4700::1',
      });

      expect(result).toContain("Can't reach the AI service.");
      expect(result).not.toContain('UND_ERR_CONNECT_TIMEOUT');
      expect(result).not.toContain('chatgpt.com');
      expect(result).not.toContain('2606:4700::1');
    });

    it('invalid_request returns "message is safe" copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'invalid_request',
        rawMessage: 'Bad request',
      });
      expect(result).toContain('message is safe');
    });
  });

  describe('humanizeStructuredOutputSchemaRejection (planner schema rejection)', () => {
    it('produces brand-voiced copy reassuring the user message is safe', () => {
      const result = humanizeStructuredOutputSchemaRejection();
      expect(result).toContain('Plan mode hit an internal error');
      expect(result).toContain('message is safe');
      expect(result).toContain('try again');
      expect(result.toLowerCase()).not.toContain('your fault');
    });

    it('returns deterministic copy across calls', () => {
      const a = humanizeStructuredOutputSchemaRejection();
      const b = humanizeStructuredOutputSchemaRejection();
      expect(a).toBe(b);
    });
  });

  describe('routing', () => {
    // F2 (plan 260422_routing_followups_mock_and_kind): 'routing' is a
    // first-class AgentErrorKind distinct from 'invalid_request'. The kind is
    // stamped by `createDirectAnthropicClient`'s R2 dialect assertion and the
    // `rebelCoreQuery` defense-in-depth guard; sub-cause lives on the error
    // object's `__routingCause` side-channel.
    it('returns routing copy that reassures the message is safe', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'routing',
        rawMessage:
          'createDirectAnthropicClient received non-native model ID "anthropic/claude-opus-4.7"',
      });
      expect(result).toContain('routing your request');
      expect(result).toContain('message is safe');
      expect(result).toContain('Settings');
    });

    it('returns the same copy regardless of provider context', () => {
      // Routing errors are about our internal provider/transport mismatch — the
      // copy does not embed any provider name, so swapping providers is a no-op.
      const a = humanizeAgentError({
        kind: 'classified',
        errorKind: 'routing',
        provider: 'OpenAI',
        rawMessage: 'slash-dialect leaked',
      });
      const b = humanizeAgentError({
        kind: 'classified',
        errorKind: 'routing',
        provider: 'Anthropic',
        rawMessage: 'slash-dialect leaked',
      });
      expect(a).toBe(b);
    });
  });

  describe('context_overflow', () => {
    it('returns "summarize and continue" copy', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'context_overflow',
        rawMessage: 'context reduction is suggested',
      });
      expect(result).toContain('conversation got too long');
    });
  });

  describe('model_unavailable', () => {
    it('extracts model name from rawMessage when present', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'model_unavailable',
        rawMessage: '{"type":"not_found_error","message":"model: anthropic/claude-opus-4.6"}',
      });
      expect(result).toContain("model 'anthropic/claude-opus-4.6' wasn't found");
      expect(result).toContain('Settings → Models');
    });

    it('falls back to generic copy when model name is absent', () => {
      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'model_unavailable',
        rawMessage: 'Unknown model',
      });
      expect(result).toContain('different model');
      expect(result).toContain('Settings');
    });

    // Phase 7 R1 regression (GPT5.4 Final Review): Stage 6 re-humanizes at the
    // renderer/cloud-client layer by passing ev.error (already humanized by
    // dispatcher Stage 2) back through humanizeAgentError. For this kind, the
    // dispatcher's output carries the model name in the form `model 'X'`
    // (quoted), not the raw `model: X` pattern. Re-humanization MUST be
    // idempotent — losing the model name is a user-visible regression.
    it('is idempotent when run on already-humanized output (preserves model name)', () => {
      const firstPass = humanizeAgentError({
        kind: 'classified',
        errorKind: 'model_unavailable',
        rawMessage: '{"type":"not_found_error","message":"model: anthropic/claude-opus-4.6"}',
      });
      const secondPass = humanizeAgentError({
        kind: 'classified',
        errorKind: 'model_unavailable',
        rawMessage: firstPass,
      });
      expect(secondPass).toBe(firstPass);
      expect(secondPass).toContain("model 'anthropic/claude-opus-4.6' wasn't found");
    });
  });
});

describe('humanizeAgentError — CALLER_OVERRIDE_KINDS (safe fallback)', () => {
  it('message_timeout → safe fallback', () => {
    expect(
      humanizeAgentError({
        kind: 'classified',
        errorKind: 'message_timeout',
        rawMessage: 'MessageTimeoutError: watchdog fired',
      }),
    ).toBe(HUMANIZER_SAFE_FALLBACK);
  });

  it('process_exit → safe fallback', () => {
    expect(
      humanizeAgentError({
        kind: 'classified',
        errorKind: 'process_exit',
        rawMessage: 'process exited with code 1',
      }),
    ).toBe(HUMANIZER_SAFE_FALLBACK);
  });

  it('mcp_error → safe fallback', () => {
    expect(
      humanizeAgentError({
        kind: 'classified',
        errorKind: 'mcp_error',
        rawMessage: 'MCP transport error',
      }),
    ).toBe(HUMANIZER_SAFE_FALLBACK);
  });

  it('session_not_found → safe fallback', () => {
    expect(
      humanizeAgentError({
        kind: 'classified',
        errorKind: 'session_not_found',
        rawMessage: 'SESSION_NOT_FOUND_RETRY: xyz',
      }),
    ).toBe(HUMANIZER_SAFE_FALLBACK);
  });

  it('tool_name_corrupt → safe fallback', () => {
    expect(
      humanizeAgentError({
        kind: 'classified',
        errorKind: 'tool_name_corrupt',
        rawMessage: 'Tool name contains invalid characters',
      }),
    ).toBe(HUMANIZER_SAFE_FALLBACK);
  });

  it('user_action → safe fallback', () => {
    expect(
      humanizeAgentError({
        kind: 'classified',
        errorKind: 'user_action',
        rawMessage: 'User cancelled',
      }),
    ).toBe(HUMANIZER_SAFE_FALLBACK);
  });

  it('classified + errorKind=unknown delegates to the legacy humanizer', () => {
    const raw = 'ETIMEDOUT connection timeout';
    expect(
      humanizeAgentError({
        kind: 'classified',
        errorKind: 'unknown',
        rawMessage: raw,
      }),
    ).toBe(humanizeError(raw));
  });
});

describe('humanizeAgentError — unclassified branch', () => {
  it('delegates to legacy humanizeError for known patterns', () => {
    const raw = 'ETIMEDOUT connection timeout';
    expect(humanizeAgentError({ kind: 'unclassified', rawMessage: raw })).toBe(
      humanizeError(raw),
    );
  });

  it('passes provider through to the legacy humanizer (OpenAI rate-limit)', () => {
    const raw = 'HTTP 429 - Rate limit exceeded';
    const result = humanizeAgentError({
      kind: 'unclassified',
      rawMessage: raw,
      provider: 'OpenAI',
    });
    expect(result).toContain('few hours');
  });

  it('empty rawMessage → safe fallback (never empty string)', () => {
    expect(humanizeAgentError({ kind: 'unclassified', rawMessage: '' })).toBe(
      HUMANIZER_SAFE_FALLBACK,
    );
  });

  it('OpenAI bare-quota message (bug regression, unclassified path)', () => {
    const result = humanizeAgentError({
      kind: 'unclassified',
      rawMessage:
        'You exceeded your current quota, please check your plan and billing details.',
    });
    // After Stage 1 `exceed` narrowing, this no longer matches "too large".
    expect(result).not.toContain('too large');
  });
});

describe('humanizeAgentError — safety / try-catch fallback', () => {
  it('returns the safe fallback when an internal branch throws', () => {
    // Monkey-patch capitalizeFirst (via formatProviderLabel) to blow up.
    // Easiest angle: pass a custom Set-like billingMeta where accessing .subtype throws.
    const poison = new Proxy(
      { subtype: 'credits' as const },
      {
        get() {
          throw new Error('boom');
        },
      },
    );

    const observed: HumanizerFailureReport[] = [];
    setHumanizerFailureObserver((report) => {
      observed.push(report);
    });

    const result = humanizeAgentError({
      kind: 'classified',
      errorKind: 'billing',
      provider: 'OpenAI',
      rawMessage: 'boom',
      billingMeta: poison as unknown as { subtype: 'credits' },
    });

    expect(result).toBe(HUMANIZER_SAFE_FALLBACK);
    expect(observed).toHaveLength(1);
    expect(observed[0].inputKind).toBe('classified');
    expect(observed[0].errorKind).toBe('billing');
    expect(observed[0].err).toBeInstanceOf(Error);
  });

  it('does not throw when the observer itself throws', () => {
    setHumanizerFailureObserver(() => {
      throw new Error('observer boom');
    });

    const poison = new Proxy(
      { subtype: 'credits' as const },
      {
        get() {
          throw new Error('branch boom');
        },
      },
    );

    expect(() =>
      humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenAI',
        rawMessage: 'boom',
        billingMeta: poison as unknown as { subtype: 'credits' },
      }),
    ).not.toThrow();
  });

  it('logs a last-ditch console.warn when no observer is wired', () => {
    // Regression guard (v2 Round 2 / GPT-5.5 M): the observer-failure path must not be
    // fully silent. When no observer has been wired yet (early startup), the humanizer
    // emits a `console.warn` so the failure is discoverable in stdout / devtools.
    __clearHumanizerFailureObserverForTests();

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const poison = new Proxy(
        { subtype: 'credits' as const },
        {
          get() {
            throw new Error('branch boom');
          },
        },
      );

      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenAI',
        rawMessage: 'boom',
        billingMeta: poison as unknown as { subtype: 'credits' },
      });

      expect(result).toBe(HUMANIZER_SAFE_FALLBACK);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [tag, payload] = warnSpy.mock.calls[0];
      expect(tag).toContain('humanizeAgentError');
      expect(payload).toMatchObject({ inputKind: 'classified', errorKind: 'billing' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('logs a last-ditch console.warn when the observer itself throws', () => {
    // The observer is wired but throws. We must not propagate the throw, AND we must
    // emit a console.warn so the observer-failure path is discoverable.
    setHumanizerFailureObserver(() => {
      throw new Error('observer boom');
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const poison = new Proxy(
        { subtype: 'credits' as const },
        {
          get() {
            throw new Error('branch boom');
          },
        },
      );

      const result = humanizeAgentError({
        kind: 'classified',
        errorKind: 'billing',
        provider: 'OpenAI',
        rawMessage: 'boom',
        billingMeta: poison as unknown as { subtype: 'credits' },
      });

      expect(result).toBe(HUMANIZER_SAFE_FALLBACK);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [tag, payload] = warnSpy.mock.calls[0];
      expect(tag).toContain('observer threw');
      expect(payload).toMatchObject({ inputKind: 'classified' });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never returns an empty string', () => {
    const cases: Array<{ input: Parameters<typeof humanizeAgentError>[0]; label: string }> = [
      { label: 'empty unclassified', input: { kind: 'unclassified', rawMessage: '' } },
      {
        label: 'empty classified auth',
        input: { kind: 'classified', errorKind: 'auth', rawMessage: '' },
      },
      {
        label: 'empty classified billing',
        input: {
          kind: 'classified',
          errorKind: 'billing',
          provider: 'OpenAI',
          rawMessage: '',
        },
      },
    ];
    for (const { label, input } of cases) {
      const result = humanizeAgentError(input);
      expect(result, `case: ${label}`).not.toBe('');
      expect(result.length, `case: ${label}`).toBeGreaterThan(0);
    }
  });
});

describe('humanizeError legacy narrowing (exceed branch)', () => {
  it('bare "You exceeded your quota" no longer matches "too large"', () => {
    const result = humanizeError('You exceeded your quota');
    expect(result).not.toContain('too large');
  });

  it('bare "exceed" without size-qualifier does not match "too large"', () => {
    const result = humanizeError('You have exceeded the value you provided');
    expect(result).not.toContain('too large');
  });

  it('"Prompt too long: exceeded max prompt tokens" still matches "too large"', () => {
    const result = humanizeError('Prompt too long: exceeded max prompt tokens by 1500');
    expect(result).toContain('That request was too large');
  });

  it('"too large" alone still matches', () => {
    const result = humanizeError('Request is too large to process');
    expect(result).toContain('That request was too large');
  });

  it('"too long" alone still matches', () => {
    const result = humanizeError('Prompt too long');
    expect(result).toContain('That request was too large');
  });

  it('"exceeded request limit" still matches (exceed + request)', () => {
    const result = humanizeError('You have exceeded the request size limit');
    expect(result).toContain('That request was too large');
  });

  it('"exceeded token limit" still matches (exceed + token)', () => {
    const result = humanizeError('You have exceeded the token limit');
    expect(result).toContain('That request was too large');
  });

  it('regression: OpenAI insufficient_quota via humanizeAgentError unclassified path does NOT say "too large"', () => {
    const raw =
      'You exceeded your current quota, please check your plan and billing details.';
    const result = humanizeAgentError({ kind: 'unclassified', rawMessage: raw });
    // Stage 1 goal: kill the false-positive "too large" routing. The
    // unclassified path now falls through to the generic fallback — Stage 3
    // extends `isBillingMessage` so the classified path produces the correct
    // billing/usage-limit copy.
    expect(result).not.toContain('too large');
  });
});

describe('AgentErrorKind enumeration — representative case per kind', () => {
  // Minimal smoke coverage per-kind so any newly added kind that isn't
  // handled in switch/override logic is caught by the alignment test above
  // and by these per-kind smoke tests.
  const cases: Array<{ kind: AgentErrorKind; expectation: (s: string) => void }> = [
    {
      kind: 'rate_limit',
      expectation: (s) => expect(s).toContain("rate limit"),
    },
    {
      kind: 'auth',
      expectation: (s) => expect(s).toContain('API key'),
    },
    {
      kind: 'connection-not-configured',
      expectation: (s) => expect(s).toBe('representative raw'),
    },
    {
      kind: 'billing',
      expectation: (s) => expect(s).toMatch(/billing|credit|usage|spending/i),
    },
    {
      kind: 'moderation',
      expectation: (s) => expect(s).toContain('safety filter'),
    },
    {
      kind: 'server_error',
      expectation: (s) => expect(s).toContain('had a moment'),
    },
    {
      kind: 'network',
      expectation: (s) => expect(s).toContain("Can't reach the AI service"),
    },
    {
      kind: 'invalid_request',
      expectation: (s) => expect(s).toContain('message is safe'),
    },
    {
      kind: 'routing',
      expectation: (s) => expect(s).toContain('routing your request'),
    },
    {
      kind: 'context_overflow',
      expectation: (s) => expect(s).toContain('too long'),
    },
    {
      kind: 'model_unavailable',
      expectation: (s) => expect(s).toMatch(/model|Settings/),
    },
    {
      kind: 'unsupported_model',
      expectation: (s) => expect(s).toMatch(/subscription|supported model|Settings/),
    },
    {
      kind: 'image_input_unsupported',
      // Leads with switch-model (DA F2, 260610): a tool-result image is baked
      // into history, so retry/remove-attachment can't fix it.
      expectation: (s) => expect(s).toMatch(/can't view images.*vision-capable/i),
    },
    {
      kind: 'session_not_found',
      expectation: (s) => expect(s).toBe(HUMANIZER_SAFE_FALLBACK),
    },
    {
      kind: 'tool_name_corrupt',
      expectation: (s) => expect(s).toBe(HUMANIZER_SAFE_FALLBACK),
    },
    {
      kind: 'process_exit',
      expectation: (s) => expect(s).toBe(HUMANIZER_SAFE_FALLBACK),
    },
    {
      kind: 'mcp_error',
      expectation: (s) => expect(s).toBe(HUMANIZER_SAFE_FALLBACK),
    },
    {
      kind: 'message_timeout',
      expectation: (s) => expect(s).toBe(HUMANIZER_SAFE_FALLBACK),
    },
    {
      kind: 'user_action',
      expectation: (s) => expect(s).toBe(HUMANIZER_SAFE_FALLBACK),
    },
  ];

  for (const { kind, expectation } of cases) {
    it(`handles errorKind='${kind}' without throwing`, () => {
      const out = humanizeAgentError({
        kind: 'classified',
        errorKind: kind,
        rawMessage: 'representative raw',
        provider: 'OpenAI',
      });
      expect(out).toBeTypeOf('string');
      expect(out.length).toBeGreaterThan(0);
      expectation(out);
    });
  }

  it("handles errorKind='unknown' by delegating to legacy humanizer", () => {
    const raw = 'ETIMEDOUT';
    const out = humanizeAgentError({
      kind: 'classified',
      errorKind: 'unknown',
      rawMessage: raw,
    });
    expect(out).toBe(humanizeError(raw));
  });
});

// ---------------------------------------------------------------------------
// Re-humanization idempotency invariant (Phase 7 Final Review, plan 260421).
//
// Stage 6 of plan 260421 introduced re-humanization at the renderer
// (src/renderer/App.tsx) and cloud-client (cloud-client/src/hooks/useAgentTurn.ts):
// when `ev.errorKind ∈ HUMANIZER_OWNED_KINDS`, the already-humanized
// `ev.error` is fed BACK through `humanizeAgentError` with the same structured
// metadata (billingMeta, rateLimitMeta, provider, upstreamProviderName).
//
// For that design to be safe, every kind in HUMANIZER_OWNED_KINDS MUST produce
// identical output when run on its own output — humanize(humanize(x)) === humanize(x).
// Phase 7 Final Review (GPT5.4) caught a latent break in `model_unavailable`
// where the extractor regex couldn't parse the humanized form's `model 'X'`
// and fell back to generic copy, silently dropping the model name.
//
// These tests enumerate HUMANIZER_OWNED_KINDS from the source of truth
// (not a hardcoded list) so any future kind added to the set is forced to
// declare a representative idempotency sample below, or the test fails
// loudly with a clear error.
// ---------------------------------------------------------------------------

describe('humanizeAgentError — re-humanization idempotency invariant (HUMANIZER_OWNED_KINDS)', () => {
  // One OR MORE samples per owned kind. Inputs match the renderer's real call
  // shape: structured metadata is preserved across both passes (as it is in
  // AgentEvent); only `rawMessage` varies (raw upstream → already-humanized).
  //
  // Multi-sample coverage MATTERS for kinds whose per-branch logic differs
  // (notably `billing`: explicit-subtype branches produce fixed copy, but the
  // `subtype: 'unknown'` / no-billingMeta fallback runs a rawMessage-substring
  // classifier and is the original v1-bug-class code path — idempotency there
  // is accidental, not structural, and must be explicitly guarded).
  type Sample = {
    rawMessage: string;
    extra?: Partial<{
      provider: string;
      upstreamProviderName: string;
      billingMeta: {
        subtype:
          | 'credits'
          | 'negative_balance'
          | 'key_limit'
          | 'spend_limit'
          | 'free_tier_exhausted'
          | 'unknown';
        upstreamProviderName?: string;
        managedSubscription?: { tier: string; resetsAt?: string };
      };
      rateLimitMeta: { retryAfterMs?: number };
      managedModelMeta: ManagedModelNotAllowedMeta;
    }>;
    note?: string;
  };

  const samples: Partial<Record<AgentErrorKind, Sample | Sample[]>> = {
    billing: [
      {
        rawMessage: 'Your credit balance is too low to access the Anthropic API.',
        extra: {
          provider: 'Anthropic',
          billingMeta: { subtype: 'credits' },
        },
        note: 'explicit subtype — fixed-copy branch',
      },
      {
        // Exact v1-bug-class input: OpenAI insufficient_quota / raw substring
        // routing via the `unknown` subtype default branch. Idempotency here
        // depends on the humanized output ("usage limit") still matching the
        // same substring branch on the second pass.
        rawMessage:
          'You exceeded your current quota, please check your plan and billing details.',
        extra: {
          provider: 'OpenAI',
          billingMeta: { subtype: 'unknown' },
        },
        note: 'unknown subtype → rawMessage-substring classifier (v1 bug class)',
      },
      {
        // No billingMeta at all — dispatcher didn't attach metadata. The
        // humanizer runs classifyBillingSubtype(rawMessage) first pass,
        // then re-runs on humanized text second pass. Accidental idempotency
        // via the 'credits' substring overlap.
        rawMessage: 'Your credit balance is too low.',
        extra: { provider: 'Anthropic' },
        note: 'no billingMeta → classifyBillingSubtype fallback',
      },
      {
        // Stage E3 — managed-subscription branch. Idempotency here is
        // structural (not substring-accidental): the managed branch is the
        // first conditional in humanizeBilling, gated on
        // `billingMeta.managedSubscription.tier`, so both passes route
        // through `humanizeManagedBilling()` regardless of the rawMessage
        // shape.
        rawMessage: 'managed-key 402 body',
        extra: {
          provider: 'OpenRouter',
          billingMeta: {
            subtype: 'credits',
            managedSubscription: { tier: 'dash' },
          },
        },
        note: 'managed subscription branch (Stage E3) — structural idempotency',
      },
    ],
    rate_limit: {
      rawMessage: '429 Too Many Requests',
      extra: { provider: 'OpenAI' },
    },
    auth: [
      {
        rawMessage: 'Invalid API key',
        note: 'generic API-key auth',
      },
      {
        // CLAUDE_MAX_BLOCKED_ERROR sub-path — different code branch in
        // humanizeAuth. Its output must contain the sentinel so that the
        // second pass still routes through the same branch.
        rawMessage:
          'This account has been restricted by Anthropic for third-party tool use',
        note: 'Claude-Max OAuth-blocked sentinel',
      },
    ],
    'connection-not-configured': {
      rawMessage: 'Reconnect OpenRouter to use this model',
    },
    moderation: {
      rawMessage: 'Content flagged by safety filter',
    },
    server_error: {
      rawMessage: '500 Internal Server Error',
    },
    network: {
      rawMessage: 'TypeError: fetch failed',
    },
    invalid_request: {
      rawMessage: '400 Bad Request',
    },
    context_overflow: {
      rawMessage: 'prompt is too long',
    },
    model_unavailable: {
      rawMessage:
        '{"type":"not_found_error","message":"model: anthropic/claude-opus-4.6"}',
    },
    unsupported_model: {
      rawMessage: 'ChatGPT Pro does not support gpt-5.5-pro',
    },
    image_input_unsupported: {
      // The literal OpenRouter 404 body from the 260610 incident. Constant
      // copy (rawMessage-independent) -> structural idempotency.
      rawMessage:
        '{"error":{"message":"No endpoints found that support image input","code":404}}',
    },
    routing: {
      rawMessage: 'routing failure',
    },
    managed_model_not_allowed: [
      {
        rawMessage:
          '{"code":"MANAGED_MODEL_NOT_ALLOWED","model":"openai/gpt-5.5","allowed":["anthropic/claude-opus-4.6","openai/gpt-4.1"]}',
        extra: {
          managedModelMeta: {
            requested: 'openai/gpt-5.5',
            allowed: ['anthropic/claude-opus-4.6', 'openai/gpt-4.1'],
          },
        },
        note: 'with managedModelMeta.requested — model-name-aware copy branch',
      },
      {
        // managedModelMeta absent → generic-fallback branch. Idempotency here
        // is structural: both passes route through the no-requested-model
        // arm of `humanizeManagedModelNotAllowed`.
        rawMessage: 'managed model not allowed',
        note: 'no managedModelMeta → generic fallback branch',
      },
    ],
  };

  for (const kind of HUMANIZER_OWNED_KINDS) {
    const bucket = samples[kind];
    expect(
      bucket,
      `HUMANIZER_OWNED_KINDS gained '${kind}' but no idempotency sample exists in this test. Add one to the \`samples\` map above. If the kind has multiple code branches (e.g., subtype-dependent routing), declare a Sample[] covering each branch.`,
    ).toBeDefined();
    const cases = Array.isArray(bucket) ? bucket : [bucket!];
    for (let i = 0; i < cases.length; i += 1) {
      const sample = cases[i];
      const label = sample.note ? ` — ${sample.note}` : '';
      it(`is idempotent for errorKind='${kind}'${label} [sample ${i + 1}/${cases.length}]`, () => {
        const makeInput = (rawMessage: string) => ({
          kind: 'classified' as const,
          errorKind: kind,
          rawMessage,
          ...(sample.extra ?? {}),
        });
        const firstPass = humanizeAgentError(makeInput(sample.rawMessage));
        const secondPass = humanizeAgentError(makeInput(firstPass));
        expect(
          secondPass,
          `Re-humanization for '${kind}'${label} is NOT idempotent. First pass produced:\n  "${firstPass}"\nSecond pass produced:\n  "${secondPass}"\nThis means the renderer's HUMANIZER_OWNED_KINDS.has guard would silently change the user-visible copy when re-humanizing ev.error. Either make the kind's humanizer idempotent (e.g., accept both raw AND humanized forms in any regex), or move the kind to CALLER_OVERRIDE_KINDS.`,
        ).toBe(firstPass);
      });
    }
  }
});
