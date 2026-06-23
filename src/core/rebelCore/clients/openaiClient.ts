import { createScopedLogger, getTurnContext } from '@core/logger';
import { turnObservability } from '@core/services/turnObservability';
import {
  finalizeChatCompletionsBody,
  serializeChatCompletionsBody,
  type ValidatedChatCompletionsBody,
} from '@core/services/chatCompletionsParamCapability';
import {
  createStreamTranslator,
  parseSseEventBlock,
  translateChatToResponses,
  translateResponsesToChatCompletion,
  readResponsesSseToCompletion,
  extractReasoningFromResponsesJson,
  type ChatCompletionRequest,
  type ResponsesApiResponse,
} from '@core/services/codexResponsesTranslator';
import { stripThinkingBlocks } from '@core/utils/stripThinkingBlocks';
import { getCatalogEntryById, modelSupportsImageInput } from '@shared/data/modelCatalog';
import {
  FULFILLMENT_SERVER_HINT_ALLOWLIST,
  type FulfillmentProvider,
} from '@shared/types/providerMetadata';
import { buildCompletionsUrl, buildResponsesUrl } from '@shared/utils/modelNormalization';
import { getSettings } from '@core/services/settingsStore';
import { resolveModelLimits } from '../modelLimits';
import { PLAN_OUTPUT_FORMAT_NAME, PLAN_RESPONSE_SCHEMA_OPENAI_STRICT } from '../planningMode';
import type {
  CreateParams,
  CreateResult,
  ModelClient,
  ModelClientConfig,
  RetryInfo,
  StreamEvent,
  StreamParams,
  StreamResult,
} from '../modelClient';
import { ModelError, classifyError, classifyHttpError, classifyStatus, type ModelErrorKind } from '../modelErrors';
import type {
  OpenAIReasoningEffort,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIResponseFormat,
  OpenAIStreamChunk,
  OpenAIStreamState,
} from './openaiTypes';
import type { JsonSchemaFormat } from '../modelClient';
import { isResultAffectingStreamEvent } from '../modelClient';
import {
  createOpenAIStreamState,
  extractMiniMaxXmlToolCalls,
  flushLateReasoningBuffer,
  processStreamChunk,
  translateMessagesToOpenAI,
  translateResponseToNeutral,
  translateToolsToOpenAI,
} from './openaiTranslators';
import { mapOpenAIChatChunk, mapOpenAIResponsesEvent, type RuntimeActivityEvent } from '../runtimeActivity';
import { estimatePromptTokens } from '../tokenEstimation';
import { reportRuntimeActivityMapperFailure } from './runtimeActivityMapperReporter';
import {
  buildOfflineFailFastError,
  isOfflineFailFastEnabled,
  probeOfflineOnce,
} from './offlineFailFast';
import type { OpenAIProviderType } from './openaiClientTypes';
export type { OpenAIProviderType } from './openaiClientTypes';
import {
  aggregateToolCallSignatures,
  aggregatePreClassifiedSignatures,
  emitGatewayToolSignatureObserved,
  LITELLM_THOUGHT_ID_DELIMITER,
} from './gatewayToolSignatureDiagnostic';
import type { ProviderCapabilities } from '../contextPolicy';
import {
  emitsStrictResponseFormat,
  nonChatModelGuardEnabled,
  supportsInlineImageContent,
  surfacesCustomGatewayToolSignature,
  takesResponsesApiRoute,
} from '../providerFeatureGuards';
import type { WireModelId } from '@shared/utils/wireModelId';
import { mintOpenAiWireModel } from '@shared/utils/wireModelId';

const log = createScopedLogger({ service: 'openaiClient' });

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const CODEX_RECONNECT_MESSAGE =
  'Your ChatGPT connection needs to be refreshed. Open Settings → AI Providers → ChatGPT and reconnect your account.';
const PREFLIGHT_CONTEXT_HEADROOM = 0.98;
const RUNAWAY_PROMPT_HARD_CAP_TOKENS = 1_000_000;
const LATE_REASONING_FINISH_DEADLINE_MS = 30_000;
const STREAM_FIRST_CHUNK_TIMEOUT_MS = 5 * 60 * 1000;
const STREAM_FIRST_CHUNK_TIMEOUT_MESSAGE =
  'OpenAI-compatible stream timed out waiting for first response chunk.';
// Inter-chunk idle deadline (dead-stream detection). Once the first chunk has
// arrived, a dead OpenRouter/OpenAI-compatible socket can stall `reader.read()`
// indefinitely (zero SSE bytes) — the only existing backstop is the 10/30-min
// agent-turn watchdog. 90s of complete silence is far above any legitimate
// token/keepalive cadence (so healthy slow-but-streaming turns are unaffected)
// yet ~7-10× faster than the watchdog, fast-failing a doomed turn. The idle
// timeout surfaces as a transient `server_error`, which the existing
// `runWithRetry` transient-retry harness re-issues. See
// docs/plans/260608_minimax-ds4-mcp-toolcall-eval/subagent_reports/
// 260609_researcher-watchdog-rootcause.md (fix B).
const STREAM_IDLE_TIMEOUT_MS = 90_000;
const STREAM_IDLE_TIMEOUT_MESSAGE =
  'OpenAI-compatible stream went idle (no chunk for 90s mid-stream; likely a dead upstream socket).';
const FINISH_DEADLINE_TIMEOUT = Symbol('finish-deadline-timeout');
const STREAM_IDLE_TIMEOUT = Symbol('stream-idle-timeout');
const KNOWN_NON_CHAT_OPENAI_MODEL_PATTERNS = [
  /^text-embedding-/,
  /^text-search-/,
  /^text-(ada|babbage|curie|davinci)-/,
  /^(babbage|davinci)-002$/,
  /^gpt-3\.5-turbo-instruct$/,
  /^whisper-/,
  /^tts-/,
  /^dall-e-/,
  /^gpt-image-/,
  /^omni-moderation-/,
  /^text-moderation-/,
  /^gpt-4o(-mini)?-transcribe$/,
] as const;

const sleep = (ms: number, signal?: AbortSignal, provider?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelError('abort', 'Operation was aborted', undefined, provider));
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new ModelError('abort', 'Operation was aborted', undefined, provider));
    };

    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    signal?.addEventListener('abort', onAbort, { once: true });
  });

function estimateOpenAIRequestTokens(request: OpenAIRequest): number {
  return estimatePromptTokens({
    messages: request.messages,
    tools: request.tools,
  });
}

export type { CodexModeConfig } from '../codexModeTypes';
import type { CodexModeConfig } from '../codexModeTypes';

export interface OpenAIClientConfig extends ModelClientConfig {
  providerType?: OpenAIProviderType;
  codexMode?: CodexModeConfig;
  /**
   * When true, never send a reasoning/thinking parameter (`reasoning_effort`) to this
   * provider, regardless of the per-turn effort. For gateways that mistranslate
   * `reasoning_effort` into a thinking format the underlying model rejects (e.g. a
   * litellm→Vertex proxy emitting the legacy `thinking.type:"enabled"` for an Opus-4.8
   * that requires adaptive; Sentry REBEL-5RJ).
   *
   * Set by the caller from the profile suppression gate
   * (`shouldSuppressProfileReasoning` — the profile's auto-detected
   * `thinkingCompatibility === 'incompatible'` verdict).
   *
   * @see docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md
   */
  suppressReasoningEffort?: boolean;
}

type StreamStartTimeoutGuard = {
  signal: AbortSignal;
  markFirstChunkReceived: () => void;
  didTimeout: () => boolean;
  dispose: () => void;
};

const getDefaultProviderName = (providerType: OpenAIProviderType): string => {
  switch (providerType) {
    case 'openai':
      return 'OpenAI';
    case 'together':
      return 'Together';
    case 'cerebras':
      return 'Cerebras';
    case 'other':
    default:
      return 'OpenAI-compatible provider';
  }
};

const toOpenAIReasoningEffort = (effort?: 'low' | 'medium' | 'high' | 'max'): OpenAIReasoningEffort | undefined => {
  if (!effort) return undefined;
  if (effort === 'max') return 'high';
  return effort;
};

type OpenAiFulfillmentTransport = 'openai-direct' | 'codex';

const normalizeComparableUrl = (url: string): string => url.replace(/\/+$/, '');

const hasModelEcho = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const model = (value as { model?: unknown }).model;
  return typeof model === 'string' && model.trim().length > 0;
};

const extractAllowlistedServerHints = (
  headers: { get: (name: string) => string | null } | undefined,
): Record<string, string> | undefined => {
  if (!headers) {
    return undefined;
  }

  const hints: Record<string, string> = {};
  for (const key of FULFILLMENT_SERVER_HINT_ALLOWLIST) {
    const value = headers.get(key);
    if (typeof value === 'string' && value.length > 0) {
      hints[key] = value;
    }
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
};

const buildFulfillmentProvider = (
  transport: OpenAiFulfillmentTransport,
  serverHints: Record<string, string> | undefined,
  bodyModelEchoPresent: boolean,
): FulfillmentProvider => ({
  name: null,
  transport,
  source: serverHints
    ? 'response-headers-hints'
    : bodyModelEchoPresent
      ? 'response-body-echo'
      : 'unknown',
  ...(serverHints ? { serverHints } : {}),
});

/**
 * [BUG-PREVENTION] OpenAI strict mode rejects top-level `anyOf`; Anthropic
 * constrained-decoding rejects `type:[X,null]+enum`. This helper returns the
 * OpenAI-strict variant only when the format name matches
 * `PLAN_OUTPUT_FORMAT_NAME`. Both schemas live in `planningMode.ts`. See
 * `docs-private/postmortems/2feaa34a*` (Anthropic) and `f1b4d44b*` (OpenAI) for the
 * originating incidents.
 */
const selectOpenAIPlannerSchema = (format: JsonSchemaFormat): Record<string, unknown> => {
  return format.name === PLAN_OUTPUT_FORMAT_NAME ? PLAN_RESPONSE_SCHEMA_OPENAI_STRICT : format.schema;
};

export class OpenAIClient implements ModelClient {
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly defaultHeaders?: Record<string, string>;
  private readonly providerType: OpenAIProviderType;
  private readonly provider: string;
  private readonly codexMode?: CodexModeConfig;

  private readonly suppressReasoningEffort: boolean;

  readonly capabilities: ProviderCapabilities;

  constructor(config: OpenAIClientConfig) {
    this.providerType = config.providerType ?? 'other';
    this.provider = config.provider ?? getDefaultProviderName(this.providerType);
    this.codexMode = config.codexMode;
    this.suppressReasoningEffort = config.suppressReasoningEffort ?? false;

    this.capabilities = {
      hasNativeContextEditing: false,
      hasNativeCompaction: false,
      cacheStrategy: 'implicit' as const,
      cacheHeuristicTtlMs: 600_000,
      // Vision capability is FAIL-CLOSED for OpenAI-compatible providers.
      //
      // `Read` (Stage 3) now emits image content blocks for arbitrary image
      // files, not just screenshots. Sending an image block to a text-only
      // model produces a provider error, so we only advertise vision for the
      // first-party `openai` endpoint, whose multimodal models we trust. Every
      // other variant — `together`, `cerebras`, and the catch-all `other`
      // (which `normalizeToOpenAIProviderType` collapses OpenRouter, Google's
      // OpenAI-compat endpoint, and local/localhost proxies into) — is treated
      // as NON-vision. The boundary then substitutes a text placeholder rather
      // than risk an error (`buildModelFacingToolResultContent`).
      //
      // The provider-level gate lives in
      // `providerFeatureGuards.supportsInlineImageContent` (not inlined here)
      // per the typed-capability-matrix lint rule, ANDed with the per-MODEL
      // term from the catalog (260610 image-unsupported-by-model): even a
      // trusted vision provider must not receive images for a text-only model
      // (e.g. first-party-shaped deepseek ids).
      // See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 4 (#4).
      supportsImageContent: (model: string) =>
        supportsInlineImageContent(this.providerType) && modelSupportsImageInput(model),
    };

    if (!config.baseURL && !this.codexMode) {
      throw new ModelError('invalid_request', 'OpenAI client requires a base URL', undefined, this.provider);
    }

    this.baseURL = config.baseURL ?? '';
    this.apiKey = config.apiKey;
    this.defaultHeaders = config.defaultHeaders;
  }

  async create(params: CreateParams): Promise<CreateResult> {
    return this.runWithRetry(params.signal, () => this.doCreate(params), params.onRetry);
  }

  async stream(params: StreamParams, onEvent: (event: StreamEvent) => void): Promise<StreamResult> {
    // Idempotency guard for stream retries: once a RESULT-AFFECTING event has
    // been forwarded to the consumer, a transient mid-stream failure must NOT
    // re-run `doStream` from scratch — that would re-emit and produce
    // `attempt1_partial + attempt2_full` duplicated output (silent transcript
    // corruption). Instead we fail clean (throw the single transient error).
    // See docs/plans/260616_proxy-transient-retry/PLAN.md (Option X).
    let emittedResultContent = false;
    const guardedOnEvent = (event: StreamEvent): void => {
      // Retry-safety: only result-affecting events block a mid-stream retry —
      // see isResultAffectingStreamEvent (the exhaustive switch carries the
      // invariant by construction).
      if (isResultAffectingStreamEvent(event)) {
        emittedResultContent = true;
      }
      onEvent(event);
    };
    return this.runWithRetry(
      params.signal,
      () => this.doStream(params, guardedOnEvent),
      params.onRetry,
      () => !emittedResultContent,
    );
  }

  private async runWithRetry<T>(
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
    onRetry?: (params: RetryInfo) => void,
    isRetrySafe?: () => boolean,
  ): Promise<T> {
    // Fail-fast-offline gate (260618_arthur-offline-resilience Stage 2 +
    // refinement): shared with AnthropicClient via `offlineFailFast.ts`. Probe
    // reachability AT MOST ONCE per invocation (`undefined` = not yet probed) so
    // N retries never trigger N probes. Covers OpenAI BYOK, OpenAI-compatible
    // custom gateways, local models, and Codex-subscription offline turns.
    let offlineVerdict: boolean | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const modelError = classifyError(error, signal, this.provider);
        if (modelError.isAbort) throw modelError;

        // Idempotency guard (streaming only): if result-affecting content has
        // already been emitted to the consumer, re-running the stream would
        // duplicate output. Fail clean instead of retrying. `create()` passes
        // no `isRetrySafe` (atomic — always retry-safe), unchanged.
        if (isRetrySafe && !isRetrySafe()) throw modelError;

        if (attempt < MAX_RETRIES && modelError.isTransient) {
          // Fail-OPEN multi-host reachability gate — runs ONLY on the failure/
          // retry path (a healthy stream never enters this catch) and only stops
          // retries when the machine is CONFIRMED offline (all corroboration
          // hosts unreachable). Throws the `offlineFailFast`-marked error that
          // recovery routes to the retryable message_timeout terminal.
          if (isOfflineFailFastEnabled()) {
            offlineVerdict = await probeOfflineOnce(signal, offlineVerdict);
            if (offlineVerdict) {
              log.warn(
                { attempt: attempt + 1, kind: modelError.kind, provider: this.provider },
                'Fail-fast-offline: reachability probe confirmed offline — stopping retries, surfacing retryable offline terminal',
              );
              // Turn-level signal: if ANY model call during the turn (incl. a
              // sub-agent's) confirms offline, the turn experienced offline — so
              // this is intentionally NOT callsite-scoped, unlike appRetryCount.
              turnObservability.recordOfflineDetected(getTurnContext()?.turnId);
              throw buildOfflineFailFastError(modelError, this.provider);
            }
          }

          const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
          log.warn(
            {
              attempt: attempt + 1,
              kind: modelError.kind,
              provider: this.provider,
              delayMs,
            },
            'Transient OpenAI-compatible error, retrying',
          );
          turnObservability.recordAppRetry(getTurnContext()?.turnId);
          onRetry?.({
            attempt: attempt + 1,
            maxRetries: MAX_RETRIES,
            delayMs,
            errorKind: modelError.kind,
            provider: this.provider,
          });
          await sleep(delayMs, signal, this.provider);
          continue;
        }

        throw modelError;
      }
    }
  }

  private async doCreate(params: CreateParams): Promise<CreateResult> {
    const reasoningEffort = this.suppressReasoningEffort ? undefined : toOpenAIReasoningEffort(params.effort);
    const responseFormat = this.toOpenAIResponseFormat(params.outputConfig?.format);
    const wireModel: WireModelId = mintOpenAiWireModel(params.model);
    const request: OpenAIRequest = {
      model: wireModel,
      messages: await translateMessagesToOpenAI(
        params.messages,
        {
          supportsReasoningReplay: params.supportsReasoningReplay ?? false,
          supportsImageContent: this.capabilities.supportsImageContent(params.model),
        },
        params.systemPrompt,
        params.model,
        params.sessionId,
        params.hydrationCache,
        params.contentHydrationCache,
        params.contentCloudClient,
      ),
      max_completion_tokens: params.maxTokens,
      stream: false,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };
    this.assertPromptWithinTokenBudget(request);

    // Codex mode: always route through Codex Responses endpoint
    if (this.codexMode) {
      return this.doCodexCreate(request, params.signal);
    }

    this.assertChatCompatibleModel(request.model);
    const completion = await this.requestCompletion(request, params.signal);
    const translated = translateResponseToNeutral(completion.response, params.model);
    // Gateway tool-signature diagnostic (observability-only, fail-open): measure
    // which thought_signature convention (if any) a custom gateway surfaces on
    // tool-calls. Gated to `providerType === 'other'` + tool-calls present.
    emitGatewayToolSignatureObserved({
      shouldEmit: surfacesCustomGatewayToolSignature(this.providerType),
      providerType: this.providerType,
      provider: this.provider,
      modelId: params.model,
      streaming: false,
      aggregate: aggregateToolCallSignatures(
        completion.response.choices.flatMap((choice) => choice.message.tool_calls ?? []),
      ),
    });
    return {
      ...translated,
      usage: {
        ...translated.usage,
        fulfillmentProvider: completion.fulfillmentProvider,
      },
      model: translated.model ?? completion.response.model ?? undefined,
    };
  }

  private async doStream(params: StreamParams, onEvent: (event: StreamEvent) => void): Promise<StreamResult> {
    const reasoningEffort = this.suppressReasoningEffort ? undefined : toOpenAIReasoningEffort(params.effort);
    const responseFormat = this.toOpenAIResponseFormat(params.outputConfig?.format);
    const { onStreamActivity } = params;
    const wireModel: WireModelId = mintOpenAiWireModel(params.model);
    const request: OpenAIRequest = {
      model: wireModel,
      messages: await translateMessagesToOpenAI(
        params.messages,
        {
          supportsReasoningReplay: params.supportsReasoningReplay ?? false,
          supportsImageContent: this.capabilities.supportsImageContent(params.model),
        },
        params.systemPrompt,
        params.model,
        params.sessionId,
        params.hydrationCache,
        params.contentHydrationCache,
        params.contentCloudClient,
      ),
      max_completion_tokens: params.maxTokens,
      tools: translateToolsToOpenAI(params.tools),
      stream: true,
      stream_options: { include_usage: true },
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
    };
    this.assertPromptWithinTokenBudget(request);

    // Codex mode: always route through Codex Responses endpoint
    if (this.codexMode) {
      return this.doCodexStream(request, params.signal, onEvent, onStreamActivity);
    }

    this.assertChatCompatibleModel(request.model);
    if (this.needsResponsesApiRoute(request)) {
      return this.streamResponses(request, params.signal, onEvent, onStreamActivity);
    }

    return this.streamChatCompletions(request, params.signal, onEvent, onStreamActivity);
  }

  // ── Codex OAuth routing ───────────────────────────────────────

  private async buildCodexHeaders(): Promise<Record<string, string>> {
    const codex = this.codexMode!;
    if (codex.isConnected?.() === false) {
      throw new ModelError('auth', CODEX_RECONNECT_MESSAGE, undefined, this.provider);
    }

    const accessToken = await codex.getAccessToken();
    if (!accessToken) {
      throw new ModelError('auth', CODEX_RECONNECT_MESSAGE, undefined, this.provider);
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };
    const accountId = codex.getAccountId();
    if (accountId) {
      headers['openai-organization'] = accountId;
    }
    return headers;
  }

  private async doCodexCreate(request: OpenAIRequest, signal?: AbortSignal): Promise<CreateResult> {
    const codex = this.codexMode!;
    const codexRequest = translateChatToResponses({
      ...request,
      // INVARIANT: Codex Responses API rejects stream:false with HTTP 400
      // "Stream must be set to true". This client forces stream:true upstream
      // and buffers the SSE response.completed event via
      // readResponsesSseToCompletion(), returning a CreateResult to
      // non-streaming callers. Do NOT change this to false.
      // See docs/plans/260504_codex_passthrough_streaming_fix.md.
      stream: true,
    } as unknown as ChatCompletionRequest);

    let headers = await this.buildCodexHeaders();
    log.info({ model: request.model }, 'Forwarding non-streaming request to Codex (upstream stream:true + buffered)');

    let captured = await this.fetchWithMetadata(codex.endpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(codexRequest),
      signal,
    });
    let response = captured.response;

    // 401 retry: force-refresh token and retry once
    if (response.status === 401) {
      log.warn('Codex returned 401 on non-streaming request, attempting token refresh');
      const refreshedToken = await codex.forceRefreshToken();
      if (!refreshedToken) {
        throw new ModelError('auth', CODEX_RECONNECT_MESSAGE, 401, this.provider);
      }
      headers = { ...headers, Authorization: `Bearer ${refreshedToken}` };
      captured = await this.fetchWithMetadata(codex.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(codexRequest),
        signal,
      });
      response = captured.response;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw classifyHttpError(response.status, errorBody, this.provider);
    }

    if (!response.body) {
      throw new ModelError('server_error', 'Codex returned no response body', response.status, this.provider);
    }

    let codexReasoningContent = '';
    const responsesBody = await readResponsesSseToCompletion(response.body, {
      throwUpstreamError: (status, body) => classifyHttpError(status, body, this.provider),
      onDiagnostic: (d) => log.info({ ...d, model: request.model }, 'Codex non-streaming SSE buffered'),
      onReasoningSummary: (text) => { codexReasoningContent = text; },
    });
    const chatResponse = translateResponsesToChatCompletion(
      responsesBody,
      codexReasoningContent ? { reasoningContent: codexReasoningContent } : undefined,
    ) as unknown as OpenAIResponse;
    const translated = translateResponseToNeutral(chatResponse, request.model);
    const fulfillmentProvider = buildFulfillmentProvider(
      captured.transport,
      captured.serverHints,
      hasModelEcho(responsesBody) || hasModelEcho(chatResponse),
    );
    return {
      ...translated,
      usage: {
        ...translated.usage,
        fulfillmentProvider,
      },
      model: translated.model || chatResponse.model || request.model,
    };
  }

  private async doCodexStream(
    request: OpenAIRequest,
    signal: AbortSignal | undefined,
    onEvent: (event: StreamEvent) => void,
    onStreamActivity?: (event: RuntimeActivityEvent) => void,
  ): Promise<StreamResult> {
    const streamStartTimeout = this.createStreamStartTimeoutGuard(signal);

    const codex = this.codexMode!;
    const codexRequest = translateChatToResponses(request as unknown as ChatCompletionRequest);

    let headers = await this.buildCodexHeaders();
    log.info({ model: request.model }, 'Starting Codex streaming request');

    try {
      let captured = await this.fetchWithMetadata(codex.endpointUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(codexRequest),
        signal: streamStartTimeout.signal,
      });
      let response = captured.response;

      // 401 retry: force-refresh token and retry once
      if (response.status === 401) {
        log.warn('Codex returned 401 on streaming request, attempting token refresh');
        const refreshedToken = await codex.forceRefreshToken();
        if (!refreshedToken) {
          throw new ModelError('auth', CODEX_RECONNECT_MESSAGE, 401, this.provider);
        }
        headers = { ...headers, Authorization: `Bearer ${refreshedToken}` };
        captured = await this.fetchWithMetadata(codex.endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(codexRequest),
          signal: streamStartTimeout.signal,
        });
        response = captured.response;
      }

      if (!response.ok) {
        const errorBody = await response.text();
        throw classifyHttpError(response.status, errorBody, this.provider);
      }

      if (!response.body) {
        throw new ModelError('server_error', 'Codex streaming response body is empty', response.status, this.provider);
      }

      // Codex uses Responses API SSE format — reuse the existing streamResponses parser
      const streamTranslator = createStreamTranslator();
      const state = createOpenAIStreamState();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let shouldStop = false;
      let firstChunkSeen = false;

      try {
        for (;;) {
          const readResult = await this.readWithFinishDeadline(reader, state, firstChunkSeen);
          if (readResult === FINISH_DEADLINE_TIMEOUT) {
            state.lateReasoningCapHit = state.lateReasoningCapHit ?? 'time';
            await reader.cancel('late-reasoning-finish-timeout');
            break;
          }
          if (readResult === STREAM_IDLE_TIMEOUT) {
            throw await this.buildStreamIdleError(reader, request.model, signal);
          }

          const { done, value } = readResult;
          if (done) break;
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            streamStartTimeout.markFirstChunkReceived();
          }

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? '';

          for (const rawEvent of events) {
            const parsedEvent = this.parseResponsesSseEvent(rawEvent);
            if (!parsedEvent) continue;

            try {
              onStreamActivity?.(mapOpenAIResponsesEvent(parsedEvent.eventType || 'response.event'));
            } catch (mapperErr) {
              reportRuntimeActivityMapperFailure('codex', mapperErr, {
                rawEventType: parsedEvent.eventType ?? null,
              });
            }

            if (parsedEvent.data === '[DONE]') continue;

            let eventData: Record<string, unknown>;
            try {
              eventData = JSON.parse(parsedEvent.data) as Record<string, unknown>;
            } catch {
              log.warn({ eventType: parsedEvent.eventType }, 'Failed to parse Codex SSE event data');
              continue;
            }

            const translated = streamTranslator.translateEvent(parsedEvent.eventType, eventData);
            if (!translated) continue;
            const stopAfterChunk = this.consumeTranslatedChunks(translated, state, onEvent);
            if (stopAfterChunk) {
              shouldStop = true;
              break;
            }
          }

          if (shouldStop) break;
        }

        const tail = decoder.decode();
        if (tail) buffer += tail;

        if (!shouldStop && buffer.trim()) {
          const parsedEvent = this.parseResponsesSseEvent(buffer);
          if (parsedEvent) {
            try {
              onStreamActivity?.(mapOpenAIResponsesEvent(parsedEvent.eventType || 'response.event'));
            } catch (mapperErr) {
              reportRuntimeActivityMapperFailure('codex', mapperErr, {
                rawEventType: parsedEvent.eventType ?? null,
              });
            }
          }
          if (parsedEvent?.data && parsedEvent.data !== '[DONE]') {
            try {
              const eventData = JSON.parse(parsedEvent.data) as Record<string, unknown>;
              const translated = streamTranslator.translateEvent(parsedEvent.eventType, eventData);
              if (translated) {
                this.consumeTranslatedChunks(translated, state, onEvent);
              }
            } catch {
              log.warn({ eventType: parsedEvent.eventType }, 'Failed to parse final Codex SSE event data');
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      this.emitBufferedLateReasoning(state, onEvent);

      const fulfillmentProvider = buildFulfillmentProvider(
        captured.transport,
        captured.serverHints,
        typeof state.model === 'string' && state.model.length > 0,
      );
      return this.toStreamResult(state, fulfillmentProvider);
    } catch (error) {
      if (streamStartTimeout.didTimeout() && !signal?.aborted) {
        log.warn(
          { model: request.model, timeoutMs: STREAM_FIRST_CHUNK_TIMEOUT_MS, provider: this.provider },
          'OpenAI-compatible stream start timed out before first chunk',
        );
        throw new ModelError('server_error', STREAM_FIRST_CHUNK_TIMEOUT_MESSAGE, undefined, this.provider);
      }
      throw error;
    } finally {
      streamStartTimeout.dispose();
    }
  }

  // ── Standard OpenAI routing ─────────────────────────────────

  private resolveFulfillmentTransport(url: string | URL | Request): OpenAiFulfillmentTransport {
    const requestUrl = typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.href
        : url.url;

    const codexEndpoint = this.codexMode?.endpointUrl;
    if (codexEndpoint && normalizeComparableUrl(requestUrl) === normalizeComparableUrl(codexEndpoint)) {
      return 'codex';
    }

    return 'openai-direct';
  }

  private async fetchWithMetadata(
    url: string | URL | Request,
    init: RequestInit,
  ): Promise<{
    response: Response;
    transport: OpenAiFulfillmentTransport;
    serverHints: Record<string, string> | undefined;
  }> {
    const response = await fetch(url, init);
    const transport = this.resolveFulfillmentTransport(url);
    const serverHints = extractAllowlistedServerHints(response.headers);

    return { response, transport, serverHints };
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.defaultHeaders ?? {}),
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private toOpenAIResponseFormat(format: JsonSchemaFormat | undefined): OpenAIResponseFormat | undefined {
    if (!format) return undefined;
    if (!emitsStrictResponseFormat(this.providerType)) return undefined;
    const schema = selectOpenAIPlannerSchema(format);
    return {
      type: 'json_schema',
      json_schema: {
        name: format.name,
        schema,
        strict: true,
      },
    };
  }

  private needsResponsesApiRoute(request: OpenAIRequest): boolean {
    const hasTools = !!request.tools?.length;
    return takesResponsesApiRoute(this.providerType) && hasTools && !!request.reasoning_effort;
  }

  private assertChatCompatibleModel(model: string): void {
    if (!nonChatModelGuardEnabled(this.providerType)) return;

    const normalizedModel = model.trim().toLowerCase();
    const catalogEntry = getCatalogEntryById(normalizedModel);
    if (catalogEntry?.provider === 'openai') return;

    const isKnownNonChatModel = KNOWN_NON_CHAT_OPENAI_MODEL_PATTERNS.some((pattern) => pattern.test(normalizedModel));
    if (!isKnownNonChatModel) return;

    throw new ModelError(
      'invalid_request',
      `OpenAI model "${model}" is not a chat model and cannot be used for Rebel conversations. Choose a chat-capable model in Settings.`,
      undefined,
      this.provider,
    );
  }

  private assertPromptWithinTokenBudget(request: OpenAIRequest): void {
    const estimatedInputTokens = estimateOpenAIRequestTokens(request);
    const { contextWindow } = resolveModelLimits({
      model: request.model,
      allProfiles: getSettings().localModel?.profiles ?? [],
    });
    const maxCompletionTokens = request.max_completion_tokens ?? 0;
    const hardCapTokens = Math.min(RUNAWAY_PROMPT_HARD_CAP_TOKENS, contextWindow * 2);

    if (estimatedInputTokens > hardCapTokens) {
      log.error(
        {
          model: request.model,
          provider: this.provider,
          estimatedInputTokens,
          hardCapTokens,
          contextWindow,
        },
        'Runaway OpenAI-compatible prompt preflight cap exceeded — refusing to send API request',
      );
      throw new ModelError(
        'context_overflow',
        `Prompt is too large to send safely (estimated ${estimatedInputTokens} tokens). Try starting a fresh conversation or narrowing the request.`,
        undefined,
        this.provider,
      );
    }

    if (estimatedInputTokens + maxCompletionTokens > contextWindow * PREFLIGHT_CONTEXT_HEADROOM) {
      throw new ModelError(
        'context_overflow',
        `Prompt is too large for ${request.model}'s context window (estimated ${estimatedInputTokens} input tokens plus ${maxCompletionTokens} output tokens). Try starting a fresh conversation or narrowing the request.`,
        undefined,
        this.provider,
      );
    }
  }

  private async requestCompletion(
    request: OpenAIRequest,
    signal?: AbortSignal,
  ): Promise<{ response: OpenAIResponse; fulfillmentProvider: FulfillmentProvider }> {
    if (this.needsResponsesApiRoute(request)) {
      const responsesRequest = translateChatToResponses(request as unknown as ChatCompletionRequest);
      const responsesResponse = await this.postJson<ResponsesApiResponse>(
        buildResponsesUrl(this.baseURL),
        responsesRequest,
        signal,
      );
      const reasoningContent = extractReasoningFromResponsesJson(responsesResponse.data);
      return {
        response: translateResponsesToChatCompletion(
          responsesResponse.data,
          reasoningContent ? { reasoningContent } : undefined,
        ) as unknown as OpenAIResponse,
        fulfillmentProvider: responsesResponse.fulfillmentProvider,
      };
    }

    const validatedRequest = finalizeChatCompletionsBody(request, {
      modelId: request.model,
      providerType: this.providerType,
      log,
    });
    const completionResponse = await this.postChatCompletionsJson<OpenAIResponse>(
      buildCompletionsUrl(this.baseURL),
      validatedRequest,
      signal,
    );
    return {
      response: completionResponse.data,
      fulfillmentProvider: completionResponse.fulfillmentProvider,
    };
  }

  private async postJson<T>(
    url: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{ data: T; fulfillmentProvider: FulfillmentProvider }> {
    const captured = await this.fetchWithMetadata(url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    const response = captured.response;

    if (!response.ok) {
      const errorBody = await response.text();
      throw classifyHttpError(response.status, errorBody, this.provider);
    }

    const data = (await response.json()) as T;
    const fulfillmentProvider = buildFulfillmentProvider(
      captured.transport,
      captured.serverHints,
      hasModelEcho(data),
    );
    return { data, fulfillmentProvider };
  }

  private async postChatCompletionsJson<T, TBody extends object = object>(
    url: string,
    body: ValidatedChatCompletionsBody<TBody>,
    signal?: AbortSignal,
  ): Promise<{ data: T; fulfillmentProvider: FulfillmentProvider }> {
    return this.postJson<T>(url, body, signal);
  }

  private async streamChatCompletions(
    request: OpenAIRequest,
    signal: AbortSignal | undefined,
    onEvent: (event: StreamEvent) => void,
    onStreamActivity?: (event: RuntimeActivityEvent) => void,
  ): Promise<StreamResult> {
    const streamStartTimeout = this.createStreamStartTimeoutGuard(signal);
    try {
      const validatedRequest = finalizeChatCompletionsBody(request, {
        modelId: request.model,
        providerType: this.providerType,
        log,
      });
      const captured = await this.fetchWithMetadata(buildCompletionsUrl(this.baseURL), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: serializeChatCompletionsBody(validatedRequest),
        signal: streamStartTimeout.signal,
      });
      const response = captured.response;

      if (!response.ok) {
        const errorBody = await response.text();
        throw classifyHttpError(response.status, errorBody, this.provider);
      }

      if (!response.body) {
        throw new ModelError('server_error', 'Streaming response body is empty', response.status, this.provider);
      }

      const state = createOpenAIStreamState();
      await this.consumeChatCompletionStream(
        response.body,
        state,
        onEvent,
        onStreamActivity,
        streamStartTimeout.markFirstChunkReceived,
        request.model,
        signal,
      );
      const fulfillmentProvider = buildFulfillmentProvider(
        captured.transport,
        captured.serverHints,
        typeof state.model === 'string' && state.model.length > 0,
      );
      return this.toStreamResult(state, fulfillmentProvider);
    } catch (error) {
      if (streamStartTimeout.didTimeout() && !signal?.aborted) {
        log.warn(
          { model: request.model, timeoutMs: STREAM_FIRST_CHUNK_TIMEOUT_MS, provider: this.provider },
          'OpenAI-compatible stream start timed out before first chunk',
        );
        throw new ModelError('server_error', STREAM_FIRST_CHUNK_TIMEOUT_MESSAGE, undefined, this.provider);
      }
      throw error;
    } finally {
      streamStartTimeout.dispose();
    }
  }

  private async streamResponses(
    request: OpenAIRequest,
    signal: AbortSignal | undefined,
    onEvent: (event: StreamEvent) => void,
    onStreamActivity?: (event: RuntimeActivityEvent) => void,
  ): Promise<StreamResult> {
    const streamStartTimeout = this.createStreamStartTimeoutGuard(signal);
    const responsesRequest = translateChatToResponses(request as unknown as ChatCompletionRequest);
    try {
      const captured = await this.fetchWithMetadata(buildResponsesUrl(this.baseURL), {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify(responsesRequest),
        signal: streamStartTimeout.signal,
      });
      const response = captured.response;

      if (!response.ok) {
        const errorBody = await response.text();
        throw classifyHttpError(response.status, errorBody, this.provider);
      }

      if (!response.body) {
        throw new ModelError('server_error', 'Responses API stream body is empty', response.status, this.provider);
      }

      const streamTranslator = createStreamTranslator();
      const state = createOpenAIStreamState();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let shouldStop = false;
      let firstChunkSeen = false;

      try {
        for (;;) {
          const readResult = await this.readWithFinishDeadline(reader, state, firstChunkSeen);
          if (readResult === FINISH_DEADLINE_TIMEOUT) {
            state.lateReasoningCapHit = state.lateReasoningCapHit ?? 'time';
            await reader.cancel('late-reasoning-finish-timeout');
            break;
          }
          if (readResult === STREAM_IDLE_TIMEOUT) {
            throw await this.buildStreamIdleError(reader, request.model, signal);
          }
          const { done, value } = readResult;
          if (done) break;
          if (!firstChunkSeen) {
            firstChunkSeen = true;
            streamStartTimeout.markFirstChunkReceived();
          }

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? '';

          for (const rawEvent of events) {
            const parsedEvent = this.parseResponsesSseEvent(rawEvent);
            if (!parsedEvent) continue;

            try {
              onStreamActivity?.(mapOpenAIResponsesEvent(parsedEvent.eventType || 'response.event'));
            } catch (mapperErr) {
              reportRuntimeActivityMapperFailure('openai-responses', mapperErr, {
                rawEventType: parsedEvent.eventType ?? null,
              });
            }

            if (parsedEvent.data === '[DONE]') {
              continue;
            }

            let eventData: Record<string, unknown>;
            try {
              eventData = JSON.parse(parsedEvent.data) as Record<string, unknown>;
            } catch {
              log.warn({ eventType: parsedEvent.eventType }, 'Failed to parse Responses API event payload');
              continue;
            }

            const translated = streamTranslator.translateEvent(parsedEvent.eventType, eventData);
            if (!translated) continue;
            const stopAfterChunk = this.consumeTranslatedChunks(translated, state, onEvent);
            if (stopAfterChunk) {
              shouldStop = true;
              break;
            }
          }

          if (shouldStop) break;
        }

        const tail = decoder.decode();
        if (tail) {
          buffer += tail;
        }

        if (!shouldStop && buffer.trim()) {
          const parsedEvent = this.parseResponsesSseEvent(buffer);
          if (parsedEvent) {
            try {
              onStreamActivity?.(mapOpenAIResponsesEvent(parsedEvent.eventType || 'response.event'));
            } catch (mapperErr) {
              reportRuntimeActivityMapperFailure('openai-responses', mapperErr, {
                rawEventType: parsedEvent.eventType ?? null,
              });
            }
          }
          if (parsedEvent?.data && parsedEvent.data !== '[DONE]') {
            try {
              const eventData = JSON.parse(parsedEvent.data) as Record<string, unknown>;
              const translated = streamTranslator.translateEvent(parsedEvent.eventType, eventData);
              if (translated) {
                this.consumeTranslatedChunks(translated, state, onEvent);
              }
            } catch {
              log.warn({ eventType: parsedEvent.eventType }, 'Failed to parse final Responses API event payload');
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      this.emitBufferedLateReasoning(state, onEvent);

      const fulfillmentProvider = buildFulfillmentProvider(
        captured.transport,
        captured.serverHints,
        typeof state.model === 'string' && state.model.length > 0,
      );
      return this.toStreamResult(state, fulfillmentProvider);
    } catch (error) {
      if (streamStartTimeout.didTimeout() && !signal?.aborted) {
        log.warn(
          { model: request.model, timeoutMs: STREAM_FIRST_CHUNK_TIMEOUT_MS, provider: this.provider },
          'OpenAI-compatible stream start timed out before first chunk',
        );
        throw new ModelError('server_error', STREAM_FIRST_CHUNK_TIMEOUT_MESSAGE, undefined, this.provider);
      }
      throw error;
    } finally {
      streamStartTimeout.dispose();
    }
  }

  private async consumeChatCompletionStream(
    body: ReadableStream<Uint8Array>,
    state: OpenAIStreamState,
    onEvent: (event: StreamEvent) => void,
    onStreamActivity?: (event: RuntimeActivityEvent) => void,
    onFirstChunk?: () => void,
    model?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let shouldStop = false;
    let firstChunkSeen = false;

    try {
      for (;;) {
        const readResult = await this.readWithFinishDeadline(reader, state, firstChunkSeen);
        if (readResult === FINISH_DEADLINE_TIMEOUT) {
          state.lateReasoningCapHit = state.lateReasoningCapHit ?? 'time';
          await reader.cancel('late-reasoning-finish-timeout');
          break;
        }
        if (readResult === STREAM_IDLE_TIMEOUT) {
          throw await this.buildStreamIdleError(reader, model, signal);
        }
        const { done, value } = readResult;
        if (done) break;
        if (!firstChunkSeen) {
          firstChunkSeen = true;
          onFirstChunk?.();
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('data:')) continue;

          const payload = line.slice('data:'.length).trim();
          if (payload === '[DONE]') {
            shouldStop = true;
            break;
          }
          this.handleChatChunkPayload(payload, state, onEvent, onStreamActivity);
          if (state.lateReasoningCapHit) {
            shouldStop = true;
            break;
          }
        }

        if (shouldStop) break;
      }

      const tail = decoder.decode();
      if (tail) {
        buffer += tail;
      }

      if (!shouldStop && buffer.trim().startsWith('data:')) {
        const payload = buffer.trim().slice('data:'.length).trim();
        if (payload !== '[DONE]') {
          this.handleChatChunkPayload(payload, state, onEvent, onStreamActivity);
        }
      }
    } finally {
      reader.releaseLock();
    }

    this.emitBufferedLateReasoning(state, onEvent);
  }

  private handleChatChunkPayload(
    payload: string,
    state: OpenAIStreamState,
    onEvent: (event: StreamEvent) => void,
    onStreamActivity?: (event: RuntimeActivityEvent) => void,
  ): void {
    if (!payload || payload === '[DONE]') return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      log.warn({ payloadPreview: payload.slice(0, 120) }, 'Failed to parse chat completion stream chunk');
      return;
    }

    try {
      onStreamActivity?.(
        mapOpenAIChatChunk(
          parsed as unknown as {
            choices: Array<{ finish_reason: string | null }>;
          },
        ),
      );
    } catch (mapperErr) {
      reportRuntimeActivityMapperFailure('openai-chat', mapperErr, {
        rawEventType: 'chat.completion.chunk',
      });
    }

    const maybeError = parsed as {
      error?: { message?: string; code?: string; type?: string };
      choices?: unknown;
    };
    if (maybeError.error && !maybeError.choices) {
      const { code, type, message } = maybeError.error;
      const errorMessage = message ?? 'OpenAI-compatible streaming error';

      let kind: ModelErrorKind = 'server_error';
      if (code === 'rate_limit_exceeded' || type === 'rate_limit_exceeded') {
        kind = 'rate_limit';
      } else if (
        code === 'insufficient_quota' ||
        type === 'insufficient_quota' ||
        code === 'insufficient_funds' ||
        type === 'insufficient_funds'
      ) {
        kind = 'billing';
      } else if (code === 'invalid_prompt' || type === 'invalid_request_error') {
        kind = classifyStatus(400, errorMessage).kind;
      }

      throw new ModelError(kind, errorMessage, undefined, this.provider);
    }

    const streamEvents = processStreamChunk(parsed as unknown as OpenAIStreamChunk, state);
    for (const event of streamEvents) {
      onEvent(event);
    }
  }

  private parseResponsesSseEvent(rawEvent: string): { eventType: string; data: string } | null {
    const parsed = parseSseEventBlock(rawEvent);
    if (!parsed) return null;
    return {
      eventType: parsed.event,
      data: parsed.data,
    };
  }

  private createStreamStartTimeoutGuard(signal: AbortSignal | undefined): StreamStartTimeoutGuard {
    const timeoutController = new AbortController();
    let timedOut = false;
    let cleared = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, STREAM_FIRST_CHUNK_TIMEOUT_MS);

    const clear = () => {
      if (cleared) return;
      cleared = true;
      clearTimeout(timeoutId);
    };

    if (signal?.aborted) {
      clear();
      return {
        signal,
        markFirstChunkReceived: clear,
        didTimeout: () => false,
        dispose: clear,
      };
    }

    return {
      signal: signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal,
      markFirstChunkReceived: clear,
      didTimeout: () => timedOut,
      dispose: clear,
    };
  }

  private async readWithFinishDeadline(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    state: OpenAIStreamState,
    armIdleDeadline: boolean,
  ): Promise<
    ReadableStreamReadResult<Uint8Array>
    | typeof FINISH_DEADLINE_TIMEOUT
    | typeof STREAM_IDLE_TIMEOUT
  > {
    // Two independent deadlines race the read:
    //   (1) finish deadline (30s) — ONLY armed after `finishReasonSeen`; a
    //       short grace window for late-reasoning trailers. Preserves the
    //       prior graceful-cutoff behavior (FINISH_DEADLINE_TIMEOUT → break).
    //   (2) idle deadline (90s) — armed ONLY once the first chunk has been
    //       received (`armIdleDeadline`), i.e. a true INTER-chunk dead-stream
    //       backstop for the "still streaming" phase where (1) does not apply.
    //       The pre-first-byte phase is intentionally NOT governed here — it
    //       stays under the 5-min STREAM_FIRST_CHUNK_TIMEOUT_MS start guard
    //       (createStreamStartTimeoutGuard, wired via the fetch signal), which
    //       preserves the prior first-byte window for slow-to-start reasoning
    //       models that buffer before emitting any SSE bytes. Surfaces as a
    //       retryable error rather than a graceful end.
    // When both are armed (post-finish, which implies post-first-chunk) the
    // finish deadline is shorter and binds first, so behavior post-
    // `finishReasonSeen` is unchanged. When NEITHER is armed (pre-first-chunk,
    // pre-finish) this is a bare reader.read() — byte-identical to the original.
    const readPromise = reader.read();
    const deadlines: Array<Promise<typeof FINISH_DEADLINE_TIMEOUT | typeof STREAM_IDLE_TIMEOUT>> = [];
    const timeoutIds: Array<ReturnType<typeof setTimeout>> = [];

    if (state.finishReasonSeen) {
      deadlines.push(new Promise((resolve) => {
        timeoutIds.push(setTimeout(() => resolve(FINISH_DEADLINE_TIMEOUT), LATE_REASONING_FINISH_DEADLINE_MS));
      }));
    }
    if (armIdleDeadline) {
      deadlines.push(new Promise((resolve) => {
        timeoutIds.push(setTimeout(() => resolve(STREAM_IDLE_TIMEOUT), STREAM_IDLE_TIMEOUT_MS));
      }));
    }

    try {
      return await Promise.race([readPromise, ...deadlines]);
    } finally {
      for (const id of timeoutIds) {
        clearTimeout(id);
      }
    }
  }

  // Dead-stream handler: the inter-chunk idle deadline fired (no SSE bytes for
  // STREAM_IDLE_TIMEOUT_MS mid-stream). Cancel the (dangling) reader and return
  // a TRANSIENT server_error for the caller to throw, so `runWithRetry`
  // re-issues a fresh request. If the turn was actually aborted by the caller,
  // surface the abort instead — don't mask it as a transient stream failure.
  // The caller throws the returned error (keeps TS control-flow narrowing of
  // the read-result union at the call site).
  private async buildStreamIdleError(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    model: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ModelError> {
    try {
      await reader.cancel('stream-idle-timeout');
    } catch {
      // Best-effort: the socket may already be torn down; cancellation failure
      // must not mask the idle error we are about to surface.
    }
    if (signal?.aborted) {
      return new ModelError('abort', 'Request aborted', undefined, this.provider);
    }
    log.warn(
      { model, idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS, provider: this.provider },
      'OpenAI-compatible stream went idle mid-stream (dead-stream detection); failing transiently for retry',
    );
    return new ModelError('server_error', STREAM_IDLE_TIMEOUT_MESSAGE, undefined, this.provider);
  }

  private emitBufferedLateReasoning(
    state: OpenAIStreamState,
    onEvent: (event: StreamEvent) => void,
  ): void {
    const bufferedEvents = flushLateReasoningBuffer(state);
    for (const event of bufferedEvents) {
      onEvent(event);
    }
  }

  private consumeTranslatedChunks(
    translated: string,
    state: OpenAIStreamState,
    onEvent: (event: StreamEvent) => void,
  ): boolean {
    const lines = translated.split('\n');
    let shouldStop = false;
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice('data:'.length).trim();
      if (payload === '[DONE]') {
        shouldStop = true;
        break;
      }
      this.handleChatChunkPayload(payload, state, onEvent);
      if (state.lateReasoningCapHit) {
        shouldStop = true;
        break;
      }
    }
    return shouldStop;
  }

  private toStreamResult(
    state: OpenAIStreamState,
    fulfillmentProvider?: FulfillmentProvider,
  ): StreamResult {
    // Strip <think> tags before MiniMax XML extraction so tool calls
    // hidden inside think blocks are not incorrectly extracted.
    const strippedContent = state.content
      .map((block) => {
        if (block.type !== 'text') return block;
        return { ...block, text: stripThinkingBlocks(block.text) };
      })
      .filter((block) => block.type !== 'text' || block.text.length > 0);

    const extraction = extractMiniMaxXmlToolCalls(strippedContent, state.messageId ?? '0');
    const content = extraction.hadXmlToolCalls ? extraction.content : strippedContent;

    const hasToolUse = content.some((block) => block.type === 'tool_use');
    let stopReason = state.stopReason === 'unknown' ? (hasToolUse ? 'tool_use' : 'end_turn') : state.stopReason;

    if (extraction.hadXmlToolCalls && stopReason === 'end_turn') {
      stopReason = 'tool_use';
    }

    // Gateway tool-signature diagnostic (observability-only, fail-open): streaming
    // is the suspected-broken path (litellm's stream_chunk_builder drops the
    // signature), so it MUST be measured. Read the OR-accumulated per-call flags;
    // derive `idEmbedded` from the final assembled tool-call id. Presence ONLY —
    // the signature VALUE is never extracted/logged/emitted.
    emitGatewayToolSignatureObserved({
      shouldEmit: surfacesCustomGatewayToolSignature(this.providerType),
      providerType: this.providerType,
      provider: this.provider,
      modelId: state.model ?? 'unknown',
      streaming: true,
      aggregate: aggregatePreClassifiedSignatures(
        Array.from(state.toolCalls.values(), (tc) => ({
          idEmbedded: tc.id.includes(LITELLM_THOUGHT_ID_DELIMITER),
          providerSpecificFields: tc.sawProviderSpecificFields,
          extraContent: tc.sawExtraContent,
        })),
      ),
    });

    return {
      content,
      stopReason,
      usage: {
        ...state.usage,
        ...(fulfillmentProvider ? { fulfillmentProvider } : {}),
      },
      model: state.model || undefined,
    };
  }
}
