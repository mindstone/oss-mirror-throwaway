/**
 * Codex Responses API Translator
 *
 * Pure data transformation between OpenAI Chat Completions API and the
 * Codex Responses API used at chatgpt.com/backend-api/codex/responses.
 *
 * Six exports:
 * - translateChatToResponses()  — request: Chat Completions → Responses
 * - translateResponsesToChatCompletion() — response: Responses → Chat Completions (non-streaming)
 * - createStreamTranslator()    — factory for per-stream SSE event translation
 * - parseSseEventBlock() — shared SSE event block parser
 * - ResponsesApiResponseSchema — Zod schema for boundary validation of Codex responses
 * - readResponsesSseToCompletion() — buffer SSE stream → ResponsesApiResponse (for non-streaming callers)
 *
 * INVARIANT: Codex Responses API REQUIRES `stream: true` upstream and rejects
 * `stream: false` with HTTP 400 "Stream must be set to true". Non-streaming
 * callers (BTS, sub-agent fallback) must call readResponsesSseToCompletion()
 * to satisfy that contract while preserving their JSON-back semantics. See
 * docs/plans/260504_codex_passthrough_streaming_fix.md.
 *
 * No Electron dependencies — this is a core, platform-agnostic module.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Chat Completions types (input side — matches proxy's OpenAI* interfaces)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatTextContentPart {
  type: 'text';
  text: string;
}

export interface ChatImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type ChatContentPart =
  | ChatTextContentPart
  | ChatImageUrlContentPart;

export interface ChatToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatJsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export type ChatResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | ChatJsonSchemaResponseFormat;

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  temperature?: number;
  max_completion_tokens?: number;
  reasoning_effort?: string;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  response_format?: ChatResponseFormat;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string;
      tool_calls?: ChatToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

// ---------------------------------------------------------------------------
// Responses API types (Codex side)
// ---------------------------------------------------------------------------

/** User input item */
export interface ResponsesUserInput {
  role: 'user';
  content: Array<
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string }
  >;
}

/** Assistant message item (in input context, represents prior assistant output) */
export interface ResponsesAssistantMessage {
  type: 'message';
  id?: string;
  role: 'assistant';
  content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>;
  status: 'completed';
}

/** Function call item */
export interface ResponsesFunctionCall {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status: 'completed';
}

/** Function call output item */
export interface ResponsesFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesUserInput
  | ResponsesAssistantMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput;

export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface ResponsesJsonSchemaTextFormat {
  type: 'json_schema';
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export type ResponsesTextFormat =
  | { type: 'text' }
  | ResponsesJsonSchemaTextFormat;

export interface ResponsesRequest {
  model: string;
  input: ResponsesInputItem[];
  previous_response_id?: string;
  instructions?: string;
  tools?: ResponsesTool[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; name: string };
  // NOTE: intentionally NOT emitted by translateChatToResponses — Responses-API models reject it
  // (HTTP 400 "Unsupported parameter: temperature"). Kept only to type the wire shape; do not assign it.
  temperature?: number;
  max_output_tokens?: number;
  reasoning?: { effort: string; summary?: string };
  stream: boolean;
  store: false;
  text: { format: ResponsesTextFormat };
}

/** Shape of a non-streaming Responses API result */
export interface ResponsesApiResponse {
  id: string;
  object?: string;
  model: string;
  output: Array<ResponsesOutputItem>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  status?: string;
  error?: { message?: string; code?: string } | null;
}

export interface ResponsesOutputTextContent {
  type: 'output_text';
  text: string;
  annotations: unknown[];
}

export interface ResponsesOutputMessage {
  type: 'message';
  id?: string;
  role: 'assistant';
  content: ResponsesOutputTextContent[];
  status: string;
}

export interface ResponsesOutputFunctionCall {
  type: 'function_call';
  id?: string;
  call_id: string;
  name: string;
  arguments: string;
  status: string;
}

export type ResponsesOutputItem = ResponsesOutputMessage | ResponsesOutputFunctionCall;

const extractTextFromChatMessageContent = (
  content: ChatMessage['content'],
): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((part): part is ChatTextContentPart => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
};

const toResponsesUserContent = (
  content: ChatMessage['content'],
): ResponsesUserInput['content'] => {
  if (typeof content === 'string' || content === null) {
    return [{ type: 'input_text', text: content ?? '' }];
  }

  const parts = content
    .map((part) => {
      if (part.type === 'text') {
        return { type: 'input_text' as const, text: part.text };
      }
      if (part.type === 'image_url' && typeof part.image_url?.url === 'string' && part.image_url.url.length > 0) {
        return { type: 'input_image' as const, image_url: part.image_url.url };
      }
      return null;
    })
    .filter((part): part is ResponsesUserInput['content'][number] => part !== null);

  return parts.length > 0 ? parts : [{ type: 'input_text', text: '' }];
};

const ensureNonEmptyResponsesInput = (input: ResponsesInputItem[]): ResponsesInputItem[] => {
  if (input.length > 0) return input;
  return [{ role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] }];
};

// ---------------------------------------------------------------------------
// 1. translateChatToResponses
// ---------------------------------------------------------------------------

/**
 * Reasoning summary mode passed to the Responses API when the caller sets a
 * `reasoning_effort`.  'auto' lets the model emit a summary only when it
 * actually reasons, which keeps output_text clean of self-talk (the primary
 * bug this constant was introduced to fix — GPT-5.5 reasoning bled into the
 * visible answer because no summary channel was requested).  Accepted by both
 * the Codex OAuth passthrough and direct OpenAI Responses-API callers.
 */
const CODEX_REASONING_SUMMARY_MODE = 'auto';

/**
 * Translate a Chat Completions request body into a Codex Responses API request.
 */
export function translateChatToResponses(chatBody: ChatCompletionRequest): ResponsesRequest {
  const input: ResponsesInputItem[] = [];
  const systemParts: string[] = [];

  for (const msg of chatBody.messages) {
    switch (msg.role) {
      case 'system':
      case 'developer':
        {
          const text = extractTextFromChatMessageContent(msg.content);
          if (text) systemParts.push(text);
        }
        break;

      case 'user':
        input.push({
          role: 'user',
          content: toResponsesUserContent(msg.content),
        });
        break;

      case 'assistant': {
        // Assistant text → message item
        const assistantText = extractTextFromChatMessageContent(msg.content);
        if (assistantText) {
          input.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: assistantText, annotations: [] }],
            status: 'completed',
          });
        }
        // tool_calls → separate function_call items
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            input.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.function.name,
              arguments: tc.function.arguments,
              status: 'completed',
            });
          }
        }
        break;
      }

      case 'tool':
        if (msg.tool_call_id) {
          const toolText = extractTextFromChatMessageContent(msg.content);
          input.push({
            type: 'function_call_output',
            call_id: msg.tool_call_id,
            output: toolText,
          });
        }
        break;
    }
  }

  const instructions = systemParts.length > 0
    ? systemParts.join('\n\n')
    : 'You are a helpful assistant.';

  const textFormat: ResponsesTextFormat =
    chatBody.response_format?.type === 'json_schema'
      ? {
          type: 'json_schema',
          name: chatBody.response_format.json_schema.name,
          schema: chatBody.response_format.json_schema.schema,
          ...(chatBody.response_format.json_schema.strict !== undefined
            ? { strict: chatBody.response_format.json_schema.strict }
            : {}),
        }
      : { type: 'text' };

  const result: ResponsesRequest = {
    model: chatBody.model,
    input: ensureNonEmptyResponsesInput(input),
    instructions,
    stream: chatBody.stream ?? false,
    store: false,
    text: { format: textFormat },
  };

  // This translator is POSITIVE-ALLOWLIST: it only forwards fields explicitly constructed
  // above / below. Sampling and other params NOT in that allowlist are intentionally dropped
  // because every caller targets a Responses-API endpoint (Codex passthrough + OpenAI reasoning
  // models gated by needsResponsesApiRoute), and those models reject them with HTTP 400
  // "Unsupported parameter: <field>". Do NOT add a temperature/top_p/etc. pass-through here.
  // Sampling params are disabled on reasoning models by design — reasoning_effort is the control.
  // Known-rejected fields this seam must never leak:
  // - temperature / top_p: rejected ("'temperature' is not supported with this model" / "only default 1").
  // - max_output_tokens: rejected ("Unsupported parameter: max_output_tokens"); API uses its own default.
  if (chatBody.reasoning_effort) {
    // Request a reasoning summary channel so GPT reasoning self-talk routes to
    // that channel instead of bleeding into output_text (the visible answer).
    // CODEX_REASONING_SUMMARY_MODE = 'auto' emits summaries only when the
    // model actually reasons, accepted by both Codex OAuth and direct OpenAI.
    result.reasoning = { effort: chatBody.reasoning_effort, summary: CODEX_REASONING_SUMMARY_MODE };
  }

  // Translate tools (unwrap nested function → flat)
  if (chatBody.tools && chatBody.tools.length > 0) {
    result.tools = chatBody.tools.map((tool) => ({
      type: 'function' as const,
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
    }));
  }

  // Translate tool_choice
  if (chatBody.tool_choice !== undefined) {
    if (typeof chatBody.tool_choice === 'string') {
      result.tool_choice = chatBody.tool_choice;
    } else if (chatBody.tool_choice.type === 'function') {
      result.tool_choice = {
        type: 'function',
        name: chatBody.tool_choice.function.name,
      };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 2. translateResponsesToChatCompletion
// ---------------------------------------------------------------------------

/**
 * Extract reasoning summary text from a non-streaming Responses API JSON body.
 *
 * When the request includes `reasoning: { summary: 'auto' }`, the Responses API
 * returns reasoning items in `output[]` with shape:
 *   { type: 'reasoning', summary: [{ type: 'summary_text', text: '...' }] }
 *
 * This helper finds those items and concatenates their summary text, returning
 * an empty string when no reasoning was emitted (model did not reason, or
 * `summary` was not requested).
 *
 * Use this for callers that call the Responses API in non-streaming mode
 * (`stream: false`) and receive a plain JSON response body — as opposed to the
 * SSE-buffered path (Codex passthrough) which uses the `onReasoningSummary`
 * callback on `readResponsesSseToCompletion`.
 */
export function extractReasoningFromResponsesJson(body: ResponsesApiResponse): string {
  const parts: string[] = [];
  for (const item of body.output) {
    // The ResponsesOutputItem union only covers message + function_call, but the
    // actual API response may include reasoning items — access via loose cast.
    const raw = item as {
      type?: string;
      summary?: Array<{ type?: string; text?: string }>;
    };
    if (raw.type !== 'reasoning') continue;
    if (!Array.isArray(raw.summary)) continue;
    for (const part of raw.summary) {
      if (part.type === 'summary_text' && typeof part.text === 'string' && part.text.length > 0) {
        parts.push(part.text);
      }
    }
  }
  return parts.join('');
}

/**
 * Translate a non-streaming Codex Responses API response into a Chat Completions response.
 *
 * @param body - The Responses API body (output items, usage, etc.)
 * @param options.reasoningContent - Optional pre-accumulated reasoning summary text from the
 *   SSE accumulator.  When present it is forwarded as `message.reasoning_content` so the
 *   downstream `extractOpenAITextFields` / `translateResponseToNeutral` routes it to the
 *   "Behind the scenes" thinking channel, matching the streaming path.
 */
export function translateResponsesToChatCompletion(
  body: ResponsesApiResponse,
  options?: { reasoningContent?: string },
): ChatCompletionResponse {
  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const item of body.output) {
    if (item.type === 'message' && item.content) {
      if (!Array.isArray(item.content)) continue;
      for (const block of item.content) {
        if (block.type === 'output_text' && block.text) {
          textParts.push(block.text);
        }
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      });
    }
  }

  const content = textParts.length > 0 ? textParts.join('') : null;
  const hasToolCalls = toolCalls.length > 0;

  let finishReason: 'stop' | 'tool_calls' | 'length' | null;
  if (body.status === 'incomplete') {
    finishReason = 'length';
  } else if (hasToolCalls) {
    finishReason = 'tool_calls';
  } else {
    finishReason = 'stop';
  }

  const reasoningContent = options?.reasoningContent;

  return {
    id: body.id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          // Surface reasoning summary text as reasoning_content so the downstream
          // extractOpenAITextFields / translateResponseToNeutral routes it to the
          // thinking channel ("Behind the scenes"), matching the streaming path.
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(hasToolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      },
    ],
    usage: {
      prompt_tokens: body.usage?.input_tokens ?? 0,
      completion_tokens: body.usage?.output_tokens ?? 0,
      total_tokens: body.usage?.total_tokens ?? (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
      ...(body.usage?.input_tokens_details?.cached_tokens != null
        ? { prompt_tokens_details: { cached_tokens: body.usage.input_tokens_details.cached_tokens } }
        : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 3. createStreamTranslator
// ---------------------------------------------------------------------------

export interface StreamTranslator {
  /**
   * Translate a Responses SSE event into a Chat Completions SSE chunk string,
   * or null if the event should be skipped.
   */
  translateEvent(eventType: string, eventData: Record<string, unknown>): string | null;
}

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

function stripControlCharsAndCap(value: string): string {
  return value.replace(/[\u0000-\u0009\u000B\u000C\u000E-\u001F]/g, '').slice(0, 500);
}

function extractErrorMessageOpaque(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err === 'string') return stripControlCharsAndCap(err);

  if (Array.isArray(err)) {
    const first = err[0];
    if (first && typeof first === 'object') {
      const message = (first as { message?: unknown }).message;
      if (typeof message === 'string') return stripControlCharsAndCap(message);
    }
    try {
      return stripControlCharsAndCap(JSON.stringify(err));
    } catch {
      return null;
    }
  }

  if (typeof err === 'object') {
    const e = err as {
      message?: unknown;
      detail?: unknown;
      text?: unknown;
      reason?: unknown;
    };
    if (typeof e.message === 'string') return stripControlCharsAndCap(e.message);
    if (typeof e.detail === 'string') return stripControlCharsAndCap(e.detail);
    if (typeof e.text === 'string') return stripControlCharsAndCap(e.text);
    if (typeof e.reason === 'string') return stripControlCharsAndCap(e.reason);
    try {
      return stripControlCharsAndCap(JSON.stringify(err));
    } catch {
      return null;
    }
  }

  return stripControlCharsAndCap(String(err));
}

type CodexTerminalEventType = 'response.failed' | 'error';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractAllowlistedErrorMessage(err: unknown): string | null {
  if (err == null) return null;
  if (typeof err === 'string') return stripControlCharsAndCap(err);

  if (Array.isArray(err)) {
    return extractAllowlistedErrorMessage(err[0]);
  }

  const record = asRecord(err);
  if (!record) return null;
  for (const key of ['message', 'detail', 'text', 'reason'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return stripControlCharsAndCap(value);
    }
  }
  return extractAllowlistedErrorMessage(record.error);
}

function readStringField(record: Record<string, unknown> | null, field: 'type' | 'code'): string | undefined {
  const value = record?.[field];
  return typeof value === 'string' && value.length > 0 ? stripControlCharsAndCap(value) : undefined;
}

function readStatusField(record: Record<string, unknown> | null): string | undefined {
  const value = record?.status;
  if (typeof value === 'string' && value.length > 0) return stripControlCharsAndCap(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function collectTerminalErrorFields(
  eventType: CodexTerminalEventType,
  sources: ReadonlyArray<unknown>,
): { eventType: CodexTerminalEventType; type?: string; code?: string; status?: string } {
  const records = sources
    .map(asRecord)
    .filter((record): record is Record<string, unknown> => record !== null);
  const nestedErrorRecords = records
    .map((record) => asRecord(record.error))
    .filter((record): record is Record<string, unknown> => record !== null);
  const candidates = [...records, ...nestedErrorRecords];
  return {
    eventType,
    type: candidates.map((record) => readStringField(record, 'type')).find(Boolean),
    code: candidates.map((record) => readStringField(record, 'code')).find(Boolean),
    status: candidates.map(readStatusField).find(Boolean),
  };
}

/**
 * Quota / rate-limit `type`/`code` signals that must surface as HTTP 429 (so the
 * proxy classifies them as billing/rate-limit, not a generic 502/api_error —
 * matching the direct-HTTP-429 path; REBEL-4GH / FOX-3152). Deliberately a NARROW
 * allowlist: a generic `response.failed` stays 502 (GPT-5.5 review F1 — don't map
 * all terminal failures to 429).
 */
const CODEX_QUOTA_SIGNALS: ReadonlySet<string> = new Set([
  'usage_limit_reached', 'rate_limit_exceeded', 'rate_limit_error', 'rate_limit',
]);

function isCodexQuotaSignal(value: string | undefined): boolean {
  return value !== undefined && CODEX_QUOTA_SIGNALS.has(value);
}

/**
 * Single throw site for ALL buffered-reader terminal failures (`response.failed`
 * / `error` events AND `response.completed` with `status:"failed"`). A quota /
 * rate signal (narrow allowlist) becomes HTTP 429 (`rate_limit_error` + preserved
 * `code` + reset timing, sanitized — only allowlisted fields), so it classifies
 * as billing/rate-limit matching the direct-HTTP-429 path; everything else stays
 * 502. Reset timing is read from any source record OR its nested `error` (the
 * SSE `error` event nests quota fields under `.error`). REBEL-4GH / FOX-3152.
 */
function throwCodexTerminalError(
  throwUpstreamError: (status: number, body: string) => Error,
  sources: ReadonlyArray<unknown>,
  message: string,
): never {
  const fields = collectTerminalErrorFields('response.failed', sources);
  const quotaCode = isCodexQuotaSignal(fields.code) ? fields.code
    : isCodexQuotaSignal(fields.type) ? fields.type
    : undefined;
  if (quotaCode) {
    const records = sources.map(asRecord).filter((r): r is Record<string, unknown> => r !== null);
    const candidates = [
      ...records,
      ...records.map((r) => asRecord(r.error)).filter((r): r is Record<string, unknown> => r !== null),
    ];
    const resetsAt = candidates.map((r) => r.resets_at).find((v) => typeof v === 'number');
    const resetsIn = candidates.map((r) => r.resets_in_seconds).find((v) => typeof v === 'number');
    const safeBody = JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message,
        code: quotaCode,
        ...(typeof resetsAt === 'number' ? { resets_at: resetsAt } : {}),
        ...(typeof resetsIn === 'number' ? { resets_in_seconds: resetsIn } : {}),
      },
    });
    throw throwUpstreamError(429, safeBody);
  }
  throw throwUpstreamError(502, message);
}

function makeTerminalErrorDescriptor(fields: {
  eventType: CodexTerminalEventType;
  type?: string;
  code?: string;
  status?: string;
}): string {
  const parts = [
    `eventType=${fields.eventType}`,
    fields.type ? `type=${fields.type}` : null,
    fields.code ? `code=${fields.code}` : null,
    fields.status ? `status=${fields.status}` : null,
  ].filter((part): part is string => part !== null);
  return `Codex terminal error (${parts.join(', ')})`;
}

function getTerminalFailureMessage(rawResponse: unknown): string | null {
  if (!rawResponse || typeof rawResponse !== 'object') return null;
  const rawObj = rawResponse as Record<string, unknown>;
  const rawError = rawObj.error;
  const rawStatus = rawObj.status;
  const isTerminalFailure = rawError != null
    || (
      typeof rawStatus === 'string'
      && rawStatus !== 'completed'
      && rawStatus !== 'in_progress'
    );

  if (!isTerminalFailure) return null;
  return extractErrorMessageOpaque(rawError)
    ?? `Codex returned status: ${typeof rawStatus === 'string' ? rawStatus : 'unspecified'}`;
}

function getIncompleteReason(eventData: Record<string, unknown>): string {
  const response = eventData.response;
  const source = response && typeof response === 'object'
    ? response as Record<string, unknown>
    : eventData;
  const incompleteDetails = source.incomplete_details;
  if (incompleteDetails && typeof incompleteDetails === 'object') {
    const reason = (incompleteDetails as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.length > 0) {
      return stripControlCharsAndCap(reason);
    }
  }
  return 'unspecified';
}

function makeTranslatorErrorChunk(message: string): string {
  return `data: ${JSON.stringify({ error: { message: stripControlCharsAndCap(message), type: 'server_error' } })}\n\n`;
}

/**
 * Create a per-stream translator with isolated mutable state.
 * Each concurrent stream gets its own translator instance.
 */
export function createStreamTranslator(): StreamTranslator {
  // Per-stream mutable state
  let responseId = '';
  let model = '';
  const created = Math.floor(Date.now() / 1000);
  const toolCallMap = new Map<string, number>(); // item_id → tool_call index
  let nextToolCallIndex = 0;
  let hasToolCalls = false;
  let sentInitialRole = false;

  function makeChunk(
    delta: ChatCompletionChunk['choices'][0]['delta'],
    finishReason: ChatCompletionChunk['choices'][0]['finish_reason'] = null,
    usage?: ChatCompletionChunk['usage'],
  ): string {
    const chunk: ChatCompletionChunk = {
      id: responseId || `chatcmpl-${Date.now()}`,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    if (usage) {
      chunk.usage = usage;
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  function ensureInitialRole(): string {
    if (!sentInitialRole) {
      sentInitialRole = true;
      return makeChunk({ role: 'assistant' });
    }
    return '';
  }

  return {
    translateEvent(eventType: string, eventData: Record<string, unknown>): string | null {
      switch (eventType) {
        // Capture metadata from the response object
        case 'response.created': {
          const resp = eventData as { id?: string; model?: string };
          if (resp.id) responseId = resp.id;
          if (resp.model) model = resp.model;
          return null;
        }

        // Text content delta
        case 'response.output_text.delta': {
          const delta = eventData as { delta?: string };
          if (!delta.delta) return null;
          const prefix = ensureInitialRole();
          return prefix + makeChunk({ content: delta.delta });
        }

        // Reasoning summary deltas — route to reasoning_content channel so the
        // downstream openaiTranslators.processStreamChunk maps them to
        // thinking_delta → "Behind the scenes".  The part.added / *.done
        // boundary events and *.text.done carry no text and are no-ops here.
        case 'response.reasoning_summary_text.delta': {
          const data = eventData as { delta?: string };
          if (!data.delta) return null;
          const prefix = ensureInitialRole();
          return prefix + makeChunk({ reasoning_content: data.delta });
        }

        // No-op: part boundary events (no text; streaming consumer needs no action)
        case 'response.reasoning_summary_part.added':
        case 'response.reasoning_summary_part.done':
        case 'response.reasoning_summary_text.done':
          return null;

        // New function call output item added
        case 'response.output_item.added': {
          const data = eventData as {
            item?: { type?: string; id?: string; call_id?: string; name?: string };
          };
          const item = data.item;
          if (!item || item.type !== 'function_call') return null;

          hasToolCalls = true;
          const index = nextToolCallIndex++;
          if (item.id) toolCallMap.set(item.id, index);

          const prefix = ensureInitialRole();
          return prefix + makeChunk({
            tool_calls: [{
              index,
              id: item.call_id ?? item.id ?? `call_${index}`,
              type: 'function',
              function: {
                name: item.name ?? '',
                arguments: '',
              },
            }],
          });
        }

        // Function call arguments streaming (both event name variants)
        case 'response.function_call_arguments.delta':
        case 'response.function_call.arguments.delta': {
          const data = eventData as { item_id?: string; delta?: string };
          if (!data.delta) return null;

          const index = data.item_id ? (toolCallMap.get(data.item_id) ?? 0) : 0;
          return makeChunk({
            tool_calls: [{
              index,
              function: { arguments: data.delta },
            }],
          });
        }

        // Stream completed
        case 'response.completed': {
          const resp = eventData as {
            response?: {
              status?: string;
              error?: unknown;
              usage?: {
                input_tokens: number;
                output_tokens: number;
                total_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
              };
            };
          };
          const responseCandidate = getResponseCandidate(eventData);
          const terminalFailureMessage = getTerminalFailureMessage(responseCandidate);
          if (terminalFailureMessage) {
            return makeTranslatorErrorChunk(`Codex completed with failure: ${terminalFailureMessage}`);
          }

          const finishReason = hasToolCalls ? 'tool_calls' as const : 'stop' as const;
          let usage: ChatCompletionChunk['usage'] | undefined;
          if (resp.response?.usage) {
            const u = resp.response.usage;
            usage = {
              prompt_tokens: u.input_tokens,
              completion_tokens: u.output_tokens,
              total_tokens: u.total_tokens ?? (u.input_tokens + u.output_tokens),
              ...(u.input_tokens_details?.cached_tokens != null
                ? { prompt_tokens_details: { cached_tokens: u.input_tokens_details.cached_tokens } }
                : {}),
            };
          }

          const prefix = ensureInitialRole();
          return prefix + makeChunk({}, finishReason, usage) + 'data: [DONE]\n\n';
        }

        case 'response.incomplete': {
          return makeTranslatorErrorChunk(`Codex completed incomplete: ${getIncompleteReason(eventData)}`);
        }

        // Error events — pass through structured fields verbatim (dumb transport)
        case 'response.failed': {
          const data = eventData as { response?: { error?: unknown; status?: unknown } };
          const upstream = data.response?.error;
          const safeFields = collectTerminalErrorFields('response.failed', [upstream, data.response, eventData]);
          const translated: Record<string, string> = {
            message: extractAllowlistedErrorMessage(upstream) ?? makeTerminalErrorDescriptor(safeFields),
            type: safeFields.type ?? 'server_error',
          };
          if (safeFields.code) translated.code = safeFields.code;
          if (safeFields.status) translated.status = safeFields.status;
          return `data: ${JSON.stringify({ error: translated })}\n\n`;
        }

        case 'error': {
          const data = eventData as { message?: unknown; detail?: unknown; text?: unknown; reason?: unknown; type?: unknown; code?: unknown; error?: unknown };
          const nestedError = asRecord(data.error);
          const safeFields = collectTerminalErrorFields('error', [data.error, eventData]);
          const fallbackMessage = extractAllowlistedErrorMessage({
            detail: data.detail,
            text: data.text,
            reason: data.reason,
          });
          const translated: Record<string, string> = {
            message: extractAllowlistedErrorMessage(data.message)
              ?? extractAllowlistedErrorMessage(nestedError)
              ?? fallbackMessage
              ?? makeTerminalErrorDescriptor(safeFields),
            type: safeFields.type ?? 'server_error',
          };
          if (safeFields.code) translated.code = safeFields.code;
          if (safeFields.status) translated.status = safeFields.status;
          return `data: ${JSON.stringify({ error: translated })}\n\n`;
        }

        default:
          // Ignore unrecognised events (response.output_item.done, etc.)
          return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 4. ResponsesApiResponseSchema — boundary validation
// ---------------------------------------------------------------------------

const ResponsesOutputTextContentSchema = z.object({
  type: z.literal('output_text'),
  text: z.string().catch(''),
  annotations: z.array(z.unknown()).catch([]),
});

const ResponsesOutputMessageSchema = z.object({
  type: z.literal('message'),
  id: z.string().optional(),
  role: z.literal('assistant'),
  content: z.array(ResponsesOutputTextContentSchema).catch([]),
  status: z.string().catch('completed'),
});

const ResponsesOutputFunctionCallSchema = z.object({
  type: z.literal('function_call'),
  id: z.string().optional(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string().catch(''),
  status: z.string().catch('completed'),
});

export const ResponsesApiResponseSchema: z.ZodType<ResponsesApiResponse> = z.object({
  id: z.string().catch(''),
  object: z.string().optional(),
  model: z.string().catch(''),
  output: z.array(z.union([
    ResponsesOutputMessageSchema,
    ResponsesOutputFunctionCallSchema,
    z.object({ type: z.string() }).passthrough(),
  ])).catch([]),
  usage: z.object({
    input_tokens: z.number().catch(0),
    output_tokens: z.number().catch(0),
    total_tokens: z.number().optional(),
    input_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
  }).optional(),
  status: z.string().optional(),
  // intent-critical: do not "clean up" .catch(undefined as unknown as string)
  //   to .catch('') or remove the cast. The cast preserves the runtime "undefined"
  //   value that signals shape-drift to the failure-detection-first path; an
  //   empty string would mask "shape-drifted" as "actually empty". See plan
  //   docs/plans/260506_codex_sse_translator_hardening_followup.md (Stage 6
  //   sub-step 2) and the iteration-cluster postmortem at
  //   docs-private/postmortems/260504_codex_passthrough_stream_invariant_postmortem.md.
  error: z.object({
    message: z.string().catch(undefined as unknown as string),
    code: z.string().optional(),
  }).passthrough().nullable().optional(),
}) as z.ZodType<ResponsesApiResponse>;

// ---------------------------------------------------------------------------
// 5. readResponsesSseToCompletion — buffer SSE stream → ResponsesApiResponse
// ---------------------------------------------------------------------------

export interface SseDiagnostic {
  eventCount: number;
  chunkCount: number;
  bytesDecoded: number;
  lastEventType: string;
  sawCompleted: boolean;
  elapsedMs: number;
  reconciliation?: {
    accumulator: 'empty' | 'populated';
    snapshot: 'empty' | 'populated';
    usingAccumulator: boolean;
    divergence?: {
      accumulatorItemCount: number;
      snapshotItemCount: number;
      accumulatorTextLength: number;
      snapshotTextLength: number;
      countMismatch: boolean;
      textLengthMismatch: boolean;
    };
  };
  schemaValidation?: {
    result: 'failed';
    paths: string[];
  };
  upstreamMessage?: string;
  usageDefaulted?: boolean;
  warning?: string;
}

export interface ReadResponsesSseOptions {
  /** Per-chunk timeout (ms). Aborts the buffering loop if a single
   *  reader.read() exceeds this. Default 30_000. */
  streamChunkTimeoutMs?: number;
  /** Optional sanitized diagnostics callback (success and failure paths). */
  onDiagnostic?: (info: SseDiagnostic) => void;
  /** Called on success with the accumulated reasoning summary text (empty string when the
   *  model emitted no reasoning).  Callers that need to surface reasoning via
   *  `translateResponsesToChatCompletion({ reasoningContent })` use this to capture the text
   *  without changing the function's return type.  */
  onReasoningSummary?: (text: string) => void;
  /** Factory for caller-typed upstream errors. Allows main-process callers to
   *  throw `CodexUpstreamError` and Codex-client callers to throw `ModelError`
   *  without coupling the helper to a specific error class. */
  throwUpstreamError: (status: number, body: string) => Error;
}

export function parseSseEventBlock(block: string): { event: string; data: string } | null {
  let event = '';
  const dataLines: string[] = [];

  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(':')) continue;

    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const field = line.slice(0, colonIndex);
    let value = line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event = value.trim();
    else if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

type AccumulatedOutput =
  | {
      type: 'message';
      id?: string;
      text: string;
    }
  | {
      /** Reasoning summary text — kept separate from message.text so it never
       *  bleeds into output_text.  materializeOutputs omits it from the Responses
       *  API output[] (there is no reasoning item schema in ResponsesOutputItem);
       *  translateResponsesToChatCompletion reads it via the accumulator's
       *  `reasoningSummaryText` side-channel instead.  */
      type: 'reasoning';
      summaryText: string;
    }
  | {
      type: 'function_call';
      id?: string;
      call_id: string;
      name: string;
      arguments: string;
    };

interface BufferingAccumulator {
  readonly id: string;
  readonly model: string;
  readonly outputs: ResponsesOutputItem[];
  /** Accumulated reasoning summary text (empty string if no reasoning was emitted). */
  readonly reasoningSummaryText: string;
  consume(eventType: string, eventData: Record<string, unknown>): void;
}

/**
 * Per-event accumulator for Codex Responses SSE. Synthesizes the final
 * `ResponsesApiResponse` from `response.output_text.delta`,
 * `response.function_call_arguments.delta`, etc., rather than relying on
 * the `response.completed.response.output[]` snapshot.
 *
 * INVARIANT: this accumulator MUST track the same event-type set as
 * `createStreamTranslator` above. When Codex adds a new event type
 * (e.g., a hypothetical `response.thinking.delta`), update BOTH or the
 * buffered consumer will silently produce different content from the
 * streaming consumer. The streaming-vs-buffering parity test in
 * `__tests__/codexResponsesTranslator.test.ts` locks this invariant.
 */
function createBufferingAccumulator(): BufferingAccumulator {
  let responseId = '';
  let model = '';
  const outputsByIndex = new Map<number, AccumulatedOutput>();
  const itemIdToOutputIndex = new Map<string, number>();
  /** Index reserved for the reasoning summary pseudo-output (never emitted to outputs[]). */
  let reasoningOutputIndex: number | null = null;

  function nextOutputIndex(): number {
    if (outputsByIndex.size === 0) return 0;
    return Math.max(...outputsByIndex.keys()) + 1;
  }

  function resolveOutputIndex(data: { output_index?: unknown; item_id?: unknown }, fallbackType?: AccumulatedOutput['type']): number {
    if (typeof data.output_index === 'number' && Number.isInteger(data.output_index) && data.output_index >= 0) {
      return data.output_index;
    }

    if (typeof data.item_id === 'string') {
      const mapped = itemIdToOutputIndex.get(data.item_id);
      if (mapped !== undefined) return mapped;
    }

    if (fallbackType) {
      for (const [index, output] of outputsByIndex) {
        if (output.type === fallbackType) return index;
      }
    }

    return 0;
  }

  function ensureMessage(index: number, id?: string): Extract<AccumulatedOutput, { type: 'message' }> {
    const existing = outputsByIndex.get(index);
    if (existing?.type === 'message') {
      if (id && !existing.id) existing.id = id;
      return existing;
    }

    const message: Extract<AccumulatedOutput, { type: 'message' }> = {
      type: 'message',
      ...(id ? { id } : {}),
      text: '',
    };
    outputsByIndex.set(index, message);
    return message;
  }

  function ensureFunctionCall(
    index: number,
    item?: { id?: string; call_id?: string; name?: string },
  ): Extract<AccumulatedOutput, { type: 'function_call' }> {
    const existing = outputsByIndex.get(index);
    if (existing?.type === 'function_call') {
      if (item?.id && !existing.id) existing.id = item.id;
      if (item?.call_id && existing.call_id.startsWith('call_')) existing.call_id = item.call_id;
      if (item?.name && !existing.name) existing.name = item.name;
      return existing;
    }

    const functionCall: Extract<AccumulatedOutput, { type: 'function_call' }> = {
      type: 'function_call',
      ...(item?.id ? { id: item.id } : {}),
      call_id: item?.call_id ?? item?.id ?? `call_${index}`,
      name: item?.name ?? '',
      arguments: '',
    };
    outputsByIndex.set(index, functionCall);
    return functionCall;
  }

  function materializeOutputs(): ResponsesOutputItem[] {
    return [...outputsByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, output]): ResponsesOutputItem | null => {
        if (output.type === 'message') {
          if (output.text.length === 0) return null;
          return {
            type: 'message',
            ...(output.id ? { id: output.id } : {}),
            role: 'assistant',
            content: [{ type: 'output_text', text: output.text, annotations: [] }],
            status: 'completed',
          };
        }

        // Reasoning summary is a side-channel — omit from Responses API outputs[]
        // (there is no reasoning item schema in ResponsesOutputItem; the text is
        // surfaced via reasoningSummaryText instead).
        if (output.type === 'reasoning') return null;

        return {
          type: 'function_call',
          ...(output.id ? { id: output.id } : {}),
          call_id: output.call_id,
          name: output.name,
          arguments: output.arguments,
          status: 'completed',
        };
      })
      .filter((output): output is ResponsesOutputItem => output !== null);
  }

  function getReasoningSummaryText(): string {
    if (reasoningOutputIndex === null) return '';
    const output = outputsByIndex.get(reasoningOutputIndex);
    return output?.type === 'reasoning' ? output.summaryText : '';
  }

  return {
    get id() {
      return responseId;
    },
    get model() {
      return model;
    },
    get outputs() {
      return materializeOutputs();
    },
    get reasoningSummaryText() {
      return getReasoningSummaryText();
    },
    consume(eventType: string, eventData: Record<string, unknown>): void {
      switch (eventType) {
        case 'response.created': {
          const data = eventData as {
            id?: unknown;
            model?: unknown;
            response?: { id?: unknown; model?: unknown };
          };
          const id = typeof data.id === 'string' ? data.id : data.response?.id;
          const createdModel = typeof data.model === 'string' ? data.model : data.response?.model;
          if (typeof id === 'string') responseId = id;
          if (typeof createdModel === 'string') model = createdModel;
          break;
        }

        case 'response.output_item.added': {
          const data = eventData as {
            output_index?: unknown;
            item?: {
              type?: unknown;
              id?: unknown;
              call_id?: unknown;
              name?: unknown;
            };
          };
          const item = data.item;
          if (!item) break;
          const outputIndex = typeof data.output_index === 'number' && Number.isInteger(data.output_index) && data.output_index >= 0
            ? data.output_index
            : nextOutputIndex();
          const itemId = typeof item.id === 'string' ? item.id : undefined;
          if (itemId) itemIdToOutputIndex.set(itemId, outputIndex);

          if (item.type === 'message') {
            ensureMessage(outputIndex, itemId);
          } else if (item.type === 'function_call') {
            ensureFunctionCall(outputIndex, {
              ...(itemId ? { id: itemId } : {}),
              ...(typeof item.call_id === 'string' ? { call_id: item.call_id } : {}),
              ...(typeof item.name === 'string' ? { name: item.name } : {}),
            });
          }
          break;
        }

        case 'response.output_text.delta': {
          const data = eventData as { output_index?: unknown; item_id?: unknown; delta?: unknown };
          if (typeof data.delta !== 'string' || data.delta.length === 0) break;
          const outputIndex = resolveOutputIndex(data, 'message');
          ensureMessage(outputIndex).text += data.delta;
          break;
        }

        case 'response.function_call_arguments.delta':
        case 'response.function_call.arguments.delta': {
          const data = eventData as { output_index?: unknown; item_id?: unknown; delta?: unknown };
          if (typeof data.delta !== 'string' || data.delta.length === 0) break;
          const outputIndex = resolveOutputIndex(data, 'function_call');
          ensureFunctionCall(outputIndex).arguments += data.delta;
          break;
        }

        // Reasoning summary deltas — accumulate into a dedicated reasoning slot
        // that is separate from message text (parity with createStreamTranslator
        // which routes these to reasoning_content, not content/output_text).
        // The part.added / *.done boundary events carry no text and are no-ops.
        case 'response.reasoning_summary_text.delta': {
          const data = eventData as { delta?: unknown };
          if (typeof data.delta !== 'string' || data.delta.length === 0) break;
          if (reasoningOutputIndex === null) {
            reasoningOutputIndex = nextOutputIndex();
            outputsByIndex.set(reasoningOutputIndex, { type: 'reasoning', summaryText: '' });
          }
          const reasoning = outputsByIndex.get(reasoningOutputIndex);
          if (reasoning?.type === 'reasoning') {
            reasoning.summaryText += data.delta;
          }
          break;
        }

        // No-op: reasoning part boundary events (no text, no state change needed)
        case 'response.reasoning_summary_part.added':
        case 'response.reasoning_summary_part.done':
        case 'response.reasoning_summary_text.done':
          break;
      }
    },
  };
}

function getResponseCandidate(eventData: Record<string, unknown>): unknown {
  const wrapped = (eventData as { response?: unknown }).response;
  return wrapped !== undefined ? wrapped : eventData;
}

function getRawOutputLength(candidate: unknown): number {
  if (!candidate || typeof candidate !== 'object') return 0;
  const output = (candidate as { output?: unknown }).output;
  return Array.isArray(output) ? output.length : 0;
}

function getOutputTextLength(outputs: ResponsesOutputItem[]): number {
  return outputs.reduce((total, output) => {
    if (output.type === 'message') {
      return total + output.content.reduce((sum, content) => sum + content.text.length, 0);
    }

    return total + output.arguments.length;
  }, 0);
}

function getReconciliationDivergence(
  accumulatorOutputs: ResponsesOutputItem[],
  snapshotOutputs: ResponsesOutputItem[],
): NonNullable<NonNullable<SseDiagnostic['reconciliation']>['divergence']> {
  const accumulatorTextLength = getOutputTextLength(accumulatorOutputs);
  const snapshotTextLength = getOutputTextLength(snapshotOutputs);
  const textLengthDiff = Math.abs(accumulatorTextLength - snapshotTextLength);
  const textLengthThreshold = Math.max(accumulatorTextLength, snapshotTextLength, 1) * 0.05;

  return {
    accumulatorItemCount: accumulatorOutputs.length,
    snapshotItemCount: snapshotOutputs.length,
    accumulatorTextLength,
    snapshotTextLength,
    countMismatch: accumulatorOutputs.length !== snapshotOutputs.length,
    textLengthMismatch: textLengthDiff > textLengthThreshold,
  };
}

function getSchemaIssuePaths(error: z.ZodError): string[] {
  return error.issues
    .map(i => `${i.path.join('.')}(${i.code})`)
    .filter((p, i, a) => a.indexOf(p) === i)
    .slice(0, 5);
}

function hasDefaultedUsage(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== 'object') return true;
  const usage = (candidate as { usage?: unknown }).usage;
  if (!usage || typeof usage !== 'object') return true;
  const tokenUsage = usage as { input_tokens?: unknown; output_tokens?: unknown };
  return typeof tokenUsage.input_tokens !== 'number' || typeof tokenUsage.output_tokens !== 'number';
}

/**
 * Buffer a Codex Responses API SSE stream and return the validated
 * `ResponsesApiResponse` from the `response.completed` event. Used by
 * non-streaming callers (BTS proxy, sub-agent Codex client) so they can
 * satisfy Codex's mandatory `stream: true` upstream contract while preserving
 * their JSON-back semantics.
 *
 * INVARIANT: Codex Responses API rejects `stream: false` with HTTP 400
 * "Stream must be set to true". This helper exists so non-streaming callers
 * never need to violate that invariant. Do NOT introduce parallel
 * non-streaming Codex paths — extend this helper if you need new behavior.
 * See docs/plans/260504_codex_passthrough_streaming_fix.md.
 *
 * Parsing is defensive against:
 *   - Canonical SSE: `event: <type>\ndata: <json>\n\n`
 *   - `data:`-only with `type` in payload: `data: {"type":"<type>",...}\n\n`
 *
 * Throws (via `options.throwUpstreamError`):
 *   - 502 — `response.completed` missing/malformed `response` payload (Zod fails)
 *   - 502 — `response.completed.status === 'failed'` or `error` set
 *   - 502 — `response.failed` / `error` SSE events (sanitized message only;
 *           no raw payload leakage)
 *   - 502 — stream ended without seeing `response.completed`
 *   - 504 — per-chunk stall exceeding `streamChunkTimeoutMs`
 */
export async function readResponsesSseToCompletion(
  body: ReadableStream<Uint8Array>,
  options: ReadResponsesSseOptions,
): Promise<ResponsesApiResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventCount = 0;
  let chunkCount = 0;
  let bytesDecoded = 0;
  let lastEventType = '';
  const startMs = Date.now();
  const chunkTimeoutMs = options.streamChunkTimeoutMs ?? 30_000;
  const accumulator = createBufferingAccumulator();

  try {
    while (true) {
      let chunkTimer: ReturnType<typeof setTimeout> | undefined;
      const readResult = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(
            () => reject(options.throwUpstreamError(504, `Codex SSE chunk stalled (>${chunkTimeoutMs}ms)`)),
            chunkTimeoutMs,
          );
        }),
      ]);
      if (chunkTimer) clearTimeout(chunkTimer);
      const { done, value } = readResult;
      if (done) break;

      chunkCount++;
      bytesDecoded += value.byteLength;
      buffer += decoder.decode(value, { stream: true });

      const eventBlocks = buffer.split(/\r?\n\r?\n/);
      buffer = eventBlocks.pop() ?? '';

      for (const eventBlock of eventBlocks) {
        if (!eventBlock.trim()) continue;
        const parsedEvent = parseSseEventBlock(eventBlock);
        if (!parsedEvent) continue;
        let eventData: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(parsedEvent.data);
          if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            continue;
          }
          eventData = parsed as Record<string, unknown>;
        } catch {
          continue;
        }

        const resolvedType = parsedEvent.event || (typeof eventData.type === 'string' ? eventData.type : '');
        if (!resolvedType) continue;
        eventCount++;
        lastEventType = resolvedType;
        accumulator.consume(resolvedType, eventData);

        if (resolvedType === 'response.completed') {
          const respCandidate = getResponseCandidate(eventData);
          const terminalFailureMessage = getTerminalFailureMessage(respCandidate);
          if (terminalFailureMessage) {
            options.onDiagnostic?.({
              eventCount, chunkCount, bytesDecoded, lastEventType: resolvedType,
              sawCompleted: false, elapsedMs: Date.now() - startMs,
              upstreamMessage: terminalFailureMessage,
            });
            throwCodexTerminalError(options.throwUpstreamError, [respCandidate], `Codex completed with failure: ${terminalFailureMessage}`);
          }

          const usageDefaulted = hasDefaultedUsage(respCandidate);
          const parsedCompletion = ResponsesApiResponseSchema.safeParse(respCandidate);
          const accumulatorOutputs = accumulator.outputs;
          const accumulatorHasOutput = accumulatorOutputs.length > 0;
          const snapshotHasOutput = parsedCompletion.success
            ? parsedCompletion.data.output.length > 0
            : getRawOutputLength(respCandidate) > 0;
          const usingAccumulator = accumulatorHasOutput;

          if (!parsedCompletion.success && !accumulatorHasOutput && !snapshotHasOutput) {
            const issuePaths = getSchemaIssuePaths(parsedCompletion.error);
            const respKeys = respCandidate && typeof respCandidate === 'object'
              ? Object.keys(respCandidate as Record<string, unknown>).slice(0, 10)
              : [];
            const envelopeKeys = eventData && typeof eventData === 'object'
              ? Object.keys(eventData).slice(0, 10)
              : [];
            options.onDiagnostic?.({
              eventCount, chunkCount, bytesDecoded, lastEventType: resolvedType,
              sawCompleted: false, elapsedMs: Date.now() - startMs,
              schemaValidation: { result: 'failed', paths: issuePaths },
              warning: 'response.completed schema mismatch',
            });
            throw options.throwUpstreamError(
              502,
              `Codex SSE response.completed schema mismatch (paths=${issuePaths.join(',') || '<none>'}; respKeys=${respKeys.join(',') || '<none>'}; envelopeKeys=${envelopeKeys.join(',') || '<none>'})`,
            );
          }

          const completion = parsedCompletion.success ? parsedCompletion.data : undefined;
          const snapshotOutputs = completion?.output ?? [];
          const divergence = accumulatorHasOutput && snapshotHasOutput
            ? getReconciliationDivergence(accumulatorOutputs, snapshotOutputs)
            : undefined;
          const reconciliation: NonNullable<SseDiagnostic['reconciliation']> = {
            accumulator: accumulatorHasOutput ? 'populated' : 'empty',
            snapshot: snapshotHasOutput ? 'populated' : 'empty',
            usingAccumulator,
            ...(divergence ? { divergence } : {}),
          };
          const synthesizedCandidate: ResponsesApiResponse = {
            id: accumulator.id || completion?.id || '',
            model: accumulator.model || completion?.model || '',
            output: usingAccumulator ? accumulatorOutputs : snapshotOutputs,
            ...(completion?.usage ? { usage: completion.usage } : {}),
            ...(completion?.status ? { status: completion.status } : {}),
            ...(completion?.error ? { error: completion.error } : {}),
          };
          const parsedSynthesized = ResponsesApiResponseSchema.safeParse(synthesizedCandidate);
          const schemaWarning = parsedSynthesized.success
            ? undefined
            : {
                result: 'failed' as const,
                paths: getSchemaIssuePaths(parsedSynthesized.error),
              };
          const resp = parsedSynthesized.success ? parsedSynthesized.data : synthesizedCandidate;

          const synthesizedFailureMessage = getTerminalFailureMessage(resp);
          if (synthesizedFailureMessage) {
            options.onDiagnostic?.({
              eventCount, chunkCount, bytesDecoded, lastEventType: resolvedType,
              sawCompleted: false, elapsedMs: Date.now() - startMs,
              reconciliation,
              upstreamMessage: synthesizedFailureMessage,
              ...(schemaWarning ? {
                schemaValidation: schemaWarning,
                warning: 'synthesized response schema sanity-check failed',
              } : {}),
            });
            throwCodexTerminalError(options.throwUpstreamError, [resp], `Codex completed with failure: ${synthesizedFailureMessage}`);
          }
          options.onDiagnostic?.({
            eventCount, chunkCount, bytesDecoded, lastEventType: resolvedType,
            sawCompleted: true, elapsedMs: Date.now() - startMs,
            reconciliation,
            usageDefaulted,
            ...(schemaWarning ? {
              schemaValidation: schemaWarning,
              warning: 'synthesized response schema sanity-check failed',
            } : {}),
          });
          // Deliver reasoning summary text to the caller so it can pass it through
          // translateResponsesToChatCompletion({ reasoningContent }) and surface it
          // in the "Behind the scenes" channel.
          options.onReasoningSummary?.(accumulator.reasoningSummaryText);
          return resp;
        }

        if (resolvedType === 'response.incomplete') {
          const reason = getIncompleteReason(eventData);
          options.onDiagnostic?.({
            eventCount, chunkCount, bytesDecoded, lastEventType: resolvedType,
            sawCompleted: false, elapsedMs: Date.now() - startMs,
            upstreamMessage: reason,
          });
          throw options.throwUpstreamError(502, `Codex completed incomplete: ${reason}`);
        }

        if (resolvedType === 'response.failed' || resolvedType === 'error') {
          const e = eventData as {
            message?: unknown; type?: unknown; code?: unknown;
            response?: { error?: unknown };
          };
          const upstream = e.response?.error ?? eventData;
          const safeMessage = extractErrorMessageOpaque(upstream) ?? 'unspecified';
          options.onDiagnostic?.({
            eventCount, chunkCount, bytesDecoded, lastEventType: resolvedType,
            sawCompleted: false, elapsedMs: Date.now() - startMs,
            upstreamMessage: safeMessage,
          });
          // Quota → 429 (rate_limit_error + code/reset); generic → 502. Shared
          // with the response.completed-failed branches above. REBEL-4GH / FOX-3152.
          throwCodexTerminalError(options.throwUpstreamError, [upstream, eventData], safeMessage);
        }
      }
    }

    options.onDiagnostic?.({
      eventCount, chunkCount, bytesDecoded, lastEventType,
      sawCompleted: false, elapsedMs: Date.now() - startMs,
    });
    throw options.throwUpstreamError(502, 'Codex SSE stream ended without response.completed event');
  } finally {
    reader.releaseLock();
  }
}
