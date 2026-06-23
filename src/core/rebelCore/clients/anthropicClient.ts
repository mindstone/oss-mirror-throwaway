/**
 * Anthropic provider client — translates between the Anthropic Messages API
 * format and Rebel Core's internal types (modelTypes.ts / modelClient.ts).
 */
import { Anthropic } from '@anthropic-ai/sdk';
import type {
  ContentBlock as AnthropicContentBlock,
  Message,
  MessageParam as AnthropicMessageParam,
  TextBlockParam,
  Tool as AnthropicTool,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { createScopedLogger, getTurnContext } from '@core/logger';
import { turnObservability } from '@core/services/turnObservability';
import { getErrorReporter } from '@core/errorReporter';
import type { FulfillmentProvider } from '@shared/types/providerMetadata';
import type { RoutingModelId } from '@shared/utils/modelChoiceCodec';
// Direct module import (NOT via any barrel) — barrel imports have perturbed
// unrelated vitest mocks before; see MEMORY ipc-contract-harness lesson.
import { modelSupportsImageInput } from '@shared/data/modelCatalog';
import type { WireModelId } from '@shared/utils/wireModelId';
import { mintAnthropicWireModel, mintOpenRouterPassthroughModel } from '@shared/utils/wireModelId';
import type { TokenUsage } from '../types';
import { getEffectiveInputTokens } from '../types';
import type { ProviderCapabilities } from '../contextPolicy';
import type {
  ModelClient,
  ModelClientConfig,
  CreateParams,
  CreateResult,
  JsonSchemaFormat,
  RetryInfo,
  StreamParams,
  StreamResult,
  StreamEvent,
} from '../modelClient';
import { isResultAffectingStreamEvent } from '../modelClient';
import type { ChatMessage, ContentBlock, SystemPrompt, ToolDefinition, ToolResultBlock } from '../modelTypes';
import { ModelError, classifyError, type ToolInputTooLargeDetails } from '../modelErrors';
import { resolveModelLimits, supportsCompact } from '../modelLimits';
import { assertWireSafeForAlwaysOnThinking } from '../alwaysOnThinkingWireSafety';
import { getSettings } from '@core/services/settingsStore';
import {
  buildOfflineFailFastError,
  isOfflineFailFastEnabled,
  probeOfflineOnce,
} from './offlineFailFast';
import type { ProviderRoutePlan } from '../providerRoutePlan';
import { mapAnthropicStreamEvent } from '../runtimeActivity';
import { reportRuntimeActivityMapperFailure } from './runtimeActivityMapperReporter';
import { getAssetStore } from '@core/assetStore';
import { hydrateImageRef } from '@core/services/imageHydration';
import type { TurnScopedHydrationCache } from '@core/services/imageHydrationCache';
import { getContentStore } from '@core/contentStore';
import {
  hydrateContentRef,
  isHydratedContent,
  applyTruncationForBudget,
  type HydratedTextBlock,
  type ContentDownloader,
} from '@core/services/contentHydration';
import { TurnScopedContentHydrationCache } from '@core/services/contentHydrationCache';
import { boundToolOutputForSafety } from '@core/services/contentTruncation';
import {
  checkInlineImageWithinLimits,
  buildOversizedImagePlaceholder,
  buildVisionUnsupportedImagePlaceholder,
  buildVisionUnsupportedAttachmentPlaceholder,
} from '@core/utils/fileTypeDetection';
import type { ContentRef } from '@shared/types/agent';

/**
 * Conservative byte budget for Anthropic provider context. ~180k tokens at
 * ~4 bytes/token. Used as the post-hydration truncation ceiling for
 * `content_ref`-derived text. See Stage B1b § truncation policy.
 */
const ANTHROPIC_CONTENT_BUDGET_BYTES = 180_000 * 4;

const log = createScopedLogger({ service: 'anthropicClient' });

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;

/**
 * Centralized escape hatch for Anthropic SDK beta APIs that are not yet
 * represented by ModelClient. Callers must pass a ProviderRoutePlan and should
 * first check ensureDirectAnthropicCapable(plan); this helper also fails closed
 * so bare SDK construction stays isolated to this wrapper module.
 */
export function createAnthropicSdkClientForDirectPlan(
  plan: ProviderRoutePlan,
  options?: { defaultHeaders?: Record<string, string> },
): Anthropic {
  // eslint-disable-next-line no-restricted-syntax -- non-routing kind discriminator: ProviderAuthPlan.auth.kind ('api-key' vs 'oauth-token')
  if (plan.decision.transport !== 'anthropic-direct' || plan.auth.kind !== 'api-key' || !plan.auth.apiKey) {
    throw new ModelError(
      'invalid_request',
      `Direct Anthropic SDK client requires an anthropic-direct api-key plan; got ${plan.decision.transport}/${plan.auth.kind}.`,
      undefined,
      'Anthropic',
    );
  }
  return new Anthropic({
    apiKey: plan.auth.apiKey,
    ...(options?.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
  });
}

/**
 * Per-`tool_use` byte cap on accumulated `input_json_delta` bytes during
 * streaming. Prevents the provider-side stall class where a model emits
 * tens of kilobytes of inline base64 in a single tool input and the stream
 * silently halts mid-delta.
 *
 * Default 256 KiB keeps a local safety valve for pathological streams while
 * leaving headroom for legitimate large tool inputs (for example inline image
 * data) that can exceed the earlier 96 KiB guard by only a few bytes.
 *
 * Calibration (from 443-transcript corpus analysis, 7,684 completed tool
 * calls, see `260423_agent_to_tool_file_ref_sentinel.md`):
 *  - Empirical max legitimate `partial_json`: 46.8 KiB (`Write`)
 *  - Zero legitimate calls above 64 KiB; only 9 calls above 32 KiB
 *  - P99.9 × 1.5 ≈ 68.9 KiB
 *  - 256 KiB = 5.47× over empirical legit max, enough to avoid borderline
 *    false positives while still bounding runaway partial_json streams.
 *
 * False-positive surface is accepted in exchange for catching the bug
 * class. `REBEL_STREAM_CAP_BYTES` env override exists for emergency
 * tuning without a release; set to `0` to disable enforcement (emits
 * breadcrumbs only) for diagnosis or if a legitimate workload pattern
 * outgrows the default.
 */
const DEFAULT_STREAM_CAP_BYTES = 256 * 1024;

function getStreamCapBytes(): number {
  const raw = typeof process !== 'undefined' ? process.env?.REBEL_STREAM_CAP_BYTES : undefined;
  if (raw === undefined || raw === '') return DEFAULT_STREAM_CAP_BYTES;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_STREAM_CAP_BYTES;
  return parsed;
}

/** Fraction of the cap at which a "near cap" breadcrumb fires. */
const NEAR_CAP_BREADCRUMB_THRESHOLD = 0.5;

/** Per-block byte tracking state for the stream cap enforcer. @internal */
export interface ToolInputCapState {
  name: string;
  id: string;
  bytes: number;
  nearCapFired: boolean;
}

/**
 * Decision returned by {@link recordToolInputDelta}. `'continue'` means the
 * stream may proceed; `'near_cap'` means a breadcrumb should be emitted and
 * tracking continues; `'exceeded'` means the cap was breached and the
 * caller must abort the stream and throw `ModelError('tool_input_too_large')`.
 *
 * @internal Exported for testing.
 */
export type ToolInputCapDecision =
  | { action: 'continue' }
  | { action: 'near_cap'; toolName: string; bytesAccumulated: number }
  | { action: 'exceeded'; details: ToolInputTooLargeDetails };

/**
 * Core cap-check step. Mutates `state.bytes` / `state.nearCapFired`.
 * Pure w.r.t. the outside world — caller handles logging, breadcrumbs,
 * and stream-abort side effects.
 *
 * @internal Exported for testing.
 */
export function recordToolInputDelta(
  state: ToolInputCapState,
  partialJsonLen: number,
  capBytes: number,
  blockIndex: number,
  nearCapFraction: number = NEAR_CAP_BREADCRUMB_THRESHOLD,
): ToolInputCapDecision {
  if (capBytes <= 0 || partialJsonLen <= 0) return { action: 'continue' };

  state.bytes += partialJsonLen;

  if (state.bytes > capBytes) {
    return {
      action: 'exceeded',
      details: {
        toolName: state.name,
        toolUseId: state.id,
        bytesAccumulated: state.bytes,
        capBytes,
        blockIndex,
      },
    };
  }

  if (!state.nearCapFired && state.bytes >= capBytes * nearCapFraction) {
    state.nearCapFired = true;
    return {
      action: 'near_cap',
      toolName: state.name,
      bytesAccumulated: state.bytes,
    };
  }

  return { action: 'continue' };
}

/** @internal Exported for testing. */
export function resolveStreamCapBytes(): number {
  return getStreamCapBytes();
}

const sleep = (ms: number, signal?: AbortSignal, provider?: string): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelError('abort', 'Operation was aborted', undefined, provider));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new ModelError('abort', 'Operation was aborted', undefined, provider));
    }, { once: true });
  });

/**
 * Map Anthropic usage to our TokenUsage type.
 * @param responseCost - OpenRouter's usage.cost extracted from the raw HTTP response
 *   (before the SDK strips non-standard fields). Falls back to checking message.usage.cost
 *   in case the SDK preserves it (e.g. for streaming finalMessage).
 */
const ANTHROPIC_DIRECT_SERVER_HINT_KEYS = ['cf-ray', 'x-served-by'] as const;

const hasModelEcho = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const model = (value as { model?: unknown }).model;
  return typeof model === 'string' && model.trim().length > 0;
};

const extractServerHintsFromHeaders = (
  headers: Headers,
  keys: ReadonlyArray<string>,
): Record<string, string> | undefined => {
  const hints: Record<string, string> = {};
  for (const key of keys) {
    const value = headers.get(key);
    if (typeof value === 'string' && value.length > 0) {
      hints[key] = value;
    }
  }
  return Object.keys(hints).length > 0 ? hints : undefined;
};

const buildAnthropicDirectFulfillmentProvider = (
  serverHints: Record<string, string> | undefined,
  bodyModelEchoPresent: boolean,
): FulfillmentProvider => ({
  name: null,
  transport: 'anthropic-direct',
  source: serverHints
    ? 'response-headers-hints'
    : bodyModelEchoPresent
      ? 'response-body-echo'
      : 'unknown',
  ...(serverHints ? { serverHints } : {}),
});

/**
 * Extract metadata that must be captured from raw HTTP responses before the SDK
 * normalizes payloads.
 *
 * @internal Exported for testing.
 */
export async function captureAnthropicResponseMetadata(
  response: Response,
  options: { isOpenRouterPassthrough: boolean },
): Promise<{
  responseCost?: number;
  responseProvider?: string;
  fulfillmentProvider?: FulfillmentProvider;
}> {
  const contentType = response.headers.get('content-type') ?? '';
  const isOpenRouterPassthrough = options.isOpenRouterPassthrough;
  let responseCost: number | undefined;
  const orProviderHeader = response.headers.get('x-rebel-or-provider');
  let responseProvider = typeof orProviderHeader === 'string' && orProviderHeader
    ? orProviderHeader
    : undefined;
  const directServerHints = isOpenRouterPassthrough
    ? undefined
    : extractServerHintsFromHeaders(response.headers, ANTHROPIC_DIRECT_SERVER_HINT_KEYS);
  let bodyModelEchoPresent = false;

  if (contentType.includes('application/json')) {
    try {
      const json = await response.clone().json();
      const cost = json?.usage?.cost;
      if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
        responseCost = cost;
      }

      if (!responseProvider && typeof json?.provider === 'string' && json.provider) {
        responseProvider = json.provider;
      }

      bodyModelEchoPresent = hasModelEcho(json);
    } catch {
      // Ignore parse failures; callers still receive header-derived capture.
    }
  }

  const fulfillmentProvider = isOpenRouterPassthrough
    ? undefined
    : buildAnthropicDirectFulfillmentProvider(directServerHints, bodyModelEchoPresent);

  return {
    ...(responseCost !== undefined ? { responseCost } : {}),
    ...(responseProvider ? { responseProvider } : {}),
    ...(fulfillmentProvider ? { fulfillmentProvider } : {}),
  };
}

const mapUsage = (
  message: Message,
  responseCost?: number,
  responseProvider?: string,
  responseFulfillmentProvider?: FulfillmentProvider,
): TokenUsage => {
  const fulfillmentProvider = responseFulfillmentProvider && responseFulfillmentProvider.source === 'unknown' && hasModelEcho(message)
    ? { ...responseFulfillmentProvider, source: 'response-body-echo' as const }
    : responseFulfillmentProvider;
  const orCost = responseCost ?? (message.usage as unknown as Record<string, unknown>).cost;
  const hasExactCost = typeof orCost === 'number' && Number.isFinite(orCost) && orCost >= 0;
  if (hasExactCost) {
    log.debug({ exactCostUsd: orCost, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens }, 'OpenRouter exact cost extracted');
  }
  return {
    inputTokens: message.usage.input_tokens ?? 0,
    outputTokens: message.usage.output_tokens ?? 0,
    cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
    ...(hasExactCost ? { exactCostUsd: orCost } : {}),
    ...(responseProvider ? { openRouterProvider: responseProvider } : {}),
    ...(fulfillmentProvider ? { fulfillmentProvider } : {}),
  };
};

type AnthropicBase64ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

const SUPPORTED_ANTHROPIC_IMAGE_MEDIA_TYPES = new Set<AnthropicBase64ImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const toAnthropicMediaType = (mimeType: string): AnthropicBase64ImageMediaType | null => (
  SUPPORTED_ANTHROPIC_IMAGE_MEDIA_TYPES.has(mimeType as AnthropicBase64ImageMediaType)
    ? mimeType as AnthropicBase64ImageMediaType
    : null
);

type AnthropicToolResultPart =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: AnthropicBase64ImageMediaType; data: string } };

const toAnthropicToolResultContent = async (
  content: ToolResultBlock['content'],
  // REQUIRED, no fail-open default: an omitted capability silently sent images
  // to text-only models — the exact lying-default shape behind the 260610
  // image-unsupported-by-model incident (DA F4).
  supportsImageContent: boolean,
  sessionId?: string,
  hydrationCache?: TurnScopedHydrationCache,
  contentHydrationCache?: TurnScopedContentHydrationCache,
  cloudClient?: ContentDownloader,
  hydratedTextBlocks?: HydratedTextBlock[],
): Promise<ToolResultBlock['content'] | AnthropicToolResultPart[]> => {
  // Stage 2 (guard-large-tool-outputs): tool_result content reconstructed from
  // EXISTING history can carry pre-fix raw megabytes (a plain string, or a
  // persisted text block) that bypass the Stage 1 fresh-result cap on replay.
  // Bound each provider-bound text source by the same 200 KiB cap. Idempotent:
  // already-bounded text is under the cap and passes through unchanged.
  if (typeof content === 'string') {
    return boundToolOutputForSafety(content, false).output;
  }
  if (!Array.isArray(content)) return '';

  const result: AnthropicToolResultPart[] = [];
  // Stage 5: number replayed image placeholders by their position among image
  // blocks, mirroring the fresh boundary's per-image index.
  let imageIndex = 0;

  for (const part of content as unknown as Array<Record<string, unknown>>) {
    if (part.type === 'text' && typeof part.text === 'string') {
      result.push({ type: 'text' as const, text: boundToolOutputForSafety(part.text, false).output });
      continue;
    }

    if (
      part.type === 'content_ref'
      && part.contentRef
      && typeof part.contentRef === 'object'
    ) {
      const ref = part.contentRef as ContentRef;
      if (sessionId && contentHydrationCache) {
        const hydrated = await hydrateContentRef(ref, sessionId, {
          contentStore: getContentStore(),
          cache: contentHydrationCache,
          ...(cloudClient ? { cloudClient } : {}),
          log,
        });

        if (isHydratedContent(hydrated)) {
          // Stage 2: cap the model-facing hydration of a content_ref. The full
          // bytes remain in the ContentStore for persistence/recoverability;
          // only the text replayed to the provider is bounded by the 200 KiB
          // cap. (The downstream budget pass may shrink it further, but never
          // grows it back.)
          const text = boundToolOutputForSafety(hydrated.bytes.toString('utf8'), false).output;
          const blockIndex = result.length;
          const textBlock: AnthropicToolResultPart = { type: 'text', text };
          result.push(textBlock);
          if (hydratedTextBlocks) {
            const hydratedBlock: HydratedTextBlock = {
              index: blockIndex,
              contentRef: ref,
              text,
              byteSize: Buffer.byteLength(text, 'utf8'),
            };
            hydratedTextBlocks.push(hydratedBlock);
            (textBlock as unknown as Record<string, unknown>).__hydratedBlock = hydratedBlock;
          }
          continue;
        }

        result.push({ type: 'text', text: `[Tool output unavailable: ${hydrated.reason}]` });
        continue;
      }

      const fallbackSummary = typeof part.summary === 'string' ? part.summary : '';
      result.push({
        type: 'text',
        text: fallbackSummary || `[Tool output unavailable: pending-upload]`,
      });
      continue;
    }

    if (part.type === 'image') {
      const currentImageIndex = imageIndex;
      imageIndex += 1;
      let data = typeof part.data === 'string' ? part.data : undefined;
      let mimeType = typeof part.mimeType === 'string' ? part.mimeType : undefined;
      const imageRef = part.imageRef as Parameters<typeof hydrateImageRef>[0] | undefined;

      if (!data && imageRef && sessionId && hydrationCache) {
        const hydrated = await hydrateImageRef(imageRef, sessionId, {
          assetStore: getAssetStore(),
          cache: hydrationCache,
          providerKey: 'anthropic',
          maxBytes: 5 * 1024 * 1024,
          log
        });

        if ('data' in hydrated) {
          data = hydrated.data;
          mimeType = hydrated.mimeType;
        } else {
          result.push({ type: 'text', text: `[image unavailable: ${hydrated.reason}]` });
          continue;
        }
      } else if (!data) {
        result.push({ type: 'text', text: '[image unavailable: pending-sync]' });
        continue;
      }

      if (!mimeType) mimeType = 'image/png';

      // Stage 5 (guard-large-tool-outputs): apply the SAME universal image guard
      // to REPLAYED/historical inline image blocks as the fresh model-facing
      // boundary (`buildModelFacingToolResultContent`). Persisted raw
      // `imageContent` (incl. pre-fix oversized images, or images bound for a
      // now-non-vision provider after a model switch) is reconstructed here on
      // later turns and would otherwise be sent uncapped/unsupported. The
      // ContentStore/persistence of the raw image is untouched — only this
      // provider-bound replay is bounded, exactly as Stage 2 did for text.
      if (!supportsImageContent) {
        result.push({
          type: 'text' as const,
          text: buildVisionUnsupportedImagePlaceholder(currentImageIndex),
        });
        continue;
      }

      const verdict = checkInlineImageWithinLimits(data, mimeType);
      if (!verdict.ok) {
        result.push({
          type: 'text' as const,
          text: buildOversizedImagePlaceholder(currentImageIndex, verdict.reason),
        });
        continue;
      }

      const mediaType = toAnthropicMediaType(mimeType);
      if (!mediaType) {
        log.warn(
          { mimeType },
          'Unsupported image mime type for Anthropic tool_result image block; substituting text',
        );
        result.push({
          type: 'text' as const,
          text: `[Unsupported image mime type: ${mimeType}]`,
        });
      } else {
        result.push({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: mediaType,
            data,
          },
        });
      }
    }
  }

  return result;
};

const TOOL_RESULT_UNAVAILABLE_MESSAGE = 'Tool result unavailable';

const getToolUseIds = (message: ChatMessage): string[] => {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'tool_use' }> =>
      block.type === 'tool_use' && typeof block.id === 'string' && block.id.length > 0,
    )
    .map((block) => block.id);
};

const getToolResultIds = (message: ChatMessage | undefined): Set<string> => {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) {
    return new Set();
  }

  return new Set(
    message.content
      .filter((block): block is ToolResultBlock =>
        block.type === 'tool_result' && typeof block.tool_use_id === 'string',
      )
      .map((block) => block.tool_use_id),
  );
};

const buildSyntheticToolResults = (toolUseIds: string[]): ToolResultBlock[] =>
  toolUseIds.map((toolUseId) => ({
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: TOOL_RESULT_UNAVAILABLE_MESSAGE,
    is_error: true,
  }));

/**
 * Anthropic rejects a history where an assistant `tool_use` is not immediately
 * followed by a user `tool_result` for the same id. Older persisted histories
 * can be malformed, so repair them just before provider translation instead of
 * sending an invalid request.
 */
function sanitizeMissingToolResults(messages: ChatMessage[]): ChatMessage[] {
  const sanitized: ChatMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    sanitized.push(message);

    const toolUseIds = getToolUseIds(message);
    if (toolUseIds.length === 0) continue;

    const nextMessage = messages[index + 1];
    const existingResultIds = getToolResultIds(nextMessage);
    const missingToolUseIds = toolUseIds.filter((toolUseId) => !existingResultIds.has(toolUseId));
    if (missingToolUseIds.length === 0) continue;

    const syntheticToolResults = buildSyntheticToolResults(missingToolUseIds);
    log.warn(
      { missingToolUseIds, messageIndex: index },
      'Inserted synthetic Anthropic tool_result blocks for malformed history',
    );

    if (nextMessage?.role === 'user') {
      const nextContent: ContentBlock[] = Array.isArray(nextMessage.content)
        ? [...syntheticToolResults, ...nextMessage.content]
        : [...syntheticToolResults, { type: 'text', text: nextMessage.content }];
      sanitized.push({ ...nextMessage, content: nextContent });
      index += 1;
    } else {
      sanitized.push({ role: 'user', content: syntheticToolResults });
    }
  }

  return sanitized;
}

export const toAnthropicMessages = async (
  messages: ChatMessage[],
  // REQUIRED, no fail-open default (DA F4): callers must resolve the
  // per-model capability (`capabilities.supportsImageContent(params.model)`).
  supportsImageContent: boolean,
  sessionId?: string,
  hydrationCache?: TurnScopedHydrationCache,
  contentHydrationCache?: TurnScopedContentHydrationCache,
  cloudClient?: ContentDownloader,
): Promise<AnthropicMessageParam[]> => {
  const sanitized = sanitizeMissingToolResults(messages);
  const result: AnthropicMessageParam[] = [];
  const hydratedTextBlocks: HydratedTextBlock[] = [];

  for (const message of sanitized) {
    if (!Array.isArray(message.content)) {
      result.push(message as unknown as AnthropicMessageParam);
      continue;
    }

    const mappedContent = [];
    // Stage 3 (260610 image-unsupported-by-model): user-attached/DIRECT image
    // blocks (Anthropic source format, built by agentTurnUtils) must obey the
    // same per-model vision gate as tool_result images — same class, different
    // ingress. The neutral ContentBlock union doesn't name this block type, so
    // detect it structurally. SUBSTITUTE, never drop (postmortem
    // 260506_openai_translator_user_image_block_drop): translate-time only —
    // persisted history keeps the real image for a later vision-capable model.
    let directImageIndex = 0;
    for (const block of message.content) {
      if (block.type !== 'tool_result') {
        if ((block as { type?: unknown }).type === 'image') {
          const currentIndex = directImageIndex;
          directImageIndex += 1;
          if (!supportsImageContent) {
            mappedContent.push({
              type: 'text' as const,
              text: buildVisionUnsupportedAttachmentPlaceholder(currentIndex),
            });
            continue;
          }
        }
        mappedContent.push(block);
        continue;
      }

      mappedContent.push({
        ...block,
        content: await toAnthropicToolResultContent(
          block.content,
          supportsImageContent,
          sessionId,
          hydrationCache,
          contentHydrationCache,
          cloudClient,
          hydratedTextBlocks,
        ),
      });
    }

    result.push({
      ...message,
      content: mappedContent,
    } as unknown as AnthropicMessageParam);
  }

  if (sessionId && hydratedTextBlocks.length > 0) {
    applyTruncationForBudget(hydratedTextBlocks, {
      budgetBytes: ANTHROPIC_CONTENT_BUDGET_BYTES,
      usedBytes: 0,
      log,
      sessionId,
    });
    rewriteHydratedTextBlocks(result);
  }

  return result;
};

/**
 * Walk through the translated message tree and copy each hydrated text
 * block's (possibly post-truncation) text back into the wire-shape text
 * block. The sentinel `__hydratedBlock` is set at hydration time and
 * stripped here so it never reaches the provider API.
 */
function rewriteHydratedTextBlocks(messages: AnthropicMessageParam[]): void {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content as unknown as Array<Record<string, unknown>>) {
      if (block.type !== 'tool_result') continue;
      const content = block.content;
      if (!Array.isArray(content)) continue;
      for (const part of content as Array<Record<string, unknown>>) {
        const hydrated = part.__hydratedBlock as HydratedTextBlock | undefined;
        if (part.type === 'text' && hydrated) {
          part.text = hydrated.text;
          delete part.__hydratedBlock;
        }
      }
    }
  }
}

const toAnthropicTools = (tools?: ToolDefinition[]): AnthropicTool[] | undefined =>
  tools as unknown as AnthropicTool[] | undefined;

const toAnthropicSystemPrompt = (systemPrompt: SystemPrompt): string | TextBlockParam[] =>
  systemPrompt as unknown as string | TextBlockParam[];

const toNeutralContent = (content: AnthropicContentBlock[]): ContentBlock[] =>
  content as unknown as ContentBlock[];

/**
 * Strip the neutral `name` field from a JsonSchemaFormat — Anthropic's
 * `output_config.format` only accepts `{ type, schema }`. The name lives in
 * the neutral type for OpenAI's `response_format.json_schema.name`.
 */
const toAnthropicJsonFormat = (format: JsonSchemaFormat): { type: 'json_schema'; schema: Record<string, unknown> } => ({
  type: 'json_schema',
  schema: format.schema,
});

// See contextPreservation.ts for the shared 6-category preservation schema.
import { formatPreservationInstructions } from '../contextPreservation';

/**
 * REBEL-51K: Anthropic rejects compact_20260112 for Haiku and older/smaller
 * Claude models. Keep the compact beta behind an explicit model capability
 * gate even when the user-level experimental flag is enabled.
 *
 * [BUG-PREVENTION] This function is intentionally per-Claude-model, NOT
 * per-route. Compaction support is a Claude-model-version capability (e.g.,
 * Sonnet 4.6 supports it; Sonnet 4.5 doesn't), not a provider/transport
 * capability. The per-model regex stays here; do NOT migrate to
 * `providerFeatureGuards.ts`. See
 * docs/plans/260505_typed_provider_capability_matrix.md Stage 2f.
 *
 * @internal Exported for testing.
 */
export function modelSupportsAnthropicCompact(model: string): boolean {
  let cleanModel = model.replace(/\[1[mM]\]$/, '').trim();
  if (cleanModel.startsWith('anthropic/')) {
    cleanModel = cleanModel.slice('anthropic/'.length);
  }
  if (/^claude-/i.test(cleanModel)) {
    cleanModel = cleanModel.replace(/(\d)\.(\d)/g, '$1-$2');
  }
  return supportsCompact(cleanModel);
}

/**
 * Resolve the model id this client will put in the wire request body. Direct
 * Anthropic rejects OpenRouter-style namespaced ids (`anthropic/...`,
 * `deepseek/...`, etc.); OpenRouter passthrough requires them. Caller signals
 * OR-passthrough via the `x-openrouter-turn: 'true'` request header at client
 * construction time (see providerRouteHeaders.ts), and this resolver gates on
 * that flag rather than baseURL (which test paths normalise).
 *
 * Direct path: strip a leading `anthropic/` prefix; fail-closed on any other
 * slashed prefix (mis-routed call). OpenRouter path: pass through unchanged.
 *
 * @internal Exported for testing.
 */
export function resolveAnthropicWireModel(
  model: RoutingModelId,
  isOpenRouterPassthrough: boolean,
  provider: string,
): WireModelId {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new ModelError('invalid_request', 'Anthropic model id is empty', undefined, provider);
  }
  if (isOpenRouterPassthrough) {
    return mintOpenRouterPassthroughModel(model);
  }
  if (trimmed.startsWith('anthropic/')) {
    const stripped = trimmed.slice('anthropic/'.length);
    if (!stripped || stripped.includes('/')) {
      throw new ModelError(
        'invalid_request',
        `Invalid direct-Anthropic model id "${model}"`,
        undefined,
        provider,
      );
    }
    // Normalize dotted aliases (e.g. `claude-opus-4.7` -> `claude-opus-4-7`)
    // at the wire boundary so eval harnesses or other callers that pass
    // legacy/dotted ids end up with the canonical SDK form Anthropic accepts
    // on the wire. (This is the single owner of that normalization now that
    // the legacy `clientFactory.stripAnthropicPrefix` Claude-ish predicate was
    // folded into the `resolveDirectAnthropicModel` chokepoint, whose boolean
    // result never used the normalized string.)
    return mintAnthropicWireModel(model);
  }
  if (trimmed.includes('/')) {
    throw new ModelError(
      'invalid_request',
      `Direct-Anthropic client received non-Anthropic namespaced model id "${model}"; routing mismatch`,
      undefined,
      provider,
    );
  }
  return mintAnthropicWireModel(model);
}

/**
 * Build model-aware context_management config with two edit layers:
 * 1. clear_tool_uses — free pruning of old tool pairs at 50% context window
 * 2. compact — server-side summarization at 75% context window
 * Trigger thresholds are proportional to the model's context window.
 */
function buildContextManagementConfig(model: string, options?: { includeCompact?: boolean }) {
  const { contextWindow } = resolveModelLimits({
    model,
    allProfiles: getSettings().localModel?.profiles ?? [],
  });
  const edits: Array<Record<string, unknown>> = [
    {
      type: 'clear_tool_uses_20250919',
      trigger: { type: 'input_tokens', value: Math.round(contextWindow * 0.5) },
      keep: { type: 'tool_uses', value: 10 },
      clear_at_least: { type: 'input_tokens', value: Math.round(contextWindow * 0.1) },
      clear_tool_inputs: true,
      exclude_tools: ['Read', 'rebel_search_files', 'WebSearch', 'WebFetch', 'SearchFiles', 'Glob', 'LS'],
    },
  ];

  if ((options?.includeCompact ?? false) && modelSupportsAnthropicCompact(model)) {
    edits.push({
      type: 'compact_20260112',
      trigger: { type: 'input_tokens', value: Math.round(contextWindow * 0.75) },
      instructions: formatPreservationInstructions(),
    });
  }

  return { edits };
}

/**
 * Detect Anthropic invalid-request rejections for the `compact_20260112`
 * context-management edit type. Anchor on the stable API identifier
 * (`compact_20260112`) + invalid-request/400 structural signal, not exact
 * human prose, because Anthropic reworded the message (REBEL-52B).
 *
 * @internal Exported for testing.
 */
export function isCompactNotSupportedError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return false;
  if (!message.includes('compact_20260112')) return false;

  const status = (
    typeof error === 'object'
    && error !== null
    && 'status' in error
    && typeof (error as { status?: unknown }).status === 'number'
  ) ? (error as { status: number }).status : undefined;

  return (
    status === 400
    || message.includes('invalid_request')
    || /400/.test(message)
    || /does not support/i.test(message)
    || /does not match/i.test(message)
    || /expected tags/i.test(message)
  );
}

/**
 * Extract SSE line data, looking for cost in `usage.cost` fields.
 * @internal Exported for testing.
 */
export function extractCostFromSseLine(line: string): number | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    const cost = parsed?.usage?.cost;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) {
      return cost;
    }
  } catch { /* ignore non-JSON SSE lines */ }
  return null;
}

/**
 * Extract OpenRouter upstream provider from an SSE data line.
 * OpenRouter includes a `provider` field in SSE chunks (e.g. `"provider":"openai"`).
 * @internal Exported for testing.
 */
export function extractProviderFromSseLine(line: string): string | null {
  if (!line.startsWith('data: ')) return null;
  const data = line.slice(6).trim();
  if (data === '[DONE]') return null;
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed?.provider === 'string' && parsed.provider) {
      return parsed.provider;
    }
  } catch { /* ignore non-JSON SSE lines */ }
  return null;
}

/**
 * Create a TransformStream that passes SSE chunks through unchanged while
 * extracting `usage.cost` and `provider` from SSE data lines.
 * Last extracted cost wins (OpenRouter may send cost in intermediate and final message_delta events).
 * First extracted provider wins (provider is consistent across chunks).
 *
 * @param onCost - Called with extracted cost value
 * @param onFlush - Called when stream completes (for missing-cost warnings)
 * @param onProvider - Called with extracted OpenRouter upstream provider
 * @internal Exported for testing.
 */
export function createSseCostExtractor(
  onCost: (cost: number) => void,
  onFlush?: () => void,
  onProvider?: (provider: string) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let providerExtracted = false;

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      sseBuffer += decoder.decode(chunk, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const cost = extractCostFromSseLine(line);
        if (cost !== null) onCost(cost);
        if (!providerExtracted && onProvider) {
          const provider = extractProviderFromSseLine(line);
          if (provider !== null) {
            providerExtracted = true;
            onProvider(provider);
          }
        }
      }
    },
    flush() {
      const remaining = sseBuffer + decoder.decode();
      if (remaining.trim()) {
        for (const line of remaining.split('\n')) {
          const cost = extractCostFromSseLine(line);
          if (cost !== null) onCost(cost);
          if (!providerExtracted && onProvider) {
            const provider = extractProviderFromSseLine(line);
            if (provider !== null) {
              providerExtracted = true;
              onProvider(provider);
            }
          }
        }
      }
      onFlush?.();
    },
  });
}

export class AnthropicClient implements ModelClient {
  private readonly client: Anthropic;
  private readonly provider: string;
  private readonly enableContextManagement: boolean;
  private readonly enableCompact: boolean;
  /**
   * True when this client was constructed with OpenRouter routing headers
   * (x-openrouter-turn: 'true'). Used by `resolveAnthropicWireModel` to decide
   * whether to strip OpenRouter-style `anthropic/` prefixes from the model id
   * before sending to Anthropic-direct, vs preserving them for OR passthrough.
   */
  private readonly isOpenRouterPassthrough: boolean;

  /** Extracted from the raw HTTP response before the SDK strips non-standard fields. */
  private lastResponseCost: number | undefined;
  /** OpenRouter upstream provider extracted from response (e.g. 'Anthropic', 'Google'). */
  private lastResponseProvider: string | undefined;
  /** Structured direct-transport fulfillment metadata extracted from response headers/body. */
  private lastFulfillmentProvider: FulfillmentProvider | undefined;

  /**
   * Sticky for the lifetime of this client instance. Set to true the first
   * time the API rejects `compact_20260112`; subsequent
   * requests on this same client skip the compact edit entirely.
   *
   * Important scope clarification: `agentTurnExecutor` constructs a fresh
   * AnthropicClient per turn, so in production this stickiness is effectively
   * per-turn — the user pays one rejection round-trip on the first iteration
   * of each turn when compact is unsupported. Within a turn's iterations,
   * subsequent calls skip the compact edit (no repeated 400 round-trip).
   *
   * Cross-turn re-discovery is intentional: when Anthropic adds compact
   * support to a model the next fresh client will pick it up automatically.
   *
   * Tracks the documented Stage 6 fallback in
   * docs/plans/260405_cache_aware_context_management.md.
   */
  private compactRejected = false;

  readonly capabilities: ProviderCapabilities = {
    hasNativeContextEditing: true,
    hasNativeCompaction: false,
    cacheStrategy: 'ephemeral',
    cacheHeuristicTtlMs: 300_000,
    // The provider (Anthropic dialect — direct, OR passthrough, Gemini proxy)
    // supports images, but the per-request MODEL must too: this same client
    // serves every managed/OpenRouter-proxied model (clientFactory PRECEDENCE
    // 1), including text-only ones (deepseek). A hardcoded `true` here is what
    // caused the 260610 image-unsupported-by-model incident. Unknown ids fail
    // open — see `modelSupportsImageInput()`.
    supportsImageContent: (model: string) => modelSupportsImageInput(model),
  };

  constructor(config: ModelClientConfig) {
    this.provider = config.provider ?? 'Anthropic';
    this.enableContextManagement = config.enableContextManagement ?? false;
    this.enableCompact = config.enableCompact ?? false;

    if (!config.apiKey) {
      throw new ModelError(
        'auth',
        'Anthropic client requires an API key',
        undefined,
        this.provider,
      );
    }

    // Normalize header keys to lowercase. Internal producers (providerRouteHeaders.ts,
    // local proxy) emit lowercase, but env-derived custom headers via
    // queryRouter.extractProxyConfig preserve caller casing. A mixed-case
    // `X-OpenRouter-Turn` would otherwise silently disable OR-passthrough mode and
    // corrupt direct-vs-OR routing. Anthropic SDK lowercases on the wire anyway.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(config.defaultHeaders ?? {})) {
      headers[k.toLowerCase()] = v;
    }
    this.isOpenRouterPassthrough = headers['x-openrouter-turn'] === 'true';

    if (this.enableContextManagement) {
      const existingFlags = (headers['anthropic-beta'] ?? '')
        .split(',')
        .map(flag => flag.trim())
        .filter(Boolean);

      // REBEL-52B (live probe, 2026-05-30): context edits and compaction are
      // distinct Anthropic betas. `context-management-2025-06-27` enables
      // clear_tool_uses/clear_thinking edits; `compact-2026-01-12` is required
      // for the `compact_20260112` edit and returns 200 when present.
      // Gated on the client-level `enableCompact` flag, not the per-request model
      // (the model isn't known at construction). A compact-enabled client on a
      // model that doesn't support compaction therefore carries this beta header
      // with no corresponding compact edit in the body — that "orphan header" is
      // a confirmed no-op: live probes returned 200 for both opus-4-7 and Haiku
      // 4.5 (unsupported) with the header present and no compact edit. Do NOT
      // restructure to per-request headers for this; it's safe as-is. (REBEL-52B follow-up.)
      const requiredFlags = ['context-management-2025-06-27'];
      if (this.enableCompact) {
        requiredFlags.push('compact-2026-01-12');
      }

      const managedFlags = new Set(['context-management-2025-06-27', 'compact-2026-01-12']);
      const existingNonRequired: string[] = [];
      for (const flag of existingFlags) {
        if (managedFlags.has(flag) || existingNonRequired.includes(flag)) continue;
        existingNonRequired.push(flag);
      }

      headers['anthropic-beta'] = [...requiredFlags, ...existingNonRequired].join(',');
    }

    const authOpts = { apiKey: config.apiKey };

    // Intercept HTTP responses to extract OpenRouter's non-standard usage.cost
    // before the SDK strips it during response parsing.
    const customFetch: typeof globalThis.fetch = async (url, init) => {
      this.lastResponseCost = undefined;
      this.lastResponseProvider = undefined;
      this.lastFulfillmentProvider = undefined;
      const response = await globalThis.fetch(url, init);
      const contentType = response.headers.get('content-type') ?? '';
      try {
        const captured = await captureAnthropicResponseMetadata(response, {
          isOpenRouterPassthrough: this.isOpenRouterPassthrough,
        });
        this.lastResponseCost = captured.responseCost;
        this.lastResponseProvider = captured.responseProvider;
        this.lastFulfillmentProvider = captured.fulfillmentProvider;
      } catch {
        this.lastResponseCost = undefined;
        this.lastResponseProvider = undefined;
        this.lastFulfillmentProvider = undefined;
      }

      // For OpenRouter SSE streams, observe chunks flowing through to extract
      // usage.cost and provider from message_delta events.
      if (contentType.includes('text/event-stream') && response.body) {
        const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : '';
        if (this.isOpenRouterPassthrough) {
          const self = this;
          const costExtractor = createSseCostExtractor(
            (cost) => { self.lastResponseCost = cost; },
            () => {
              if (self.lastResponseCost === undefined) {
                log.warn({ url: requestUrl }, 'OpenRouter stream completed without extracting exact cost — falling back to local pricing');
              }
            },
            (provider) => { self.lastResponseProvider = provider; },
          );

          const readable = response.body.pipeThrough(costExtractor);
          return new Response(readable, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      }

      return response;
    };

    this.client = new Anthropic({
      ...authOpts,
      ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      defaultHeaders: headers,
      fetch: customFetch,
      ...(config.maxRetries !== undefined ? { maxRetries: config.maxRetries } : {}),
    });
  }

  async create(params: CreateParams): Promise<CreateResult> {
    return this.runWithRetry(params.signal, () => this.doCreate(params), params.onRetry);
  }

  async stream(
    params: StreamParams,
    onEvent: (event: StreamEvent) => void,
  ): Promise<StreamResult> {
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
    // Fail-fast-offline gate (260618_arthur-offline-resilience Stage 2): probe
    // reachability AT MOST ONCE per invocation. `undefined` = not yet probed;
    // a boolean caches the verdict so N retries never trigger N probes.
    let offlineVerdict: boolean | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        return await run();
      } catch (error) {
        const modelError = classifyError(error, signal, this.provider);

        if (modelError.isAbort) throw modelError;

        // Don't retry rate limits — they're typically subscription-tier-based
        // (especially for Codex/ChatGPT Pro) and retries just amplify load.
        // The SDK already retried before this point (unless maxRetries=0).
        // eslint-disable-next-line no-restricted-syntax -- non-routing kind discriminator: ModelError.kind classification
        if (modelError.kind === 'rate_limit') throw modelError;

        // Idempotency guard (streaming only): if result-affecting content has
        // already been emitted to the consumer, re-running the stream would
        // duplicate output. Fail clean instead of retrying. `create()` passes
        // no `isRetrySafe` (atomic — always retry-safe), unchanged.
        if (isRetrySafe && !isRetrySafe()) throw modelError;

        if (attempt < MAX_RETRIES && modelError.isTransient) {
          // Before sleeping to retry a transient error, ask an INDEPENDENT
          // bounded reachability probe whether the machine is even online.
          // Offline `fetch` fails instantly → the proxy returns 500 → server_error
          // → isTransient, so without this gate an offline turn churns through
          // stacked SDK + runWithRetry retries and then dangles to the 10/30-min
          // watchdog ceilings (~32 min). Fail-fast instead.
          //
          // Fail-OPEN by construction: the multi-host probe only returns `true`
          // when EVERY corroboration host is confirmed unreachable; an
          // inconclusive / slow / timed-out / mixed result returns `false` → we
          // retry exactly as today. This is the regression guard for
          // slow-but-valid streams and weird/captive/domain-filtered networks.
          // The probe runs ONLY here, on the failure/retry path — a healthy
          // streaming turn never enters this catch — and at most once per
          // invocation (the verdict is cached across retries). Shared with
          // OpenAIClient via `offlineFailFast.ts`.
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
          log.warn({ attempt: attempt + 1, kind: modelError.kind, delayMs }, 'Transient error, retrying');
          // App-retry counting is recorded scope-aware in logProviderRetryTelemetry
          // (excludes sub-agent callsites); not here, where the callsite is unknown.
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
    const thinkingParams: Record<string, unknown> = {};
    if (params.thinking && params.thinking.type !== 'disabled') {
      thinkingParams.thinking = params.thinking;
    }
    const outputConfig: Record<string, unknown> = {};
    if (params.effort) {
      outputConfig.effort = params.effort;
    }
    if (params.outputConfig?.format) {
      outputConfig.format = toAnthropicJsonFormat(params.outputConfig.format);
    }
    if (Object.keys(outputConfig).length > 0) {
      thinkingParams.output_config = outputConfig;
    }

    const wireModel: WireModelId = resolveAnthropicWireModel(params.model, this.isOpenRouterPassthrough, this.provider);

    const buildRequestBody = async (includeCompact: boolean) => ({
      model: wireModel,
      max_tokens: params.maxTokens,
      system: toAnthropicSystemPrompt(params.systemPrompt),
      messages: await toAnthropicMessages(
        params.messages,
        this.capabilities.supportsImageContent(params.model),
        params.sessionId,
        params.hydrationCache,
        params.contentHydrationCache,
        params.contentCloudClient,
      ),
      cache_control: { type: 'ephemeral' },
      ...(this.enableContextManagement
        ? { context_management: buildContextManagementConfig(params.model, { includeCompact }) }
        : {}),
      ...thinkingParams,
    });

    // Use beta.messages to match the Claude Code SDK subprocess path (/v1/messages?beta=true).
    // Anthropic routes OAuth tokens through a different rate-limit bucket for beta vs stable.
    const runOnce = async (includeCompact: boolean): Promise<Message> => {
      const requestBody = await buildRequestBody(includeCompact);
      // Wire-shape backstop for sampling-forbidden / always-on-thinking models:
      // throws in dev/test, captures + strips in prod. No-op for other models.
      assertWireSafeForAlwaysOnThinking(
        wireModel,
        requestBody as unknown as Record<string, unknown>,
        'anthropicClient.doCreate',
      );
      const result = await this.client.beta.messages.create(
        {
          ...requestBody,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type erasure: cache_control, context_management, and extended thinking params not yet in SDK type definitions
        } as any,
        { signal: params.signal },
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BetaMessage → Message structural cast (identical shape; SDK keeps them as separate types)
      return result as any as Message;
    };

    const message: Message = await this.runWithCompactFallback(runOnce, params.model);

    this.logRefusalStopDetails(message, 'doCreate');

    const contextManagementEdits = this.getAppliedEditCount(message);

    return {
      content: toNeutralContent(message.content),
      stopReason: message.stop_reason ?? 'unknown',
      usage: mapUsage(
        message,
        this.lastResponseCost,
        this.lastResponseProvider,
        this.lastFulfillmentProvider,
      ),
      model: message.model,
      ...(contextManagementEdits > 0 ? { contextManagementEdits } : {}),
    };
  }

  /**
   * Wraps a single Anthropic API call with a one-shot fallback that strips
   * the `compact_20260112` edit if the API rejects it as unsupported for the
   * current model. Implements the Stage 6 fallback documented in
   * docs/plans/260405_cache_aware_context_management.md.
   *
   * Behaviour:
   * - First call uses `this.useCompact()` (enabled unless previously rejected).
   * - On rejection (`isCompactNotSupportedError()` matches), sets the sticky
   *   `compactRejected` flag and retries the call ONCE with
   *   `includeCompact=false`.
   * - The retry condition does NOT also gate on `!this.compactRejected`:
   *   under concurrent calls a second in-flight call may have already sent
   *   compact before the flag flipped, and that second call's rejection still
   *   needs to be retried without compact. The `enableCompact` gate ensures
   *   we never attempt the fallback when the user opted out entirely.
   * - Any error from the retry propagates unchanged so the generic
   *   `runWithRetry` retry/classification path handles transient cases.
   * - Non-compact errors propagate unchanged (no fallback, no retry).
   */
  private async runWithCompactFallback<T>(
    runOnce: (includeCompact: boolean) => Promise<T>,
    model: string,
  ): Promise<T> {
    try {
      return await runOnce(this.useCompact());
    } catch (error) {
      if (this.enableCompact && this.enableContextManagement && isCompactNotSupportedError(error)) {
        const wasRejectedAlready = this.compactRejected;
        this.compactRejected = true;
        log.warn(
          { model, provider: this.provider, wasRejectedAlready },
          'compact_20260112 rejected by model — disabling compact for this client and retrying once with clear_tool_uses only',
        );
        return await runOnce(false);
      }
      throw error;
    }
  }

  /**
   * Whether the next API call should include `compact_20260112`. Returns true
   * only when context_management is enabled, the user opted in via
   * `enableCompact`, and we haven't yet observed a rejection on this client.
   */
  private useCompact(): boolean {
    return this.enableContextManagement && this.enableCompact && !this.compactRejected;
  }

  private async doStream(
    params: StreamParams,
    onEvent: (event: StreamEvent) => void,
  ): Promise<StreamResult> {
    const thinkingParams: Record<string, unknown> = {};
    if (params.thinking && params.thinking.type !== 'disabled') {
      thinkingParams.thinking = params.thinking;
    }
    const outputConfig: Record<string, unknown> = {};
    if (params.effort) {
      outputConfig.effort = params.effort;
    }
    if (params.outputConfig?.format) {
      outputConfig.format = toAnthropicJsonFormat(params.outputConfig.format);
    }
    if (Object.keys(outputConfig).length > 0) {
      thinkingParams.output_config = outputConfig;
    }

    const wireModel: WireModelId = resolveAnthropicWireModel(params.model, this.isOpenRouterPassthrough, this.provider);

    const buildRequestBody = async (includeCompact: boolean) => ({
      model: wireModel,
      max_tokens: params.maxTokens,
      system: toAnthropicSystemPrompt(params.systemPrompt),
      messages: await toAnthropicMessages(
        params.messages,
        this.capabilities.supportsImageContent(params.model),
        params.sessionId,
        params.hydrationCache,
        params.contentHydrationCache,
        params.contentCloudClient,
      ),
      cache_control: { type: 'ephemeral' },
      ...(params.tools && params.tools.length > 0 ? { tools: toAnthropicTools(params.tools) } : {}),
      ...(this.enableContextManagement
        ? { context_management: buildContextManagementConfig(params.model, { includeCompact }) }
        : {}),
      ...thinkingParams,
    });

    if (this.enableContextManagement) {
      const cmConfig = buildContextManagementConfig(params.model, { includeCompact: this.useCompact() });
      log.debug({
        model: params.model,
        editTypes: cmConfig.edits.map((e) => e.type),
        compactRequested: this.enableCompact,
        compactEnabled: cmConfig.edits.some((e) => e.type === 'compact_20260112'),
        compactRejected: this.compactRejected,
      }, 'Context management config for API request');
    }

    // Use beta.messages to match the Claude Code SDK subprocess path (/v1/messages?beta=true).
    const runStream = async (includeCompact: boolean): Promise<Message> => {
      const requestBody = await buildRequestBody(includeCompact);
      // Wire-shape backstop for sampling-forbidden / always-on-thinking models:
      // throws in dev/test, captures + strips in prod. No-op for other models.
      assertWireSafeForAlwaysOnThinking(
        wireModel,
        requestBody as unknown as Record<string, unknown>,
        'anthropicClient.doStream',
      );
      const stream = this.client.beta.messages.stream(
        {
          ...requestBody,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type erasure: cache_control, context_management, and extended thinking params not yet in SDK type definitions
        } as any,
        { signal: params.signal },
      );

      // Per-tool_use byte accumulation tracking. Keyed by block index because
      // multiple tool_use blocks may appear sequentially in a single message
      // and each needs its own cap window. Populated on content_block_start
      // (for tool_use blocks), incremented on input_json_delta, cleared on
      // content_block_stop.
      const streamCapBytes = getStreamCapBytes();
      const toolUseByIndex = new Map<number, ToolInputCapState>();

      for await (const event of stream) {
        // Track all raw SDK events for diagnostic observability (see 260407 plan).
        // mapAnthropicStreamEvent accepts the BetaRawMessageStreamEvent | RawMessageStreamEvent
        // union directly, so beta-only delta variants (e.g. compaction_delta) are typed
        // at the boundary instead of being suppressed by an `as unknown` cast.
        if (params.onStreamActivity) {
          try {
            params.onStreamActivity(mapAnthropicStreamEvent(event));
          } catch (mapperErr) {
            reportRuntimeActivityMapperFailure('anthropic', mapperErr, {
              rawEventType: String(event.type),
            });
          }
        }

        // Begin tracking a new tool_use block.
        if (event.type === 'content_block_start') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK types don't expose content_block.name on all variants
          const cb = (event as any).content_block;
          if (cb && cb.type === 'tool_use' && typeof event.index === 'number') {
            toolUseByIndex.set(event.index, {
              name: typeof cb.name === 'string' ? cb.name : 'unknown',
              id: typeof cb.id === 'string' ? cb.id : '',
              bytes: 0,
              nearCapFired: false,
            });
          }
          continue;
        }

        // Stop tracking when the block closes.
        if (event.type === 'content_block_stop' && typeof event.index === 'number') {
          toolUseByIndex.delete(event.index);
          continue;
        }

        if (event.type !== 'content_block_delta') continue;

        // Accumulate input_json_delta bytes per tool_use block and enforce cap.
        if (event.delta.type === 'input_json_delta' && typeof event.index === 'number') {
          const entry = toolUseByIndex.get(event.index);
          const partial = typeof event.delta.partial_json === 'string' ? event.delta.partial_json : '';
          if (entry) {
            // Use UTF-8 byte length, not `String.length` (UTF-16 code units).
            // For ASCII/base64 the two coincide, but multi-byte UTF-8 content
            // (CJK, emoji, etc.) would otherwise be under-counted, letting an
            // oversized payload slip past the cap. Constant-time on V8.
            const partialBytes = Buffer.byteLength(partial, 'utf8');
            const decision = recordToolInputDelta(entry, partialBytes, streamCapBytes, event.index);
            if (decision.action === 'near_cap') {
              try {
                getErrorReporter().addBreadcrumb({
                  category: 'stream',
                  message: 'tool_input_near_cap',
                  level: 'warning',
                  data: {
                    toolName: decision.toolName,
                    bytesAccumulated: decision.bytesAccumulated,
                    capBytes: streamCapBytes,
                    thresholdFraction: NEAR_CAP_BREADCRUMB_THRESHOLD,
                  },
                });
              } catch { /* observability must never crash the stream */ }
            } else if (decision.action === 'exceeded') {
              const { details } = decision;
              log.warn(details, 'tool_input_too_large — stream aborted');
              try {
                getErrorReporter().addBreadcrumb({
                  category: 'stream',
                  message: 'tool_input_too_large',
                  level: 'error',
                  data: { ...details },
                });
              } catch { /* observability must never crash the stream */ }

              // Abort the live stream so the SDK closes the underlying connection
              // promptly; the thrown ModelError carries the machine-readable
              // details for recovery handlers. Uses the SDK's public
              // `BetaMessageStream.abort()` (verified in
              // `node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.js`).
              try {
                stream.abort();
              } catch { /* best-effort abort */ }

              throw new ModelError(
                'tool_input_too_large',
                `Tool input exceeded streaming cap: tool '${details.toolName}' accumulated ${details.bytesAccumulated} bytes (cap ${streamCapBytes}). The input likely contained a large inline payload such as base64 file data. Consider using a file path reference instead of inlining bytes.`,
                undefined,
                this.provider,
                { details: details as unknown as Record<string, unknown> },
              );
            }
          }
        }

        if (event.delta.type === 'text_delta' && event.delta.text) {
          onEvent({ type: 'text_delta', text: event.delta.text });
        }

        if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
          onEvent({ type: 'thinking_delta', thinking: event.delta.thinking });
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BetaMessage → Message structural cast
      return stream.finalMessage() as any as Message;
    };

    const message = await this.runWithCompactFallback(runStream, params.model);

    this.logRefusalStopDetails(message, 'doStream');

    const usage = mapUsage(
      message,
      this.lastResponseCost,
      this.lastResponseProvider,
      this.lastFulfillmentProvider,
    );

    if (usage.cacheCreationTokens > 0 || usage.cacheReadTokens > 0) {
      const totalInput = getEffectiveInputTokens(usage);
      const cacheHitRatio = totalInput > 0
        ? usage.cacheReadTokens / totalInput
        : 0;
      log.debug({
        cacheHitRatio: (cacheHitRatio * 100).toFixed(1) + '%',
        cacheWrite: usage.cacheCreationTokens,
        cacheRead: usage.cacheReadTokens,
        inputTokens: usage.inputTokens,
      }, 'Prompt cache metrics');
    }

    const contextManagementEdits = this.getAppliedEditCount(message);

    return {
      content: toNeutralContent(message.content),
      stopReason: message.stop_reason ?? 'unknown',
      usage,
      model: message.model,
      ...(contextManagementEdits > 0 ? { contextManagementEdits } : {}),
    };
  }

  /**
   * Observability for provider safety refusals (Fable 5 Stage 6): when
   * `stop_reason: 'refusal'` arrives, log the `stop_details.category` the API
   * attaches — it is dropped by `CreateResult` (only `stop_reason` survives),
   * and threading it through the result contract is deliberately deferred
   * until Sentry shows refusals are frequent (see the Fable 5 plan's
   * out-of-scope table). The log line is the only place the category lands.
   */
  private logRefusalStopDetails(message: Message, surface: 'doCreate' | 'doStream'): void {
    if (message.stop_reason !== 'refusal') return;
    // stop_details is not yet in the SDK's Message type; widen through unknown rather than `any`
    const stopDetails = (message as unknown as { stop_details?: { category?: unknown; reason?: unknown } })
      .stop_details;
    log.warn(
      {
        model: message.model,
        stopReason: message.stop_reason,
        stopDetailsCategory: stopDetails?.category,
        surface,
      },
      'Response stopped by provider safety classifier (stop_reason: refusal)',
    );
  }

  /** Log context_management applied edits and return the count. */
  private getAppliedEditCount(message: Message): number {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- context_management not yet in SDK type definitions
    const cmResponse = (message as any).context_management;
    const editCount = cmResponse?.applied_edits?.length ?? 0;
    if (editCount > 0) {
      log.info({ appliedEdits: cmResponse.applied_edits }, 'Context management: server applied edits');
    }
    return editCount;
  }
}
