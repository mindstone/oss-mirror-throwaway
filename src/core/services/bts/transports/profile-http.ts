/**
 * Profile-direct (OpenAI-compatible HTTP) BTS transport.
 *
 * Extracted verbatim from `behindTheScenesClient.ts` in Stage 7. Makes a direct
 * HTTP call to a model profile's OpenAI-compatible `/chat/completions` endpoint,
 * bypassing the proxy. Handles reasoning-model token-budget inflation + a single
 * length-finish retry that shares a deadline with the first attempt.
 *
 * Both `openai-compatible-http` and `local-openai-compatible-http` transports
 * dispatch here; they are the same wire behaviour.
 */
import { createScopedLogger } from '@core/logger';
import {
  finalizeChatCompletionsBody,
  serializeChatCompletionsBody,
} from '@core/services/chatCompletionsParamCapability';
import { buildCompletionsUrl } from '@shared/utils/modelNormalization';
import { normalizeApiKey, resolveProfileApiKey } from '@shared/utils/providerKeys';
import { extractOpenAITextFields } from '@core/rebelCore/clients/openaiTranslators';
import { classifyHttpError, isChatIncompatibilityError } from '@core/rebelCore/modelErrors';
import { stripThinkingBlocks } from '@core/utils/stripThinkingBlocks';
import type { CustomProvider, ModelProfile, ProviderKeys } from '@shared/types';
import type { ProviderRoutePlan } from '@core/rebelCore/providerRoutePlanTypes';
import { markProfileChatIncompatible } from '../profileCompatibility';
import { attachCooldownRateLimitSignal } from '../cooldown';
import {
  type BehindTheScenesResponse,
  type WireSafeBtsOptions,
  extractJsonFromStructuredResponse,
  headersRecord,
  parseJsonResponseBody,
  parseRetryAfterHeader,
  withTransientRetry,
} from './shared';
import type { BtsTransportAdapter } from './types';

/**
 * Reasoning-aware token budget constants.
 *
 * Reasoning models (e.g. MiniMax M2.7, DeepSeek R1) include thinking tokens
 * in the max_tokens budget. Callers specify maxTokens as "how much visible
 * output I need", so we inflate the budget for reasoning models upfront and
 * retry once on truncation for any profile model.
 */
const REASONING_INFLATION_FACTOR = 4;
const REASONING_MIN_TOKENS = 4096;
const REASONING_MAX_TOKENS = 16384;
const RETRY_INFLATION_FACTOR = 4;
const DEFAULT_PROFILE_TIMEOUT_MS = 60000;

const log = createScopedLogger({ service: 'behindTheScenesClient' });

interface ProfileHttpResult extends BehindTheScenesResponse {
  _finishReason?: string;
  /** True when the model returned reasoning_content (reasoning model detected at runtime). */
  _hasReasoningContent?: boolean;
}

/**
 * Make a direct HTTP call to a model profile's server, bypassing the proxy.
 * Uses OpenAI-compatible API format (POST /chat/completions) since most
 * non-Claude providers use it.
 *
 * Handles reasoning models automatically:
 * - If profile has reasoningEffort set, inflates max_tokens to leave room for thinking
 * - If any profile response is truncated (finish_reason=length), retries once with a larger budget
 * - Retry shares a deadline with the first attempt so total wall-clock never exceeds caller's timeout
 * - If retry fails (network error, provider 400), falls back to the truncated first result
 */
export async function callDirectWithProfile(
  profile: ModelProfile,
  options: WireSafeBtsOptions,
  providerKeys?: ProviderKeys,
  customProviders?: CustomProvider[],
  fallbackApiKey?: string | null,
  plan?: ProviderRoutePlan,
): Promise<BehindTheScenesResponse> {
  // Fail-fast: skip network call if profile is known chat-incompatible
  if (profile.chatCompatibility === 'incompatible') {
    throw new Error(
      `Model profile "${profile.name}" is marked as chat-incompatible (non-chat model). ` +
      'Skipping network call. Reconfigure the model in Settings → Your Models.'
    );
  }

  const callerMaxTokens = options.maxTokens ?? 512;
  const isKnownReasoningModel = !!profile.reasoningEffort;
  const deadline = Date.now() + (options.timeout ?? DEFAULT_PROFILE_TIMEOUT_MS);

  // Inflate budget upfront for known reasoning models so thinking tokens don't starve output
  const initialMaxTokens = isKnownReasoningModel
    ? Math.min(
        Math.max(callerMaxTokens * REASONING_INFLATION_FACTOR, REASONING_MIN_TOKENS),
        REASONING_MAX_TOKENS,
      )
    : callerMaxTokens;

  try {
    const result = await callProfileHttp(
      profile,
      options,
      providerKeys,
      initialMaxTokens,
      deadline,
      customProviders,
      fallbackApiKey,
      plan,
    );

    // Runtime reasoning model detection: if the response contained
    // reasoning_content but the profile didn't have reasoningEffort set,
    // the initial budget was likely too small. Treat as truncated and retry
    // with an inflated budget even if finish_reason isn't 'length' (some
    // providers return empty content with 'stop' when budget is exhausted
    // by reasoning tokens).
    const detectedReasoningModel = result._hasReasoningContent && !isKnownReasoningModel;
    const needsRetry = result._finishReason === 'length'
      || (detectedReasoningModel && !result.content?.[0]?.text);

    // Retry once if truncated or if reasoning consumed the entire budget
    if (needsRetry) {
      const retryBase = detectedReasoningModel
        ? Math.min(Math.max(callerMaxTokens * REASONING_INFLATION_FACTOR, REASONING_MIN_TOKENS), REASONING_MAX_TOKENS)
        : initialMaxTokens;
      const retryMaxTokens = Math.min(retryBase * RETRY_INFLATION_FACTOR, REASONING_MAX_TOKENS);
      const remaining = deadline - Date.now();

      if (remaining <= 0) {
        log.warn({ profile: profile.name, detectedReasoningModel }, 'Profile response needs retry but no time remaining');
        return stripInternalFields(result);
      }

      log.info(
        { profile: profile.name, initial: initialMaxTokens, retry: retryMaxTokens, remainingMs: remaining, detectedReasoningModel },
        detectedReasoningModel
          ? 'Reasoning model detected at runtime (reasoning_content present), retrying with inflated budget'
          : 'Profile response truncated (finish_reason=length), retrying with larger budget'
      );

      try {
        const retryResult = await callProfileHttp(
          profile,
          options,
          providerKeys,
          retryMaxTokens,
          deadline,
          customProviders,
          fallbackApiKey,
          plan,
        );
        if (retryResult._finishReason === 'length') {
          log.warn(
            { profile: profile.name, maxTokens: retryMaxTokens },
            'Profile response still truncated after retry'
          );
        }
        return stripInternalFields(retryResult);
      } catch (retryError) {
        log.warn(
          { profile: profile.name, err: retryError instanceof Error ? retryError.message : String(retryError) },
          'Retry failed, returning truncated first result'
        );
        return stripInternalFields(result);
      }
    }

    return stripInternalFields(result);
  } catch (error) {
    // Auto-mark profile as chat-incompatible on runtime detection
    if (isChatIncompatibilityError(error) && profile.id) {
      markProfileChatIncompatible(profile.id);
    }
    throw error;
  }
}

function stripInternalFields(result: ProfileHttpResult): BehindTheScenesResponse {
  const { _finishReason: _, _hasReasoningContent: __, ...clean } = result;
  return clean;
}

/**
 * Low-level HTTP call to a profile's OpenAI-compatible endpoint.
 * Separated from callDirectWithProfile to allow retry with different max_tokens.
 * Uses a shared deadline so total wall-clock time never exceeds the caller's timeout.
 */
async function callProfileHttp(
  profile: ModelProfile,
  options: WireSafeBtsOptions,
  providerKeys: ProviderKeys | undefined,
  maxTokens: number,
  deadline: number,
  customProviders?: CustomProvider[],
  fallbackApiKey?: string | null,
  plan?: ProviderRoutePlan,
): Promise<ProfileHttpResult> {
  const headers: Record<string, string> = plan
    ? headersRecord(plan.headers)
    : { 'content-type': 'application/json' };

  if (!plan) {
    const effectiveKey = resolveProfileApiKey(profile, providerKeys, customProviders)
      ?? normalizeApiKey(fallbackApiKey);
    if (effectiveKey) {
      headers['authorization'] = `Bearer ${effectiveKey}`;
    }
  }

  // Build OpenAI-compatible request body
  const messages: Array<{ role: string; content: string }> = [];
  if (options.system) {
    messages.push({ role: 'system', content: options.system });
  }
  for (const msg of options.messages) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // REBEL-1C8: Fail closed on missing model instead of sending "default" to the
  // provider. When EMFILE prevents reading settings, profile.model can be empty,
  // causing a sustained 400-error storm (~150 reqs in 2 min).
  if (!profile.model) {
    throw new Error(
      `Model profile "${profile.name}" (${profile.id}) has no model configured. ` +
      'Check the profile settings and ensure a model is assigned.'
    );
  }

  const body: Record<string, unknown> = {
    model: profile.model,
    // OpenAI GPT-5.x models reject max_tokens; use max_completion_tokens
    // for OpenAI-compatible endpoints (consistent with localModelProxyServer,
    // openaiClient, and apiKeyValidation).
    max_completion_tokens: maxTokens,
    messages,
  };

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  // Use json_object mode for broad provider compatibility (OpenAI, Together, etc.).
  // Full json_schema enforcement varies across providers, but json_object mode
  // is widely supported and callers already have JSON parse error handling.
  if (options.outputFormat) {
    // OpenAI requires at least one message to contain the word "json" when using
    // response_format: json_object. Anthropic has no such requirement, so many BTS
    // prompts omit it. Inject a hint into the system message when needed.
    const hasJsonMention = messages.some(m =>
      m.content.toLowerCase().includes('json')
    );
    if (!hasJsonMention) {
      const systemIdx = messages.findIndex(m => m.role === 'system');
      if (systemIdx !== -1) {
        messages[systemIdx] = {
          ...messages[systemIdx],
          content: messages[systemIdx].content + '\n\nRespond with valid JSON.',
        };
      } else {
        messages.unshift({ role: 'system', content: 'Respond with valid JSON.' });
      }
    }
    body.response_format = { type: 'json_object' };
  }

  const validatedBody = finalizeChatCompletionsBody(body, {
    modelId: profile.model,
    providerType: profile.providerType,
    log,
  });

  const url = buildCompletionsUrl(plan?.endpoint?.baseURL ?? profile.serverUrl);

  // Use shared deadline so first attempt + retry never exceed the caller's total timeout
  const remaining = deadline - Date.now();
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), Math.max(remaining, 0));
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: serializeChatCompletionsBody(validatedBody),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      const providerName = profile.providerType ?? 'Profile';
      const classifiedError = classifyHttpError(response.status, errorText, providerName);
      if (classifiedError.kind === 'rate_limit') {
        // Stage 10: parse retry-after here (transport knowledge), attach as a
        // typed signal; the dispatch layer does the `cooldown.recordRateLimit` call.
        const retryAfterMs = parseRetryAfterHeader(response.headers.get('retry-after'));
        attachCooldownRateLimitSignal(classifiedError, { retryAfterMs, provider: providerName, route: 'direct-profile' });
      }
      // Throw the classified ModelError (not a generic Error) so upstream
      // consumers — turnErrorRecovery, executeWithStructuredOutputProfileFallback's
      // JSON-capability heuristic, agentErrorCatalog — see kind/status/__rawMessage.
      // Symmetric with the other transports. See merge resolution review (260428).
      throw classifiedError;
    }

    // Stage 10: success is recorded by the dispatch layer only AFTER this adapter
    // returns. parseJsonResponseBody throws on an SSE body BEFORE we return, so a
    // parse failure is never recorded as provider success (invariants 12/13).
    const data = (await parseJsonResponseBody(response)) as {
      choices?: Array<{ message?: Record<string, unknown>; finish_reason?: string }>;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    // Convert OpenAI-compatible response to BehindTheScenesResponse format.
    // Uses the shared extractOpenAITextFields() from openaiTranslators — the
    // single source of truth for reading content + reasoning_content from
    // OpenAI-compatible providers.
    const choice = data?.choices?.[0];
    const { text: rawContent, reasoningText, hasReasoningContent } =
      extractOpenAITextFields(choice?.message ?? {});

    // BTS consumers only need the final text answer. Fall back to
    // reasoning_content when content is empty (reasoning models like MiniMax 2.7
    // may consume the entire token budget for reasoning, leaving content empty).
    const rawText = rawContent || reasoningText;

    // Strip reasoning model <think>...</think> blocks — some providers embed
    // thinking in the content field rather than using reasoning_content.
    let text = stripThinkingBlocks(rawText);
    // Extract clean JSON when structured output was requested.
    if (options.outputFormat) {
      text = extractJsonFromStructuredResponse(text);
    }

    return {
      content: [{ type: 'text', text }],
      model: data?.model ?? profile.model ?? 'unknown',
      usage: data?.usage
        ? { input_tokens: data.usage.prompt_tokens ?? 0, output_tokens: data.usage.completion_tokens ?? 0 }
        : undefined,
      _finishReason: choice?.finish_reason,
      _hasReasoningContent: hasReasoningContent,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve the profile a route plan selected, throwing the same diagnostic as the
 * original `findProfileForPlan` when none matches.
 */
function findProfileForPlan(profiles: ModelProfile[] | undefined, plan: ProviderRoutePlan): ModelProfile {
  const profileId = plan.decision.profileId;
  const profile = profileId
    ? profiles?.find((candidate) => candidate.id === profileId)
    : null;
  if (!profile) {
    throw new Error(`Provider route plan selected ${plan.decision.transport} but no model profile was resolved.`);
  }
  return profile;
}

export const profileHttpAdapter: BtsTransportAdapter = {
  // Both openai-compatible-http and local-openai-compatible-http dispatch to the
  // same adapter; the registry maps each transport key to this object.
  transport: 'openai-compatible-http',
  requiredBehaviors: {
    recordsCooldown: true,
    guardsSseViaParseJson: true,
    classifiesHttpErrors: true,
    // Profile-direct intentionally uses response_format=json_object (not
    // output_format) for broad OpenAI-compatible provider support; see the
    // outputFormat branch in callProfileHttp and investigation 260509.
    propagatesOutputFormat: true,
    sentryViaCaptureKnownConditionOnly: true,
    // PM 260427: reads reasoning_content via extractOpenAITextFields and strips
    // <think> blocks via stripThinkingBlocks in callProfileHttp. This is the
    // direct-profile path whose 55-day reasoning_content omission this contract exists to catch.
    extractsReasoningContent: true,
    // execute() wraps callDirectWithProfile in withTransientRetry.
    wrapsTransientRetry: true,
    requiresWireSafeOptions: true,
  },
  execute: ({ plan, options, settings }) => {
    const profile = findProfileForPlan(settings.localModel?.profiles, plan);
    return withTransientRetry(
      () => callDirectWithProfile(
        profile,
        options,
        settings.providerKeys,
        settings.customProviders,
        null,
        plan,
      ),
      options.signal,
    );
  },
};
