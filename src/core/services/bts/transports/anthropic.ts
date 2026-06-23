/**
 * Anthropic-direct BTS transport (API-key fetch + OAuth-SDK + plan dispatcher).
 *
 * Extracted verbatim from `behindTheScenesClient.ts` in Stage 7. Behaviour is
 * preserved exactly; only the home module changed. The OAuth sub-path lives in
 * `./anthropic-oauth.ts` and is invoked by `callAnthropicWithPlan` here.
 */
import { getSettings } from '@core/services/settingsStore';
import { classifyHttpError } from '@core/rebelCore/modelErrors';
import { getOAuthToken } from '@core/rebelCore/settingsAccessors';
import { assertWireSafeForAlwaysOnThinking } from '@core/rebelCore/alwaysOnThinkingWireSafety';
import type { ProviderRouteHeaderTuples } from '@core/rebelCore/providerRouteDecision';
import type { ProviderRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { attachCooldownRateLimitSignal } from '../cooldown';
import {
  type BehindTheScenesResponse,
  type WireSafeBtsOptions,
  BTS_DEFAULT_TIMEOUT_MS,
  getPreOAuthCallHook,
  headersRecord,
  makeTimeoutSignal,
  parseRetryAfterHeader,
  withTransientRetry,
} from './shared';
import { callAnthropicWithOAuthToken } from './anthropic-oauth';
import type { BtsTransportAdapter } from './types';

export async function callAnthropic(
  apiKey: string,
  model: string,
  options: WireSafeBtsOptions,
  plannedHeaders?: ProviderRouteHeaderTuples,
): Promise<BehindTheScenesResponse> {
  const headers: Record<string, string> = plannedHeaders
    ? headersRecord(plannedHeaders)
    : {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(options.outputFormat ? { 'anthropic-beta': 'structured-outputs-2025-11-13' } : {}),
      };

  const body: Record<string, unknown> = {
    model,
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

  // BTS calls are always non-streaming. Explicit stream:false prevents the
  // provider from defaulting to streaming and surfaces a deterministic error
  // via parseJsonResponseBody if SSE somehow comes back.
  // See docs/plans/260429_bts_sse_parsing_fix.md.
  body.stream = false;

  // Runtime backstop behind the WireSafeBtsOptions brand: throws in dev/test,
  // captures + strips in prod.
  assertWireSafeForAlwaysOnThinking(model, body, 'bts.anthropic-direct');

  const { signal, timeoutId } = makeTimeoutSignal(options, BTS_DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const classifiedError = classifyHttpError(response.status, errorText, 'Anthropic');
      if (classifiedError.kind === 'rate_limit') {
        // Stage 10: parse the provider-specific retry-after here (transport
        // knowledge) and attach it as a typed signal; the dispatch layer does
        // the actual `cooldown.recordRateLimit` call.
        const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
        attachCooldownRateLimitSignal(classifiedError, { retryAfterMs, provider: 'Anthropic', route: 'api-key' });
      }
      throw classifiedError;
    }

    // Stage 10: cooldown SUCCESS is recorded by the dispatch layer AFTER this
    // adapter resolves a fully-parsed response — preserving invariants 12/13.
    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      stop_reason?: string;
      usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
    };

    const content = data?.content ?? [];

    // Parse structured output from text content when outputFormat was requested
    let structuredOutput: unknown;
    if (options.outputFormat) {
      const textContent = content
        .filter((block): block is { type: string; text: string } => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (textContent) {
        try {
          structuredOutput = JSON.parse(textContent);
        } catch (parseError) {
          ignoreBestEffortCleanup(parseError, {
            operation: 'btsAnthropicTransport.parseStructuredOutput',
            reason: 'Best-effort JSON parse of Anthropic text content; text remains canonical.',
          });
        }
      }
    }

    return {
      content,
      model: data?.model ?? model,
      usage: data?.usage,
      ...(typeof data?.stop_reason === 'string' ? { _stopReason: data.stop_reason } : {}),
      ...(structuredOutput != null ? { structured_output: structuredOutput } : {}),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function callAnthropicWithPlan(
  plan: ProviderRoutePlan,
  options: WireSafeBtsOptions,
): Promise<BehindTheScenesResponse> {
  if (plan.auth.kind === 'oauth-token') {
    const preOAuthCallHook = getPreOAuthCallHook();
    if (preOAuthCallHook) await preOAuthCallHook();
    const freshSettings = getSettings();
    const oauthToken = getOAuthToken(freshSettings) ?? plan.auth.oauthToken;
    if (!oauthToken) {
      throw new Error('No OAuth token available for background task');
    }
    return callAnthropicWithOAuthToken(oauthToken, plan.decision.wireModelId, options, plan.headers);
  }

  if (plan.auth.kind !== 'api-key' || !plan.auth.apiKey) {
    throw new Error('No API key available for background task');
  }

  return withTransientRetry(
    () => callAnthropic(plan.auth.kind === 'api-key' ? plan.auth.apiKey ?? '' : '', plan.decision.wireModelId, options, plan.headers),
    options.signal,
  );
}

export const anthropicDirectAdapter: BtsTransportAdapter = {
  transport: 'anthropic-direct',
  requiredBehaviors: {
    recordsCooldown: true,
    // The API-key path uses response.json() directly; the OAuth sub-path uses
    // the Anthropic SDK. Neither receives a raw SSE Response to guard with
    // parseJsonResponseBody (stream:false + SDK non-streaming create).
    guardsSseViaParseJson: false,
    classifiesHttpErrors: true,
    propagatesOutputFormat: true,
    sentryViaCaptureKnownConditionOnly: true,
    // Pure Anthropic responses carry no reasoning_content / <think> blocks to
    // extract; content is returned verbatim. The OAuth SDK sub-path likewise.
    extractsReasoningContent: false,
    // callAnthropicWithPlan wraps the API-key path in withTransientRetry.
    wrapsTransientRetry: true,
    requiresWireSafeOptions: true,
    notes: 'guardsSseViaParseJson=false: API-key path JSON.parses a non-streaming body directly; OAuth sub-path is SDK-based. Both set stream:false / non-streaming create. extractsReasoningContent=false: native Anthropic output has no reasoning_content/<think> to strip.',
  },
  execute: ({ plan, options }) => callAnthropicWithPlan(plan, options),
};
