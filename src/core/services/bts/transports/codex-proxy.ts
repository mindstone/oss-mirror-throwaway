/**
 * Codex-proxy BTS transport.
 *
 * Extracted verbatim from `behindTheScenesClient.ts` in Stage 7. Uses the same
 * local-proxy infrastructure as OpenRouter but with `x-codex-turn: true`; the
 * proxy injects the Codex OAuth access token, translates Anthropic-format →
 * OpenAI-format on the request, and translates the response back.
 */
import { classifyHttpError } from '@core/rebelCore/modelErrors';
import { stripThinkingBlocks } from '@core/utils/stripThinkingBlocks';
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

/**
 * Route a BTS call through the local proxy with Codex passthrough headers.
 * The proxy handles OAuth token injection for Codex subscribers. Uses the same
 * proxy infrastructure as OpenRouter but with `x-codex-turn: true` instead.
 *
 * The proxy translates from Anthropic-format requests to OpenAI-format and
 * injects the Codex OAuth access token. Response is translated back to
 * Anthropic-compatible BehindTheScenesResponse.
 */
export async function callViaCodexProxy(
  model: string,
  options: WireSafeBtsOptions,
  plan?: ProviderRoutePlan,
): Promise<BehindTheScenesResponse> {
  // When a plan is present, proxy values come from the plan and the seam is not
  // read (so a surface that always passes a plan never triggers the unwired
  // throw). Plan-less calls resolve via the hard transport-time read, which
  // throws BtsProxyNotWiredError if no surface ever wired the proxy (I6 —
  // identical resolution to callViaOpenRouterProxy).
  const { url: resolvedUrl, auth: resolvedAuth } = plan
    ? { url: plan.proxyBaseURL, auth: undefined }
    : await resolveBtsProxyForTransport();
  const proxyUrl = resolvedUrl;
  const headers: Record<string, string> = plan
    ? headersRecord(plan.headers)
    : {
        'x-proxy-auth': resolvedAuth ?? '',
        'x-codex-turn': 'true',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(options.outputFormat ? { 'anthropic-beta': 'structured-outputs-2025-11-13' } : {}),
      };
  const proxyAuth = headers['x-proxy-auth'];
  if (!proxyUrl || !proxyAuth) {
    throw new Error(
      'Codex proxy not available for background task. ' +
      `proxyUrl=${proxyUrl ? 'set' : 'missing'}, proxyAuth=${proxyAuth ? 'set' : 'missing'}`
    );
  }

  const callerMaxTokens = options.maxTokens ?? 512;

  let effectiveSystem = options.system;
  if (options.outputFormat) {
    const allContent = [options.system ?? '', ...options.messages.map(m => m.content)].join(' ');
    if (!allContent.toLowerCase().includes('json')) {
      effectiveSystem = (effectiveSystem ?? '') + '\n\nRespond with valid JSON.';
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: callerMaxTokens,
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

  // BTS calls are always non-streaming. The proxy's Codex passthrough used to
  // force stream=true unconditionally, returning SSE to BTS clients; explicit
  // stream:false routes through the proxy's non-streaming Codex branch.
  // See docs/plans/260429_bts_sse_parsing_fix.md.
  body.stream = false;

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
      const classifiedError = classifyHttpError(response.status, errorText, 'Codex');
      if (classifiedError.kind === 'rate_limit') {
        // Stage 10: parse retry-after here (transport knowledge), attach as a
        // typed signal; the dispatch layer does the `cooldown.recordRateLimit` call.
        const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
        attachCooldownRateLimitSignal(classifiedError, { retryAfterMs, provider: 'Codex', route: 'proxy' });
      }
      throw classifiedError;
    }

    // Stage 10: success is recorded by the dispatch layer only AFTER this adapter
    // returns. parseJsonResponseBody throws on an SSE body BEFORE we return, so a
    // parse failure is never recorded as provider success (invariants 12/13).
    const data = (await parseJsonResponseBody(response)) as {
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };

    const rawContent: Array<{ type: string; text?: string }> = data?.content ?? [];
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

    const normalizedContent = textBlocks.length > 0 ? textBlocks : rawContent;

    return {
      content: normalizedContent,
      model: data?.model ?? model,
      usage: data?.usage,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export const codexProxyAdapter: BtsTransportAdapter = {
  transport: 'codex-proxy',
  requiredBehaviors: {
    recordsCooldown: true,
    guardsSseViaParseJson: true,
    classifiesHttpErrors: true,
    propagatesOutputFormat: true,
    sentryViaCaptureKnownConditionOnly: true,
    // Strips <think> blocks via stripThinkingBlocks on returned text blocks.
    // PM 260427 regression class.
    extractsReasoningContent: true,
    wrapsTransientRetry: false,
    requiresWireSafeOptions: true,
    notes: 'wrapsTransientRetry=false: proxy paths delegate transient 5xx/network retry to the local proxy; only the direct anthropic-direct API-key and profile-direct paths wrap withTransientRetry. Intentional asymmetry (invariants 23-24).',
  },
  execute: ({ plan, options }) =>
    callViaCodexProxy(plan.decision.wireModelId, options, plan),
};
