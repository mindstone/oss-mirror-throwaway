/**
 * Anthropic-compatible local-proxy BTS transport.
 *
 * Extracted verbatim from `behindTheScenesClient.ts` in Stage 7. Raw Anthropic
 * passthrough through the localhost proxy. BTS `role=bts` routing never
 * naturally selects this transport (Google profiles route to
 * openai-compatible-http per providerRouting.ts), so it is exercised only via a
 * synthetic dispatch decision in the parity test. It classifies 4xx via
 * `classifyHttpError` and does NOT route through `parseJsonResponseBody` (a
 * dormant pre-`parseJsonResponseBody` passthrough).
 *
 * Stage 10: cooldown is now enforced at the DISPATCH layer for every transport,
 * including this dormant one — so it attaches a typed rate-limit cooldown signal
 * on a classified 429 (and dispatch records success after it resolves) exactly
 * like the live transports. Its prior `recordsCooldown:false` exception is gone.
 */
import { classifyHttpError } from '@core/rebelCore/modelErrors';
import { assertWireSafeForAlwaysOnThinking } from '@core/rebelCore/alwaysOnThinkingWireSafety';
import type { ProviderRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { attachCooldownRateLimitSignal } from '../cooldown';
import {
  type BehindTheScenesResponse,
  type WireSafeBtsOptions,
  BTS_DEFAULT_TIMEOUT_MS,
  headersRecord,
  makeTimeoutSignal,
  parseRetryAfterHeader,
} from './shared';
import type { BtsTransportAdapter } from './types';

export async function callViaAnthropicCompatibleProxy(
  plan: ProviderRoutePlan,
  options: WireSafeBtsOptions,
): Promise<BehindTheScenesResponse> {
  const proxyUrl = plan.proxyBaseURL;
  const headers = headersRecord(plan.headers);
  const proxyAuth = headers['x-proxy-auth'];
  if (!proxyUrl || !proxyAuth) {
    throw new Error(
      'Anthropic-compatible proxy not available for background task. ' +
      `proxyUrl=${proxyUrl ? 'set' : 'missing'}, proxyAuth=${proxyAuth ? 'set' : 'missing'}`
    );
  }

  const body: Record<string, unknown> = {
    model: plan.decision.wireModelId,
    max_tokens: options.maxTokens ?? 512,
    messages: options.messages,
  };

  if (options.system) {
    body.system = options.system;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (options.outputFormat) {
    body.output_format = options.outputFormat;
  }

  // Runtime backstop behind the WireSafeBtsOptions brand: throws in dev/test,
  // captures + strips in prod.
  assertWireSafeForAlwaysOnThinking(plan.decision.wireModelId, body, 'bts.anthropic-compatible-proxy');

  const { signal, timeoutId } = makeTimeoutSignal(options, BTS_DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const classifiedError = classifyHttpError(response.status, errorText, 'Anthropic-compatible proxy');
      if (classifiedError.kind === 'rate_limit') {
        // Stage 10: parse retry-after here, attach as a typed signal; the dispatch
        // layer does the `cooldown.recordRateLimit` call (now covers this transport).
        const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
        attachCooldownRateLimitSignal(classifiedError, { retryAfterMs, provider: 'Anthropic-compatible proxy', route: 'proxy' });
      }
      throw classifiedError;
    }

    // Stage 10: success is recorded by the dispatch layer after this resolves.
    const data = await response.json();
    return {
      content: data?.content ?? [],
      model: data?.model ?? plan.decision.wireModelId,
      usage: data?.usage,
      ...(typeof data?.stop_reason === 'string' ? { _stopReason: data.stop_reason } : {}),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export const anthropicCompatibleProxyAdapter: BtsTransportAdapter = {
  transport: 'anthropic-compatible-local-proxy',
  requiredBehaviors: {
    // Stage 10: cooldown recording moved to the DISPATCH layer, so this dormant
    // transport is now covered like every other — it emits a cooldown signal
    // (attachCooldownRateLimitSignal on a 429) and dispatch records. The prior
    // `recordsCooldown:false` exception is resolved (asserted by the symmetry
    // script's dispatch-coverage check, not deleted silently).
    recordsCooldown: true,
    guardsSseViaParseJson: false,
    classifiesHttpErrors: true,
    propagatesOutputFormat: true,
    sentryViaCaptureKnownConditionOnly: true,
    // Dormant raw-Anthropic passthrough returns content verbatim and is never
    // selected by live BTS routing — no reasoning extraction, no transient-retry
    // wrap (proxy paths delegate transient retry to the local proxy).
    extractsReasoningContent: false,
    wrapsTransientRetry: false,
    requiresWireSafeOptions: true,
    notes: 'guardsSseViaParseJson / extractsReasoningContent / wrapsTransientRetry=false: dormant raw-Anthropic passthrough never selected by live BTS routing; returns content verbatim and delegates transient retry to the local proxy. recordsCooldown=true: cooldown is recorded at the dispatch layer (Stage 10) for every transport including this one.',
  },
  execute: ({ plan, options }) => callViaAnthropicCompatibleProxy(plan, options),
};
