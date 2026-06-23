/**
 * OpenAI provider translators — translate between the OpenAI Chat Completions API
 * format and Rebel Core's internal types (modelTypes.ts / modelClient.ts).
 * Also used by other OpenAI-compatible providers (Together, Cerebras, local models).
 */
import { createScopedLogger } from '@core/logger';
import { stripThinkingBlocks } from '@core/utils/stripThinkingBlocks';
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
  buildUnsendableImageAttachmentPlaceholder,
} from '@core/utils/fileTypeDetection';
import type { ContentRef, ImageRef } from '@shared/types/agent';

/**
 * Conservative byte budget for OpenAI/compat provider context. ~120k tokens
 * at ~4 bytes/token. Used as the post-hydration truncation ceiling for
 * `content_ref`-derived text. See Stage B1b § truncation policy.
 */
const OPENAI_CONTENT_BUDGET_BYTES = 120_000 * 4;
import type { StreamEvent } from '../modelClient';
import type {
  ChatMessage,
  ContentBlock,
  SystemPrompt,
  ToolDefinition,
  ToolResultBlock,
  ToolUseBlock,
} from '../modelTypes';
import type { TokenUsage } from '../types';
import type {
  LateReasoningBufferCap,
  OpenAIContentPart,
  OpenAIImageUrlContentPart,
  OpenAIMessage,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAIStreamState,
  OpenAITool,
} from './openaiTypes';

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

/**
 * Logger for the empty-content assistant-message drop. We persist a structured
 * warning every time we drop a message rather than silently filtering it, so
 * the silent-failure principle is upheld and downstream debugging has a
 * breadcrumb. See docs/plans/260429_eval_reliability_judge_panel.md § S2.
 */
const emptyContentDropLog = createScopedLogger({ service: 'openai-translator-empty-drop' });
const lateReasoningBufferLog = createScopedLogger({ service: 'openai-translator-late-reasoning-buffer' });

function isImageRef(value: unknown): value is ImageRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.assetId === 'string' &&
    typeof record.mimeType === 'string' &&
    typeof record.byteSize === 'number'
  );
}

// `finishReason` is widened to `string | null` deliberately: it comes from
// UNVALIDATED JSON of an OpenAI-compatible HTTP response (no zod), and real
// providers (OpenRouter, llama.cpp/Ollama/vLLM, OpenAI) legitimately return
// values outside the documented set (e.g. 'content_filter', 'function_call').
// Those must map to 'end_turn', NOT throw — so this is an open switch with a
// real default, not an assertNever-closed union.
const mapStopReason = (finishReason: string | null): string => {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    case null:
      return 'end_turn';
    default:
      return 'end_turn';
  }
};

const extractTextFromBlocks = (content: string | ContentBlock[]): string => {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
};

const toOpenAIImageContentPart = (data: string, mimeType: string): OpenAIImageUrlContentPart => ({
  type: 'image_url',
  image_url: {
    url: `data:${mimeType};base64,${data}`,
  },
});

const isDirectUserImageBlock = (
  entry: unknown,
): entry is { type: 'image'; source: { type: 'base64'; data: string; media_type: string } } =>
  !!entry
  && typeof entry === 'object'
  && (entry as { type?: unknown }).type === 'image'
  && (entry as { source?: { type?: unknown } }).source?.type === 'base64'
  && typeof (entry as { source?: { data?: unknown } }).source?.data === 'string'
  && ((entry as { source: { data: string } }).source.data).length > 0
  && typeof (entry as { source?: { media_type?: unknown } }).source?.media_type === 'string'
  && ((entry as { source: { media_type: string } }).source.media_type).length > 0;

const buildDirectUserContentParts = (
  content: ContentBlock[],
  // Stage 3 (260610 image-unsupported-by-model): user-attached/direct image
  // blocks must obey the same per-model vision gate as tool_result images.
  // REQUIRED, no fail-open default (DA F4).
  supportsImageContent: boolean,
): OpenAIContentPart[] => {
  const parts: OpenAIContentPart[] = [];
  let imageIndex = 0;

  for (const entry of content as unknown[]) {
    if (!entry || typeof entry !== 'object') continue;
    if ((entry as { type?: unknown }).type === 'text') {
      const text = (entry as { text?: unknown }).text;
      if (typeof text === 'string' && text.length > 0) {
        parts.push({ type: 'text', text });
      }
    } else if ((entry as { type?: unknown }).type === 'image') {
      const currentIndex = imageIndex;
      imageIndex += 1;
      if (!supportsImageContent) {
        // SUBSTITUTE, never drop (postmortem 260506_openai_translator_user_
        // image_block_drop): translate-time only — persisted history keeps the
        // real image for a later vision-capable model. Gate on the loose
        // type==='image' shape so a malformed image block can never leak
        // through to a text-only model.
        parts.push({ type: 'text', text: buildVisionUnsupportedAttachmentPlaceholder(currentIndex) });
      } else if (isDirectUserImageBlock(entry)) {
        parts.push(toOpenAIImageContentPart(entry.source.data, entry.source.media_type));
      } else {
        // Vision-capable model but the block fails the strict base64 shape
        // check: SUBSTITUTE, never drop (postmortem 260506 — this exact
        // supported+malformed corner used to silently lose the block).
        parts.push({ type: 'text', text: buildUnsendableImageAttachmentPlaceholder(currentIndex) });
      }
    }
  }

  return parts;
};

const extractToolResultPayload = async (
  block: ToolResultBlock,
  // REQUIRED, no fail-open default: an omitted capability silently sent images
  // to text-only models — the lying-default shape behind the 260610
  // image-unsupported-by-model incident (DA F4).
  supportsImageContent: boolean,
  sessionId?: string,
  hydrationCache?: TurnScopedHydrationCache,
  contentHydrationCache?: TurnScopedContentHydrationCache,
  cloudClient?: ContentDownloader,
  hydratedTextBlocks?: HydratedTextBlock[],
): Promise<{
  text: string;
  images: OpenAIImageUrlContentPart[];
  hydratedBlocks?: HydratedTextBlock[];
}> => {
  const rawContent = (block as ToolResultBlock & { content: unknown }).content;
  // Stage 2 (guard-large-tool-outputs): tool_result content reconstructed from
  // EXISTING history can carry pre-fix raw megabytes (a plain string, a
  // persisted text block, or a content_ref hydrated below) that bypass the
  // Stage 1 fresh-result cap on replay. Bound each provider-bound text source by
  // the same 200 KiB cap. Idempotent: already-bounded text passes through.
  if (typeof rawContent === 'string') {
    return { text: boundToolOutputForSafety(rawContent, false).output, images: [] };
  }
  if (!Array.isArray(rawContent)) {
    return { text: '', images: [] };
  }

  const joinedText = (rawContent as unknown[])
    .filter((entry: unknown): entry is { type: string; text?: string } => !!entry && typeof entry === 'object')
    .filter((entry: { type: string; text?: string }) => entry.type === 'text')
    .map((entry: { type: string; text?: string }) => entry.text ?? '')
    .join('');
  let text = boundToolOutputForSafety(joinedText, false).output;

  const hydratedBlocks: HydratedTextBlock[] = [];

  const contentRefEntries = (rawContent as unknown[]).filter(
    (c: unknown): c is { type: 'content_ref'; contentRef: ContentRef; summary?: string } =>
      !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'content_ref',
  );
  for (const refEntry of contentRefEntries) {
    if (sessionId && contentHydrationCache) {
      const hydrated = await hydrateContentRef(refEntry.contentRef, sessionId, {
        contentStore: getContentStore(),
        cache: contentHydrationCache,
        ...(cloudClient ? { cloudClient } : {}),
        log: emptyContentDropLog,
      });
      if (isHydratedContent(hydrated)) {
        // Stage 2: cap the model-facing hydration of a content_ref. The full
        // bytes remain in the ContentStore; only the replayed text is bounded.
        // The downstream budget pass keys on this (capped) text, so record the
        // capped value as both the appended text and the HydratedTextBlock text.
        const hydratedText = boundToolOutputForSafety(hydrated.bytes.toString('utf8'), false).output;
        text += (text ? '\n' : '') + hydratedText;
        if (hydratedTextBlocks) {
          const hydratedBlock: HydratedTextBlock = {
            index: 0,
            contentRef: refEntry.contentRef,
            text: hydratedText,
            byteSize: Buffer.byteLength(hydratedText, 'utf8'),
          };
          hydratedTextBlocks.push(hydratedBlock);
          hydratedBlocks.push(hydratedBlock);
        }
        continue;
      }
      text += `\n[Tool output unavailable: ${hydrated.reason}]`;
      continue;
    }
    const fallback = typeof refEntry.summary === 'string' ? refEntry.summary : '';
    text += (text ? '\n' : '') + (fallback || `[Tool output unavailable: pending-upload]`);
  }

  const images: OpenAIImageUrlContentPart[] = [];
  const maxImages = Math.max(
    (rawContent as unknown[]).filter((c: unknown) => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'image').length,
    block.imageRef?.length ?? 0
  );

  const imagesContent = (rawContent as unknown[]).filter((c: unknown): c is { type: 'image'; data?: string; mimeType?: string; imageRef?: unknown } => !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'image');
  
  // Stage 5 (guard-large-tool-outputs): apply the SAME universal image guard to
  // REPLAYED/historical inline image blocks as the fresh model-facing boundary
  // (`buildModelFacingToolResultContent`). Persisted raw `imageContent` (incl.
  // pre-fix oversized images, or images bound for a now-non-vision provider after
  // a model switch) is reconstructed here on later turns and would otherwise be
  // sent uncapped/unsupported. Oversized/over-dimension → text placeholder;
  // non-vision client → text placeholder (no image part, no provider error). The
  // ContentStore/persistence of the raw image is untouched — only this
  // provider-bound replay is bounded, exactly as Stage 2 did for text.
  const pushGuardedImage = (i: number, data: string, mimeType: string): void => {
    if (!supportsImageContent) {
      text += `\n${buildVisionUnsupportedImagePlaceholder(i)}`;
      return;
    }
    const verdict = checkInlineImageWithinLimits(data, mimeType);
    if (!verdict.ok) {
      text += `\n${buildOversizedImagePlaceholder(i, verdict.reason)}`;
      return;
    }
    images.push(toOpenAIImageContentPart(data, mimeType));
  };

  for (let i = 0; i < maxImages; i++) {
    const inline = imagesContent[i];
    const ref = block.imageRef?.[i] ?? inline?.imageRef;

    if (inline?.data && inline.mimeType) {
      pushGuardedImage(i, inline.data, inline.mimeType);
      continue;
    }

    if (isImageRef(ref) && sessionId && hydrationCache) {
      const hydrated = await hydrateImageRef(ref, sessionId, {
        assetStore: getAssetStore(),
        cache: hydrationCache,
        providerKey: 'openai',
        maxBytes: 20 * 1024 * 1024,
        log: emptyContentDropLog
      });

      if ('data' in hydrated) {
        pushGuardedImage(i, hydrated.data, hydrated.mimeType);
        continue;
      }

      text += `\n[image unavailable: ${hydrated.reason}]`;
      continue;
    }

    if (!inline?.data) {
      text += `\n[image unavailable: pending-sync]`;
    }
  }

  return { text, images, ...(hydratedBlocks.length > 0 ? { hydratedBlocks } : {}) };
};

const parseToolInput = (input: string): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return null;
  }
};

const isGarbageTextDelta = (text: string): boolean => {
  const trimmed = text.trim().toLowerCase();
  return (
    trimmed === '(no content)'
    || trimmed === '(no'
    || trimmed === '(no)'
    || trimmed === 'no content'
    || (trimmed.startsWith('(no') && trimmed.length < 15)
  );
};

export const LATE_REASONING_BUFFER_MAX_BYTES = 256 * 1024;
export const LATE_REASONING_BUFFER_MAX_CHUNKS = 1000;

const extractReasoningFromBlocks = (content: ContentBlock[]): string =>
  (content as Array<ContentBlock | { type: 'thinking_delta'; thinking?: string }>)
    .filter((block) => block.type === 'thinking' || block.type === 'thinking_delta')
    .map((block) => block.thinking ?? '')
    .join('');

function bufferLateReasoningDelta(
  state: OpenAIStreamState,
  reasoningDelta: string,
): LateReasoningBufferCap | null {
  if (!reasoningDelta) return null;

  state.lateReasoningBuffer += reasoningDelta;
  state.lateReasoningBufferedBytes += Buffer.byteLength(reasoningDelta, 'utf8');
  state.lateReasoningBufferedChunks += 1;

  if (state.lateReasoningBufferedBytes >= LATE_REASONING_BUFFER_MAX_BYTES) {
    state.lateReasoningCapHit = 'bytes';
    return 'bytes';
  }
  if (state.lateReasoningBufferedChunks >= LATE_REASONING_BUFFER_MAX_CHUNKS) {
    state.lateReasoningCapHit = 'chunks';
    return 'chunks';
  }

  return null;
}

export function getSystemRole(modelName: string): 'system' | 'developer' {
  const normalized = modelName.toLowerCase();
  if (
    normalized.startsWith('gpt-5')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4')
  ) {
    return 'developer';
  }
  return 'system';
}

export async function translateMessagesToOpenAI(
  messages: ChatMessage[],
  // `supportsImageContent` is REQUIRED with no fail-open default (DA F4,
  // 260610 image-unsupported-by-model): callers must resolve the per-model
  // capability (`capabilities.supportsImageContent(params.model)`). `opts`
  // sits at position 2 so it can be required after the optional tail params.
  opts: { supportsReasoningReplay?: boolean; supportsImageContent: boolean },
  systemPrompt?: SystemPrompt,
  modelName?: string,
  sessionId?: string,
  hydrationCache?: TurnScopedHydrationCache,
  contentHydrationCache?: TurnScopedContentHydrationCache,
  cloudClient?: ContentDownloader,
): Promise<OpenAIMessage[]> {
  const result: OpenAIMessage[] = [];
  const hydratedTextBlocks: HydratedTextBlock[] = [];
  const toolMessagesByHydratedBlock = new Map<HydratedTextBlock, { messageRef: OpenAIMessage; originalText: string }>();
  const supportsReasoningReplay = opts.supportsReasoningReplay ?? false;
  // Stage 5: gate replayed inline image blocks on the active client's vision
  // capability (now per-model, resolved by the caller).
  const supportsImageContent = opts.supportsImageContent;

  if (systemPrompt) {
    const systemText = typeof systemPrompt === 'string'
      ? systemPrompt
      : systemPrompt
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n');

    if (systemText) {
      result.push({ role: getSystemRole(modelName ?? ''), content: systemText });
    }
  }

  for (const message of messages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        result.push({ role: 'user', content: message.content });
        continue;
      }

      const toolResultBlocks = message.content.filter(
        (block): block is ToolResultBlock => block.type === 'tool_result',
      );
      for (const block of toolResultBlocks) {
        const payload = await extractToolResultPayload(
          block,
          supportsImageContent,
          sessionId,
          hydrationCache,
          contentHydrationCache,
          cloudClient,
          hydratedTextBlocks,
        );
        const toolMessage: OpenAIMessage = {
          role: 'tool',
          content: payload.text,
          tool_call_id: block.tool_use_id,
        };
        result.push(toolMessage);
        if (payload.hydratedBlocks && payload.hydratedBlocks.length > 0) {
          for (const hydratedBlock of payload.hydratedBlocks) {
            toolMessagesByHydratedBlock.set(hydratedBlock, {
              messageRef: toolMessage,
              originalText: hydratedBlock.text,
            });
          }
        }

        if (payload.images.length > 0) {
          result.push({
            role: 'user',
            content: [
              { type: 'text', text: `Visual output from tool call ${block.tool_use_id}.` },
              ...payload.images,
            ],
          });
        }
      }

      const directContentParts = buildDirectUserContentParts(message.content, supportsImageContent);
      if (directContentParts.some((part) => part.type === 'image_url')) {
        result.push({ role: 'user', content: directContentParts });
      } else if (directContentParts.length > 0) {
        result.push({
          role: 'user',
          content: directContentParts
            .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
            .map((part) => part.text)
            // '\n' separator: this branch collapses text + substituted-image
            // placeholders into one string; '' produced run-on text like
            // "two screenshots attached[Image attachment 1 omitted…]"
            // (Claude stage-4 review F5).
            .join('\n'),
        });
      } else {
        const textContent = extractTextFromBlocks(message.content);
        if (textContent) {
          result.push({ role: 'user', content: textContent });
        }
      }
      continue;
    }

    if (typeof message.content === 'string') {
      // Skip empty assistant strings — see the equivalent block-array branch
      // below for the rationale (Cohere/strict OpenAI-compat reject empty
      // content with HTTP 400; OpenAI tolerated it silently).
      if (message.content) {
        result.push({ role: 'assistant', content: message.content });
      } else {
        emptyContentDropLog.warn(
          { messageRole: 'assistant', dropPath: 'string', modelName },
          'Dropping empty-content assistant message before OpenAI-compat dispatch',
        );
      }
      continue;
    }

    const textContent = extractTextFromBlocks(message.content);
    const reasoningContent = supportsReasoningReplay
      ? extractReasoningFromBlocks(message.content)
      : '';
    const toolUseBlocks = message.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use',
    );
    const reasoningField = supportsReasoningReplay && reasoningContent
      ? { reasoning_content: reasoningContent }
      : {};

    if (toolUseBlocks.length > 0) {
      result.push({
        role: 'assistant',
        content: textContent || null,
        ...reasoningField,
        tool_calls: toolUseBlocks.map((block) => ({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          },
        })),
      });
    } else if (textContent) {
      result.push({ role: 'assistant', content: textContent, ...reasoningField });
    } else {
      // Skip assistant messages with neither text nor tool calls. They convey
      // no information to the next-turn LLM (a thinking-only or stream-truncated
      // turn) and strict OpenAI-compat providers reject them outright. Cohere
      // returns HTTP 400: "must have non-empty content or tool calls". OpenAI
      // tolerated this, so the silent-empty path was never visible until now.
      emptyContentDropLog.warn(
        {
          messageRole: 'assistant',
          dropPath: 'contentBlocks',
          blockTypes: Array.isArray(message.content)
            ? message.content.map((b) => b.type)
            : ['<non-array>'],
          modelName,
        },
        'Dropping empty-content assistant message before OpenAI-compat dispatch',
      );
    }
  }

  if (sessionId && hydratedTextBlocks.length > 0) {
    applyTruncationForBudget(hydratedTextBlocks, {
      budgetBytes: OPENAI_CONTENT_BUDGET_BYTES,
      usedBytes: 0,
      log: emptyContentDropLog,
      sessionId,
    });
    for (const block of hydratedTextBlocks) {
      const entry = toolMessagesByHydratedBlock.get(block);
      if (!entry) continue;
      if (block.text === entry.originalText) continue;
      const currentText = typeof entry.messageRef.content === 'string' ? entry.messageRef.content : '';
      entry.messageRef.content = currentText.replace(entry.originalText, block.text);
    }
  }

  return result;
}

export function translateToolsToOpenAI(tools?: ToolDefinition[]): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

export interface NeutralResponseTranslation {
  content: ContentBlock[];
  stopReason: string;
  usage: TokenUsage;
  model?: string;
}

/**
 * Extract text fields from an OpenAI-compatible choice message.
 *
 * This is the single source of truth for reading content + reasoning_content
 * from any OpenAI-compatible provider (OpenAI, MiniMax, DeepSeek, Together, etc.).
 * Used by:
 * - `translateResponseToNeutral` (agentic runtime)
 * - `localModelProxyServer` (proxy)
 * - `callProfileHttp` in behindTheScenesClient (BTS direct profile calls)
 *
 * Accepts a loose shape so callers don't need to cast to the full OpenAI types.
 */
export function extractOpenAITextFields(message: {
  content?: string | null;
  reasoning_content?: string | null;
}): { text: string; reasoningText: string; hasReasoningContent: boolean } {
  const text = message.content ?? '';
  const reasoningText = message.reasoning_content ?? '';
  return { text, reasoningText, hasReasoningContent: !!reasoningText };
}

export function translateResponseToNeutral(
  response: OpenAIResponse,
  model: string,
): NeutralResponseTranslation {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error(`No response choices for model ${model}`);
  }

  const content: ContentBlock[] = [];
  const { text, reasoningText } = extractOpenAITextFields(choice.message);
  const cleanedText = stripThinkingBlocks(text);

  if (reasoningText) {
    content.push({ type: 'thinking', thinking: reasoningText });
  }

  if (cleanedText) {
    content.push({ type: 'text', text: cleanedText });
  }

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    for (const toolCall of choice.message.tool_calls) {
      const parsedInput = parseToolInput(toolCall.function.arguments) ?? {};
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: parsedInput,
      });
    }
  }

  const extraction = extractMiniMaxXmlToolCalls(content, response.id ?? '0');
  const finalContent = extraction.hadXmlToolCalls ? extraction.content : content;
  let stopReason = mapStopReason(choice.finish_reason);
  if (extraction.hadXmlToolCalls && stopReason === 'end_turn') {
    stopReason = 'tool_use';
  }

  return {
    content: finalContent,
    stopReason,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      cacheCreationTokens: 0,
      cacheReadTokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
    model: response.model || undefined,
  };
}

export function createOpenAIStreamState(): OpenAIStreamState {
  return {
    messageId: null,
    model: null,
    currentBlockType: null,
    content: [],
    toolCalls: new Map(),
    stopReason: 'unknown',
    usage: { ...ZERO_USAGE },
    finishReasonSeen: false,
    lateReasoningBuffer: '',
    lateReasoningBufferedBytes: 0,
    lateReasoningBufferedChunks: 0,
    lateReasoningCapHit: null,
  };
}

export function processStreamChunk(
  chunk: OpenAIStreamChunk,
  state: OpenAIStreamState,
): StreamEvent[] {
  const events: StreamEvent[] = [];

  if (!state.messageId) {
    state.messageId = chunk.id;
  }
  if (!state.model) {
    state.model = chunk.model;
  }

  if (chunk.usage) {
    state.usage.inputTokens += chunk.usage.prompt_tokens ?? 0;
    state.usage.outputTokens += chunk.usage.completion_tokens ?? 0;
    state.usage.cacheReadTokens += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
  }

  const choice = chunk.choices[0];
  if (!choice) return events;

  if (choice.delta.reasoning_content) {
    if (state.finishReasonSeen) {
      bufferLateReasoningDelta(state, choice.delta.reasoning_content);
    } else {
      if (state.currentBlockType !== 'thinking') {
        state.content.push({ type: 'thinking', thinking: '' });
        state.currentBlockType = 'thinking';
      }
      const block = state.content[state.content.length - 1];
      if (block?.type === 'thinking') {
        block.thinking += choice.delta.reasoning_content;
        events.push({ type: 'thinking_delta', thinking: choice.delta.reasoning_content });
      }
    }
  }

  if (choice.delta.content && !isGarbageTextDelta(choice.delta.content)) {
    if (state.currentBlockType !== 'text') {
      state.content.push({ type: 'text', text: '' });
      state.currentBlockType = 'text';
    }
    const block = state.content[state.content.length - 1];
    if (block?.type === 'text') {
      block.text += choice.delta.content;
      events.push({ type: 'text_delta', text: choice.delta.content });
    }
  }

  if (choice.delta.tool_calls) {
    for (const toolCall of choice.delta.tool_calls) {
      const index = toolCall.index ?? 0;
      let callState = state.toolCalls.get(index);

      const incomingId = toolCall.id;
      if (!callState) {
        // First delta for this stream index → open a new tool-call. Use the real
        // id if present, else a stable fallback derived from the index (the id
        // may arrive in a later delta).
        const toolId = incomingId ?? `call_${index}`;
        const toolName = toolCall.function?.name ?? 'unknown';
        const blockIndex = state.content.length;
        state.content.push({
          type: 'tool_use',
          id: toolId,
          name: toolName,
          input: {},
        });
        callState = {
          id: toolId,
          name: toolName,
          arguments: '',
          blockIndex,
          sawProviderSpecificFields: false,
          sawExtraContent: false,
        };
        state.toolCalls.set(index, callState);
        state.currentBlockType = 'tool_use';
      } else if (incomingId && incomingId !== callState.id) {
        // The real id arrived after we'd already opened this call with a fallback
        // (e.g. a signature-bearing delta came before the id). `index` is the
        // stable streaming multiplexing key, so a changing id at the same index is
        // realistically only fallback→real — treat it as an UPDATE, not a replace.
        // Upgrade the id in place and PRESERVE accumulated arguments/name and the
        // signature-presence flags (replacing would drop them — the F1 bug).
        callState.id = incomingId;
        const block = state.content[callState.blockIndex];
        if (block?.type === 'tool_use') {
          block.id = incomingId;
        }
        state.currentBlockType = 'tool_use';
      }

      // Gateway tool-signature diagnostic (observability-only): OR-accumulate
      // presence of litellm/Google signature conventions across deltas. The
      // `id`-embedded convention is derived from the final assembled `callState.id`
      // at stream finalize. Presence ONLY — the signature VALUE is never
      // extracted/logged/emitted (the litellm id form lives in `id`, preserved
      // verbatim, but is never pulled out as a value).
      if (toolCall.provider_specific_fields?.thought_signature) {
        callState.sawProviderSpecificFields = true;
      }
      if (toolCall.extra_content?.google?.thought_signature) {
        callState.sawExtraContent = true;
      }

      if (toolCall.function?.name) {
        callState.name = toolCall.function.name;
        const block = state.content[callState.blockIndex];
        if (block?.type === 'tool_use') {
          block.name = toolCall.function.name;
        }
      }

      if (toolCall.function?.arguments) {
        callState.arguments += toolCall.function.arguments;
        const parsedInput = parseToolInput(callState.arguments);
        if (parsedInput) {
          const block = state.content[callState.blockIndex];
          if (block?.type === 'tool_use') {
            block.input = parsedInput;
          }
        }
      }
    }
  }

  if (choice.finish_reason) {
    state.stopReason = mapStopReason(choice.finish_reason);
    state.finishReasonSeen = true;
  }

  return events;
}

export function flushLateReasoningBuffer(
  state: OpenAIStreamState,
): StreamEvent[] {
  if (!state.lateReasoningBuffer) return [];

  const events: StreamEvent[] = [];
  const capHit = state.lateReasoningCapHit;
  if (capHit) {
    lateReasoningBufferLog.warn(
      {
        category: 'late-reasoning-buffer-cap',
        cap: capHit,
        buffered: state.lateReasoningBufferedBytes,
      },
      'Late reasoning buffer cap reached',
    );
    events.push({
      type: 'degraded-status',
      reason: 'late-reasoning-buffer-cap',
      cap: capHit,
    });
  }

  lateReasoningBufferLog.info(
    {
      buffered_bytes: state.lateReasoningBufferedBytes,
      buffered_chunks: state.lateReasoningBufferedChunks,
      cap_hit: capHit,
    },
    'late_reasoning_content_buffer_fired',
  );

  state.content.push({ type: 'thinking', thinking: state.lateReasoningBuffer });
  state.currentBlockType = 'thinking';
  events.push({ type: 'thinking_delta', thinking: state.lateReasoningBuffer });
  state.lateReasoningBuffer = '';
  state.lateReasoningBufferedBytes = 0;
  state.lateReasoningBufferedChunks = 0;
  state.lateReasoningCapHit = null;
  state.currentBlockType = null;
  return events;
}

// ── MiniMax XML tool call extraction ──────────────────────────────────
//
// MiniMax M2.5/M2.7 natively uses XML for tool calls:
//   <minimax:tool_call>
//   <invoke name="tool_name">
//   <parameter name="param">value</parameter>
//   </invoke>
//   </minimax:tool_call>
//
// OpenRouter is supposed to translate this to standard tool_use format but
// does so inconsistently. When the XML leaks through as text, the agent
// loop sees no tool_use blocks and exits. This function detects and converts
// them into proper ToolUseBlock entries.

const minimaxLog = createScopedLogger({ service: 'minimax-xml-extract' });

const MINIMAX_TOOL_CALL_RE = /<minimax:tool_call>([\s\S]*?)<\/minimax:tool_call>/g;
const INVOKE_RE = /<invoke\s+name=["']([^"']+)["']>([\s\S]*?)<\/invoke>/g;
const PARAMETER_RE = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/g;

function parseParameterValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseInvokeBlock(
  invokeBody: string,
  toolName: string,
  idPrefix: string,
  index: number,
): ToolUseBlock | null {
  const input: Record<string, unknown> = {};
  let match: RegExpExecArray | null;

  const paramRe = new RegExp(PARAMETER_RE.source, PARAMETER_RE.flags);
  while ((match = paramRe.exec(invokeBody)) !== null) {
    const [, paramName, paramValue] = match;
    input[paramName] = parseParameterValue(paramValue);
  }

  return {
    type: 'tool_use',
    id: `toolu_minimax_${idPrefix}_${index}`,
    name: toolName,
    input,
  };
}

export interface MiniMaxExtractionResult {
  content: ContentBlock[];
  hadXmlToolCalls: boolean;
}

export function extractMiniMaxXmlToolCalls(
  content: ContentBlock[],
  idPrefix = '0',
): MiniMaxExtractionResult {
  const alreadyHasToolUse = content.some((b) => b.type === 'tool_use');
  const result: ContentBlock[] = [];
  let toolIndex = 0;
  let hadXmlToolCalls = false;

  for (const block of content) {
    if (block.type !== 'text' || !block.text.includes('<minimax:tool_call>')) {
      result.push(block);
      continue;
    }

    const text = block.text;
    let lastIndex = 0;
    let blockExtractedCount = 0;

    const outerRe = new RegExp(MINIMAX_TOOL_CALL_RE.source, MINIMAX_TOOL_CALL_RE.flags);
    let outerMatch: RegExpExecArray | null;

    while ((outerMatch = outerRe.exec(text)) !== null) {
      const beforeText = text.slice(lastIndex, outerMatch.index).trim();
      if (beforeText) {
        result.push({ type: 'text', text: beforeText });
      }

      const innerXml = outerMatch[1];
      const invokeRe = new RegExp(INVOKE_RE.source, INVOKE_RE.flags);
      let invokeMatch: RegExpExecArray | null;

      while ((invokeMatch = invokeRe.exec(innerXml)) !== null) {
        const [, toolName, invokeBody] = invokeMatch;
        const toolBlock = parseInvokeBlock(invokeBody, toolName, idPrefix, toolIndex);
        if (toolBlock) {
          if (!alreadyHasToolUse) {
            result.push(toolBlock);
            blockExtractedCount++;
          }
          toolIndex++;
        }
      }

      lastIndex = outerMatch.index + outerMatch[0].length;
    }

    const afterText = text.slice(lastIndex).trim();
    if (afterText) {
      result.push({ type: 'text', text: afterText });
    }

    if (blockExtractedCount > 0) {
      hadXmlToolCalls = true;
      const toolNames = result
        .filter((b): b is ToolUseBlock => b.type === 'tool_use')
        .map((t) => t.name);
      minimaxLog.info(
        { count: blockExtractedCount, tools: toolNames },
        'Extracted MiniMax XML tool calls from text content',
      );
    }
  }

  return { content: result, hadXmlToolCalls };
}
