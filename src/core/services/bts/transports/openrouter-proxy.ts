/**
 * OpenRouter-proxy BTS transport.
 *
 * Extracted verbatim from `behindTheScenesClient.ts` in Stage 7. Routes through
 * the local proxy with OpenRouter passthrough headers; the proxy handles the
 * proxy-auth → OpenRouter-bearer swap and thinking↔reasoning translation.
 */
import { classifyHttpError } from '@core/rebelCore/modelErrors';
import { stripThinkingBlocks } from '@core/utils/stripThinkingBlocks';
import { createScopedLogger } from '@core/logger';
import { assertWireSafeForAlwaysOnThinking } from '@core/rebelCore/alwaysOnThinkingWireSafety';
import type { ProviderRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { attachCooldownRateLimitSignal } from '../cooldown';
import {
  type BehindTheScenesResponse,
  type WireSafeBtsOptions,
  BTS_DEFAULT_TIMEOUT_MS,
  extractJsonFromStructuredResponse,
  headersRecord,
  makeTimeoutSignal,
  parseJsonResponseBody,
  parseRetryAfterHeader,
  resolveBtsProxyForTransport,
} from './shared';
import type { BtsTransportAdapter } from './types';

const log = createScopedLogger({ service: 'behindTheScenesClient' });

/**
 * Reasoning model token budget constants for OpenRouter proxy path.
 * Non-Anthropic reasoning models (GLM, DeepSeek R1, etc.) include thinking
 * tokens in the max_tokens budget. BTS callers specify small budgets (64-512)
 * which get exhausted by reasoning, leaving no room for the text response.
 * Matches the inflation pattern in callDirectWithProfile.
 */
const OR_REASONING_INFLATION_FACTOR = 4;
const OR_REASONING_MIN_TOKENS = 4096;
const OR_REASONING_MAX_TOKENS = 16384;

/**
 * Route a BTS call through the local proxy with OpenRouter passthrough headers.
 * The proxy handles auth header swap (proxy-auth → OpenRouter bearer) and
 * thinking↔reasoning translation. Same timeout/signal pattern as callAnthropic.
 *
 * For non-Anthropic models, inflates max_tokens to accommodate reasoning tokens
 * that count against the budget. Also extracts text from thinking blocks as a
 * fallback when the model produces only thinking output.
 */
export async function callViaOpenRouterProxy(
  model: string,
  options: WireSafeBtsOptions,
  plan?: ProviderRoutePlan,
): Promise<BehindTheScenesResponse> {
  // When a plan is present, proxy values come from the plan and the seam is not
  // read (so a surface that always passes a plan never triggers the unwired
  // throw). Plan-less calls resolve via the hard transport-time read, which
  // throws BtsProxyNotWiredError if no surface ever wired the proxy (I6).
  const { url: resolvedUrl, auth: resolvedAuth } = plan
    ? { url: plan.proxyBaseURL, auth: undefined }
    : await resolveBtsProxyForTransport();
  const proxyUrl = resolvedUrl;
  const headers: Record<string, string> = plan
    ? headersRecord(plan.headers)
    : {
        'x-proxy-auth': resolvedAuth ?? '',
        'x-openrouter-turn': 'true',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(options.outputFormat ? { 'anthropic-beta': 'structured-outputs-2025-11-13' } : {}),
      };
  const proxyAuth = headers['x-proxy-auth'];
  if (!proxyUrl || !proxyAuth) {
    throw new Error(
      'OpenRouter proxy not available for background task. ' +
      `proxyUrl=${proxyUrl ? 'set' : 'missing'}, proxyAuth=${proxyAuth ? 'set' : 'missing'}`
    );
  }

  // Non-Anthropic models on OpenRouter may be reasoning models that include
  // thinking tokens in the max_tokens budget. Inflate to leave room for text output.
  const callerMaxTokens = options.maxTokens ?? 512;
  const isNonAnthropic = !model.startsWith('anthropic/');
  const effectiveMaxTokens = isNonAnthropic
    ? Math.min(
        Math.max(callerMaxTokens * OR_REASONING_INFLATION_FACTOR, OR_REASONING_MIN_TOKENS),
        OR_REASONING_MAX_TOKENS,
      )
    : callerMaxTokens;

  if (isNonAnthropic && effectiveMaxTokens !== callerMaxTokens) {
    log.debug(
      { model, callerMaxTokens, effectiveMaxTokens },
      'Inflated max_tokens for non-Anthropic OR model (reasoning budget)',
    );
  }

  // When structured output is requested, inject a JSON hint into the system
  // prompt for non-Anthropic models that may not honor output_format reliably.
  // Matches the pattern in callProfileHttp for profile-direct calls.
  let effectiveSystem = options.system;
  if (options.outputFormat && isNonAnthropic) {
    const allContent = [options.system ?? '', ...options.messages.map(m => m.content)].join(' ');
    if (!allContent.toLowerCase().includes('json')) {
      effectiveSystem = (effectiveSystem ?? '') + '\n\nRespond with valid JSON.';
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: effectiveMaxTokens,
    messages: options.messages,
  };

  if (effectiveSystem) {
    body.system = effectiveSystem;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  if (options.outputFormat) {
    body.output_format = options.outputFormat;
  }

  // BTS calls are always non-streaming. See docs/plans/260429_bts_sse_parsing_fix.md.
  body.stream = false;

  // Runtime backstop behind the WireSafeBtsOptions brand: throws in dev/test,
  // captures + strips in prod. OR-routed Claude models normalize inside the assert.
  assertWireSafeForAlwaysOnThinking(model, body, 'bts.openrouter-proxy');

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
      const classifiedError = classifyHttpError(response.status, errorText, 'OpenRouter');
      if (classifiedError.kind === 'rate_limit') {
        // Stage 10: parse retry-after here (transport knowledge), attach as a
        // typed signal; the dispatch layer does the `cooldown.recordRateLimit` call.
        const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
        attachCooldownRateLimitSignal(classifiedError, { retryAfterMs, provider: 'OpenRouter', route: 'proxy' });
      }
      throw classifiedError;
    }

    // Stage 10: success is recorded by the dispatch layer only AFTER this adapter
    // returns. parseJsonResponseBody throws on an SSE body BEFORE we return, so a
    // parse failure is never recorded as provider success (invariants 12/13).
    const data = (await parseJsonResponseBody(response)) as {
      content?: Array<{ type: string; text?: string; thinking?: string }>;
      model?: string;
      provider?: string;
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; cost?: number };
    };

    // Extract exact cost from OpenRouter response (non-streaming JSON includes usage.cost)
    const rawCost = data?.usage?.cost;
    const exactCost = typeof rawCost === 'number' && Number.isFinite(rawCost) && rawCost >= 0
      ? rawCost
      : undefined;

    // Extract upstream provider from proxy-injected header or response body
    const orProviderHeader = response.headers.get('x-rebel-or-provider');
    const orProviderBody = typeof data?.provider === 'string' && data.provider ? data.provider : undefined;
    const openRouterProvider = orProviderHeader || orProviderBody || undefined;

    // Normalize response content for non-Anthropic reasoning models.
    // The proxy translates OpenRouter → Anthropic format, but reasoning models
    // (e.g. MiniMax) may return thinking blocks as leading content entries or
    // embed <think>...</think> in text. BTS consumers expect clean text output.
    // This matches the normalization in callProfileHttp for profile-direct calls.
    const rawContent: Array<{ type: string; text?: string; thinking?: string }> = data?.content ?? [];
    let normalizedContent: Array<{ type: string; text?: string }>;

    if (isNonAnthropic) {
      // Extract and clean text from all text-type blocks
      const textBlocks = rawContent
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => {
          let text = stripThinkingBlocks(block.text!);
          if (options.outputFormat) {
            text = extractJsonFromStructuredResponse(text);
          }
          return { type: 'text' as const, text };
        })
        .filter(block => block.text.length > 0);

      normalizedContent = textBlocks.length > 0 ? textBlocks : rawContent;
    } else if (options.outputFormat) {
      const textBlocks = rawContent
        .filter(block => block.type === 'text' && typeof block.text === 'string')
        .map(block => ({
          type: 'text' as const,
          text: extractJsonFromStructuredResponse(block.text!),
        }))
        .filter(block => block.text.length > 0);

      normalizedContent = textBlocks.length > 0 ? textBlocks : rawContent;
    } else {
      normalizedContent = rawContent;
    }

    return {
      content: normalizedContent,
      model: data?.model ?? model,
      usage: data?.usage,
      ...(typeof data?.stop_reason === 'string' ? { _stopReason: data.stop_reason } : {}),
      ...(exactCost != null ? { _exactCostUsd: exactCost } : {}),
      ...(openRouterProvider ? { _openRouterProvider: openRouterProvider } : {}),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export const openRouterProxyAdapter: BtsTransportAdapter = {
  transport: 'openrouter-proxy',
  requiredBehaviors: {
    recordsCooldown: true,
    guardsSseViaParseJson: true,
    classifiesHttpErrors: true,
    propagatesOutputFormat: true,
    sentryViaCaptureKnownConditionOnly: true,
    // Strips <think> blocks via stripThinkingBlocks for non-Anthropic OR models
    // (reasoning models embed thinking in text). PM 260427 regression class.
    extractsReasoningContent: true,
    wrapsTransientRetry: false,
    requiresWireSafeOptions: true,
    notes: 'wrapsTransientRetry=false: proxy paths delegate transient 5xx/network retry to the local proxy; only the direct (non-proxied) anthropic-direct API-key and profile-direct paths wrap withTransientRetry. Intentional asymmetry (invariants 23-24).',
  },
  execute: ({ plan, options }) =>
    callViaOpenRouterProxy(plan.decision.wireModelId, options, plan),
};
