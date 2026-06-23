import type { TokenUsage } from '../types';
import type { ContentBlock } from '../modelTypes';
import type { WireModelId } from '@shared/utils/wireModelId';

export type OpenAIMessageRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';
export type OpenAIReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface OpenAIFunctionCall {
  name: string;
  arguments: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: OpenAIFunctionCall;
  // Google OpenAI-compat convention for carrying Gemini's per-call thought_signature.
  extra_content?: { google?: { thought_signature?: string } };
  // litellm convention for the same token (it does NOT use extra_content; it also
  // embeds the signature in `id` as `call_xxx__thought__<sig>`). Read by the
  // gateway tool-signature diagnostic only — NEVER carried into request building.
  // @see clients/gatewayToolSignatureDiagnostic.ts
  provider_specific_fields?: { thought_signature?: string };
}

export interface OpenAITextContentPart {
  type: 'text';
  text: string;
}

export interface OpenAIImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export type OpenAIContentPart =
  | OpenAITextContentPart
  | OpenAIImageUrlContentPart;

export interface OpenAIMessage {
  role: OpenAIMessageRole;
  content: string | OpenAIContentPart[] | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type OpenAIToolChoice =
  | 'auto'
  | 'required'
  | 'none'
  | { type: 'function'; function: { name: string } };

export interface OpenAIJsonSchemaResponseFormat {
  type: 'json_schema';
  json_schema: {
    name: string;
    schema: Record<string, unknown>;
    strict?: boolean;
  };
}

export type OpenAIResponseFormat =
  | { type: 'json_object' }
  | OpenAIJsonSchemaResponseFormat;

export interface OpenAIRequest {
  model: WireModelId;
  messages: OpenAIMessage[];
  max_completion_tokens?: number;
  tools?: OpenAITool[];
  tool_choice?: OpenAIToolChoice;
  reasoning_effort?: OpenAIReasoningEffort;
  response_format?: OpenAIResponseFormat;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
}

export interface OpenAIResponseChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    reasoning_content?: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

export interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: OpenAIResponseChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
        extra_content?: { google?: { thought_signature?: string } };
        provider_specific_fields?: { thought_signature?: string };
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

export interface OpenAIStreamToolCallState {
  id: string;
  name: string;
  arguments: string;
  blockIndex: number;
  // Gateway tool-signature diagnostic (observability-only): OR-accumulated
  // presence flags for litellm's `provider_specific_fields.thought_signature`
  // and Google's `extra_content.google.thought_signature` across stream deltas.
  // The `id`-embedded convention is checked from the final assembled `id`.
  // Presence booleans ONLY — the diagnostic never extracts/logs/emits the
  // signature VALUE (the litellm id-embedded form does live inside `id`, which is
  // preserved verbatim, but it is never pulled out as a value).
  // @see clients/gatewayToolSignatureDiagnostic.ts
  sawProviderSpecificFields: boolean;
  sawExtraContent: boolean;
}

export type LateReasoningBufferCap = 'bytes' | 'chunks' | 'time';

export interface OpenAIStreamState {
  messageId: string | null;
  model: string | null;
  currentBlockType: 'text' | 'thinking' | 'tool_use' | null;
  content: ContentBlock[];
  toolCalls: Map<number, OpenAIStreamToolCallState>;
  stopReason: string;
  usage: TokenUsage;
  finishReasonSeen: boolean;
  lateReasoningBuffer: string;
  lateReasoningBufferedBytes: number;
  lateReasoningBufferedChunks: number;
  lateReasoningCapHit: LateReasoningBufferCap | null;
}
