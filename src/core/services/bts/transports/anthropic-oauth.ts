/**
 * Anthropic OAuth-token BTS transport (Anthropic SDK with `authToken`).
 *
 * Extracted verbatim from `behindTheScenesClient.ts` in Stage 7. Invoked by the
 * anthropic-direct dispatcher (`callAnthropicWithPlan`) when the route plan auth
 * kind is `oauth-token`. The pre-OAuth token-refresh hook runs in the
 * dispatcher before this is called (process-scoped hook lives in `./shared`).
 *
 * This transport is SDK-based: it never touches a raw `Response`, so the SSE
 * guard (`parseJsonResponseBody`) is intentionally not applicable here — the SDK
 * issues a non-streaming `messages.create` and decodes the body itself.
 */
import { Anthropic } from '@anthropic-ai/sdk';
import { classifyError } from '@core/rebelCore/modelErrors';
import { assertWireSafeForAlwaysOnThinking } from '@core/rebelCore/alwaysOnThinkingWireSafety';
import type { ProviderRouteHeaderTuples } from '@core/rebelCore/providerRouteDecision';
import { attachCooldownRateLimitSignal } from '../cooldown';
import {
  type BehindTheScenesResponse,
  type WireSafeBtsOptions,
  getRetryAfterHeaderFromSdkError,
  headersRecord,
  parseRetryAfterHeader,
} from './shared';

export async function callAnthropicWithOAuthToken(
  oauthToken: string,
  model: string,
  options: WireSafeBtsOptions,
  plannedHeaders?: ProviderRouteHeaderTuples,
): Promise<BehindTheScenesResponse> {
  // eslint-disable-next-line no-restricted-syntax -- R4 whitelist: narrow OAuth helper uses Anthropic SDK authToken path; all API-key routing goes through ProviderRoutePlan.
  const client = new Anthropic({ authToken: oauthToken });

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: options.maxTokens ?? 512,
    messages: options.messages,
    ...(options.system ? { system: options.system } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.outputFormat ? { output_config: { format: options.outputFormat } } : {}),
  };

  // Runtime backstop behind the WireSafeBtsOptions brand: throws in dev/test,
  // captures + strips in prod. SDK params object mutated on
  // the prod strip arm, which is exactly the repair we want pre-wire.
  assertWireSafeForAlwaysOnThinking(model, params as unknown as Record<string, unknown>, 'bts.anthropic-oauth');

  const requestOptions: Anthropic.RequestOptions = {
    signal: options.signal,
    timeout: options.timeout ?? 30000,
    ...(plannedHeaders
      ? { headers: headersRecord(plannedHeaders) }
      : options.outputFormat
        ? { headers: { 'anthropic-beta': 'structured-outputs-2025-11-13' } }
        : {}),
  };

  let response: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    response = await client.messages.create(params, requestOptions);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message.toLowerCase() : '';
    const isAbortOrTimeout = !!options.signal?.aborted || errorMessage.includes('timed out');
    if (isAbortOrTimeout) {
      // Abort/timeout takes precedence (preserves the original re-wrap); a
      // cooldown is not recorded for an aborted/timed-out call.
      throw new Error('Behind-the-scenes task timed out');
    }
    const classifiedError = classifyError(error);
    if (classifiedError.kind === 'rate_limit') {
      // Stage 10: parse the SDK-error retry-after here (transport knowledge) and
      // attach it as a typed signal; the dispatch layer does the actual
      // `cooldown.recordRateLimit` call. Throw the classified error (carrying the
      // signal) so dispatch sees `kind==='rate_limit'` and records it.
      const retryAfterMs = parseRetryAfterHeader(getRetryAfterHeaderFromSdkError(error));
      throw attachCooldownRateLimitSignal(classifiedError, { retryAfterMs, provider: 'Anthropic', route: 'oauth' });
    }
    throw error;
  }

  // Stage 10: cooldown SUCCESS is recorded by the dispatch layer AFTER this
  // adapter resolves (the SDK has already decoded the non-streaming body).
  const mappedContent = response.content.map((block) => ({
    type: block.type,
    ...(block.type === 'text' ? { text: block.text } : {}),
  }));

  const textContent = mappedContent
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();

  let structuredOutput: unknown;
  if (options.outputFormat && textContent) {
    try {
      structuredOutput = JSON.parse(textContent);
    } catch {
      // Best-effort parsing only; text content remains canonical.
      structuredOutput = undefined;
    }
  }

  return {
    content: mappedContent,
    model: response.model,
    ...(typeof response.stop_reason === 'string' ? { _stopReason: response.stop_reason } : {}),
    usage: response.usage
      ? {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? undefined,
          cache_read_input_tokens: response.usage.cache_read_input_tokens ?? undefined,
        }
      : undefined,
    ...(structuredOutput != null ? { structured_output: structuredOutput } : {}),
  };
}
