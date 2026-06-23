/**
 * Local Model Proxy Server
 *
 * HTTP server that translates Anthropic Messages API to OpenAI Chat Completions API.
 * Runs on localhost when local model is enabled, allowing Rebel Core's
 * Anthropic-compatible API traffic to reach any OpenAI-compatible local model server.
 *
 * Rebel Core calls this proxy via ANTHROPIC_BASE_URL, and we translate and forward
 * to the user's local model server (LM Studio, Ollama, LocalAI, etc.).
 */

import http from 'node:http';
import crypto from 'node:crypto';
import type { ModelProfile, ThinkingEffort } from '@shared/types';
import { getWorkingModelProfile } from '@shared/types';
import { buildCompletionsUrl, buildResponsesUrl, PLAN_MODE_ALIAS } from '@shared/utils/modelNormalization';
import { resolveConnectionCredentials } from '@shared/utils/connectionCredentials';
import { isLoopbackRoutableProfile } from '@shared/utils/profileHelpers';
import { computeSupportsReasoningReplay } from '@shared/utils/reasoningCapability';
import { isCodexSubscriptionProfile } from '@shared/utils/providerKeys';
import { assertNever } from '@shared/utils/assertNever';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { CHINA_ORIGIN_PROVIDER_ALLOWLISTS } from '@shared/openrouterProviderAllowlists';
import { getSettings } from '@core/services/settingsStore';
import {
  finalizeChatCompletionsBody,
  serializeChatCompletionsBody,
} from '@core/services/chatCompletionsParamCapability';

import { getPlatformConfig } from '@core/platform';
import { createScopedLogger } from '@core/logger';
import { attachBenignSocketErrorGuard } from '@core/utils/socketErrorGuard';
import { diagLog, fingerprint } from '@core/devDiag/anthropicAuthDiag';
import { getErrorReporter } from '@core/errorReporter';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import { getCodexAuthProvider, CODEX_ENDPOINT_URL } from '@core/codexAuth';
import { getAuthForDirectUse } from '@core/utils/authEnvUtils';
import { PROXY_HANDLES_AUTH_SENTINEL } from '@core/rebelCore/proxyAuthContract';
import {
  OPENROUTER_ATTRIBUTION_REFERER,
  OPENROUTER_ATTRIBUTION_TITLE,
  ROUTE_TAG_HEADER,
  ROUTE_ID_HEADER,
  ROUTE_WIRE_MODEL_HEADER,
  ROUTE_FACTS_HEADER,
} from '@core/rebelCore/providerRouteHeaders';
import { inspectRouteTag, verifyRouteFacts, type RouteTagFacts } from '@core/rebelCore/providerRouteTag';
import {
  translateChatToResponses,
  createStreamTranslator,
  parseSseEventBlock,
  translateResponsesToChatCompletion,
  readResponsesSseToCompletion,
  extractReasoningFromResponsesJson,
  type ChatCompletionRequest,
  type ChatResponseFormat,
  type ResponsesApiResponse,
} from '@core/services/codexResponsesTranslator';
import { extractOpenAITextFields } from '@core/rebelCore/clients/openaiTranslators';
import { resolveProfileReasoningEffort } from '@core/rebelCore/modelLimits';
import { getManagedAllowedModelIds } from '@shared/types/managedProvider';

import { agentTurnRegistry } from './agentTurnRegistry';
import { getRebelAuthProvider } from '@core/rebelAuth';
import {
  classifyRequest,
  remapToCodexEgressModel,
  type RequestClassification,
  type CodexEgressModel,
  type CodexEgressModelResolution,
} from './localModelProxy/classifier';
import { injectUpstreamAuth, stripClientAuthHeaders } from './localModelProxy/upstreamAuth';
import { applyAnthropicOutputFormat } from './localModelProxy/outputFormatTranslator';
import { StreamLifecycle } from './localModelProxy/streamLifecycle';
import { loadOpenRouterTokens } from '@core/services/tokenStorage/openRouterTokenStorage';
import { loadManagedOpenRouterKey } from './openRouterTokenStorage';
import { createPausableInterval } from './visibilityAwareScheduler';

/**
 * Resolve OpenRouter API key from the best available source.
 *
 * On desktop, the encrypted token store (safeStorage) is the primary source.
 * On cloud, the encrypted store is empty because tokens aren't migrated —
 * but the API key IS synced to cloud via settings dual-write
 * (settings.openRouter.oauthToken). This fallback makes OpenRouter work
 * seamlessly on mobile/cloud without any migration changes.
 */
export function resolveOpenRouterApiKey(): string | null {
  // Primary: encrypted token store (always populated on desktop)
  const stored = loadOpenRouterTokens();
  if (stored?.apiKey) return stored.apiKey;

  // Fallback: settings (synced to cloud via dual-write)
  const settings = getSettings();
  const settingsToken = settings.openRouter?.oauthToken;
  if (settingsToken) {
    log.debug('OpenRouter API key resolved from settings fallback (cloud/mobile path)');
    return settingsToken;
  }

  return null;
}

/**
 * Resolve managed (Mindstone subscription) OpenRouter API key.
 * Fail-closed: returns null if managed key is not in secure storage.
 * NEVER falls back to personal OpenRouter key.
 */
export function resolveManagedOpenRouterApiKey(): string | null {
  return loadManagedOpenRouterKey();
}

const log = createScopedLogger({ service: 'localModelProxyServer' });

/** Preserves the upstream HTTP status code from the Codex API so the proxy
 *  can forward it to the SDK instead of collapsing everything to 500. */
class CodexUpstreamError extends Error {
  readonly upstreamStatus: number;
  readonly upstreamBody: string;
  constructor(status: number, body: string) {
    super(`Codex error (${status}): ${body}`);
    this.name = 'CodexUpstreamError';
    this.upstreamStatus = status;
    this.upstreamBody = body;
  }
}

/**
 * Build the proxy error response for a Codex upstream failure, preserving the
 * real upstream HTTP status + the quota/billing signal so downstream SDK error
 * classification works (429 → `rate_limit_error`, not 500 → generic `api_error`;
 * `usage_limit_reached` `code` survives for `classifyHttpError`'s
 * QUOTA_EXHAUSTION_TYPES check — REBEL-4GH / FOX-3152).
 *
 * Single source of truth for BOTH Codex catch sites: the `x-codex-turn`
 * passthrough catch and the route-resolved request catch. Before this helper the
 * route-resolved catch only honoured a `statusCode` field (which `CodexUpstreamError`
 * lacks — it carries `upstreamStatus`), so route-resolved Codex 429 usage-limits
 * collapsed to 500/api_error while the passthrough path forwarded them correctly.
 */
function codexUpstreamErrorResponse(err: unknown, message: string): { status: number; body: Record<string, unknown> } {
  const status = err instanceof CodexUpstreamError ? err.upstreamStatus : 500;
  const errorType = status === 429 ? 'rate_limit_error'
    : status === 401 ? 'authentication_error'
    : status === 403 ? 'permission_error'
    : 'api_error';
  // Forward reset timing + the upstream quota type/code from a 429 so the UI can
  // show "resets in N" and classifiers can distinguish a quota cap from a
  // transient rate limit. Codex nests these under `error`.
  const resetFields: Record<string, unknown> = {};
  if (status === 429 && err instanceof CodexUpstreamError) {
    try {
      const upstream = JSON.parse(err.upstreamBody) as Record<string, unknown>;
      const nested = upstream.error && typeof upstream.error === 'object'
        ? upstream.error as Record<string, unknown>
        : undefined;
      const src = nested ?? upstream;
      if (typeof src.resets_at === 'number') resetFields.resets_at = src.resets_at;
      if (typeof src.resets_in_seconds === 'number') resetFields.resets_in_seconds = src.resets_in_seconds;
      const upstreamType = typeof src.type === 'string' ? src.type : undefined;
      const upstreamCode = typeof src.code === 'string' ? src.code : undefined;
      const preservedCode = upstreamCode ?? upstreamType;
      if (preservedCode) resetFields.code = preservedCode;
    } catch { /* upstream body not JSON — ignore */ }
  }
  return {
    status,
    body: { type: 'error', error: { type: errorType, message, ...resetFields } },
  };
}

/** errno codes for transient connection blips worth a single immediate retry. */
const RETRIABLE_UPSTREAM_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * True for a THROWN pre-response network error from a Codex upstream `fetch()` —
 * a connection-layer blip that produced no HTTP response (REBEL-5EZ / REBEL-5K4
 * "Codex passthrough failed: fetch failed"). undici/Node surface these as
 * `TypeError('fetch failed')` whose `cause` carries the errno `code`. This is
 * deliberately NARROW: it must NOT match a real upstream response (4xx/429/5xx
 * arrive as a `Response`/`CodexUpstreamError`, never a throw) nor a deliberate
 * timeout/abort (`AbortError`/`TimeoutError` — excluded by the caller's
 * `isTimeoutError` guard), so a single retry can never amplify a rate limit.
 */
export function isRetriableUpstreamNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const readCode = (val: unknown): string | undefined =>
    val && typeof val === 'object' && 'code' in val && typeof (val as { code?: unknown }).code === 'string'
      ? (val as { code: string }).code
      : undefined;
  const directCode = readCode(error);
  const causeCode = readCode((error as { cause?: unknown }).cause);
  if ((directCode && RETRIABLE_UPSTREAM_NETWORK_CODES.has(directCode))
    || (causeCode && RETRIABLE_UPSTREAM_NETWORK_CODES.has(causeCode))) {
    return true;
  }
  // undici's generic network failure: TypeError('fetch failed').
  return error.name === 'TypeError' && /fetch failed/i.test(error.message);
}
const OPENROUTER_MESSAGES_URL = 'https://openrouter.ai/api/v1/messages';

// CHINA_ORIGIN_PROVIDER_ALLOWLISTS lives in @shared/openrouterProviderAllowlists
// so the CI validator script can import the same source of truth without
// pulling in main-process dependencies. Re-exported here for callers that
// already import the symbol from this module.
export { CHINA_ORIGIN_PROVIDER_ALLOWLISTS };

const DEFAULT_PROXY_PORT = 18765;

// Proxy usage and error stats — accumulated per model, read and reset at turn end.
export interface ProxyModelStats {
  inputTokens: number;
  outputTokens: number;
  requestCount: number;
  errorCount: number;
}

// Allowed origins for CORS (explicit allowlist, not wildcard)
const ALLOWED_ORIGINS = new Set([
  'app://.',               // Packaged Electron app
  'http://localhost:5173', // Vite dev server
  'http://localhost:5174', // Alternate dev port
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
]);

// buildCompletionsUrl imported from @shared/utils/modelNormalization

// System prompt can be string or array of content blocks with cache_control
export type SystemPromptBlock = { type: string; text?: string; cache_control?: unknown };

// Anthropic API types
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'thinking_delta' | 'tool_use' | 'tool_result';
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  // tool_result content can be string or array of content blocks
  content?: string | Array<{ type: string; text?: string }>;
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | SystemPromptBlock[];
  max_tokens?: number;
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' | 'any' | 'tool'; name?: string };
  stream?: boolean;
  /**
   * Sampling temperature passed through from BTS callers.
   * Declared on the typed boundary so all Anthropic→OpenAI proxy branches
   * can forward it instead of silently dropping it.
   */
  temperature?: number;
  /**
   * Anthropic-shaped structured-output enforcement. BTS callers populate this
   * via `BehindTheScenesRequestOptions.outputFormat`. Every typed Anthropic→OpenAI
   * proxy branch MUST translate this to OpenAI `response_format.json_schema`
   * via `translateAnthropicOutputFormatToOpenAIResponseFormat()` before handing
   * the request to `translateChatToResponses` or any other upstream call.
   * See docs/project/REBEL_CORE.md § Structured Output Schema Boundary —
   * "BTS request boundary".
   */
  output_format?: {
    type: 'json_schema';
    schema: Record<string, unknown>;
    name?: string;
    strict?: boolean;
  };
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// OpenAI API types
interface OpenAIMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  // Gemini thought signatures — Gemini 3 models return these on tool_calls
  // and require them back in subsequent requests for multi-turn tool use.
  extra_content?: { google?: { thought_signature?: string } };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_completion_tokens?: number;
  tools?: OpenAITool[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  /** Sampling temperature forwarded from inbound AnthropicRequest. */
  temperature?: number;
  /**
   * OpenAI-shaped structured-output enforcement. Populated from inbound
   * Anthropic `output_format` via `translateAnthropicOutputFormatToOpenAIResponseFormat()`
   * so the Codex Responses translator can emit `text.format.json_schema`.
   * Structurally compatible with `ChatResponseFormat` from
   * `codexResponsesTranslator.ts`.
   */
  response_format?: ChatResponseFormat;
  /** Ollama-specific options (e.g. num_ctx for context window). Ignored by non-Ollama providers. */
  options?: Record<string, unknown>;
}

/**
 * An {@link OpenAIRequest} whose `model` has been PROVEN safe for Codex egress
 * (Stage 12, F1 core fix). The `model` field is narrowed to the branded
 * {@link CodexEgressModel}, so the ONLY way to construct a value of this type is
 * to set `model` from the output of `remapToCodexEgressModel` — a raw
 * `string`/`profile.model`/`anthropicRequest.model` (which may be a `claude-`
 * dialect name) is NOT assignable. Both Codex egress construction sites
 * (`forwardToCodexModel` for non-streaming, `handleCodexStreamingRequest` for
 * streaming) accept this type, so passing an un-remapped model name to a Codex
 * upstream is a compile error rather than a silent REBEL-540 leak. This is the
 * single Codex-egress choke point the `codex-model-dialect-axis` boundary entry
 * describes.
 */
interface CodexEgressRequest extends OpenAIRequest {
  model: CodexEgressModel;
}

interface OpenAIResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string | null;
      reasoning_content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

// OpenAI streaming chunk types
interface OpenAIStreamChunk {
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
      }>;
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
    };
  };
}

// Streaming state for translation
interface StreamState {
  messageId: string | null;
  model: string | null;
  contentIndex: number;
  currentBlockType: 'text' | 'thinking' | 'tool_use' | null;
  hasSentMessageStart: boolean;
  toolCallId: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Exact cost in USD from provider (e.g. OpenRouter usage.cost). */
  cost?: number;
  finishReasonSeen: boolean;
  lateReasoningBuffer: string;
  lateReasoningBufferedBytes: number;
  lateReasoningBufferedChunks: number;
  lateReasoningCapHit: 'bytes' | 'chunks' | 'time' | null;
}

// Translation functions

/**
 * Determine the correct system message role for a given model.
 * OpenAI GPT-5+ and o1+ models use 'developer' instead of 'system'.
 * Gemini and other providers still expect 'system'.
 */
function getSystemRole(modelName: string): 'system' | 'developer' {
  if (modelName.startsWith('gpt-5') || modelName.startsWith('o1') || modelName.startsWith('o3') || modelName.startsWith('o4')) {
    return 'developer';
  }
  return 'system';
}

function _extractTextContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

const LATE_REASONING_BUFFER_MAX_BYTES = 256 * 1024;
const LATE_REASONING_BUFFER_MAX_CHUNKS = 1000;
const LATE_REASONING_FINISH_DEADLINE_MS = 30_000;

function extractReasoningFromBlocks(content: AnthropicContentBlock[]): string {
  return content
    .filter((block) => block.type === 'thinking' || block.type === 'thinking_delta')
    .map((block) => block.thinking ?? '')
    .join('');
}

function bufferLateReasoningDelta(
  state: StreamState,
  reasoningDelta: string,
): 'bytes' | 'chunks' | null {
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

export function translateMessagesToOpenAI(
  messages: AnthropicMessage[],
  systemPrompt?: string | SystemPromptBlock[],
  modelName?: string,
  supportsReasoningReplay = false,
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  // Debug: log incoming messages structure
  for (const msg of messages) {
    if (typeof msg.content !== 'string') {
      const blockTypes = msg.content.map(b => b.type);
      const toolResultBlocks = msg.content.filter(b => b.type === 'tool_result');
      if (toolResultBlocks.length > 0) {
        log.debug(
          {
            role: msg.role,
            blockTypes,
            toolResultCount: toolResultBlocks.length,
            toolResultIds: toolResultBlocks.map(b => b.tool_use_id),
            toolResultContentLengths: toolResultBlocks.map(b => 
              typeof b.content === 'string' ? b.content.length : 
              Array.isArray(b.content) ? JSON.stringify(b.content).length : 0
            ),
          },
          'Processing message with tool_result blocks'
        );
      }
    }
  }

  if (systemPrompt) {
    // Handle both string and array format (array may have cache_control blocks)
    const systemText =
      typeof systemPrompt === 'string'
        ? systemPrompt
        : systemPrompt
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('\n');
    if (systemText) {
      result.push({ role: getSystemRole(modelName ?? ''), content: systemText });
    }
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      // User messages can contain both text and tool_result blocks
      if (typeof msg.content === 'string') {
        result.push({ role: 'user', content: msg.content });
      } else {
        // Extract text content for the user message
        const textContent = msg.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('');

        // Extract tool_result blocks and convert to OpenAI tool messages
        const toolResultBlocks = msg.content.filter((block) => block.type === 'tool_result');

        // If there are tool results, add them as separate tool messages
        for (const block of toolResultBlocks) {
          // tool_result content can be string or array of content blocks
          let resultContent: string;
          if (typeof block.content === 'string') {
            resultContent = block.content;
          } else if (Array.isArray(block.content)) {
            resultContent = block.content
              .filter((b: { type: string; text?: string }) => b.type === 'text')
              .map((b: { type: string; text?: string }) => b.text ?? '')
              .join('');
          } else {
            resultContent = '';
          }
          log.debug(
            {
              tool_use_id: block.tool_use_id,
              contentLength: resultContent.length,
              contentPreview: resultContent.substring(0, 200),
            },
            'Adding tool result message'
          );
          result.push({
            role: 'tool',
            content: resultContent,
            tool_call_id: block.tool_use_id,
          });
        }

        // Add user text content if any (after tool results)
        if (textContent) {
          result.push({ role: 'user', content: textContent });
        }
      }
    } else if (msg.role === 'assistant') {
      if (typeof msg.content === 'string') {
        result.push({ role: 'assistant', content: msg.content });
      } else {
        const reasoningContent = supportsReasoningReplay
          ? extractReasoningFromBlocks(msg.content)
          : '';
        const textContent = msg.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('');

        const toolUseBlocks = msg.content.filter((block) => block.type === 'tool_use');
        const reasoningField = supportsReasoningReplay && reasoningContent
          ? { reasoning_content: reasoningContent }
          : {};

        if (toolUseBlocks.length > 0) {
          const toolCalls: OpenAIToolCall[] = toolUseBlocks.map((block) => ({
            id: block.id ?? `call_${Date.now()}`,
            type: 'function' as const,
            function: {
              name: block.name ?? 'unknown',
              arguments: JSON.stringify(block.input ?? {}),
            },
          }));
          result.push({
            role: 'assistant',
            content: textContent || null,
            ...reasoningField,
            tool_calls: toolCalls,
          });
        } else {
          result.push({ role: 'assistant', content: textContent, ...reasoningField });
        }
      }
    }
  }

  // Debug: log translated messages summary
  const toolMessages = result.filter(m => m.role === 'tool');
  if (toolMessages.length > 0) {
    log.debug(
      {
        totalMessages: result.length,
        toolMessagesCount: toolMessages.length,
        toolMessageIds: toolMessages.map(m => m.tool_call_id),
        toolMessageContentLengths: toolMessages.map(m => (m.content || '').length),
      },
      'Translated messages include tool results'
    );
  }

  return repairOrphanedToolCalls(result);
}

/**
 * Repair orphaned tool calls/results in translated OpenAI messages.
 *
 * When the runtime compacts or truncates conversation history, it can split
 * tool_use/tool_result pairs — leaving assistant messages with tool_calls
 * that have no matching tool response, or tool messages referencing calls
 * that no longer exist. OpenAI rejects these with:
 *   "No tool output found for function call call_XXX"
 *
 * This repair pass:
 * 1. Synthesizes placeholder tool results for orphaned tool calls
 * 2. Removes orphaned tool results (no matching call)
 *
 * @internal Exported for testing.
 */
export function repairOrphanedToolCalls(messages: OpenAIMessage[]): OpenAIMessage[] {
  const allToolCallIds = new Set<string>();
  const allToolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        allToolCallIds.add(tc.id);
      }
    }
    if (msg.role === 'tool' && msg.tool_call_id) {
      allToolResultIds.add(msg.tool_call_id);
    }
  }

  const orphanedCallIds = new Set<string>();
  for (const id of allToolCallIds) {
    if (!allToolResultIds.has(id)) orphanedCallIds.add(id);
  }

  const orphanedResultIds = new Set<string>();
  for (const id of allToolResultIds) {
    if (!allToolCallIds.has(id)) orphanedResultIds.add(id);
  }

  if (orphanedCallIds.size === 0 && orphanedResultIds.size === 0) {
    return messages;
  }

  log.warn(
    {
      orphanedCalls: orphanedCallIds.size,
      orphanedResults: orphanedResultIds.size,
      orphanedCallIds: [...orphanedCallIds].slice(0, 5),
      orphanedResultIds: [...orphanedResultIds].slice(0, 5),
    },
    'Repairing orphaned tool calls in conversation — runtime likely compacted mid-turn'
  );

  // A7: emit SEPARATE events when both kinds are present, so the post-incident
  // bundle can show distinct violation kinds rather than a single conflated event.
  if (orphanedCallIds.size > 0) {
    appendDiagnosticEvent({
      kind: 'streaming_invariant',
      data: {
        violation: 'orphan_tool_use',
        occurrenceCount: orphanedCallIds.size,
        repaired: true,
      },
    });
  }
  if (orphanedResultIds.size > 0) {
    appendDiagnosticEvent({
      kind: 'streaming_invariant',
      data: {
        violation: 'orphan_tool_result',
        occurrenceCount: orphanedResultIds.size,
        repaired: true,
      },
    });
  }

  const repaired: OpenAIMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id && orphanedResultIds.has(msg.tool_call_id)) {
      continue;
    }

    repaired.push(msg);

    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (orphanedCallIds.has(tc.id)) {
          repaired.push({
            role: 'tool',
            content: '[Tool output unavailable — conversation was summarized]',
            tool_call_id: tc.id,
          });
        }
      }
    }
  }

  return repaired;
}

function translateToolsToOpenAI(tools?: AnthropicTool[]): OpenAITool[] | undefined {
  if (!tools || tools.length === 0) return undefined;

  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

/**
 * INVARIANT: Every Anthropic→OpenAI translator branch in this file MUST route
 * structured-output translation through `applyAnthropicOutputFormat()` (the
 * single home in `localModelProxy/outputFormatTranslator.ts`). Skipping it
 * silently drops structured-output enforcement on the Codex/OpenAI-compat
 * upstream and turns BTS structured output into prose. The CI check
 * `scripts/check-proxy-auth-translator-centralization.ts` enforces that the
 * raw json_schema construction lives ONLY in that module. See
 * docs-private/investigations/260509_bts_output_format_dropped_codex_proxy.md.
 */

function translateToolChoiceToOpenAI(
  toolChoice?: AnthropicRequest['tool_choice']
): OpenAIRequest['tool_choice'] {
  if (!toolChoice) return undefined;

  switch (toolChoice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'tool':
      if (toolChoice.name) {
        return { type: 'function', function: { name: toolChoice.name } };
      }
      return 'required';
    default:
      return 'auto';
  }
}

function translateResponseToAnthropic(
  response: OpenAIResponse,
  actualModel: string
): AnthropicResponse {
  const choice = response.choices[0];
  if (!choice) {
    throw new Error('No response from local model');
  }

  const content: AnthropicContentBlock[] = [];

  // Use shared extraction from openaiTranslators — single source of truth for
  // reading content + reasoning_content from OpenAI-compatible providers.
  const { text, reasoningText } = extractOpenAITextFields(choice.message);

  if (reasoningText) {
    content.push({ type: 'thinking', thinking: reasoningText });
  }

  if (text) {
    content.push({ type: 'text', text });
  }

  if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
    for (const toolCall of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(toolCall.function.arguments);
      } catch {
        log.warn({ arguments: toolCall.function.arguments }, 'Failed to parse tool call arguments');
      }

      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input,
      });
    }
  }

  let stopReason: AnthropicResponse['stop_reason'] = 'end_turn';
  if (choice.finish_reason === 'tool_calls') {
    stopReason = 'tool_use';
  } else if (choice.finish_reason === 'length') {
    stopReason = 'max_tokens';
  }

  return {
    id: response.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: actualModel,
    stop_reason: stopReason,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: response.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

// Streaming helper functions

function formatSSEEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function mapStopReason(finishReason: string | null): string {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    case null:
      return 'end_turn';
    default:
      // finishReason is an open `string` from the upstream OpenAI-compatible API;
      // unknown values map to 'end_turn' (preserves the prior default behavior).
      return 'end_turn';
  }
}

export function createStreamState(): StreamState {
  return {
    messageId: null,
    model: null,
    contentIndex: 0,
    currentBlockType: null,
    hasSentMessageStart: false,
    toolCallId: null,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    finishReasonSeen: false,
    lateReasoningBuffer: '',
    lateReasoningBufferedBytes: 0,
    lateReasoningBufferedChunks: 0,
    lateReasoningCapHit: null,
  };
}

export function* processStreamChunk(
  chunk: OpenAIStreamChunk,
  state: StreamState,
  actualModel: string,
  sigStore: Map<string, string>,
  recordUsage: (model: string, inputTokens: number, outputTokens: number) => void,
  turnId?: string,
  sigTimestamps?: Map<string, number>
): Generator<string> {
  // Initialize state from first chunk
  if (!state.messageId) {
    state.messageId = chunk.id;
  }
  if (!state.model) {
    state.model = chunk.model;
  }

  // Capture usage from final usage-only chunk (OpenAI sends choices:[] with usage data)
  if (chunk.usage) {
    state.inputTokens += chunk.usage.prompt_tokens ?? 0;
    state.outputTokens += chunk.usage.completion_tokens ?? 0;
    state.cacheReadTokens += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
    if (state.model) {
      recordUsage(state.model, chunk.usage.prompt_tokens ?? 0, chunk.usage.completion_tokens ?? 0);
    }
  }

  const choice = chunk.choices[0];
  if (!choice) return;

  // Send message_start on first chunk
  if (!state.hasSentMessageStart) {
    yield formatSSEEvent('message_start', {
      type: 'message_start',
      message: {
        id: state.messageId,
        type: 'message',
        role: 'assistant',
        model: actualModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    state.hasSentMessageStart = true;
  }

  // Handle reasoning content (OpenAI reasoning models send this before regular content).
  // If reasoning arrives after finish_reason, buffer it and flush once before stop.
  if (choice.delta.reasoning_content) {
    if (state.finishReasonSeen) {
      bufferLateReasoningDelta(state, choice.delta.reasoning_content);
    } else {
      if (state.currentBlockType !== 'thinking') {
        if (state.currentBlockType !== null) {
          yield formatSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: state.contentIndex,
          });
          state.contentIndex++;
        }

        yield formatSSEEvent('content_block_start', {
          type: 'content_block_start',
          index: state.contentIndex,
          content_block: { type: 'thinking', thinking: '' },
        });
        state.currentBlockType = 'thinking';
      }

      yield formatSSEEvent('content_block_delta', {
        type: 'content_block_delta',
        index: state.contentIndex,
        delta: { type: 'thinking_delta', thinking: choice.delta.reasoning_content },
      });
    }
  }

  // Handle text content
  if (choice.delta.content) {
    // Filter out common placeholder/garbage text from models like DeepSeek
    // These appear as "(no content)", "(no", etc. before tool calls
    const trimmedContent = choice.delta.content.trim().toLowerCase();
    const isGarbageText = 
      trimmedContent === '(no content)' ||
      trimmedContent === '(no' ||
      trimmedContent === '(no)' ||
      trimmedContent === 'no content' ||
      (trimmedContent.startsWith('(no') && trimmedContent.length < 15);
    
    if (isGarbageText) {
      // Skip this text delta - it's just placeholder/thinking text
      return;
    }

    // Start text block if not already in one
    if (state.currentBlockType !== 'text') {
      // Close previous block if exists
      if (state.currentBlockType !== null) {
        yield formatSSEEvent('content_block_stop', {
          type: 'content_block_stop',
          index: state.contentIndex,
        });
        state.contentIndex++;
      }

      // Start new text block
      yield formatSSEEvent('content_block_start', {
        type: 'content_block_start',
        index: state.contentIndex,
        content_block: { type: 'text', text: '' },
      });
      state.currentBlockType = 'text';
    }

    // Send text delta
    yield formatSSEEvent('content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: { type: 'text_delta', text: choice.delta.content },
    });
  }

  // Handle tool calls
  if (choice.delta.tool_calls) {
    for (const toolCall of choice.delta.tool_calls) {
      // New tool call (has id)
      if (toolCall.id) {
        // Close previous block if exists
        if (state.currentBlockType !== null) {
          yield formatSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: state.contentIndex,
          });
          state.contentIndex++;
        }

        state.toolCallId = toolCall.id;
        state.currentBlockType = 'tool_use';

        // Capture Gemini thought signatures for multi-turn tool calling
        const sig = toolCall.extra_content?.google?.thought_signature;
        if (sig && state.model) {
          const sigKey = `${turnId || '_base'}:${state.model}:${toolCall.id}`;
          sigStore.set(sigKey, sig);
          sigTimestamps?.set(sigKey, Date.now());
          log.debug({ toolCallId: toolCall.id, model: state.model, turnId }, 'Captured Gemini thought signature (streaming)');
        }

        log.debug(
          { toolCallId: toolCall.id, toolName: toolCall.function?.name },
          'Streaming tool call received from model'
        );

        // Start tool_use block with name
        if (toolCall.function?.name) {
          yield formatSSEEvent('content_block_start', {
            type: 'content_block_start',
            index: state.contentIndex,
            content_block: {
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.function.name,
              input: {},
            },
          });
        }
      }

      // Tool call arguments (streamed)
      if (toolCall.function?.arguments) {
        yield formatSSEEvent('content_block_delta', {
          type: 'content_block_delta',
          index: state.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: toolCall.function.arguments,
          },
        });
      }
    }
  }

  // Handle finish reason
  if (choice.finish_reason) {
    // Close current block
    if (state.currentBlockType !== null) {
      yield formatSSEEvent('content_block_stop', {
        type: 'content_block_stop',
        index: state.contentIndex,
      });
      state.contentIndex++;
    }

    // Send message_delta with stop reason and accumulated usage.
    // OpenAI often sends usage in a separate final chunk after finish_reason,
    // so state.outputTokens may still be 0 here. The post-stream fixup
    // (emitted after the streaming loop ends) will patch in the final totals.
    yield formatSSEEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapStopReason(choice.finish_reason),
        stop_sequence: null,
      },
      usage: { output_tokens: state.outputTokens, cache_read_input_tokens: state.cacheReadTokens },
    });
    state.finishReasonSeen = true;
    state.currentBlockType = null;
  }
}

export function* flushLateReasoningBuffer(state: StreamState): Generator<string> {
  if (!state.lateReasoningBuffer) return;

  const capHit = state.lateReasoningCapHit;
  if (capHit) {
    log.warn(
      {
        category: 'late-reasoning-buffer-cap',
        cap: capHit,
        buffered: state.lateReasoningBufferedBytes,
      },
      'Late reasoning buffer cap reached',
    );
    yield formatSSEEvent('degraded-status', {
      reason: 'late-reasoning-buffer-cap',
      cap: capHit,
    });
  }

  log.info(
    {
      buffered_bytes: state.lateReasoningBufferedBytes,
      buffered_chunks: state.lateReasoningBufferedChunks,
      cap_hit: capHit,
    },
    'late_reasoning_content_buffer_fired',
  );

  if (state.currentBlockType !== null) {
    yield formatSSEEvent('content_block_stop', {
      type: 'content_block_stop',
      index: state.contentIndex,
    });
    state.contentIndex++;
    state.currentBlockType = null;
  }

  yield formatSSEEvent('content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: { type: 'thinking', thinking: '' },
  });
  yield formatSSEEvent('content_block_delta', {
    type: 'content_block_delta',
    index: state.contentIndex,
    delta: { type: 'thinking_delta', thinking: state.lateReasoningBuffer },
  });
  yield formatSSEEvent('content_block_stop', {
    type: 'content_block_stop',
    index: state.contentIndex,
  });

  state.lateReasoningBuffer = '';
  state.lateReasoningBufferedBytes = 0;
  state.lateReasoningBufferedChunks = 0;
  state.lateReasoningCapHit = null;
}

/**
 * Route table for multi-route proxy mode (council mode).
 * Maps non-Claude model names to their ModelProfile endpoints.
 */
export interface ModelRouteTable {
  routes: Map<string, ModelProfile>;
}

/**
 * Callback invoked when a council member request fails in the proxy.
 * Used to surface real-time error status events to the user.
 * Only fires for routed council-member requests, not passthrough/lead-agent.
 */
export type CouncilErrorCallback = (modelName: string, errorMessage: string) => void;

type RouteRequiredFailureReason = 'missing-routed-model-header' | 'empty-routed-model-header' | 'unknown-routed-model';

type RouteProfileResolutionResult =
  | {
    kind: 'resolved';
    profile: ModelProfile | null | undefined;
  }
  | {
    kind: 'route-required';
    reason: RouteRequiredFailureReason;
    message: string;
  };

/**
 * Headers that MUST NOT be forwarded to the upstream Anthropic API.
 * Includes:
 * - Internal proxy auth header (x-proxy-auth)
 * - Hop-by-hop headers per RFC 7230 §6.1
 * - Headers that must be recomputed by the outgoing fetch() call
 */
const PASSTHROUGH_BLOCKED_HEADERS = new Set([
  // Internal proxy auth (our own authentication mechanism)
  'x-proxy-auth',
  // Internal turn-scoped routing header (must not leak to upstream APIs)
  'x-routed-turn-id',
  // Internal routed-model header (must not leak to upstream APIs)
  'x-routed-model',
  // Internal OpenRouter routing header (must not leak to upstream APIs)
  'x-openrouter-turn',
  // WS1b-2 proxy integrity-gate headers (executor → proxy; must not leak upstream)
  'x-route-tag',
  'x-route-id',
  'x-route-wire-model',
  // WS4a signed fact-carrier (executor → proxy; internal control header, must not leak upstream)
  'x-route-facts',
  // Must be rewritten for the target host (fetch() sets this automatically)
  'host',
  // Hop-by-hop headers (RFC 7230 §6.1) — connection-specific, not end-to-end
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  // Recomputed by fetch() based on the body we provide
  'content-length',
  // Let fetch() handle its own compression negotiation
  'accept-encoding',
]);

const KNOWN_ROUTED_NAMESPACE_HEADERS = new Set([
  'x-routed-turn-id',
  'x-routed-model',
]);

/** @internal Exported for testing. */
export const SDK_MODEL_ALIASES = new Set([
  'sonnet', 'opus', 'haiku', 'best', 'inherit',
  'working', 'thinking', 'fast',
  'opus[1m]', PLAN_MODE_ALIAS,
]);

// Timeout for upstream to begin responding (headers/first byte).
// Applies to both streaming and non-streaming requests.
// 30s default avoids premature aborts on slower reasoning responses while still
// failing fast enough for genuinely stalled upstreams.
const UPSTREAM_FIRST_BYTE_TIMEOUT_MS = 30_000;

// Timeout for first data chunk after headers arrive (streaming only).
// Some models send 200 OK immediately but stall before generating the first token.
// 45s gives additional headroom beyond the first-byte timeout.
const UPSTREAM_FIRST_CHUNK_TIMEOUT_MS = 45_000;

let _upstreamTimeoutsScaleForTesting = 1;

// Timeout between subsequent streaming chunks (90 seconds).
// Once streaming starts, inter-chunk delays are more tolerable (model is thinking/generating).
// DO NOT read directly outside this module — use getUpstreamTimeouts().streamChunkMs.
const UPSTREAM_STREAM_CHUNK_TIMEOUT_MS = 90_000;

const CIRCUIT_BREAKER_ERROR_MESSAGE = 'Model did not respond within timeout after 3 consecutive attempts';
const CIRCUIT_BREAKER_ERROR_BODY = {
  type: 'error',
  error: {
    type: 'api_error',
    message: CIRCUIT_BREAKER_ERROR_MESSAGE,
  },
};

/**
 * Compute upstream timeouts scaled by reasoning effort.
 * Reasoning models (GPT-5.2, etc.) need significantly longer to produce
 * their first token because they perform internal "thinking" before responding.
 * Values based on Artificial Analysis benchmarks with 2-3x headroom for P95.
 *
 * Returns first-byte, first-chunk, and inter-stream-chunk timeout values. The
 * test-only `_setUpstreamTimeoutsScaleForTesting` seam scales the returned
 * values after production reasoning-effort and local-model semantics are applied.
 */
export function getUpstreamTimeouts(reasoningEffort?: ThinkingEffort, opts?: { isLocal?: boolean }): { firstByteMs: number; firstChunkMs: number; streamChunkMs: number } {
  let base: { firstByteMs: number; firstChunkMs: number };
  switch (reasoningEffort) {
    case 'low':    base = { firstByteMs: 45_000,  firstChunkMs: 60_000 }; break;
    case 'medium': base = { firstByteMs: 90_000,  firstChunkMs: 120_000 }; break;
    case 'high':   base = { firstByteMs: 150_000, firstChunkMs: 200_000 }; break;
    case 'xhigh':  base = { firstByteMs: 240_000, firstChunkMs: 300_000 }; break;
    case undefined: base = { firstByteMs: UPSTREAM_FIRST_BYTE_TIMEOUT_MS, firstChunkMs: UPSTREAM_FIRST_CHUNK_TIMEOUT_MS }; break;
    default:       assertNever(reasoningEffort, 'ThinkingEffort'); break;
  }

  // Local models process the full system prompt on-device; double the timeout
  // to account for slower prompt ingestion on consumer hardware. The inter-chunk
  // timeout remains independent of isLocal per FOX-2656 design.
  const firstByteMs = opts?.isLocal ? base.firstByteMs * 2 : base.firstByteMs;
  const firstChunkMs = opts?.isLocal ? base.firstChunkMs * 2 : base.firstChunkMs;
  const streamChunkMs = UPSTREAM_STREAM_CHUNK_TIMEOUT_MS;
  const scale = _upstreamTimeoutsScaleForTesting;
  return {
    firstByteMs: firstByteMs * scale,
    firstChunkMs: firstChunkMs * scale,
    streamChunkMs: streamChunkMs * scale,
  };
}

/**
 * Test-only: override the upstream timeout scale factor.
 * @internal DO NOT call from production code. Used only by
 * `__tests__/proxyUpstreamTimeout.integration.test.ts` to keep real-I/O
 * integration tests fast (~5s instead of ~225s).
 *
 * Multiplies every value returned by getUpstreamTimeouts (applied AFTER
 * the isLocal doubling so isLocal semantics are preserved). Default scale
 * is 1 (no override).
 *
 * @throws if scale is not a finite positive number.
 */
export function _setUpstreamTimeoutsScaleForTesting(scale: number): void {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`_setUpstreamTimeoutsScaleForTesting: scale must be a finite positive number, got ${scale}`);
  }
  _upstreamTimeoutsScaleForTesting = scale;
}

/** Test-only: reset to production defaults (scale = 1). */
export function _resetUpstreamTimeoutsScaleForTesting(): void {
  _upstreamTimeoutsScaleForTesting = 1;
}

// ── OpenRouter Anthropic-feature stripping ─────────────────────────

/** Returns true if the model name refers to an Anthropic model (e.g. "anthropic/claude-*" or "claude-*"). */
function isAnthropicModel(model: string): boolean {
  const lower = model.toLowerCase();
  return lower.startsWith('anthropic/') || lower.startsWith('claude-');
}

/**
 * Check if an OpenRouter error body indicates top-level cache_control is unsupported.
 * This happens when the Anthropic provider is unavailable and the request includes
 * top-level `cache_control`, which Bedrock/Vertex don't support.
 * Requires 'no endpoints' to avoid false-matching on unrelated 404s that mention caching.
 */
function isCacheControlUnavailableError(errorBody: string): boolean {
  const lower = errorBody.toLowerCase();
  return lower.includes('no endpoints') &&
    (lower.includes('cache_control') || lower.includes('automatic caching'));
}

/**
 * Strip top-level `cache_control` from the request body for retry.
 * When OpenRouter's Anthropic provider is unavailable, top-level cache_control
 * prevents fallback to Bedrock/Vertex. Stripping it allows the request to succeed
 * at the cost of losing automatic prompt caching for that single request.
 * Block-level cache_control inside system/message content blocks is preserved.
 * Returns the original body unchanged if no top-level cache_control is present.
 */
export function stripTopLevelCacheControl(body: string): string {
  const parsed = JSON.parse(body);
  if (!parsed.cache_control) return body;
  delete parsed.cache_control;
  return JSON.stringify(parsed);
}

/**
 * Add block-level `cache_control: { type: 'ephemeral' }` to the system prompt.
 * Used during the 404 fallback retry to preserve caching on Bedrock/Vertex providers
 * that support block-level (but not top-level) cache_control.
 *
 * Handles both formats:
 * - String system prompt → converts to block array with cache_control on the block
 * - Array of blocks → adds cache_control to the last text block
 *
 * Returns the body unchanged if no system prompt exists or no text block is found.
 * Logs a warning when injection fails so silent cache loss is observable.
 * See docs/plans/260424_openrouter_cost_reduction.md Stage 2.
 */
export function addBlockLevelCacheControl(body: string): string {
  const parsed = JSON.parse(body);
  if (!parsed.system) {
    log.debug('addBlockLevelCacheControl: no system prompt — skipping');
    return body;
  }

  if (typeof parsed.system === 'string') {
    parsed.system = [{
      type: 'text',
      text: parsed.system,
      cache_control: { type: 'ephemeral' },
    }];
    return JSON.stringify(parsed);
  }

  if (Array.isArray(parsed.system)) {
    let injected = false;
    for (let i = parsed.system.length - 1; i >= 0; i--) {
      if (parsed.system[i].type === 'text') {
        parsed.system[i].cache_control = { type: 'ephemeral' };
        injected = true;
        break;
      }
    }
    if (!injected) {
      log.warn('addBlockLevelCacheControl: system prompt array has no text blocks — cache injection skipped');
    }
    return JSON.stringify(parsed);
  }

  log.warn({ systemType: typeof parsed.system }, 'addBlockLevelCacheControl: unexpected system prompt format — skipping');
  return body;
}

/**
 * Prepare the request body for the cache_control 404 fallback retry.
 * Atomically applies all transforms needed for Bedrock/Vertex fallback:
 * 1. Strip top-level cache_control (already done by caller)
 * 2. Add block-level cache_control to system prompt blocks
 * 3. Strip context_management (Bedrock/Vertex don't support it)
 * See docs/plans/260424_openrouter_cost_reduction.md Stage 2.
 */
export function prepareFallbackRetryBody(strippedBody: string): string {
  let result = addBlockLevelCacheControl(strippedBody);
  // Force-strip context_management for the fallback path — the retry is going to
  // Bedrock/Vertex which doesn't support it, regardless of model ID.
  const parsed = JSON.parse(result);
  if (parsed.context_management) {
    log.debug('prepareFallbackRetryBody: stripping context_management for fallback provider');
    delete parsed.context_management;
    result = JSON.stringify(parsed);
  }
  return result;
}

/**
 * Strip Anthropic-only `context_management` from the request body for non-Anthropic models.
 * OpenRouter rejects context_management for non-Anthropic endpoints with:
 * "No endpoints available that support Anthropic's context management features"
 */
export function stripContextManagementForNonAnthropic(body: string): string {
  const parsed = JSON.parse(body);
  if (!parsed.context_management) return body;
  if (isAnthropicModel(parsed.model ?? '')) return body;

  log.debug({ model: parsed.model }, 'Stripping context_management for non-Anthropic model on OpenRouter');
  delete parsed.context_management;
  return JSON.stringify(parsed);
}

/**
 * Remove Anthropic context-management/compaction beta flags from the
 * anthropic-beta header value for non-Anthropic models. Returns the cleaned
 * header value, or undefined if empty.
 */
export function stripContextManagementBetaFlag(headerValue: string | undefined, model: string): string | undefined {
  if (!headerValue) return headerValue;
  if (isAnthropicModel(model)) return headerValue;

  const strippedFlags = new Set(['context-management-2025-06-27', 'compact-2026-01-12']);
  const flags = headerValue
    .split(',')
    .map(f => f.trim())
    .filter(f => f && !strippedFlags.has(f));
  return flags.length > 0 ? flags.join(',') : undefined;
}

/**
 * Inject `provider.only` for models with CN/SGP-origin providers so traffic
 * is restricted to non-CN/SGP infrastructure. Always overrides any existing
 * `provider` field (compliance requirement). Returns body unchanged for
 * non-Chinese-origin models.
 *
 * Only sets `only` — never set `order` here, as it disables OpenRouter's
 * native load-balanced routing and outage-aware failover.
 *
 * Debugging: an OpenRouter `404 "No allowed providers are available for the
 * selected model"` for a CN-origin model usually means its only provider is
 * the first-party CN endpoint, which the allowlist excludes. The 404 does not
 * mention this file — trace it here.
 *
 * @see src/shared/openrouterProviderAllowlists.ts — CHINA_ORIGIN_PROVIDER_ALLOWLISTS (edit that file, not this one)
 * @see docs/project/ADDING_AN_OPENROUTER_MODEL.md — runbook, Gotcha 2
 */
export function injectProviderRouting(body: string): string {
  const parsed = JSON.parse(body);
  const model: string = parsed.model ?? '';
  const modelLower = model.toLowerCase();

  const match = CHINA_ORIGIN_PROVIDER_ALLOWLISTS.find((entry) => modelLower.startsWith(entry.prefix));
  if (!match) return body;

  // Only `only` — no `order`, no `ignore`. OR handles routing/failover natively.
  parsed.provider = { only: match.providers };

  log.info(
    { model, providers: match.providers },
    'Injected provider routing for Chinese-origin model',
  );

  return JSON.stringify(parsed);
}

// ── OpenRouter thinking/reasoning translation ──────────────────────

/**
 * Translate outbound request body: Anthropic `thinking` -> OpenRouter `reasoning`.
 * `thinking: { type: 'enabled', budget_tokens: X }` -> `reasoning: { max_tokens: X }`
 * `thinking: { type: 'adaptive' }` -> `reasoning: { max_tokens: <capped budget> }`
 *   OpenRouter has no adaptive equivalent. We cap the reasoning budget at 32K tokens
 *   to avoid inflating costs (Opus 128K * 0.8 = 102K was allocating ~3x more headroom
 *   than needed for most turns). The cap still allows deep reasoning when needed while
 *   preventing wasteful spend at output-token rates (~$26/MTok for Opus via OR).
 *   See docs/plans/260424_openrouter_cost_reduction.md Stage 1.
 */
const ADAPTIVE_REASONING_CAP = 32_000;

export function translateThinkingToReasoning(body: string): string {
  const parsed = JSON.parse(body);
  if (!parsed.thinking) return body;

  if (parsed.thinking.type === 'enabled' && parsed.thinking.budget_tokens) {
    parsed.reasoning = { max_tokens: parsed.thinking.budget_tokens };
    log.debug({ model: parsed.model, thinkingType: 'enabled', reasoningBudget: parsed.thinking.budget_tokens }, 'OR reasoning budget: explicit');
  } else if (parsed.thinking.type === 'adaptive') {
    // Adaptive thinking: cap at ADAPTIVE_REASONING_CAP to control costs.
    // For smaller max_tokens, use 80% but don't exceed the cap.
    // Clamp so reasoning budget is always < max_tokens (API requirement).
    const maxTokens = parsed.max_tokens ?? 128_000;
    const rawBudget = Math.min(ADAPTIVE_REASONING_CAP, Math.max(10_000, Math.floor(maxTokens * 0.8)));
    const reasoningBudget = Math.min(rawBudget, Math.max(1, maxTokens - 1));
    parsed.reasoning = { max_tokens: reasoningBudget };
    log.debug({ model: parsed.model, thinkingType: 'adaptive', maxTokens, reasoningBudget, cap: ADAPTIVE_REASONING_CAP }, 'OR reasoning budget: adaptive (capped)');
  }
  delete parsed.thinking;
  return JSON.stringify(parsed);
}

/**
 * Translate an inbound SSE data line: OpenRouter `reasoning` content blocks -> Anthropic `thinking` blocks.
 * Handles both `content_block_start` and `content_block_delta` events.
 */
export function translateReasoningToThinking(dataLine: string): string {
  if (!dataLine.includes('reasoning')) return dataLine;

  try {
    const parsed = JSON.parse(dataLine);

    // content_block_start: { type: 'content_block_start', content_block: { type: 'reasoning', ... } }
    if (parsed.content_block?.type === 'reasoning') {
      parsed.content_block.type = 'thinking';
      return JSON.stringify(parsed);
    }

    // content_block_delta: { type: 'content_block_delta', delta: { type: 'reasoning_delta', reasoning: '...' } }
    if (parsed.delta?.type === 'reasoning_delta') {
      parsed.delta.type = 'thinking_delta';
      parsed.delta.thinking = parsed.delta.reasoning;
      delete parsed.delta.reasoning;
      return JSON.stringify(parsed);
    }

    return dataLine;
  } catch {
    return dataLine;
  }
}

// ── ProxyManager ────────────────────────────────────────────────────

/**
 * Encapsulates all mutable state for the local model proxy server.
 * A module-level instance provides the singleton behavior; exported functions
 * are thin wrappers that delegate to it.
 */
class ProxyManager {
  private server: http.Server | null = null;
  private currentProfile: ModelProfile | null = null;
  private currentRouteTable: ModelRouteTable | null = null;
  private currentPort: number = DEFAULT_PROXY_PORT;
  private proxyAuthToken: string | null = null;
  private councilErrorCallback: CouncilErrorCallback | null = null;
  private thoughtSignatures = new Map<string, string>();
  private proxyStats = new Map<string, ProxyModelStats>();

  // ── Turn-scoped state (Stage 2) ───────────────────────────────
  private turnRoutes = new Map<string, ModelRouteTable>();
  private turnOpenRouterFallback = new Set<string>();
  private turnCodexEnabled = new Set<string>();
  private turnErrorCallbacks = new Map<string, CouncilErrorCallback>();
  private turnStats = new Map<string, Map<string, ProxyModelStats>>();
  private turnTimeoutCounts = new Map<string, number>();
  private static readonly MAX_CONSECUTIVE_TIMEOUTS = 3;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private sigTimestamps = new Map<string, number>();
  private sigSweepInterval: (() => void) | null = null;

  // ── Ollama health tracking ────────────────────────────────────
  /** Cached "known good" flag for Ollama — resets on error. Avoids health-checking every request. */
  private ollamaKnownGood = false;

  // ── Auth ──────────────────────────────────────────────────────

  /** Generate a new authentication token for this proxy session. */
  private generateAuthToken(): string {
    this.proxyAuthToken = crypto.randomBytes(32).toString('base64url');
    return this.proxyAuthToken;
  }

  /** Get the current proxy authentication token. */
  getAuthToken(): string | null {
    return this.proxyAuthToken;
  }

  // ── Stats ─────────────────────────────────────────────────────

  private getOrCreateStats(model: string, statsMap?: Map<string, ProxyModelStats>): ProxyModelStats {
    const map = statsMap ?? this.proxyStats;
    let stats = map.get(model);
    if (!stats) {
      stats = { inputTokens: 0, outputTokens: 0, requestCount: 0, errorCount: 0 };
      map.set(model, stats);
    }
    return stats;
  }

  private getOrCreateTurnStats(turnId: string): Map<string, ProxyModelStats> {
    let stats = this.turnStats.get(turnId);
    if (!stats) {
      stats = new Map();
      this.turnStats.set(turnId, stats);
    }
    return stats;
  }

  private recordProxyRequest(model: string, turnId?: string): void {
    const statsMap = turnId ? this.getOrCreateTurnStats(turnId) : this.proxyStats;
    this.getOrCreateStats(model, statsMap).requestCount++;
  }

  private recordProxyUsage(model: string, inputTokens: number, outputTokens: number, turnId?: string): void {
    const statsMap = turnId ? this.getOrCreateTurnStats(turnId) : this.proxyStats;
    const stats = this.getOrCreateStats(model, statsMap);
    stats.inputTokens += inputTokens;
    stats.outputTokens += outputTokens;
  }

  private recordProxyError(model: string, turnId?: string): void {
    const statsMap = turnId ? this.getOrCreateTurnStats(turnId) : this.proxyStats;
    this.getOrCreateStats(model, statsMap).errorCount++;
  }

  getAndResetStats(): Map<string, ProxyModelStats> {
    const snapshot = new Map(this.proxyStats);
    this.proxyStats.clear();
    return snapshot;
  }

  getAndResetTurnStats(turnId: string): Map<string, ProxyModelStats> {
    const stats = this.turnStats.get(turnId);
    if (!stats) return new Map();
    this.turnStats.set(turnId, new Map());
    return stats;
  }

  private isCircuitBreakerTripped(turnId?: string): boolean {
    if (!turnId) return false;
    return (this.turnTimeoutCounts.get(turnId) ?? 0) >= ProxyManager.MAX_CONSECUTIVE_TIMEOUTS;
  }

  private recordTimeout(turnId?: string): void {
    if (!turnId) return;
    const count = (this.turnTimeoutCounts.get(turnId) ?? 0) + 1;
    this.turnTimeoutCounts.set(turnId, count);
    log.warn(
      { turnId, consecutiveTimeouts: count, max: ProxyManager.MAX_CONSECUTIVE_TIMEOUTS },
      count >= ProxyManager.MAX_CONSECUTIVE_TIMEOUTS
        ? 'Circuit breaker tripped — subsequent requests will fail fast'
        : 'Consecutive timeout recorded'
    );
  }

  private resetTimeoutCount(turnId?: string): void {
    if (!turnId) return;
    this.turnTimeoutCounts.delete(turnId);
  }

  private createCircuitBreakerError(): Error & { statusCode: number } {
    const error = new Error(CIRCUIT_BREAKER_ERROR_MESSAGE) as Error & { statusCode: number };
    error.statusCode = 503;
    return error;
  }

  private isTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === 'AbortError' || error.name === 'TimeoutError';
  }

  /**
   * Run a Codex upstream fetch, retrying ONCE on a thrown pre-response network
   * blip (see {@link isRetriableUpstreamNetworkError}). Applied only to the FIRST
   * fetch in each Codex path — before any HTTP response or stream bytes exist —
   * so it can never replay a partially-streamed turn nor amplify a real 4xx/429
   * (those surface as a Response/CodexUpstreamError, not a throw). Deliberate
   * timeouts/aborts are not retried. Fixes the single-blip hard-failures behind
   * REBEL-5EZ / REBEL-5K4 ("Codex passthrough failed: fetch failed"), which
   * affect BTS/sub-agent callers that lack the turn-level runWithRetry.
   *
   * Accepted trade-offs (per cross-family review):
   *  - Non-idempotent POST: a blip thrown AFTER Codex accepted/charged the request
   *    but before response headers arrive will issue a second completion. There is
   *    no upstream idempotency key; this is the standard accepted risk for any LLM
   *    proxy retry, deliberately bounded to ONE extra attempt.
   *  - Retry-depth nesting: for main-turn callers this sits inside
   *    AnthropicClient.runWithRetry, so a *persistent* network failure can reach
   *    ~2× the outer retry depth in upstream attempts. Tolerated because the common
   *    single blip is resolved here first and real 4xx/429 are never retried.
   */
  private async fetchCodexFirstWithNetworkRetry(
    doFetch: () => Promise<globalThis.Response>,
    turnId: string | undefined,
    pathLabel: 'non-streaming' | 'streaming',
  ): Promise<globalThis.Response> {
    try {
      return await doFetch();
    } catch (error) {
      if (!isRetriableUpstreamNetworkError(error)) {
        throw error;
      }
      log.warn(
        { err: error instanceof Error ? error.message : String(error), turnId, path: pathLabel },
        'Codex upstream network blip before any response — retrying once',
      );
      return await doFetch();
    }
  }

  private async readResponseTextWithTimeout(
    response: Response,
    timeoutMs: number,
    onTimeout: () => void,
    stallLabel: string,
  ): Promise<string> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const bodyTimeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        onTimeout();
        const error = new Error(`${stallLabel} stalled — no body in ${timeoutMs / 1000}s`);
        error.name = 'TimeoutError';
        reject(error);
      }, timeoutMs);
    });

    try {
      return await Promise.race([response.text(), bodyTimeout]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  // ── Thought signatures ────────────────────────────────────────

  /** Capture thought signatures from a non-streaming OpenAI response. */
  private captureThoughtSignatures(response: OpenAIResponse, modelName: string, turnId?: string): void {
    for (const choice of response.choices) {
      if (!choice.message.tool_calls) continue;
      for (const tc of choice.message.tool_calls) {
        const sig = (tc as OpenAIToolCall).extra_content?.google?.thought_signature;
        if (sig) {
          const sigKey = `${turnId || '_base'}:${modelName}:${tc.id}`;
          this.thoughtSignatures.set(sigKey, sig);
          this.sigTimestamps.set(sigKey, Date.now());
          this.startSigSweep();
          log.debug({ toolCallId: tc.id, model: modelName, turnId }, 'Captured Gemini thought signature');
        }
      }
    }
  }

  /** Inject stored thought signatures into tool_calls in outgoing messages. */
  private injectThoughtSignatures(messages: OpenAIMessage[], modelName: string, turnId?: string): void {
    for (const msg of messages) {
      if (msg.role !== 'assistant' || !msg.tool_calls) continue;
      for (const tc of msg.tool_calls) {
        const sigKey = `${turnId || '_base'}:${modelName}:${tc.id}`;
        const sig = this.thoughtSignatures.get(sigKey);
        if (sig) {
          tc.extra_content = { google: { thought_signature: sig } };
        }
      }
    }
  }

  /** Start periodic sweep of stale thought signatures (30-min TTL). */
  private startSigSweep(): void {
    if (this.sigSweepInterval) return;
    this.sigSweepInterval = createPausableInterval(() => {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [key, ts] of this.sigTimestamps) {
        if (ts < cutoff) {
          this.thoughtSignatures.delete(key);
          this.sigTimestamps.delete(key);
        }
      }
      // Stop sweep if no signatures remain
      if (this.sigTimestamps.size === 0 && this.sigSweepInterval) {
        this.sigSweepInterval();
        this.sigSweepInterval = null;
      }
    }, 5 * 60 * 1000, { pauseOnBlur: true, catchUpPriority: 9 });
  }

  // ── Route resolution ──────────────────────────────────────────

  /**
   * Resolve the profile for a request based on the model name in the request body.
   *
   * Resolution order:
   * 1. If turnId → check turn-scoped routes (council member lookup)
   * 2. Claude-* / SDK alias → return null (Anthropic passthrough)
   * 3. Base profile (alt-model fallback)
   * 4. Legacy currentRouteTable (backward compat during transition)
   * 5. Return undefined (no match)
   *
   * Returns null for Anthropic passthrough, undefined for no match.
   */
  private getSingleHeaderValue(value: string | string[] | undefined): string | undefined {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[0];
    return undefined;
  }

  /**
   * WS4b — verify + decode the executor's signed route-facts carrier
   * (`x-route-facts`, minted by `signRouteFacts` in `deriveHeaders`). Returns the
   * decoded {@link RouteTagFacts} ONLY when the carrier is present and its MAC
   * verifies under the SAME `proxyAuthToken` instance the proxy already requires
   * for `x-proxy-auth` (the carrier rides that authenticated localhost boundary).
   *
   * Returns null when the carrier is absent OR invalid (bad-signature / malformed)
   * OR the proxy has no auth token yet. **WS4b is behaviour-preserving:** a null
   * return means callers FALL BACK to the legacy re-derivation
   * (`activeProvider`/`isAnthropicModel`) exactly as before facts existed — this is
   * fact-when-valid, re-derive-when-not. Fail-closed promotion is WS4c, not here.
   *
   * Verification failures (present-but-invalid) are surfaced as telemetry so a
   * silently-dropped/forged carrier is observable; this does NOT change routing in
   * WS4b (the caller still re-derives), it only records the divergence the WS4c
   * fail-closed promotion will later act on.
   */
  private verifyInboundRouteFacts(
    req: http.IncomingMessage,
    turnId: string | null,
  ): RouteTagFacts | null {
    const carrier = this.getSingleHeaderValue(req.headers[ROUTE_FACTS_HEADER]) ?? null;
    if (carrier === null) {
      // Absent carrier is the legacy/dropped-header path — caller re-derives. No
      // telemetry here: `applyRouteTagGate` already emits the scheme-anomaly signal
      // for an absent route tag (the two are emitted together by the executor).
      return null;
    }
    if (!this.proxyAuthToken) {
      // No shared secret to verify against (proxy not fully started). Fail back to
      // re-derivation rather than trusting an unverifiable carrier.
      return null;
    }
    const verification = verifyRouteFacts(carrier, this.proxyAuthToken);
    if (!verification.ok) {
      log.warn(
        { turnId, reason: verification.reason },
        '[ROUTE-FACTS] inbound route-facts carrier failed verification — falling back to re-derivation (telemetry-only; not fail-closed until WS4c)',
      );
      getErrorReporter().addBreadcrumb({
        category: 'route-facts',
        message: 'route-facts carrier verification failed',
        level: 'warning',
        data: { turnId, reason: verification.reason },
      });
      return null;
    }
    // REQUEST BINDING (billing-correctness): the MAC proves the facts are AUTHENTIC
    // (signed by us this session), NOT that they are FOR THIS request. A valid
    // same-session carrier can be stale-threaded / mis-attached onto a DIFFERENT
    // request (e.g. a previous turn's managed carrier landing on a personal turn),
    // which would FLIP billing mode (a personal request charged to managed, or a
    // managed route charged to the user's own key). Bind by the per-request route
    // anchor `x-route-id` (`ROUTE_ID_HEADER`): the executor emits it on EVERY
    // proxy path from the SAME `routeId` value it signs into `facts.routeId`
    // (`appendRouteTagHeaders` in providerRouteHeaders.ts). If they disagree the
    // facts are NOT bound to this request → fail SAFE: return null so the caller
    // re-derives (the existing facts-absent path) and emit binding telemetry.
    //
    // Model binding is deliberately NOT enforced here: legitimate divergences exist
    // (subagent dispatch + cross-model remaps make body.model ≠ facts.wireModelId —
    // exactly why WS1b-2's model check is telemetry-only). routeId is the binding
    // authority; the `applyRouteTagGate` model-mismatch signal remains telemetry.
    const requestRouteAnchor = this.getSingleHeaderValue(req.headers[ROUTE_ID_HEADER]) ?? null;
    if (requestRouteAnchor === null || verification.facts.routeId !== requestRouteAnchor) {
      log.warn(
        {
          turnId,
          factsRouteId: verification.facts.routeId,
          requestRouteAnchor,
          factsCredentialSource: verification.facts.credentialSource,
        },
        '[ROUTE-FACTS] carrier route-id does not bind to this request — falling back to re-derivation (fail-safe; prevents stale/mis-threaded carrier flipping billing mode)',
      );
      getErrorReporter().addBreadcrumb({
        category: 'route-facts',
        message: 'route-facts carrier not bound to request (route-id mismatch)',
        level: 'warning',
        data: { turnId, factsRouteId: verification.facts.routeId, requestRouteAnchor },
      });
      captureKnownCondition(
        'route_facts_binding_mismatch',
        {
          route: 'route-facts',
          extra: {
            turnId,
            factsRouteId: verification.facts.routeId,
            requestRouteAnchor,
            factsCredentialSource: verification.facts.credentialSource,
          },
        },
        new Error('Route-facts binding: facts.routeId ≠ request x-route-id (stale/mis-threaded carrier, fail-safe re-derivation)'),
      );
      return null;
    }
    // DEFENSE-IN-DEPTH (260621): `x-route-wire-model` and `facts.wireModelId` are
    // BOTH minted from the SAME `RouteTagFacts` (`appendRouteTagHeaders` emits the
    // plaintext witness next to the signed carrier), so a VERIFIED carrier whose
    // `wireModelId` disagrees with the plaintext witness on the SAME request is a
    // carrier/witness mis-pairing (e.g. a stale carrier attached alongside fresh
    // witness/anchor headers) — treat it as a binding failure and re-derive.
    //
    // PRESENT-ONLY: `x-route-wire-model` is emitted on a SUPERSET of the
    // `x-route-facts` paths (the witness is unconditional for proxy dispatch; the
    // carrier needs a proxyAuthToken), so a verified carrier should always have the
    // witness — but a legacy/partial caller that drops the witness must NOT be
    // rejected. Unlike `body.model` (telemetry-only — subagent/cross-model remaps
    // legitimately diverge), the witness is the executor's own minted-from-facts
    // value, so equality is a true invariant here.
    const taggedWireModel = this.getSingleHeaderValue(req.headers[ROUTE_WIRE_MODEL_HEADER]) ?? null;
    if (taggedWireModel !== null && taggedWireModel !== verification.facts.wireModelId) {
      log.warn(
        {
          turnId,
          factsWireModel: verification.facts.wireModelId,
          taggedWireModel,
          factsCredentialSource: verification.facts.credentialSource,
        },
        '[ROUTE-FACTS] carrier wire-model does not match the x-route-wire-model witness — falling back to re-derivation (fail-safe; carrier/witness mis-pairing)',
      );
      getErrorReporter().addBreadcrumb({
        category: 'route-facts',
        message: 'route-facts carrier wire-model ≠ witness header',
        level: 'warning',
        data: { turnId, factsWireModel: verification.facts.wireModelId, taggedWireModel },
      });
      captureKnownCondition(
        'route_facts_binding_mismatch',
        {
          route: 'route-facts',
          extra: {
            turnId,
            factsWireModel: verification.facts.wireModelId,
            taggedWireModel,
            bindingAxis: 'wire-model',
            factsCredentialSource: verification.facts.credentialSource,
          },
        },
        new Error('Route-facts binding: facts.wireModelId ≠ request x-route-wire-model (carrier/witness mis-pairing, fail-safe re-derivation)'),
      );
      return null;
    }
    return verification.facts;
  }

  /**
   * WS4b — resolve managed-vs-personal mode from the verified route facts when
   * available, else re-derive from settings (behaviour-preserving fallback).
   *
   * The executor already decided this on the route plan: `mindstone-managed-key`
   * credentialSource is EXACTLY `activeProvider === 'mindstone'`. Consuming the
   * fact stops the proxy from being a 5th independent re-deriving authority. When
   * the carrier is absent/invalid (`facts === null`) we re-derive the legacy way.
   *
   * NOTE the caller contract: the `turnOpenRouterFallback` runtime override (a
   * plan-mode Claude turn re-routed to OpenRouter at runtime) carries facts that
   * describe the ORIGINAL Anthropic decision (credentialSource `anthropic-*`), which
   * do NOT reflect the runtime OR re-route. The override path therefore passes
   * `facts = null` so this re-derives the user's actual active provider — the
   * override decides, not the carried facts.
   */
  private isManagedModeFor(facts: RouteTagFacts | null): boolean {
    if (facts !== null) {
      return facts.credentialSource === 'mindstone-managed-key';
    }
    return getSettings().activeProvider === 'mindstone';
  }

  private warnOnUnknownRoutedHeaders(
    headers: http.IncomingHttpHeaders,
    requestPath: string | null,
    turnId: string | null,
  ): void {
    const unknownHeaders = Object.keys(headers)
      .filter((name) => name.startsWith('x-routed-') && !KNOWN_ROUTED_NAMESPACE_HEADERS.has(name))
      .sort();

    if (unknownHeaders.length === 0) {
      return;
    }

    log.warn(
      {
        turnId,
        requestPath,
        unknownHeaders,
      },
      'Unknown x-routed-* headers received on proxy request',
    );
  }

  /**
   * WS1b-2 proxy integrity gate — PURELY OBSERVABILITY-FIRST. Cross-checks the
   * executor's emitted route tag (`x-route-tag` + `x-route-id` +
   * `x-route-wire-model`, from `deriveHeaders`) against the INBOUND request and
   * emits LOUD structured telemetry on any divergence. It NEVER rejects a request
   * — there is NO fail-closed path in WS1b-2 (zero turn-breakage risk by
   * construction). The signals are characterization data for a future promotion.
   *
   * TWO divergence signals, both telemetry-only, kept distinguishable:
   *  1. model-mismatch — `body.model` (inbound, NOT the codex post-remap
   *     CodexEgressModel — this gate runs BEFORE the switch) ≠ the executor-minted
   *     `x-route-wire-model` witness (= `decision.wireModelId`). This is NOT yet a
   *     reliable corruption signal: LEGITIMATE cross-model divergences exist that
   *     we cannot enumerate. The pinned case is a non-route-table subagent
   *     OpenRouter legacy-id delegation, where `agentTool` intentionally streams
   *     the RESOLVED model (e.g. `deepseek/deepseek-chat-v3-0324`) while
   *     `wireModelId` carries the cross-model `LEGACY_OR_MODEL_REMAP` target
   *     (`deepseek/deepseek-v3.2`) — a fail-closed reject here would break a
   *     legitimate turn. So we emit a WARN-level known-condition
   *     (`route_tag_gate_model_mismatch`) and PROCEED. (See
   *     `agentTool.resolveSubAgentDispatchBodyModel` + `subAgentProxyRouting.test.ts`.)
   *  2. scheme anomaly — honest, fact-free `inspectRouteTag` signals: `absent`
   *     (tag header dropped), `stale` (older scheme), `malformed` (garbled tag).
   *     We deliberately DO NOT do digest-mismatch verification here: the proxy
   *     CANNOT reconstruct the full 8-field `RouteTagFacts` at ingress (it lacks
   *     role/profileId/credentialSource/billingSource — route resolution happens
   *     later and the decision facts aren't stored), so passing placeholder facts
   *     to `verifyRouteTag` would make EVERY valid request report a synthetic
   *     `integrity-fail` — noise. A `current` tag confirms executor→proxy header
   *     propagation + scheme currency, NOT decision-digest integrity.
   *
   * `turnOpenRouterFallback` turns are a known legitimate runtime-route override
   * and are whitelisted from BOTH signals (they routinely diverge).
   *
   * Deprecation criterion: model-mismatch (and scheme `absent`/`stale`/`malformed`)
   * promote to fail-closed ONLY after (a) telemetry characterizes the legitimate
   * `body.model ≠ wireModelId` set (subagent OR cross-model remaps, etc.) AND
   * (b) WS4 adds a signed fact-carrier OR the witness is changed to the executor's
   * ACTUAL outbound body model rather than `decision.wireModelId`.
   *
   * Scope: PROXY egress only. The non-proxy 260501 codex-divert (native Claude
   * under disconnected Codex → anthropic-direct, no proxy) never reaches here.
   *
   * Returns void — the gate is observational; the caller always continues.
   */
  private applyRouteTagGate(
    req: http.IncomingMessage,
    inboundBodyModel: string | null,
    turnId: string | null,
  ): void {
    const tag = this.getSingleHeaderValue(req.headers[ROUTE_TAG_HEADER]) ?? null;
    const routeId = this.getSingleHeaderValue(req.headers[ROUTE_ID_HEADER]) ?? null;
    const taggedWireModel = this.getSingleHeaderValue(req.headers[ROUTE_WIRE_MODEL_HEADER]) ?? null;
    // OR-fallback turns routinely diverge (runtime route override) — whitelist
    // BOTH signals so they don't generate alarm-level noise.
    if (!!turnId && this.turnOpenRouterFallback.has(turnId)) {
      return;
    }

    // (1) model-mismatch — TELEMETRY-ONLY (NEVER rejects). Distinguishable WARN
    // known-condition so a genuine corruption is separable from the known
    // legitimate body≠wire set we're still characterizing. Uses the plaintext
    // executor witness directly (an independent reference the proxy cannot
    // fabricate from its own routing — in passthrough its routed wire model ==
    // body.model by construction, so a proxy-side-only compare is a no-op).
    if (taggedWireModel !== null && inboundBodyModel !== null && inboundBodyModel !== taggedWireModel) {
      log.warn(
        { turnId, routeId, inboundBodyModel, taggedWireModel },
        '[ROUTE-TAG-GATE] model-mismatch — inbound body model differs from executor wire model; proceeding (telemetry-only; legitimate cross-model remaps exist, not yet fail-closed)',
      );
      captureKnownCondition(
        'route_tag_gate_model_mismatch',
        { route: 'route-tag-gate', extra: { turnId, routeId, inboundBodyModel, taggedWireModel } },
        new Error('Route-tag gate: body.model ≠ executor wire model (model-mismatch, observability-only)'),
      );
    }

    // (2) scheme anomaly — TELEMETRY-ONLY. `inspectRouteTag` asserts only what the
    // proxy can HONESTLY know at ingress without the route facts. A `current` tag
    // confirms header propagation + scheme currency (NOT decision integrity).
    const inspection = inspectRouteTag(tag);
    if (inspection !== 'current') {
      log.warn(
        { turnId, routeId, inspection },
        '[ROUTE-TAG-GATE] route-tag scheme anomaly — proceeding (telemetry-only; not fail-closed)',
      );
      getErrorReporter().addBreadcrumb({
        category: 'route-tag-gate',
        message: 'route-tag scheme anomaly',
        level: 'warning',
        data: { turnId, routeId, inspection },
      });
    }
  }

  private routeRequired(
    params: {
      turnId: string;
      requestPath: string | null;
      routedModelHeader: string | undefined;
      registeredRoutes: string[];
      reason: RouteRequiredFailureReason;
    },
  ): RouteProfileResolutionResult {
    const { turnId, requestPath, routedModelHeader, registeredRoutes, reason } = params;
    const message = reason === 'missing-routed-model-header'
      ? 'Missing x-routed-model header for route-table turn request'
      : reason === 'empty-routed-model-header'
        ? 'Empty x-routed-model header for route-table turn request'
        : `Unknown x-routed-model "${routedModelHeader ?? ''}" for route-table turn request`;

    log.error(
      {
        turnId,
        requestPath,
        routedModelHeader: routedModelHeader ?? null,
        registeredRoutes,
        reason,
      },
      'Route-table turn request rejected: missing or invalid x-routed-model header',
    );
    return {
      kind: 'route-required',
      reason,
      message,
    };
  }

  private resolveRouteProfile(
    modelName: string,
    turnId?: string,
    routedModelHeader?: string | string[],
    requestPath?: string,
  ): RouteProfileResolutionResult {
    const routedModelRaw = this.getSingleHeaderValue(routedModelHeader);
    const routedModel = routedModelRaw?.trim();

    // Step 1: Turn-scoped route lookup
    if (turnId) {
      const turnTable = this.turnRoutes.get(turnId);
      if (turnTable) {
        const registeredRoutes = Array.from(turnTable.routes.keys()).sort();
        if (routedModelRaw === undefined) {
          return this.routeRequired({
            turnId,
            requestPath: requestPath ?? null,
            routedModelHeader: routedModelRaw,
            registeredRoutes,
            reason: 'missing-routed-model-header',
          });
        }
        if (!routedModel || routedModel.length === 0) {
          return this.routeRequired({
            turnId,
            requestPath: requestPath ?? null,
            routedModelHeader: routedModelRaw,
            registeredRoutes,
            reason: 'empty-routed-model-header',
          });
        }
        const profile = turnTable.routes.get(routedModel);
        if (!profile) {
          return this.routeRequired({
            turnId,
            requestPath: requestPath ?? null,
            routedModelHeader: routedModel,
            registeredRoutes,
            reason: 'unknown-routed-model',
          });
        }
        return { kind: 'resolved', profile };

      }
    }

    // Step 2: Claude/Anthropic-family passthrough (must come before base profile to avoid misrouting)
    // Uses isAnthropicModel() to match both 'claude-*' and 'anthropic/claude-*' (OpenRouter format).
    //
    // WS4b: this step DELIBERATELY re-derives from the model string and does NOT
    // consume the route-facts carrier. The carrier's `transport` field cannot drive
    // this decision: `anthropic-compatible-local-proxy` is OVERLOADED — a Google
    // (Gemini) PRIMARY profile emits that exact transport too (providerRouting.ts
    // ~1182, `providerType === 'google'`, non-bts role), so `facts.transport` does
    // NOT distinguish an Anthropic passthrough from a Google profile route. Driving
    // step-2 off it would wrongly send a Google turn to Anthropic (old behaviour
    // falls through to currentProfile for non-Claude models at step 3/4) — breaking
    // the turn and risking an Anthropic-key charge.
    //
    // Unlike `isManagedMode` (which re-reads `activeProvider` — the god-object
    // authority WS1/WS4 collapse), `isAnthropicModel` is a BENIGN, deterministic
    // model-SYNTAX classification: it reads only the model string, never
    // settings/provider state, so it cannot diverge and was never the re-deriving
    // authority this workstream targets. Re-deriving it here is correct and
    // behaviour-preserving.
    if (isAnthropicModel(modelName) || SDK_MODEL_ALIASES.has(modelName)) {
      return { kind: 'resolved', profile: null };
    }

    // Step 3: Base profile (alt-model fallback for non-council, non-Claude requests)
    // When no currentRouteTable is set, use currentProfile directly
    if (this.currentProfile && !this.currentRouteTable) {
      return { kind: 'resolved', profile: this.currentProfile };
    }

    // Step 4: Legacy currentRouteTable (backward compat — used by startMultiRoute)
    if (this.currentRouteTable) {
      if (routedModel) {
        const profile = this.currentRouteTable.routes.get(routedModel);
        if (!profile) {
          log.warn(
            { routedModelHeader: routedModel, requestPath: requestPath ?? null },
            'Routed-model header references unknown model — falling back to passthrough',
          );
          return { kind: 'resolved', profile: null };
        }
        return { kind: 'resolved', profile };
      }
      return { kind: 'resolved', profile: this.currentRouteTable.routes.get(modelName) };
    }

    // Step 5: No match
    return { kind: 'resolved', profile: undefined };
  }

  // ── Request handling ──────────────────────────────────────────

  /**
   * Build headers to forward from the incoming SDK request to the upstream API.
   * Forwards ALL headers except those in the blocklist (internal proxy headers,
   * hop-by-hop headers, and headers that fetch() must recompute).
   *
   * NOTE: client-supplied auth headers (`x-api-key`, `authorization`) are NOT
   * blocklisted here because the single-profile / direct-Anthropic flow can
   * legitimately pass through a real upstream key. Each handler that targets
   * a specific upstream provider (Anthropic, OpenRouter, Codex, council
   * member) is responsible for stripping and re-injecting auth from its
   * source-of-truth at egress time. See:
   *  - `injectAnthropicUpstreamAuth()` for Anthropic
   *  - `handleOpenRouterPassthrough()` for OpenRouter
   *  - `handleCodexStreamingRequest()` / Codex passthrough for Codex
   *  - `handleStreamingRequest()` for council-member routing
   *
   * Non-auth headers (anthropic-version, anthropic-beta, custom diagnostic
   * headers, future SDK additions) are forwarded automatically.
   */
  private buildPassthroughHeaders(req: http.IncomingMessage): Record<string, string> {
    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries(req.headers)) {
      // Skip blocked headers (case-insensitive — Node.js lowercases header names)
      if (PASSTHROUGH_BLOCKED_HEADERS.has(name)) continue;
      // Skip undefined/missing values
      if (value === undefined) continue;
      // Flatten array headers (e.g., multiple values for same header) into comma-separated
      headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }

    return headers;
  }

  /**
   * Resolve and inject the real upstream Anthropic credential into the
   * forwarding headers map, stripping any client-supplied auth first.
   *
   * Why: requests originating from `clientFactory.ts` PRECEDENCE 1
   * (route-table proxy mode) carry `x-api-key: PROXY_HANDLES_AUTH_SENTINEL`
   * and a proxy-internal Bearer token. Those must NOT reach Anthropic's API.
   * The proxy is the auth boundary — it always re-resolves auth from
   * persisted settings before egress, matching the symmetric pattern used by
   * `handleOpenRouterPassthrough` and the Codex/council-member handlers.
   *
   * Returns false if no Anthropic key is configured (caller fails closed
   * with a 401 `authentication_error`). Wrapped in try/catch so a settings
   * adapter throw produces a clean fail-closed response rather than a 500
   * crash.
   *
   * Contract: see `src/core/rebelCore/proxyAuthContract.ts`.
   * Postmortem: see `docs/plans/260430_eval_harness_recovery_and_anthropic_auth_fix.md` Stage 2.
   */
  private injectAnthropicUpstreamAuth(headers: Record<string, string>): boolean {
    let apiKey: string | undefined;
    try {
      apiKey = getAuthForDirectUse(getSettings()).apiKey;
    } catch (err) {
      log.error({ err }, 'injectAnthropicUpstreamAuth: settings read failed; failing closed');
      // Fail-closed: still strip client auth so a leaked credential cannot
      // survive, but inject nothing.
      stripClientAuthHeaders(headers);
      return false;
    }

    if (!apiKey) {
      stripClientAuthHeaders(headers);
      return false;
    }
    // Central injector: strips client x-api-key/authorization, injects upstream
    // x-api-key from the proxy's resolved Anthropic credential (PM 260430).
    injectUpstreamAuth(headers, { kind: 'anthropic-x-api-key', apiKey });
    return true;
  }

  /**
   * Passthrough handler for Claude model requests in multi-route mode.
   * Forwards the Anthropic-format request to Anthropic's API.
   *
   * Auth handling: any client-supplied `x-api-key` / `authorization` is
   * replaced with the proxy-resolved Anthropic key via
   * `injectAnthropicUpstreamAuth()`. The `Anthropic` SDK's
   * `clientFactory.ts` PRECEDENCE 1 path sets a sentinel key (see
   * `proxyAuthContract.ts`); the proxy is the canonical auth boundary.
   * Non-auth headers (anthropic-version, anthropic-beta, custom headers)
   * are forwarded as-is.
   */
  private async handleAnthropicPassthrough(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    isStreaming: boolean
  ): Promise<void> {
    const headers = this.buildPassthroughHeaders(req);
    const inboundApiKeyFp = fingerprint(headers['x-api-key']);
    const inboundAuthorizationFp = fingerprint(headers.authorization);
    const inboundSentinelDetected = headers['x-api-key'] === PROXY_HANDLES_AUTH_SENTINEL;

    if (!this.injectAnthropicUpstreamAuth(headers)) {
      log.warn({
        inboundSentinelDetected,
        inboundApiKeyFp,
      }, 'Anthropic passthrough: no upstream Anthropic key configured — failing closed with 401');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'Anthropic API key not configured. Please add one in Settings → Models.',
        },
      }));
      return;
    }

    // Log forwarded header names (NOT values) for debugging without leaking secrets
    const forwardedHeaderNames = Object.keys(headers);

    // Parse model name for logging — defensive in case body is malformed
    let requestModel = 'unknown';
    try { requestModel = JSON.parse(body).model ?? 'unknown'; } catch { /* use default */ }

    log.info({
      isStreaming,
      model: requestModel,
      inboundSentinelDetected,
      forwardedHeaders: forwardedHeaderNames,
    }, 'Passthrough to Anthropic API');

    diagLog({ site: 'localProxy:anthropic-passthrough' }, {
      model: requestModel,
      inboundSentinelDetected,
      forwardedHeaders: forwardedHeaderNames,
      inboundApiKeyFp,
      inboundAuthorizationFp,
      outboundApiKeyFp: fingerprint(headers['x-api-key']),
      outboundAuthorizationFp: fingerprint(headers.authorization),
      anthropicBetaHeader: headers['anthropic-beta'] ?? null,
      anthropicVersionHeader: headers['anthropic-version'] ?? null,
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 4xx = client errors (SDK probes, bad requests) — warn, not error.
      // 5xx = server failures — genuine errors worth alerting on.
      const logFn = response.status >= 500 ? log.error.bind(log) : log.warn.bind(log);
      logFn({ status: response.status, isStreaming }, 'Anthropic API error in passthrough');
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(errorText);
      return;
    }

    if (isStreaming && response.body) {
      // Stream passthrough: pipe Anthropic SSE directly to client
      res.writeHead(response.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
        res.end();
      }
      return;
    }

    // Non-streaming passthrough
    const responseBody = await response.text();
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    res.end(responseBody);
  }

  // ── OpenRouter passthrough ─────────────────────────────────────

  private translateThinkingToReasoning(body: string): string {
    return translateThinkingToReasoning(body);
  }

  private translateReasoningToThinking(dataLine: string): string {
    return translateReasoningToThinking(dataLine);
  }

  /**
   * Passthrough handler for OpenRouter requests.
   * Forwards Anthropic-format requests to OpenRouter's Messages API with:
   * - Auth header swap (proxy auth -> OR Bearer token)
   * - Thinking -> reasoning translation (outbound)
   * - Reasoning -> thinking translation (inbound SSE)
   * - Zero data retention header
   */
  private async handleOpenRouterPassthrough(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: string,
    isStreaming: boolean,
    turnId?: string,
    facts?: RouteTagFacts | null,
  ): Promise<void> {
    // Resolve key based on managed-vs-personal mode.
    // Mindstone managed mode: use managed key (fail-closed, never fall back to personal).
    // Personal OpenRouter mode: use personal OAuth key.
    //
    // WS4b: consume the executor's verified verdict (`facts.credentialSource ===
    // 'mindstone-managed-key'`) instead of re-deriving `activeProvider === 'mindstone'`.
    // When facts are absent/invalid (`facts == null`) — including the
    // turnOpenRouterFallback override path which deliberately passes `null` — this
    // falls back to the legacy re-derivation, behaviour-preserving.
    const isManagedMode = this.isManagedModeFor(facts ?? null);
    const apiKey = isManagedMode ? resolveManagedOpenRouterApiKey() : resolveOpenRouterApiKey();
    if (!apiKey) {
      const errorMsg = isManagedMode
        ? 'Managed subscription key not available — please check your subscription status'
        : 'OpenRouter API key not configured';
      log.error({ isManagedMode }, 'OpenRouter passthrough failed: no API key available');
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'authentication_error', message: errorMsg },
      }));
      return;
    }

    let translatedBody = this.translateThinkingToReasoning(body);
    // Strip Anthropic-only context_management for non-Anthropic models (GPT, etc.)
    translatedBody = stripContextManagementForNonAnthropic(translatedBody);

    let requestModel = 'unknown';
    try { requestModel = JSON.parse(translatedBody).model ?? 'unknown'; } catch { /* use default */ }

    if (isManagedMode) {
      const presence = getRebelAuthProvider().getCachedAuthConfig();
      const allowed = getManagedAllowedModelIds(presence?.managedProvider);
      if (allowed.length === 0 || !allowed.includes(requestModel)) {
        log.warn(
          { model: requestModel, allowed, isManagedMode },
          'Managed model not allowed — rejecting at proxy boundary',
        );
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            code: 'MANAGED_MODEL_NOT_ALLOWED',
            requested: requestModel,
            allowed,
          },
        }));
        return;
      }
    }

    if (this.isCircuitBreakerTripped(turnId)) {
      log.warn({ turnId, model: requestModel }, 'OpenRouter passthrough circuit breaker tripped — failing fast');
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(CIRCUIT_BREAKER_ERROR_BODY));
      return;
    }

    // Provider routing: inject provider.only for Chinese-origin models to ensure
    // requests are routed to US/EU-based providers. OpenRouter's own per-model
    // provider configuration handles routing for all other models.
    translatedBody = injectProviderRouting(translatedBody);
    const providerRoutingApplied = CHINA_ORIGIN_PROVIDER_ALLOWLISTS.some(
      (entry) => requestModel.toLowerCase().startsWith(entry.prefix),
    );

    // Build forwarding headers — same as Anthropic passthrough but swap auth.
    // Central injector: strips client x-api-key/authorization, injects the
    // resolved OpenRouter Bearer (auth-symmetry, PM 260430).
    const headers = this.buildPassthroughHeaders(req);
    injectUpstreamAuth(headers, { kind: 'openrouter-bearer', apiKey });
    // Canonical attribution (SSOT shared with providerRouteHeaders.ts). Previously
    // hardcoded 'https://mindstone.app' — a domain we do NOT own — which drifted
    // from the route-plan path's correct value. See managed-traffic-zdr-proxy-precedence.
    headers['http-referer'] = OPENROUTER_ATTRIBUTION_REFERER;
    headers['x-title'] = OPENROUTER_ATTRIBUTION_TITLE;
    // Zero data retention — OR will not log/train on this request
    headers['x-zdr'] = 'true';
    // Strip context-management beta flag for non-Anthropic models
    const cleanedBeta = stripContextManagementBetaFlag(headers['anthropic-beta'], requestModel);
    if (cleanedBeta) {
      headers['anthropic-beta'] = cleanedBeta;
    } else {
      delete headers['anthropic-beta'];
    }

    // Do NOT log apiKeyLast4 on the success path: it has no diagnostic value
    // here (every successful passthrough), and for managed mode the key now
    // also lives on cloud at-rest, so we minimise key-fragment exposure in
    // routine high-volume logs. Failure correlation still logs apiKeyLast4 on
    // the billing-shaped error path below (where it has a documented purpose).
    log.info(
      {
        isStreaming,
        model: requestModel,
        providerRoutingApplied,
        isManagedMode,
      },
      'Passthrough to OpenRouter API'
    );

    // OpenRouter passthrough does not have a route profile carrying reasoning
    // effort. Use the medium remote-model envelope for user-facing reasoning
    // turns; BTS callers still cancel this proxy via their shorter client
    // timeout, and the close listener below aborts the orphaned upstream call.
    const timeouts = getUpstreamTimeouts('medium');
    const lifecycle = new StreamLifecycle({
      timeouts,
      finishDeadlineMs: LATE_REASONING_FINISH_DEADLINE_MS,
      recordTimeout: () => this.recordTimeout(turnId),
      resetTimeoutCount: () => this.resetTimeoutCount(turnId),
      log: {
        firstByteTimeout: () => log.warn(
          { model: requestModel, timeoutMs: timeouts.firstByteMs, isStreaming, isManagedMode },
          'OpenRouter first-byte timeout — aborting passthrough request',
        ),
        firstChunkTimeout: () => log.warn(
          { model: requestModel, timeoutMs: timeouts.firstChunkMs, isManagedMode },
          'OpenRouter first-chunk timeout — no data after headers',
        ),
      },
    });
    let passthroughComplete = false;
    const abortOpenRouterOnClientClose = () => {
      if (passthroughComplete) return;
      log.warn({ model: requestModel, turnId, isStreaming }, 'OpenRouter passthrough client closed — aborting upstream request');
      lifecycle.abort();
    };
    req.once('aborted', abortOpenRouterOnClientClose);
    res.once('close', abortOpenRouterOnClientClose);

    const readOpenRouterBody = (targetResponse: Response, stallLabel: string) =>
      this.readResponseTextWithTimeout(
        targetResponse,
        timeouts.firstChunkMs,
        () => {
          this.recordTimeout(turnId);
          lifecycle.abort();
          log.warn(
            { model: requestModel, timeoutMs: timeouts.firstChunkMs, isStreaming, isManagedMode },
            'OpenRouter response body timeout — aborting passthrough request',
          );
        },
        stallLabel,
      );

    try {
    const fetchStart = Date.now();
    let response = await lifecycle.fetchFirstByte((signal) =>
      fetch(OPENROUTER_MESSAGES_URL, {
        method: 'POST',
        headers,
        body: translatedBody,
        signal,
      }),
    );

    // Cache-control fallback: when OpenRouter's Anthropic provider is unavailable,
    // top-level cache_control prevents fallback to Bedrock/Vertex (they don't support it).
    // Detect this specific 404, apply atomic fallback transforms, and retry once.
    // See docs/plans/260424_openrouter_cost_reduction.md Stage 2.
    let consumedErrorText: string | undefined;
    if (!response.ok && response.status === 404) {
      consumedErrorText = await readOpenRouterBody(response, 'OpenRouter error body');
      if (isCacheControlUnavailableError(consumedErrorText)) {
        const strippedBody = stripTopLevelCacheControl(translatedBody);
        if (strippedBody !== translatedBody) {
          // Atomic fallback: strip cache_control, add block-level, strip context_management
          const retryBody = prepareFallbackRetryBody(strippedBody);
          // Strip context-management beta flag for the retry headers.
          // Pass empty model string to force-strip (fallback target is non-Anthropic).
          const retryHeaders = { ...headers };
          const cleanedRetryBeta = stripContextManagementBetaFlag(retryHeaders['anthropic-beta'], '');
          if (cleanedRetryBeta) {
            retryHeaders['anthropic-beta'] = cleanedRetryBeta;
          } else if (retryHeaders['anthropic-beta']) {
            delete retryHeaders['anthropic-beta'];
          }
          log.info(
            { model: requestModel, providerRoutingApplied },
            'OpenRouter cache_control fallback: retrying with block-level cache and fallback-safe body'
          );
          try {
            response = await lifecycle.fetchFirstByte((signal) =>
              fetch(OPENROUTER_MESSAGES_URL, {
                method: 'POST',
                headers: retryHeaders,
                body: retryBody,
                signal,
              }),
            );
            consumedErrorText = undefined;
          } catch (retryErr) {
            log.warn(
              { model: requestModel, err: retryErr },
              'OpenRouter cache_control fallback retry failed with network error'
            );
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(consumedErrorText);
            return;
          }
        }
      }
    }

    if (!response.ok) {
      const errorText = consumedErrorText ?? await readOpenRouterBody(response, 'OpenRouter error body');
      const elapsedMs = Date.now() - fetchStart;
      // Extract safe, structured fields from the OR error body.
      // Never log raw errorText — it's untrusted upstream content.
      let orErrorType: string | undefined;
      let orErrorCode: string | undefined;
      try {
        const parsed = JSON.parse(errorText);
        const errObj = parsed?.error ?? parsed;
        orErrorType = typeof errObj?.type === 'string' ? errObj.type.slice(0, 80) : undefined;
        orErrorCode = typeof errObj?.code === 'string' ? errObj.code.slice(0, 80) : undefined;
      } catch { /* not JSON — leave fields undefined */ }
      const logFn = response.status >= 500 ? log.error.bind(log) : log.warn.bind(log);
      logFn(
        { status: response.status, isStreaming, model: requestModel, providerRoutingApplied, elapsedMs, orErrorType, orErrorCode },
        'OpenRouter API error in passthrough'
      );
      // Diagnostic: when OpenRouter returns a billing-shaped failure (402/403,
      // or 429 with quota/billing body), log the API key's last 4 characters
      // and the truncated body so we can correlate the failure with the
      // server-side managed-key issuance logs (which log keyHashPrefix +
      // apiKeyLast4). NEVER log the full key.
      //
      // F4: the managed (Mindstone-subscription) key is a Rebel-owned billable
      // credential that, post-Layer-3, now also resides on the cloud surface.
      // Omit even the last-4 fragment of THAT key on cloud (keep it for
      // personal-key correlation and for all desktop ops). This narrows where
      // any fragment of the managed key can appear, matching "never log the
      // managed key" on the surface where it is newly present.
      const suppressManagedKeyFragment =
        isManagedMode && getPlatformConfig().surface === 'cloud';
      const isBillingShapedStatus = response.status === 402 || response.status === 403 || response.status === 429;
      if (isBillingShapedStatus) {
        log.warn(
          {
            status: response.status,
            isManagedMode,
            model: requestModel,
            providerRoutingApplied,
            elapsedMs,
            orErrorType,
            orErrorCode,
            ...(suppressManagedKeyFragment ? {} : { apiKeyLast4: apiKey.slice(-4) }),
            errorBody: errorText.slice(0, 2000),
          },
          'OpenRouter billing-shaped error — diagnostic detail'
        );
      }
      getErrorReporter().addBreadcrumb({
        category: 'openrouter-proxy',
        message: `OR API error ${response.status}`,
        level: response.status >= 500 ? 'error' : 'warning',
        data: { status: response.status, model: requestModel, providerRoutingApplied, elapsedMs, orErrorType, orErrorCode },
      });
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(errorText);
      return;
    }

    lifecycle.noteResponseSettled(response.status);

    if (isStreaming && response.body) {
      res.writeHead(response.status, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Stream with reasoning -> thinking translation
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const readResult = await lifecycle.readNextChunk(reader, false, 'OpenRouter stream');
          if (readResult.kind === 'finish-deadline') {
            lifecycle.abort();
            break;
          }
          const { done, value } = readResult;
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Keep last incomplete line in buffer
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('data: ') && line !== 'data: [DONE]') {
              const payload = line.slice(6);
              const translated = this.translateReasoningToThinking(payload);
              res.write(`data: ${translated}\n`);
            } else {
              res.write(line + '\n');
            }
          }
        }
        // Flush remaining buffer
        if (buffer.length > 0) {
          if (buffer.startsWith('data: ') && buffer !== 'data: [DONE]') {
            const payload = buffer.slice(6);
            const translated = this.translateReasoningToThinking(payload);
            res.write(`data: ${translated}\n`);
          } else {
            res.write(buffer + '\n');
          }
        }
      } catch (streamErr) {
        lifecycle.recordStreamTimeoutIfNeeded();
        lifecycle.abort();
        log.warn(
          {
            err: streamErr,
            model: requestModel,
            isManagedMode,
            timeoutMs: timeouts.streamChunkMs,
          },
          'OpenRouter streaming passthrough interrupted',
        );
        if (!res.writableEnded) {
          res.write(formatSSEEvent('error', {
            type: 'error',
            error: {
              type: 'api_error',
              message: 'OpenRouter stream timed out before Rebel received more data.',
            },
          }));
        }
      } finally {
        reader.releaseLock();
        res.end();
      }
      return;
    }

    // Non-streaming: translate reasoning blocks in response body
    let responseBody = await readOpenRouterBody(response, 'OpenRouter response body');
    let orProvider: string | undefined;
    try {
      const parsed = JSON.parse(responseBody);
      if (parsed.content) {
        for (const block of parsed.content) {
          if (block.type === 'reasoning') {
            block.type = 'thinking';
            block.thinking = block.reasoning;
            delete block.reasoning;
          }
        }
      }
      // Extract upstream provider from OpenRouter response (present in some responses)
      if (typeof parsed.provider === 'string' && parsed.provider) {
        orProvider = parsed.provider;
      }
      responseBody = JSON.stringify(parsed);
    } catch { /* forward as-is if parsing fails */ }

    const responseHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (orProvider) {
      responseHeaders['x-rebel-or-provider'] = orProvider;
    }
    res.writeHead(response.status, responseHeaders);
    res.end(responseBody);
    } finally {
      passthroughComplete = true;
      req.off('aborted', abortOpenRouterOnClientClose);
      res.off('close', abortOpenRouterOnClientClose);
    }
  }

  private async forwardToLocalModel(
    openaiRequest: OpenAIRequest,
    profile: ModelProfile,
    turnId?: string,
    codexEnabled: boolean = false,
  ): Promise<OpenAIResponse> {
    if (this.isCircuitBreakerTripped(turnId)) {
      throw this.createCircuitBreakerError();
    }

    const effectiveKey = this.resolveProfileBearerToken(profile, codexEnabled);

    // Codex OAuth fallback: OpenAI profiles without an API key.
    //
    // F1 core fix (Stage 12): this is the route-resolved → Codex egress path —
    // a fully independent way to reach the Codex Responses upstream that does
    // NOT go through the `x-codex-turn` classification. It MUST funnel through
    // the same brand-typed choke point so a `claude-`/anthropic-dialect model
    // can never reach Codex here either. We remap `openaiRequest.model` to a
    // CodexEgressModel and rebuild the request with the branded model, so
    // `forwardToCodexModel` (which requires a CodexEgressRequest) cannot be
    // called with a raw model name.
    if (codexEnabled && isCodexSubscriptionProfile(profile) && profile.providerType === 'openai') {
      const egress = remapToCodexEgressModel(openaiRequest.model);
      this.reportCodexEgressRemap(egress, openaiRequest.model, turnId);
      const codexRequest: CodexEgressRequest = { ...openaiRequest, model: egress.model };
      log.info({ profileId: profile.id, model: codexRequest.model, authMethod: 'codex-subscription' }, 'Routing to Codex OAuth fallback (non-streaming)');
      return this.forwardToCodexModel(codexRequest, profile, turnId);
    }

    // Observability: Codex-tagged profile falling through to direct routing.
    // Codex was disconnected at turn start; traffic will bill via shared key.
    if (isCodexSubscriptionProfile(profile) && profile.providerType === 'openai') {
      log.warn({ profileId: profile.id, model: openaiRequest.model, codexEnabled, reason: 'fell-back-to-shared-key' }, 'codex-profile-proxy-fallback (non-streaming)');
    }

    const url = buildCompletionsUrl(profile.serverUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    injectUpstreamAuth(headers, { kind: 'profile-bearer', bearerToken: effectiveKey });

    const isLocal = isLoopbackRoutableProfile(profile);
    const { firstByteMs } = getUpstreamTimeouts(profile.reasoningEffort, { isLocal });

    const validatedRequest = finalizeChatCompletionsBody(openaiRequest, {
      modelId: openaiRequest.model,
      providerType: profile.providerType,
      log,
    });

    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: serializeChatCompletionsBody(validatedRequest),
        signal: AbortSignal.timeout(firstByteMs),
      });
    } catch (error) {
      if (this.isTimeoutError(error)) {
        this.recordTimeout(turnId);
      }
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Local model error (${response.status}): ${errorText}`);
    }

    if (response.status === 200) {
      this.resetTimeoutCount(turnId);
    }

    return (await response.json()) as OpenAIResponse;
  }

  private async handleStreamingRequest(
    anthropicRequest: AnthropicRequest,
    res: http.ServerResponse,
    profile: ModelProfile,
    turnId?: string,
    codexEnabled: boolean = false,
  ): Promise<void> {
    if (this.isCircuitBreakerTripped(turnId)) {
      throw this.createCircuitBreakerError();
    }

    const effectiveKey = this.resolveProfileBearerToken(profile, codexEnabled);

    // Codex OAuth fallback: OpenAI profiles without an API key.
    //
    // F1 core fix (Stage 12): the route-resolved → Codex streaming egress path.
    // Same choke point as the non-streaming twin: remap `profile.model ||
    // anthropicRequest.model` to a brand-typed CodexEgressModel and thread it
    // into `handleCodexStreamingRequest` (which requires one), so no raw
    // `claude-`/anthropic-dialect model can reach the Codex upstream here.
    if (codexEnabled && isCodexSubscriptionProfile(profile) && profile.providerType === 'openai') {
      const rawModel = profile.model || anthropicRequest.model;
      const egress = remapToCodexEgressModel(rawModel);
      this.reportCodexEgressRemap(egress, rawModel, turnId);
      log.info({ profileId: profile.id, model: egress.model, authMethod: 'codex-subscription' }, 'Routing to Codex OAuth fallback (streaming)');
      return this.handleCodexStreamingRequest(anthropicRequest, res, profile, egress.model, turnId);
    }

    // Observability: Codex-tagged profile falling through to direct routing.
    // Codex was disconnected at turn start; traffic will bill via shared key.
    if (isCodexSubscriptionProfile(profile) && profile.providerType === 'openai') {
      log.warn({ profileId: profile.id, model: profile.model, codexEnabled, reason: 'fell-back-to-shared-key' }, 'codex-profile-proxy-fallback (streaming)');
    }

    const url = buildCompletionsUrl(profile.serverUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    injectUpstreamAuth(headers, { kind: 'profile-bearer', bearerToken: effectiveKey });

    const modelName = profile.model || anthropicRequest.model;
    // REBEL-5N8 / STAGE0: reasoning-replay MUST key on the RESOLVED profile's concrete model
    // (`profile.model`), never the bare inbound alias (`anthropicRequest.model`). The proxy keeps
    // its OWN independent recompute here (it must not trust a caller plan — hard constraint). Pinned
    // by scripts/check-capability-resolution-dispatch-seam.ts.
    const supportsReasoningReplay = computeSupportsReasoningReplay(profile, modelName);
    const isLocal = isLoopbackRoutableProfile(profile);
    const timeouts = getUpstreamTimeouts(profile.reasoningEffort, { isLocal });
    const messages = translateMessagesToOpenAI(
      anthropicRequest.messages,
      anthropicRequest.system,
      modelName,
      supportsReasoningReplay,
    );
    this.injectThoughtSignatures(messages, modelName, turnId);

    const openaiRequest: OpenAIRequest = {
      model: modelName,
      messages,
      max_completion_tokens: anthropicRequest.max_tokens ?? 4096,
      tools: translateToolsToOpenAI(anthropicRequest.tools),
      tool_choice: translateToolChoiceToOpenAI(anthropicRequest.tool_choice),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (anthropicRequest.temperature !== undefined) {
      openaiRequest.temperature = anthropicRequest.temperature;
    }
    applyAnthropicOutputFormat(openaiRequest, anthropicRequest.output_format);

    const reasoningEffort = resolveProfileReasoningEffort(profile);
    if (reasoningEffort) {
      openaiRequest.reasoning_effort = reasoningEffort;
    }
    this.injectOllamaOptions(openaiRequest, profile);

    const validatedRequest = finalizeChatCompletionsBody(openaiRequest, {
      modelId: modelName,
      providerType: profile.providerType,
      log,
    });

    this.recordProxyRequest(modelName, turnId);
    log.info(
      {
        url,
        model: openaiRequest.model,
        reasoningEffort: profile.reasoningEffort,
        effectiveFirstByteMs: timeouts.firstByteMs,
        inboundOutputFormat: !!anthropicRequest.output_format,
        outboundResponseFormat: !!openaiRequest.response_format,
      },
      'Starting streaming request to local model',
    );

    // Shared liveness contract (Stage 14): first-byte / first-chunk / per-chunk /
    // finish-deadline / circuit-breaker handling lives in StreamLifecycle. The
    // per-branch timeout constants + log wording are INJECTED so this branch's
    // values can never overwrite another's.
    const lifecycle = new StreamLifecycle({
      timeouts,
      finishDeadlineMs: LATE_REASONING_FINISH_DEADLINE_MS,
      recordTimeout: () => this.recordTimeout(turnId),
      resetTimeoutCount: () => this.resetTimeoutCount(turnId),
      log: {
        firstByteTimeout: () => log.warn({ model: modelName, timeoutMs: timeouts.firstByteMs, reasoningEffort: profile.reasoningEffort }, 'Upstream first-byte timeout — aborting streaming request'),
        firstChunkTimeout: () => log.warn({ model: modelName, timeoutMs: timeouts.firstChunkMs, reasoningEffort: profile.reasoningEffort }, 'Upstream first-chunk timeout — no data after headers'),
      },
    });

    const response = await lifecycle.fetchFirstByte((signal) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: serializeChatCompletionsBody(validatedRequest),
        signal,
      }),
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Local model error (${response.status}): ${errorText}`);
    }

    lifecycle.noteResponseSettled(response.status);

    if (!response.body) {
      throw new Error('No response body from local model');
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const state = createStreamState();
    state.model = modelName; // Use profile model name for consistent keying (signatures, stats)
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Bind instance methods for use in processStreamChunk
    const sigStore = this.thoughtSignatures;
    const sigTs = this.sigTimestamps;
    const boundRecordUsage = (model: string, inputTokens: number, outputTokens: number) => {
      this.recordProxyUsage(model, inputTokens, outputTokens, turnId);
    };

    let hasSentMessageStop = false;
    let doneSentinelSeen = false;
    try {
      while (true) {
        const readResult = await lifecycle.readNextChunk(reader, state.finishReasonSeen, 'Upstream stream');
        if (readResult.kind === 'finish-deadline') {
          state.lateReasoningCapHit = state.lateReasoningCapHit ?? 'time';
          lifecycle.abort();
          break;
        }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events (separated by double newline)
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            doneSentinelSeen = true;
            break;
          }

          try {
            const chunk = JSON.parse(data) as OpenAIStreamChunk;
            const actualModel = chunk.model || profile.model || 'local-model';
            for (const event of processStreamChunk(chunk, state, actualModel, sigStore, boundRecordUsage, turnId, sigTs)) {
              res.write(event);
            }
            if (state.lateReasoningCapHit) {
              break;
            }
          } catch (parseError) {
            log.warn({ data, err: parseError }, 'Failed to parse streaming chunk');
          }
        }

        if (doneSentinelSeen || state.lateReasoningCapHit) {
          break;
        }
      }

      // Process any remaining buffer
      if (!doneSentinelSeen && !state.lateReasoningCapHit && buffer.trim()) {
        const data = buffer.replace(/^data: /, '').trim();
        if (data && data !== '[DONE]') {
          try {
            const chunk = JSON.parse(data) as OpenAIStreamChunk;
            const actualModel = chunk.model || profile.model || 'local-model';
            for (const event of processStreamChunk(chunk, state, actualModel, sigStore, boundRecordUsage, turnId, sigTs)) {
              res.write(event);
            }
          } catch {
            // Ignore parse errors on final buffer
          }
        }
      }

      // Ensure terminal events are emitted when the upstream closes without [DONE].
      // Some providers (e.g. MiniMax) end the SSE stream after the final usage chunk
      // without sending a [DONE] sentinel. The Anthropic SDK requires message_stop to
      // populate receivedMessages -- without it, finalMessage() throws
      // "stream ended without producing a Message with role=assistant".
      if (!hasSentMessageStop && state.hasSentMessageStart) {
        for (const lateReasoningEvent of flushLateReasoningBuffer(state)) {
          res.write(lateReasoningEvent);
        }

        // Close any open content block
        if (state.currentBlockType !== null) {
          res.write(formatSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: state.contentIndex,
          }));
          state.currentBlockType = null;
        }

        // Emit usage fixup if we have token counts
        if (state.inputTokens > 0 || state.outputTokens > 0) {
          res.write(formatSSEEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: null, stop_sequence: null },
            usage: {
              input_tokens: state.inputTokens,
              output_tokens: state.outputTokens,
              cache_read_input_tokens: state.cacheReadTokens,
            },
          }));
        }

        res.write(formatSSEEvent('message_stop', { type: 'message_stop' }));
        hasSentMessageStop = true;
      }

      log.info({ contentIndex: state.contentIndex }, 'Streaming response completed');
    } catch (streamError) {
      // On stream error (timeout, disconnect, abort), close any open content block
      // and send terminal events so the SDK doesn't hang waiting for message_stop.
      const errMsg = streamError instanceof Error ? streamError.message : 'Stream error';
      log.warn({ err: streamError, model: modelName }, 'Streaming interrupted');
      lifecycle.recordStreamTimeoutIfNeeded();
      lifecycle.abort();

      if (state.hasSentMessageStart) {
        if (state.currentBlockType !== null) {
          res.write(formatSSEEvent('content_block_stop', { type: 'content_block_stop', index: state.contentIndex }));
        }
        res.write(formatSSEEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 0, cache_read_input_tokens: 0 },
        }));
        res.write(formatSSEEvent('message_stop', { type: 'message_stop' }));
      }
      // Re-throw so the outer catch in handleMessagesRequest triggers error callback
      throw new Error(`Streaming failed for ${modelName}: ${errMsg}`);
    } finally {
      reader.releaseLock();
      res.end();
    }
  }

  // ── Codex OAuth routing ───────────────────────────────────────

  /**
   * Emit the defence-in-depth remap diagnostics for the route-resolved → Codex
   * egress path (F1). Mirrors the diagnostics the `x-codex-turn` branch emits
   * from `classification.egress.diagnostic`, so a `claude-`-leak or a
   * Codex-unsupported model that slips through the upstream routing guards onto
   * the route-resolved path still fires the same Sentry signal. The classifier
   * returns these as data (it is logger/electron-free); this is the single
   * place the route-resolved path turns them into log + captureException.
   */
  private reportCodexEgressRemap(
    egress: CodexEgressModelResolution,
    rawModel: string,
    turnId?: string,
  ): void {
    const diag = egress.diagnostic;
    if (!diag) return;
    if (diag.reason === 'claude-leak') {
      log.warn(
        { requestedModel: rawModel, remappedModel: diag.remappedModel, turnId },
        'Claude model received on route-resolved Codex egress — remapping to Codex model (routing bug — should have been caught by providerRouting)',
      );
      // Self-healing routing backstop demoted to warning via the registry
      // (260612 sentry-telemetry-tidy; REBEL-540/67V): the egress already
      // self-heals via remap. `route` keeps the historical fingerprint split.
      captureKnownCondition(
        'codex_proxy_claude_leak',
        { route: 'route-resolved', extra: { requestedModel: rawModel, remappedModel: diag.remappedModel, turnId } },
        new Error('Claude model leaked to Codex proxy (route-resolved) — routing bug'),
      );
    } else if (diag.reason === 'codex-unsupported') {
      const diagnosticContext = {
        requestedModel: diag.requestedModel,
        rawModel,
        remappedModel: diag.remappedModel,
        turnId,
        workingProfileId: diag.workingProfileId,
        workingProfileModel: diag.workingProfileModel,
        workingProfileProvider: diag.workingProfileProvider,
      };
      log.warn(
        diagnosticContext,
        'Codex-unsupported model received on route-resolved Codex egress — remapping (routing bug — should have been caught by providerRouting)',
      );
      captureKnownCondition(
        'codex_proxy_unsupported_model',
        { route: 'route-resolved', extra: diagnosticContext },
        new Error('Codex-unsupported model leaked to Codex proxy (route-resolved) — routing bug'),
      );
    }
  }

  /**
   * Forward a non-streaming request through the Codex Responses API.
   * Translates Chat Completions → Responses, calls the Codex endpoint,
   * and translates the response back to Chat Completions format.
   */
  private async forwardToCodexModel(
    openaiRequest: CodexEgressRequest,
    profile: ModelProfile,
    turnId?: string
  ): Promise<OpenAIResponse> {
    if (this.isCircuitBreakerTripped(turnId)) {
      throw this.createCircuitBreakerError();
    }

    const codexRequest = translateChatToResponses({
      ...openaiRequest,
      // INVARIANT: Codex Responses API rejects stream:false with HTTP 400
      // "Stream must be set to true". The proxy forces stream:true upstream
      // and buffers the SSE response.completed event via
      // readResponsesSseToCompletion(), returning JSON to non-streaming
      // callers. Do NOT change this to false.
      // See docs/plans/260504_codex_passthrough_streaming_fix.md.
      stream: true,
    } satisfies ChatCompletionRequest);

    const codexAuthProvider = getCodexAuthProvider();
    const accessToken = await codexAuthProvider.getAccessToken();
    if (!accessToken) {
      throw new Error('Codex OAuth: no valid access token — re-login may be needed');
    }
    const accountId = codexAuthProvider.getAccountId();

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    injectUpstreamAuth(headers, { kind: 'codex-oauth', accessToken, accountId });

    log.info({ model: openaiRequest.model }, 'Forwarding non-streaming request to Codex (upstream stream:true + buffered)');

    const { firstByteMs, streamChunkMs } = getUpstreamTimeouts(profile.reasoningEffort);
    let response: globalThis.Response;
    try {
      response = await this.fetchCodexFirstWithNetworkRetry(
        () => fetch(CODEX_ENDPOINT_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(codexRequest),
          signal: AbortSignal.timeout(firstByteMs),
        }),
        turnId,
        'non-streaming',
      );

      // 401 retry: force-refresh token and retry once
      if (response.status === 401) {
        log.warn('Codex returned 401 on non-streaming request, attempting token refresh');
        const refreshedToken = await codexAuthProvider.forceRefreshToken();
        if (!refreshedToken) {
          throw new Error('Codex OAuth: token refresh failed — re-login needed');
        }
        injectUpstreamAuth(headers, { kind: 'codex-oauth', accessToken: refreshedToken, accountId });
        response = await fetch(CODEX_ENDPOINT_URL, {
          method: 'POST',
          headers,
          body: JSON.stringify(codexRequest),
          signal: AbortSignal.timeout(firstByteMs),
        });
      }
    } catch (error) {
      if (this.isTimeoutError(error)) {
        this.recordTimeout(turnId);
      }
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new CodexUpstreamError(response.status, errorText);
    }

    if (response.status === 200) {
      this.resetTimeoutCount(turnId);
    }

    if (!response.body) {
      throw new CodexUpstreamError(502, 'Codex returned no response body');
    }

    let reasoningContent = '';
    const responsesBody = await readResponsesSseToCompletion(response.body, {
      streamChunkTimeoutMs: streamChunkMs,
      throwUpstreamError: (status, body) => new CodexUpstreamError(status, body),
      onDiagnostic: (d) => log.info(
        { ...d, model: openaiRequest.model },
        'Codex non-streaming SSE buffered',
      ),
      onReasoningSummary: (text) => { reasoningContent = text; },
    });
    const translated = translateResponsesToChatCompletion(
      responsesBody,
      reasoningContent ? { reasoningContent } : undefined,
    ) as unknown as OpenAIResponse;
    // Guard against empty model from schema catch defaults — preserve request model for attribution
    if (!translated.model) translated.model = openaiRequest.model;
    return translated;
  }

  /**
   * Handle a streaming request through the Codex Responses API.
   *
   * Flow: Anthropic request → OpenAI format → Codex Responses format →
   * Codex SSE events → Chat Completions chunks → Anthropic SSE events → client.
   */
  private async handleCodexStreamingRequest(
    anthropicRequest: AnthropicRequest,
    res: http.ServerResponse,
    profile: ModelProfile,
    egressModel: CodexEgressModel,
    turnId?: string
  ): Promise<void> {
    if (this.isCircuitBreakerTripped(turnId)) {
      throw this.createCircuitBreakerError();
    }

    // F1 core fix (Stage 12): the egress model is the brand-typed
    // CodexEgressModel proven non-claude + Codex-supported by
    // remapToCodexEgressModel. We do NOT read `profile.model ||
    // anthropicRequest.model` here — that raw path is exactly how a `claude-`
    // name reached the Codex upstream (REBEL-540). The branded parameter makes
    // an un-remapped name a compile error at this construction site.
    const modelName: CodexEgressModel = egressModel;
    // REBEL-5N8 / STAGE0: replay keys on the branded concrete egress model (proven non-claude +
    // Codex-supported), never the inbound alias. Proxy keeps its own independent recompute. Pinned
    // by scripts/check-capability-resolution-dispatch-seam.ts.
    const supportsReasoningReplay = computeSupportsReasoningReplay(profile, modelName);
    const messages = translateMessagesToOpenAI(
      anthropicRequest.messages,
      anthropicRequest.system,
      modelName,
      supportsReasoningReplay,
    );
    this.injectThoughtSignatures(messages, modelName, turnId);

    const openaiRequest: OpenAIRequest = {
      model: modelName,
      messages,
      max_completion_tokens: anthropicRequest.max_tokens ?? 4096,
      tools: translateToolsToOpenAI(anthropicRequest.tools),
      tool_choice: translateToolChoiceToOpenAI(anthropicRequest.tool_choice),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (anthropicRequest.temperature !== undefined) {
      openaiRequest.temperature = anthropicRequest.temperature;
    }
    applyAnthropicOutputFormat(openaiRequest, anthropicRequest.output_format);

    const reasoningEffort = resolveProfileReasoningEffort(profile);
    if (reasoningEffort) {
      openaiRequest.reasoning_effort = reasoningEffort;
    }

    // Translate to Codex Responses API format
    const codexRequest = translateChatToResponses(openaiRequest satisfies ChatCompletionRequest);
    log.info(
      {
        model: modelName,
        inboundOutputFormat: !!anthropicRequest.output_format,
        outboundResponseFormat: !!openaiRequest.response_format,
        upstreamTextFormat: codexRequest.text.format.type,
      },
      '[CODEX-DIAG] Codex streaming request prepared',
    );

    // Get credentials
    const codexAuthProvider = getCodexAuthProvider();
    const accessToken = await codexAuthProvider.getAccessToken();
    if (!accessToken) {
      throw new Error('Codex OAuth: no valid access token — re-login may be needed');
    }
    const accountId = codexAuthProvider.getAccountId();

    const codexHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    injectUpstreamAuth(codexHeaders, { kind: 'codex-oauth', accessToken, accountId });

    this.recordProxyRequest(modelName, turnId);
    const timeouts = getUpstreamTimeouts(profile.reasoningEffort);
    log.info({ model: modelName, firstByteMs: timeouts.firstByteMs }, 'Starting Codex streaming request');

    // Shared liveness contract (Stage 14) — per-branch constants + Codex-specific
    // log wording injected. The Codex branch derives timeouts WITHOUT the local
    // doubling, so injecting (not recomputing) keeps its values isolated.
    const lifecycle = new StreamLifecycle({
      timeouts,
      finishDeadlineMs: LATE_REASONING_FINISH_DEADLINE_MS,
      recordTimeout: () => this.recordTimeout(turnId),
      resetTimeoutCount: () => this.resetTimeoutCount(turnId),
      log: {
        firstByteTimeout: () => log.warn({ model: modelName, timeoutMs: timeouts.firstByteMs }, 'Codex first-byte timeout — aborting'),
        firstChunkTimeout: () => log.warn({ model: modelName, timeoutMs: timeouts.firstChunkMs, reasoningEffort: profile.reasoningEffort }, 'Codex first-chunk timeout — no data after headers'),
      },
    });

    let codexResponse = await this.fetchCodexFirstWithNetworkRetry(
      () => lifecycle.fetchFirstByte((signal) =>
        fetch(CODEX_ENDPOINT_URL, {
          method: 'POST',
          headers: codexHeaders,
          body: JSON.stringify(codexRequest),
          signal,
        }),
      ),
      turnId,
      'streaming',
    );

    // 401 retry: force-refresh token and retry once
    if (codexResponse.status === 401) {
      log.warn('Codex returned 401 on streaming request, attempting token refresh');
      const refreshedToken = await codexAuthProvider.forceRefreshToken();
      if (!refreshedToken) {
        throw new Error('Codex OAuth: token refresh failed — re-login needed');
      }
      injectUpstreamAuth(codexHeaders, { kind: 'codex-oauth', accessToken: refreshedToken, accountId });
      try {
        codexResponse = await fetch(CODEX_ENDPOINT_URL, {
          method: 'POST',
          headers: codexHeaders,
          body: JSON.stringify(codexRequest),
          signal: AbortSignal.timeout(timeouts.firstByteMs),
        });
      } catch (error) {
        if (this.isTimeoutError(error)) {
          this.recordTimeout(turnId);
        }
        throw error;
      }
    }

    if (!codexResponse.ok) {
      const errorText = await codexResponse.text();
      throw new CodexUpstreamError(codexResponse.status, errorText);
    }

    lifecycle.noteResponseSettled(codexResponse.status);

    if (!codexResponse.body) {
      throw new Error('No response body from Codex');
    }

    // Set SSE headers for Anthropic-format response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // RuntimeActivityEvent producer placement: this proxy emits canonical
    // Anthropic SSE that the Anthropic SDK adapter (anthropicClient.ts) classifies
    // into typed RuntimeActivityEvent values. Adding a producer here would
    // double-count. See docs/plans/260503_s7_runtime_activity_event_migration_completion.md
    // Phase 2 synthesis finding 1.
    const streamTranslator = createStreamTranslator();
    const state = createStreamState();
    state.model = modelName;

    const sigStore = this.thoughtSignatures;
    const sigTs = this.sigTimestamps;
    const boundRecordUsage = (model: string, inputTokens: number, outputTokens: number) => {
      this.recordProxyUsage(model, inputTokens, outputTokens, turnId);
    };

    const reader = codexResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let hasSentMessageStop = false;
    let doneSentinelSeen = false;
    try {
      while (true) {
        const readResult = await lifecycle.readNextChunk(reader, state.finishReasonSeen, 'Codex stream');
        if (readResult.kind === 'finish-deadline') {
          state.lateReasoningCapHit = state.lateReasoningCapHit ?? 'time';
          await reader.cancel('late-reasoning-finish-timeout');
          break;
        }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from Codex response (events separated by double newline)
        const eventBlocks = buffer.split(/\r?\n\r?\n/);
        buffer = eventBlocks.pop() ?? '';

        for (const eventBlock of eventBlocks) {
          if (!eventBlock.trim()) continue;

          const parsedEvent = parseSseEventBlock(eventBlock);
          if (!parsedEvent?.event) continue;

          let eventData: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(parsedEvent.data);
            if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              log.warn({ eventType: parsedEvent.event }, 'Skipping non-object Codex SSE event payload');
              continue;
            }
            eventData = parsed as Record<string, unknown>;
          } catch {
            log.warn({ eventType: parsedEvent.event }, 'Failed to parse Codex SSE event data');
            continue;
          }

          // Mark upstream activity — reasoning events prevent false watchdog stalls
          if (turnId) {
            agentTurnRegistry.markUpstreamActivity(turnId);
          }

          // Translate Codex Responses event → Chat Completions chunk string(s)
          const translated = streamTranslator.translateEvent(parsedEvent.event, eventData);
          if (!translated) continue;

          // Parse translated chunks and feed through the Anthropic translator
          const lines = translated.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              doneSentinelSeen = true;
              break;
            }

            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;

              // Handle error objects from translator (response.failed / error events)
              if ('error' in parsed && !('choices' in parsed)) {
                const errObj = parsed.error as { message?: string };
                log.warn({ error: errObj, model: modelName }, 'Codex stream upstream error event');
                throw new Error(errObj?.message || 'Codex streaming error');
              }

              const chunk = parsed as unknown as OpenAIStreamChunk;
              for (const event of processStreamChunk(chunk, state, modelName, sigStore, boundRecordUsage, turnId, sigTs)) {
                res.write(event);
              }
              if (state.lateReasoningCapHit) {
                break;
              }
            } catch (err) {
              if (err instanceof SyntaxError) {
                continue;
              }
              throw err;
            }
          }
          if (doneSentinelSeen || state.lateReasoningCapHit) {
            break;
          }
        }
        if (doneSentinelSeen || state.lateReasoningCapHit) {
          break;
        }
      }

      if (!hasSentMessageStop && state.hasSentMessageStart) {
        for (const lateReasoningEvent of flushLateReasoningBuffer(state)) {
          res.write(lateReasoningEvent);
        }
        if (state.currentBlockType !== null) {
          res.write(formatSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: state.contentIndex,
          }));
          state.currentBlockType = null;
        }
        if (state.inputTokens > 0 || state.outputTokens > 0) {
          res.write(formatSSEEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: null, stop_sequence: null },
            usage: {
              input_tokens: state.inputTokens,
              output_tokens: state.outputTokens,
              cache_read_input_tokens: state.cacheReadTokens,
            },
          }));
        }
        res.write(formatSSEEvent('message_stop', { type: 'message_stop' }));
        hasSentMessageStop = true;
      }

      log.info({ contentIndex: state.contentIndex }, 'Codex streaming response completed');
    } catch (streamError) {
      const errMsg = streamError instanceof Error ? streamError.message : 'Stream error';
      log.warn({ err: streamError, model: modelName }, 'Codex streaming interrupted');
      lifecycle.recordStreamTimeoutIfNeeded();

      // Close any open Anthropic content blocks so the SDK doesn't hang
      if (!state.hasSentMessageStart && !res.writableEnded) {
        res.write(formatSSEEvent('error', {
          type: 'error',
          error: { type: 'stream_error', message: errMsg },
        }));
      } else if (state.hasSentMessageStart) {
        if (state.currentBlockType !== null) {
          res.write(formatSSEEvent('content_block_stop', { type: 'content_block_stop', index: state.contentIndex }));
          state.currentBlockType = null;
        }
        res.write(formatSSEEvent('error', {
          type: 'error',
          error: { type: 'stream_error', message: errMsg },
        }));
      }
      throw new Error(`Codex streaming failed for ${modelName}: ${errMsg}`);
    } finally {
      reader.releaseLock();
      res.end();
    }
  }

  // ── Responses API routing (reasoning_effort + tools) ──────────

  /**
   * Detect whether a request needs to be routed through the OpenAI Responses API
   * instead of Chat Completions. This is required when:
   * - The provider is OpenAI (providerType === 'openai')
   * - The request has reasoning_effort set
   * - The request has tools
   * - The profile has an API key (not relying on Codex OAuth)
   *
   * OpenAI's Chat Completions endpoint rejects reasoning_effort + tools for
   * newer models (GPT-5.5+). The Responses API supports this combination
   * for all models. See FOX-2821.
   *
   * When no API key is present and Codex OAuth is connected, we skip this path
   * and let the existing Codex OAuth handlers route through the Codex Responses
   * endpoint (which already uses the Responses API format).
   */
  private needsResponsesApiRoute(profile: ModelProfile, hasTools: boolean, codexEnabled: boolean = false): boolean {
    // Gate on the SUPPRESSION-aware effort: a thinking-incompatible profile
    // (`thinkingCompatibility === 'incompatible'`) emits no reasoning_effort, so
    // it must not take the reasoning+tools Responses route either — otherwise the
    // route decision and the wire body disagree. See CUSTOM_GATEWAY_COMPATIBILITY.md.
    if (profile.providerType !== 'openai' || !resolveProfileReasoningEffort(profile) || !hasTools) return false;
    // Skip when Codex OAuth would handle the request — it already uses the Responses API
    if (codexEnabled && isCodexSubscriptionProfile(profile)) return false;
    return true;
  }

  private async forwardViaResponsesApi(
    openaiRequest: OpenAIRequest,
    profile: ModelProfile,
    turnId?: string
  ): Promise<OpenAIResponse> {
    if (this.isCircuitBreakerTripped(turnId)) {
      throw this.createCircuitBreakerError();
    }

    const effectiveKey = this.resolveProfileBearerToken(profile, false);

    const responsesRequest = translateChatToResponses(openaiRequest satisfies ChatCompletionRequest);

    const url = buildResponsesUrl(profile.serverUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    injectUpstreamAuth(headers, { kind: 'profile-bearer', bearerToken: effectiveKey });

    const { firstByteMs } = getUpstreamTimeouts(profile.reasoningEffort);

    log.info({ url, model: openaiRequest.model, reasoningEffort: profile.reasoningEffort }, 'Routing via Responses API (reasoning_effort + tools)');

    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(responsesRequest),
        signal: AbortSignal.timeout(firstByteMs),
      });
    } catch (error) {
      if (this.isTimeoutError(error)) {
        this.recordTimeout(turnId);
      }
      throw error;
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Responses API error (${response.status}): ${errorText}`);
    }

    if (response.status === 200) {
      this.resetTimeoutCount(turnId);
    }

    const responsesBody = (await response.json()) as ResponsesApiResponse;
    const reasoningContent = extractReasoningFromResponsesJson(responsesBody);
    return translateResponsesToChatCompletion(
      responsesBody,
      reasoningContent ? { reasoningContent } : undefined,
    ) as unknown as OpenAIResponse;
  }

  private async handleStreamingViaResponsesApi(
    anthropicRequest: AnthropicRequest,
    res: http.ServerResponse,
    profile: ModelProfile,
    turnId?: string
  ): Promise<void> {
    if (this.isCircuitBreakerTripped(turnId)) {
      throw this.createCircuitBreakerError();
    }

    const effectiveKey = this.resolveProfileBearerToken(profile, false);

    const modelName = profile.model || anthropicRequest.model;
    // REBEL-5N8 / STAGE0: replay keys on the RESOLVED profile's concrete model, never the bare
    // inbound alias. Proxy keeps its own independent recompute. Pinned by
    // scripts/check-capability-resolution-dispatch-seam.ts.
    const supportsReasoningReplay = computeSupportsReasoningReplay(profile, modelName);
    const messages = translateMessagesToOpenAI(
      anthropicRequest.messages,
      anthropicRequest.system,
      modelName,
      supportsReasoningReplay,
    );
    this.injectThoughtSignatures(messages, modelName, turnId);

    const openaiRequest: OpenAIRequest = {
      model: modelName,
      messages,
      max_completion_tokens: anthropicRequest.max_tokens ?? 4096,
      tools: translateToolsToOpenAI(anthropicRequest.tools),
      tool_choice: translateToolChoiceToOpenAI(anthropicRequest.tool_choice),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (anthropicRequest.temperature !== undefined) {
      openaiRequest.temperature = anthropicRequest.temperature;
    }
    applyAnthropicOutputFormat(openaiRequest, anthropicRequest.output_format);

    const reasoningEffort = resolveProfileReasoningEffort(profile);
    if (reasoningEffort) {
      openaiRequest.reasoning_effort = reasoningEffort;
    }

    // Translate to Responses API format
    const responsesRequest = translateChatToResponses(openaiRequest satisfies ChatCompletionRequest);

    const url = buildResponsesUrl(profile.serverUrl);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    injectUpstreamAuth(headers, { kind: 'profile-bearer', bearerToken: effectiveKey });

    this.recordProxyRequest(modelName, turnId);
    const timeouts = getUpstreamTimeouts(profile.reasoningEffort);
    log.info(
      {
        url,
        model: modelName,
        reasoningEffort: profile.reasoningEffort,
        firstByteMs: timeouts.firstByteMs,
        inboundOutputFormat: !!anthropicRequest.output_format,
        outboundResponseFormat: !!openaiRequest.response_format,
      },
      'Starting Responses API streaming request (reasoning_effort + tools)',
    );

    // Shared liveness contract (Stage 14) — per-branch constants + Responses-API
    // log wording injected.
    const lifecycle = new StreamLifecycle({
      timeouts,
      finishDeadlineMs: LATE_REASONING_FINISH_DEADLINE_MS,
      recordTimeout: () => this.recordTimeout(turnId),
      resetTimeoutCount: () => this.resetTimeoutCount(turnId),
      log: {
        firstByteTimeout: () => log.warn({ model: modelName, timeoutMs: timeouts.firstByteMs }, 'Responses API first-byte timeout — aborting'),
        firstChunkTimeout: () => log.warn({ model: modelName, timeoutMs: timeouts.firstChunkMs, reasoningEffort: profile.reasoningEffort }, 'Responses API first-chunk timeout — no data after headers'),
      },
    });

    const responsesResponse = await lifecycle.fetchFirstByte((signal) =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(responsesRequest),
        signal,
      }),
    );

    if (!responsesResponse.ok) {
      const errorText = await responsesResponse.text();
      throw new Error(`Responses API error (${responsesResponse.status}): ${errorText}`);
    }

    lifecycle.noteResponseSettled(responsesResponse.status);

    if (!responsesResponse.body) {
      throw new Error('No response body from Responses API');
    }

    // Set SSE headers for Anthropic-format response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const streamTranslator = createStreamTranslator();
    const state = createStreamState();
    state.model = modelName;

    const sigStore = this.thoughtSignatures;
    const sigTs = this.sigTimestamps;
    const boundRecordUsage = (model: string, inputTokens: number, outputTokens: number) => {
      this.recordProxyUsage(model, inputTokens, outputTokens, turnId);
    };

    const reader = responsesResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    let hasSentMessageStop = false;
    let doneSentinelSeen = false;
    try {
      while (true) {
        const readResult = await lifecycle.readNextChunk(reader, state.finishReasonSeen, 'Responses API stream');
        if (readResult.kind === 'finish-deadline') {
          state.lateReasoningCapHit = state.lateReasoningCapHit ?? 'time';
          await reader.cancel('late-reasoning-finish-timeout');
          break;
        }
        const { done, value } = readResult;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from Responses API (events separated by double newline)
        const eventBlocks = buffer.split(/\r?\n\r?\n/);
        buffer = eventBlocks.pop() ?? '';

        for (const eventBlock of eventBlocks) {
          if (!eventBlock.trim()) continue;

          const parsedEvent = parseSseEventBlock(eventBlock);
          if (!parsedEvent?.event) continue;

          let eventData: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(parsedEvent.data);
            if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              log.warn({ eventType: parsedEvent.event }, 'Skipping non-object Responses API SSE event payload');
              continue;
            }
            eventData = parsed as Record<string, unknown>;
          } catch {
            log.warn({ eventType: parsedEvent.event }, 'Failed to parse Responses API SSE event data');
            continue;
          }

          // Mark upstream activity — reasoning events prevent false watchdog stalls
          if (turnId) {
            agentTurnRegistry.markUpstreamActivity(turnId);
          }

          const translated = streamTranslator.translateEvent(parsedEvent.event, eventData);
          if (!translated) continue;

          const lines = translated.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              doneSentinelSeen = true;
              break;
            }

            try {
              const parsed = JSON.parse(data) as Record<string, unknown>;

              if ('error' in parsed && !('choices' in parsed)) {
                const errObj = parsed.error as { message?: string };
                log.warn({ error: errObj, model: modelName }, 'Responses API stream upstream error event');
                throw new Error(errObj?.message || 'Responses API streaming error');
              }

              const chunk = parsed as unknown as OpenAIStreamChunk;
              for (const event of processStreamChunk(chunk, state, modelName, sigStore, boundRecordUsage, turnId, sigTs)) {
                res.write(event);
              }
              if (state.lateReasoningCapHit) {
                break;
              }
            } catch (err) {
              if (err instanceof SyntaxError) {
                continue;
              }
              throw err;
            }
          }
          if (doneSentinelSeen || state.lateReasoningCapHit) {
            break;
          }
        }
        if (doneSentinelSeen || state.lateReasoningCapHit) {
          break;
        }
      }

      if (!hasSentMessageStop && state.hasSentMessageStart) {
        for (const lateReasoningEvent of flushLateReasoningBuffer(state)) {
          res.write(lateReasoningEvent);
        }
        if (state.currentBlockType !== null) {
          res.write(formatSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: state.contentIndex,
          }));
          state.currentBlockType = null;
        }
        if (state.inputTokens > 0 || state.outputTokens > 0) {
          res.write(formatSSEEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: null, stop_sequence: null },
            usage: {
              input_tokens: state.inputTokens,
              output_tokens: state.outputTokens,
              cache_read_input_tokens: state.cacheReadTokens,
            },
          }));
        }
        res.write(formatSSEEvent('message_stop', { type: 'message_stop' }));
        hasSentMessageStop = true;
      }

      log.info({ contentIndex: state.contentIndex }, 'Responses API streaming response completed');
    } catch (streamError) {
      const errMsg = streamError instanceof Error ? streamError.message : 'Stream error';
      log.warn({ err: streamError, model: modelName }, 'Responses API streaming interrupted');
      lifecycle.recordStreamTimeoutIfNeeded();

      if (!state.hasSentMessageStart && !res.writableEnded) {
        res.write(formatSSEEvent('error', {
          type: 'error',
          error: { type: 'stream_error', message: errMsg },
        }));
      } else if (state.hasSentMessageStart) {
        if (state.currentBlockType !== null) {
          res.write(formatSSEEvent('content_block_stop', { type: 'content_block_stop', index: state.contentIndex }));
          state.currentBlockType = null;
        }
        res.write(formatSSEEvent('error', {
          type: 'error',
          error: { type: 'stream_error', message: errMsg },
        }));
      }
      throw new Error(`Responses API streaming failed for ${modelName}: ${errMsg}`);
    } finally {
      reader.releaseLock();
      res.end();
    }
  }

  // ── Ollama-specific helpers ─────────────────────────────────────

  /**
   * Ensure Ollama is running before forwarding a request.
   * Uses a cached "known good" flag to avoid health-checking every request.
   * Resets the flag on any forwarding error (see error handler in handleMessagesRequest).
   */
  private async ensureOllamaHealthy(profile: ModelProfile): Promise<void> {
    if (profile.providerType !== 'local') return;
    if (this.ollamaKnownGood) return;

    try {
      const { ollamaService } = await import('./ollamaService');
      const running = await ollamaService.isRunning();
      if (!running) {
        log.warn('Ollama not running before request — attempting recovery start');
        const { resolveStrategy, CONSERVATIVE_STRATEGY } = await import('@core/services/localInference/inferenceStrategy');
        const { getCatalogEntryByTag } = await import('@core/services/localInference/modelCatalog');
        const catalogEntry = profile.model ? getCatalogEntryByTag(profile.model) : undefined;
        let strategy = CONSERVATIVE_STRATEGY;
        if (catalogEntry) {
          const totalMemoryGB = getPlatformConfig().totalMemoryBytes / (1024 * 1024 * 1024);
          const desiredContext = profile.contextWindow ?? catalogEntry.contextWindowDefault;
          ({ strategy } = resolveStrategy(totalMemoryGB, catalogEntry, desiredContext));
        }
        await ollamaService.ensureRunning(strategy);
      }
      this.ollamaKnownGood = true;
    } catch (err) {
      this.ollamaKnownGood = false;
      throw new Error(`Ollama is not available: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Inject Ollama-specific options (num_ctx) into the request body for local profiles.
   * Non-local profiles are unaffected (options field is ignored by other providers).
   */
  private injectOllamaOptions(openaiRequest: OpenAIRequest, profile: ModelProfile): void {
    if (profile.providerType !== 'local' || !profile.contextWindow) return;
    openaiRequest.options = { num_ctx: profile.contextWindow };
  }

  private resolveProfileBearerToken(profile: ModelProfile, codexEnabled: boolean): string | undefined {
    const settings = getSettings();
    const credentials = resolveConnectionCredentials(profile, settings, codexEnabled ? true : undefined);
    return credentials.apiKey ?? credentials.oauthToken;
  }

  private handleMessagesRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _fallbackProfile: ModelProfile
  ): void {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      fireAndForget((async () => {
      // Extract turn ID from custom header (set by turn executor for council requests).
      // Fall back to '__legacy__' if that turn exists (backward-compat wrapper).
      let turnId = this.getSingleHeaderValue(req.headers['x-routed-turn-id']);
      if (!turnId && this.turnRoutes.has('__legacy__')) {
        turnId = '__legacy__';
      }

      this.warnOnUnknownRoutedHeaders(req.headers, req.url ?? null, turnId ?? null);

      // Stage 12: typed request classification. classifyRequest decides the
      // consumer/transport/dialect/auth/stream/structured-output axes up front
      // so the upstream-execution branches below consume a typed object instead
      // of re-deriving each axis inline. The KEY structural win is the Codex
      // model-dialect axis: classification.egress.model is a brand-typed
      // CodexEgressModel, so a `claude-`-dialect name can never reach the Codex
      // upstream-request construction (REBEL-540 / PM 260429 / PM 260504).
      //
      // Routing DECISIONS are unchanged: classifyRequest performs only the
      // transport-header dispatch the handler already did inline, plus the two
      // defence-in-depth Codex remaps (claude-leak + REBEL-520) it already did
      // inline. Provider/route selection still happens in resolveRouteProfile
      // (and @core/rebelCore/providerRouting.ts upstream).
      let preParsedRequest: AnthropicRequest | undefined;
      try {
        preParsedRequest = JSON.parse(body) as AnthropicRequest;
      } catch {
        // Body is not valid JSON. Preserve legacy per-branch behaviour: the
        // OpenRouter branch and the main route-resolution branch each have
        // their own try/catch that handle a parse failure; we fall back to a
        // route-resolved classification so control reaches them unchanged.
        preParsedRequest = undefined;
      }
      const classification: RequestClassification = classifyRequest({
        headers: req.headers,
        request: preParsedRequest ?? {},
        turnId,
      });

      // WS1b-2 proxy integrity gate (OBSERVABILITY-ONLY — never rejects). Runs
      // HERE — after classification, BEFORE the consumer-class switch — so the
      // model-mismatch telemetry compares the INBOUND body model (NOT the codex
      // post-remap CodexEgressModel the switch fabricates at line ~3908, which
      // would false-positive every codex request). See `applyRouteTagGate`.
      this.applyRouteTagGate(req, preParsedRequest?.model ?? null, turnId ?? null);

      // WS4b: verify + decode the executor's signed route-facts carrier ONCE, here,
      // so the OR-passthrough `isManagedMode` (billing) decision trusts the
      // executor's verdict instead of independently re-reading `activeProvider`.
      // `null` when absent/invalid → re-derive (behaviour-preserving until WS4c).
      // NOTE: `resolveRouteProfile` step-2 deliberately does NOT consume these facts
      // — its `transport` field is overloaded (Anthropic AND Google profiles), so
      // that benign model-syntax check stays re-derived. See `resolveRouteProfile`.
      const verifiedFacts = this.verifyInboundRouteFacts(req, turnId ?? null);

      // Stage 12 (F1/static exhaustiveness): dispatch on the typed
      // consumer-class discriminant with an exhaustive `switch`. The
      // `openrouter-turn` and `codex-turn` cases return; `route-resolved`
      // breaks out to the route-resolution code below. The `default:
      // assertNever(classification)` makes a NEW ConsumerClass variant added to
      // the union (e.g. a future `gemini-turn`) a COMPILE error here rather than
      // a silent fall-through to the route-resolved branch — the exact
      // omitted-axis failure mode this stage exists to eliminate.
      switch (classification.consumerClass) {
      // OpenRouter passthrough: detected via header set by agentTurnExecutor.
      // Must be checked before normal route resolution since OR requests use
      // Claude model names that would otherwise match Anthropic passthrough.
      case 'openrouter-turn': {
        try {
          const parsed = JSON.parse(body);
          const isStreaming = !!parsed.stream;
          // WS4b: genuine OR turn — the verified facts describe THIS OpenRouter
          // decision, so consume them to pick managed-vs-personal (facts.credentialSource).
          await this.handleOpenRouterPassthrough(req, res, body, isStreaming, turnId ?? undefined, verifiedFacts);
        } catch (err) {
          let passthroughModel = 'unknown';
          try { passthroughModel = JSON.parse(body).model ?? 'unknown'; } catch { /* use default */ }
          log.error({ err, model: passthroughModel }, 'OpenRouter passthrough failed');
          getErrorReporter().addBreadcrumb({
            category: 'openrouter-proxy',
            message: 'OR passthrough exception',
            level: 'error',
            data: { model: passthroughModel },
          });
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'api_error', message: 'OpenRouter passthrough failed' },
            }));
          }
        }
        return;
      }

      // Codex passthrough: detected via header set by buildCodexProxyEnv().
      // Routes through Codex Responses API with OAuth token injection.
      case 'codex-turn': {
        try {
          const anthropicRequest: AnthropicRequest = JSON.parse(body);
          const rawModelName = anthropicRequest.model || 'gpt-5.5';
          // Model-dialect axis (Stage 12): the egress model is brand-typed
          // CodexEgressModel, derived by classifyRequest →
          // remapToCodexEgressModel. That single helper performs BOTH
          // defence-in-depth remaps that used to live inline here:
          //   1. claude-* leak  → working-profile model or Codex default
          //      (PM 260429 / 260504 / REBEL-540 Claude-leak guard); and
          //   2. Codex-unsupported OpenAI model (e.g. gpt-5.5-pro) → supported
          //      working-profile model or Codex default (REBEL-520 mirror).
          // A `claude-`-dialect name therefore CANNOT reach the upstream-request
          // construction below: `modelName` is a CodexEgressModel, not a string.
          const modelName: CodexEgressModel = classification.egress.model;
          // Stage 13: CONSUME the auth + structured-output axes the classifier
          // pinned. `authPlan` here is the literal 'codex-oauth' (the union
          // narrows it on the codex-turn discriminant), and that is exactly the
          // CredentialPlan kind the downstream forwarders inject via
          // `injectUpstreamAuth` — so the auth axis is no longer advisory: it
          // names the single injector path this branch takes.
          const codexAuthPlan: 'codex-oauth' = classification.authPlan;
          // Structured-output axis: drives the diagnostics + asserts the
          // classifier's `structuredOutputContract` agrees with the parsed body
          // the translator branch will read (defence against a future divergence
          // between classify-time and execute-time parsing).
          const expectsStructuredOutput =
            classification.structuredOutputContract === 'anthropic-output-format';
          // Emit the same diagnostics the inline remap did. The classifier
          // returns these as data so it stays free of the logger / error
          // reporter (and any electron-adjacent imports).
          const remapDiag = classification.egress.diagnostic;
          if (remapDiag?.reason === 'claude-leak') {
            log.warn({ requestedModel: rawModelName, remappedModel: remapDiag.remappedModel }, 'Claude model received on Codex turn — remapping to Codex model (routing bug — should have been caught by executor)');
            captureKnownCondition(
              'codex_proxy_claude_leak',
              { route: 'codex-turn', extra: { requestedModel: rawModelName, remappedModel: remapDiag.remappedModel } },
              new Error('Claude model leaked to Codex proxy (codex-turn) — routing bug'),
            );
          } else if (remapDiag?.reason === 'codex-unsupported') {
            const diagnosticContext = {
              requestedModel: remapDiag.requestedModel,
              rawModelName,
              remappedModel: remapDiag.remappedModel,
              turnId,
              stream: anthropicRequest.stream,
              workingProfileId: remapDiag.workingProfileId,
              workingProfileModel: remapDiag.workingProfileModel,
              workingProfileProvider: remapDiag.workingProfileProvider,
            };
            log.warn(
              diagnosticContext,
              'Codex-unsupported model received on Codex turn — remapping (routing bug — should have been caught by providerRouting)',
            );
            captureKnownCondition(
              'codex_proxy_unsupported_model',
              { route: 'codex-turn', extra: diagnosticContext },
              new Error('Codex-unsupported model leaked to Codex proxy (codex-turn) — routing bug'),
            );
          }
          // Build a minimal profile for Codex routing
          const codexProfile: ModelProfile = {
            id: `codex-${modelName}`,
            name: modelName,
            model: modelName,
            providerType: 'openai',
            serverUrl: '',
            enabled: true,
            createdAt: Date.now(),
          };
          const settings = getSettings();
          const workingProfile = getWorkingModelProfile(settings);
          // Only inherit working-profile reasoning effort for main agent turns
          // (stream:true). Behind-the-scenes Codex passthrough calls
          // (stream:false: bug-report analysis, titles, summaries, time-saved,
          // memory updates) are bounded one-shot text-in/text-out and should
          // NOT inherit `high` reasoning — it bloats per-call latency
          // (firstByteMs:150000) and accelerates ChatGPT Team plan quota burn.
          // See REBEL-4GH / FOX-3152.
          const isBehindTheScenesPassthrough = anthropicRequest.stream === false;
          // Honour the suppression gate (REBEL-5RJ) at the inheritance seam: a working
          // profile marked `thinkingCompatibility:'incompatible'` must NOT propagate
          // reasoning_effort into the Codex request. (BTS passthrough is still excluded
          // for the quota/latency reasons above.) See docs/project/CUSTOM_GATEWAY_COMPATIBILITY.md.
          const inheritedReasoningEffort =
            workingProfile && !isBehindTheScenesPassthrough
              ? resolveProfileReasoningEffort(workingProfile)
              : undefined;
          if (inheritedReasoningEffort) {
            codexProfile.reasoningEffort = inheritedReasoningEffort;
          }
          log.info({
            model: modelName,
            rawModel: rawModelName,
            isStreaming: anthropicRequest.stream !== false,
            hasTools: !!anthropicRequest.tools?.length,
            messageCount: anthropicRequest.messages?.length,
            reasoningEffort: codexProfile.reasoningEffort,
            inheritedFromWorkingProfile: !!inheritedReasoningEffort,
          }, '[CODEX-DIAG] Codex passthrough entry');

          // Routing contract:
          //   - stream === false  → BTS callers want JSON. The proxy still sends
          //                         stream:true UPSTREAM to Codex, buffers the SSE
          //                         response.completed event via
          //                         readResponsesSseToCompletion(), and returns
          //                         Anthropic JSON to the caller. Do NOT send
          //                         stream:false to Codex; it returns 400 "Stream
          //                         must be set to true". See
          //                         docs/plans/260504_codex_passthrough_streaming_fix.md.
          //   - stream === true   → existing streaming path (main agent turns via SDK).
          //   - stream === undefined → preserve legacy force-streaming behavior.
          // See also docs/plans/260429_bts_sse_parsing_fix.md (which originally
          // re-introduced the stream:false branch and inadvertently regressed
          // the upstream invariant; this comment + 260504 plan correct that).
          if (anthropicRequest.stream === false) {
            // Use the brand-typed egress model directly — NOT
            // `codexProfile.model || rawModelName`, which would widen back to a
            // bare `string` and could re-introduce a raw `claude-` name via the
            // `|| rawModelName` fallback. `modelName` is the proven-safe
            // CodexEgressModel from remapToCodexEgressModel.
            const nsModelName: CodexEgressModel = modelName;
            // REBEL-5N8 / STAGE0: replay keys on the branded concrete egress model, never the
            // inbound alias. Proxy keeps its own independent recompute. Pinned by
            // scripts/check-capability-resolution-dispatch-seam.ts.
            const supportsReasoningReplay = computeSupportsReasoningReplay(codexProfile, nsModelName);
            const nsMessages = translateMessagesToOpenAI(
              anthropicRequest.messages,
              anthropicRequest.system,
              nsModelName,
              supportsReasoningReplay,
            );

            const openaiRequest: CodexEgressRequest = {
              model: nsModelName,
              messages: nsMessages,
              max_completion_tokens: anthropicRequest.max_tokens ?? 4096,
              tools: translateToolsToOpenAI(anthropicRequest.tools),
              tool_choice: translateToolChoiceToOpenAI(anthropicRequest.tool_choice),
              stream: false,
            };

            if (anthropicRequest.temperature !== undefined) {
              openaiRequest.temperature = anthropicRequest.temperature;
            }
            applyAnthropicOutputFormat(openaiRequest, anthropicRequest.output_format);

            if (codexProfile.reasoningEffort) {
              openaiRequest.reasoning_effort = codexProfile.reasoningEffort;
            }

            this.recordProxyRequest(nsModelName, turnId ?? undefined);
            const openaiResponse = await this.forwardToCodexModel(
              openaiRequest,
              codexProfile,
              turnId ?? undefined,
            );
            this.recordProxyUsage(
              nsModelName,
              openaiResponse.usage?.prompt_tokens ?? 0,
              openaiResponse.usage?.completion_tokens ?? 0,
              turnId ?? undefined,
            );
            const actualModel = openaiResponse.model || codexProfile.model || 'local-model';
            const anthropicResponse = translateResponseToAnthropic(openaiResponse, actualModel);

            log.info(
              {
                inputTokens: anthropicResponse.usage.input_tokens,
                outputTokens: anthropicResponse.usage.output_tokens,
                stopReason: anthropicResponse.stop_reason,
                authPlan: codexAuthPlan,
                expectsStructuredOutput,
                inboundOutputFormat: !!anthropicRequest.output_format,
                outboundResponseFormat: !!openaiRequest.response_format,
              },
              '[CODEX-DIAG] Codex non-streaming response sent',
            );

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(anthropicResponse));
          } else {
            // Streaming (explicit true OR legacy omitted) — preserve existing
            // forced-streaming behavior for main-agent turns.
            if (!anthropicRequest.stream) {
              anthropicRequest.stream = true;
            }
            await this.handleCodexStreamingRequest(anthropicRequest, res, codexProfile, modelName, turnId ?? undefined);
          }
        } catch (err) {
          log.error({
            err,
            errorMessage: err instanceof Error ? err.message : String(err),
            errorStack: err instanceof Error ? err.stack?.split('\n').slice(0, 5).join('\n') : undefined,
            upstreamStatus: err instanceof CodexUpstreamError ? err.upstreamStatus : undefined,
          }, '[CODEX-DIAG] Codex passthrough failed');
          if (!res.headersSent) {
            // Forward the original Codex HTTP status + quota signal via the shared
            // helper (single source of truth with the route-resolved catch below),
            // so the SDK classifies the error correctly (429 → rate_limit, not
            // 500 → server_error) and quota caps (`usage_limit_reached`) survive
            // for classifyHttpError. This prevents retry amplification against an
            // already-rate-limited API. REBEL-4GH / FOX-3152.
            const { status, body } = codexUpstreamErrorResponse(
              err,
              `Codex passthrough failed: ${err instanceof Error ? err.message : 'unknown error'}`,
            );
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
          }
        }
        return;
      }

      // Route-resolved: anthropic-passthrough / base-profile / route-table /
      // OR-fallback. Falls through to the route-resolution code below (the
      // other cases return). resolveRouteProfile owns the sub-axis selection.
      case 'route-resolved':
        break;

      // Exhaustiveness guard (F1/static): a new ConsumerClass variant added to
      // the union without a case here is a compile error, not a silent
      // route-resolved fall-through.
      default:
        assertNever(classification, 'handleMessagesRequest consumerClass');
      }

      let requestModel = '';
      // Track the resolved model name for error attribution (populated when route resolves).
      // In council mode, requestModel is an SDK alias like 'sonnet'; resolvedModelForErrors
      // captures the actual target model so error stats identify the right council member.
      let resolvedModelForErrors = '';
      try {
        const anthropicRequest: AnthropicRequest = JSON.parse(body);
        requestModel = anthropicRequest.model || '';

        // Stage 14: CONSUME the classifier's `streamContract` axis (closing the
        // last advisory axis from Stage 12). On the route-resolved path the
        // streaming dispatch is a truthy-test on `stream`, which is EXACTLY the
        // binary `streamContract` derives (`request.stream ? 'streaming' :
        // 'non-streaming'`) — so `wantsStreaming` is behaviour-identical to the
        // prior `if (anthropicRequest.stream)`. The assertion is defence against
        // a future divergence between classify-time and execute-time parsing
        // (mirrors the `expectsStructuredOutput` consistency check on the
        // codex-turn branch).
        const wantsStreaming = classification.streamContract === 'streaming';
        if (wantsStreaming !== !!anthropicRequest.stream) {
          log.warn(
            { classifyStreamContract: classification.streamContract, executeStream: anthropicRequest.stream, requestModel },
            'streamContract axis disagrees with execute-time parse — using execute-time value',
          );
        }

        // Route resolution: turn-scoped (header-required) → claude passthrough → base profile → legacy route table
        //
        // WS4b: route resolution does NOT consume the route-facts carrier — step-2's
        // Anthropic-passthrough check is a benign model-string classification, and
        // `facts.transport` cannot drive it (it's overloaded across Anthropic AND
        // Google profiles). The facts are consumed ONLY for the `isManagedMode`
        // billing decision in `handleOpenRouterPassthrough`. See `resolveRouteProfile`
        // step-2.
        const routeResolution = this.resolveRouteProfile(
          requestModel,
          turnId,
          req.headers['x-routed-model'],
          req.url,
        );
        if (routeResolution.kind === 'route-required') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'route_required',
            message: routeResolution.message,
          }));
          return;
        }
        const routeProfile = routeResolution.profile;

        // null = passthrough to Anthropic API (Claude models in multi-route mode)
        if (routeProfile === null) {
          // When this turn has OpenRouter fallback active, route Claude models through
          // OpenRouter instead of the Anthropic API. This handles the case where plan mode
          // creates ad-hoc routes while the user's active provider is OpenRouter.
          if (turnId && this.turnOpenRouterFallback.has(turnId)) {
            log.info({ model: requestModel, turnId }, 'Routing Claude model through OpenRouter (turn has OR fallback)');
            // WS4b: pass `null` facts — the runtime OR-fallback override decides, NOT
            // the carried facts (which describe the original Anthropic decision and do
            // not reflect this re-route). isManagedMode re-derives from activeProvider.
            await this.handleOpenRouterPassthrough(req, res, body, !!anthropicRequest.stream, turnId, null);
            return;
          }
          await this.handleAnthropicPassthrough(req, res, body, !!anthropicRequest.stream);
          return;
        }

        // undefined = model not found in route table
        if (routeProfile === undefined) {
          // When this turn has OpenRouter fallback, route unmatched models through
          // OpenRouter instead of returning a 400 error.
          if (turnId && this.turnOpenRouterFallback.has(turnId)) {
            log.info({ model: requestModel, turnId }, 'Routing unmatched model through OpenRouter (turn has OR fallback)');
            // WS4b: pass `null` facts — the runtime OR-fallback override decides, NOT
            // the carried facts (the override re-route is not reflected in the facts).
            await this.handleOpenRouterPassthrough(req, res, body, !!anthropicRequest.stream, turnId, null);
            return;
          }
          log.warn({ model: requestModel, turnId }, 'No route found for model in multi-route proxy');
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: `No route configured for model: ${requestModel}` },
          }));
          return;
        }

        const profile = routeProfile;
        resolvedModelForErrors = profile.model || requestModel;
        const codexEnabled = turnId ? this.turnCodexEnabled.has(turnId) : false;

        // Ensure Ollama is healthy before forwarding to local profiles.
        // Uses a cached flag — only checks on first request or after errors.
        await this.ensureOllamaHealthy(profile);

        log.info(
          {
            model: profile.model || requestModel,
            routedFrom: requestModel,
            turnId,
            messageCount: anthropicRequest.messages.length,
            hasTools: !!anthropicRequest.tools?.length,
            stream: anthropicRequest.stream,
          },
          'Proxying request to model endpoint'
        );

        // Route through Responses API when reasoning_effort + tools are both present.
        // OpenAI's Chat Completions endpoint rejects this combination for newer models (GPT-5.5+).
        // The Responses API supports it for all OpenAI models. See FOX-2821.
        if (this.needsResponsesApiRoute(profile, !!anthropicRequest.tools?.length, codexEnabled)) {
          if (wantsStreaming) {
            await this.handleStreamingViaResponsesApi(anthropicRequest, res, profile, turnId);
          } else {
            const nsModelName = profile.model || requestModel;
            // REBEL-5N8 / STAGE0: replay keys on the RESOLVED profile's concrete model, never the
            // bare inbound alias. Proxy keeps its own independent recompute. Pinned by
            // scripts/check-capability-resolution-dispatch-seam.ts.
            const supportsReasoningReplay = computeSupportsReasoningReplay(profile, nsModelName);
            const nsMessages = translateMessagesToOpenAI(
              anthropicRequest.messages,
              anthropicRequest.system,
              nsModelName,
              supportsReasoningReplay,
            );
            this.injectThoughtSignatures(nsMessages, nsModelName, turnId);

            const openaiRequest: OpenAIRequest = {
              model: nsModelName,
              messages: nsMessages,
              max_completion_tokens: anthropicRequest.max_tokens ?? 4096,
              tools: translateToolsToOpenAI(anthropicRequest.tools),
              tool_choice: translateToolChoiceToOpenAI(anthropicRequest.tool_choice),
              stream: false,
            };

            if (anthropicRequest.temperature !== undefined) {
              openaiRequest.temperature = anthropicRequest.temperature;
            }
            applyAnthropicOutputFormat(openaiRequest, anthropicRequest.output_format);

            const reasoningEffort = resolveProfileReasoningEffort(profile);
            if (reasoningEffort) {
              openaiRequest.reasoning_effort = reasoningEffort;
            }

            this.recordProxyRequest(nsModelName, turnId);
            const openaiResponse = await this.forwardViaResponsesApi(openaiRequest, profile, turnId);
            this.captureThoughtSignatures(openaiResponse, nsModelName, turnId);
            this.recordProxyUsage(nsModelName, openaiResponse.usage?.prompt_tokens ?? 0, openaiResponse.usage?.completion_tokens ?? 0, turnId);
            const actualModel = openaiResponse.model || profile.model || 'local-model';
            const anthropicResponse = translateResponseToAnthropic(openaiResponse, actualModel);

            log.info(
              {
                inputTokens: anthropicResponse.usage.input_tokens,
                outputTokens: anthropicResponse.usage.output_tokens,
                stopReason: anthropicResponse.stop_reason,
                inboundOutputFormat: !!anthropicRequest.output_format,
                outboundResponseFormat: !!openaiRequest.response_format,
              },
              'Responses API model response received'
            );

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(anthropicResponse));
          }
          return;
        }

        // Handle streaming requests (streamContract axis — Stage 14)
        if (wantsStreaming) {
          await this.handleStreamingRequest(anthropicRequest, res, profile, turnId, codexEnabled);
          return;
        }

        // Non-streaming request
        const nsModelName = profile.model || requestModel;
        // REBEL-5N8 / STAGE0: replay keys on the RESOLVED profile's concrete model, never the bare
        // inbound alias. Proxy keeps its own independent recompute. Pinned by
        // scripts/check-capability-resolution-dispatch-seam.ts.
        const supportsReasoningReplay = computeSupportsReasoningReplay(profile, nsModelName);
        const nsMessages = translateMessagesToOpenAI(
          anthropicRequest.messages,
          anthropicRequest.system,
          nsModelName,
          supportsReasoningReplay,
        );
        this.injectThoughtSignatures(nsMessages, nsModelName, turnId);

        const openaiRequest: OpenAIRequest = {
          model: nsModelName,
          messages: nsMessages,
          max_completion_tokens: anthropicRequest.max_tokens ?? 4096,
          tools: translateToolsToOpenAI(anthropicRequest.tools),
          tool_choice: translateToolChoiceToOpenAI(anthropicRequest.tool_choice),
          stream: false,
        };

        if (anthropicRequest.temperature !== undefined) {
          openaiRequest.temperature = anthropicRequest.temperature;
        }
        applyAnthropicOutputFormat(openaiRequest, anthropicRequest.output_format);

        const reasoningEffort = resolveProfileReasoningEffort(profile);
        if (reasoningEffort) {
          openaiRequest.reasoning_effort = reasoningEffort;
        }
        this.injectOllamaOptions(openaiRequest, profile);

        this.recordProxyRequest(nsModelName, turnId);
        const openaiResponse = await this.forwardToLocalModel(openaiRequest, profile, turnId, codexEnabled);
        this.captureThoughtSignatures(openaiResponse, nsModelName, turnId);
        this.recordProxyUsage(nsModelName, openaiResponse.usage?.prompt_tokens ?? 0, openaiResponse.usage?.completion_tokens ?? 0, turnId);
        const actualModel = openaiResponse.model || profile.model || 'local-model';
        const anthropicResponse = translateResponseToAnthropic(openaiResponse, actualModel);

        log.info(
          {
            inputTokens: anthropicResponse.usage.input_tokens,
            outputTokens: anthropicResponse.usage.output_tokens,
            stopReason: anthropicResponse.stop_reason,
            inboundOutputFormat: !!anthropicRequest.output_format,
            outboundResponseFormat: !!openaiRequest.response_format,
          },
          'Model response received'
        );

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(anthropicResponse));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Proxy error';
        // Codex upstream errors carry the real status on `upstreamStatus` (NOT
        // `statusCode`). Honour it via the shared helper so route-resolved Codex
        // 429 usage-limits surface as 429/rate_limit_error (matching the
        // x-codex-turn path) instead of collapsing to 500/api_error. The live
        // `addRoutes(...)` Codex traffic hits THIS catch. REBEL-4GH / FOX-3152.
        const codexErrorResponse = error instanceof CodexUpstreamError
          ? codexUpstreamErrorResponse(error, `Codex request failed: ${message}`)
          : undefined;
        const statusCode =
          codexErrorResponse?.status ??
          (typeof error === 'object' &&
          error !== null &&
          'statusCode' in error &&
          typeof (error as { statusCode?: unknown }).statusCode === 'number'
            ? (error as { statusCode: number }).statusCode
            : 500);
        // Reset Ollama health cache on any error so next request re-checks
        this.ollamaKnownGood = false;
        // Use resolvedModelForErrors (populated after route resolution) for accurate
        // council member attribution. Falls back to requestModel for pre-route failures.
        const errorAttribution = resolvedModelForErrors || requestModel || 'unknown';
        this.recordProxyError(errorAttribution, turnId);
        log.error({ err: error, errorAttribution, requestModel, turnId }, 'Proxy request failed');

        // Surface real-time error for council member failures (not passthrough/lead-agent)
        if (resolvedModelForErrors) {
          const sanitized = message.length > 120 ? message.slice(0, 120) + '...' : message;
          if (turnId) {
            this.turnErrorCallbacks.get(turnId)?.(resolvedModelForErrors, sanitized);
          } else if (this.councilErrorCallback) {
            this.councilErrorCallback(resolvedModelForErrors, sanitized);
          }
        }

        if (!res.headersSent) {
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          if (statusCode === 503 && message === CIRCUIT_BREAKER_ERROR_MESSAGE) {
            res.end(JSON.stringify(CIRCUIT_BREAKER_ERROR_BODY));
          } else if (codexErrorResponse) {
            // Codex 429/quota body (rate_limit_error + preserved code/reset fields).
            res.end(JSON.stringify(codexErrorResponse.body));
          } else {
            res.end(
              JSON.stringify({
                type: 'error',
                error: { type: statusCode === 401 ? 'authentication_error' : 'api_error', message },
              })
            );
          }
        } else if (!res.writableEnded) {
          res.write(
            formatSSEEvent('error', {
              type: 'error',
              error: { type: 'stream_error', message },
            })
          );
          res.end();
        }
      }
      })(), 'localModelProxy.messagesRequest');
    });
  }

  private createRequestHandler(profile: ModelProfile) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      // Security: Host header validation (DNS rebinding protection)
      // Must be exact match to prevent localhost.evil.com bypass
      const host = req.headers.host;
      // Handle IPv6 bracketed format: [::1]:port -> [::1]
      // Handle IPv4/hostname: 127.0.0.1:port -> 127.0.0.1, localhost:port -> localhost
      let hostWithoutPort: string | undefined;
      if (host?.startsWith('[')) {
        // IPv6 bracketed format: extract up to and including ]
        const bracketEnd = host.indexOf(']');
        hostWithoutPort = bracketEnd > 0 ? host.slice(0, bracketEnd + 1) : undefined;
      } else {
        // IPv4 or hostname: split on first colon
        hostWithoutPort = host?.split(':')[0];
      }
      const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
      if (!hostWithoutPort || !ALLOWED_HOSTS.includes(hostWithoutPort)) {
        log.warn({ host }, '[SECURITY] Rejected request with invalid Host header');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Invalid host' }));
        return;
      }

      // CORS: Only allow specific origins (not wildcard)
      const origin = req.headers.origin;
      if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
      // Echo back requested headers for CORS preflight — safe for localhost-only proxy.
      // This ensures any SDK headers (auth, custom, beta) pass CORS checks.
      const requestedHeaders = req.headers['access-control-request-headers'];
      res.setHeader(
        'Access-Control-Allow-Headers',
        typeof requestedHeaders === 'string'
          ? requestedHeaders
          : 'Content-Type, Authorization, X-Proxy-Auth, anthropic-version, anthropic-beta, x-api-key'
      );
      res.setHeader('Vary', 'Origin');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Security: Bearer token authentication
      // Token is passed via X-Proxy-Auth header to avoid conflicts with model API's Authorization header
      const authHeader = req.headers['x-proxy-auth'];
      if (!this.proxyAuthToken || typeof authHeader !== 'string') {
        log.warn('[SECURITY] Rejected request without proxy authentication');
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: Missing authentication' }));
        return;
      }

      // Constant-time comparison to prevent timing attacks
      const tokenBuffer = Buffer.from(this.proxyAuthToken);
      const authBuffer = Buffer.from(authHeader);
      if (tokenBuffer.length !== authBuffer.length || !crypto.timingSafeEqual(tokenBuffer, authBuffer)) {
        log.warn('[SECURITY] Rejected request with invalid proxy authentication');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Invalid authentication' }));
        return;
      }

      const url = req.url ?? '';

      if (req.method === 'POST' && url.includes('/v1/messages')) {
        this.handleMessagesRequest(req, res, profile);
      } else if (req.method === 'GET' && url.includes('/v1/models')) {
        // Return a minimal models response for health checks
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: profile.model || 'local-model' }] }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    };
  }

  // ── Internal lifecycle helpers ─────────────────────────────────

  /**
   * Actual stop logic — closes the server, resets all state.
   * Called by both `stop()` (public) and auto-stop timer.
   */
  private stopInternal(): Promise<void> {
    if (!this.server) return Promise.resolve();

    const server = this.server;
    return new Promise((resolve) => {
      server.close(() => {
        log.info('Local model proxy server stopped');
        this.server = null;
        this.currentProfile = null;
        this.currentRouteTable = null;
        this.councilErrorCallback = null;
        this.proxyAuthToken = null;
        this.thoughtSignatures.clear();
        this.sigTimestamps.clear();
        this.proxyStats.clear();
        this.turnRoutes.clear();
        this.turnOpenRouterFallback.clear();
        this.turnCodexEnabled.clear();
        this.turnErrorCallbacks.clear();
        this.turnStats.clear();
        this.turnTimeoutCounts.clear();
        if (this.sigSweepInterval) {
          this.sigSweepInterval();
          this.sigSweepInterval = null;
        }
        resolve();
      });
    });
  }

  /**
   * Schedule a debounced auto-stop check (3 seconds).
   * If no turn routes and no base profile remain, stops the proxy.
   */
  private scheduleAutoStop(): void {
    if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
    this.autoStopTimer = setTimeout(() => {
      this.autoStopTimer = null;
      // Re-check guard: only stop if truly idle
      if (this.turnRoutes.size === 0 && !this.currentProfile) {
        fireAndForget(this.stopInternal(), 'localModelProxyServer.line4351');
      }
    }, 3000);
  }

  /**
   * Ensure the proxy server is running. Starts it if needed.
   * Returns the proxy URL.
   */
  private async ensureRunning(port: number = DEFAULT_PROXY_PORT): Promise<string> {
    if (this.server) {
      return `http://127.0.0.1:${this.currentPort}`;
    }

    // Generate auth token for this session
    this.generateAuthToken();

    // Use a dummy profile for the request handler (routing is done by resolveRouteProfile)
    const dummyProfile: ModelProfile = {
      id: 'proxy-router',
      name: 'Proxy Router',
      serverUrl: 'https://api.anthropic.com',
      createdAt: Date.now(),
    };
    this.currentPort = port;

    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.createRequestHandler(dummyProfile));
      attachBenignSocketErrorGuard(this.server);

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn({ port }, 'Port in use, trying next port');
          this.server = null;
          this.ensureRunning(port + 1).then(resolve).catch(reject);
        } else {
          this.server = null;
          this.proxyAuthToken = null;
          reject(err);
        }
      });

      this.server.listen(port, '127.0.0.1', () => {
        const proxyUrl = `http://127.0.0.1:${port}`;
        log.info({ port }, 'Proxy server started');
        resolve(proxyUrl);
      });
    });
  }

  // ── Turn-scoped route management ──────────────────────────────

  /**
   * Add routes for a specific turn. Auto-starts the proxy if needed.
   * @param port Optional port hint (only used if proxy needs to start; ignored if already running).
   * @param openRouterFallback If true, unmatched models on this turn fall back to OpenRouter passthrough.
   */
  async addRoutes(
    turnId: string,
    routes: ModelRouteTable,
    onError?: CouncilErrorCallback,
    port?: number,
    openRouterFallback?: boolean,
    codexEnabled?: boolean,
  ): Promise<void> {
    this.turnRoutes.set(turnId, routes);
    // Explicitly set or clear OR fallback for this turn (overwrite-safe)
    if (openRouterFallback) {
      this.turnOpenRouterFallback.add(turnId);
    } else {
      this.turnOpenRouterFallback.delete(turnId);
    }
    if (codexEnabled) {
      this.turnCodexEnabled.add(turnId);
    } else {
      this.turnCodexEnabled.delete(turnId);
    }
    if (onError) {
      this.turnErrorCallbacks.set(turnId, onError);
    }
    this.turnStats.set(turnId, new Map());

    // Cancel pending auto-stop
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    // Ensure proxy is running
    await this.ensureRunning(port);

    // Start sig sweep if not already running
    this.startSigSweep();

    const routeNames = Array.from(routes.routes.keys());
    log.info({ turnId, routeCount: routeNames.length, routeNames }, 'Added turn routes');
  }

  /**
   * Merge additional routes into an existing turn's route table.
   * Unlike addRoutes (which overwrites), this preserves existing routes and adds new ones.
   */
  mergeRoutes(turnId: string, additionalRoutes: Map<string, ModelProfile>): void {
    const existing = this.turnRoutes.get(turnId);
    if (!existing) {
      log.warn({ turnId }, 'mergeRoutes called for unknown turn — ignoring');
      return;
    }
    for (const [key, profile] of additionalRoutes) {
      existing.routes.set(key, profile);
    }
    const mergedNames = Array.from(additionalRoutes.keys());
    log.info({ turnId, mergedCount: mergedNames.length, mergedNames }, 'Merged additional routes into turn');
  }

  /**
   * Remove routes for a specific turn. Schedules auto-stop if no routes remain.
   */
  removeRoutes(turnId: string): void {
    this.turnRoutes.delete(turnId);
    this.turnOpenRouterFallback.delete(turnId);
    this.turnCodexEnabled.delete(turnId);
    this.turnErrorCallbacks.delete(turnId);
    this.turnStats.delete(turnId);
    this.turnTimeoutCounts.delete(turnId);

    // Purge thought signatures with this turn's prefix
    const prefix = `${turnId}:`;
    for (const key of this.thoughtSignatures.keys()) {
      if (key.startsWith(prefix)) {
        this.thoughtSignatures.delete(key);
        this.sigTimestamps.delete(key);
      }
    }

    log.info({ turnId, remainingTurns: this.turnRoutes.size }, 'Removed turn routes');

    // Schedule auto-stop check
    this.scheduleAutoStop();
  }

  /** Get all active turn IDs. */
  getTurnIds(): IterableIterator<string> {
    return this.turnRoutes.keys();
  }

  /**
   * Set the base profile (alt-model). Auto-starts the proxy if needed.
   */
  async setBaseProfile(profile: ModelProfile): Promise<void> {
    this.currentProfile = profile;
    // Reset Ollama health cache on profile change
    this.ollamaKnownGood = false;

    // Cancel pending auto-stop
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    // Ensure proxy is running
    await this.ensureRunning();

    log.info({ profileId: profile.id, model: profile.model }, 'Set base profile');
  }

  /**
   * Clear the base profile. Schedules auto-stop if no turn routes remain.
   */
  clearBaseProfile(): void {
    this.currentProfile = null;
    this.currentRouteTable = null;
    this.ollamaKnownGood = false;

    log.info('Cleared base profile');

    // Schedule auto-stop check
    this.scheduleAutoStop();
  }

  // ── Public lifecycle methods ───────────────────────────────────

  async startSingleProfile(
    profile: ModelProfile,
    port: number = DEFAULT_PROXY_PORT
  ): Promise<string> {
    if (this.server) {
      log.info('Proxy server already running, stopping first');
      await this.stop();
    }

    this.currentProfile = profile;
    this.currentPort = port;

    // Generate new authentication token for this session
    this.generateAuthToken();
    log.info('Generated new proxy authentication token');

    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.createRequestHandler(profile));
      attachBenignSocketErrorGuard(this.server);

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn({ port }, 'Port in use, trying next port');
          this.startSingleProfile(profile, port + 1).then(resolve).catch(reject);
        } else {
          this.proxyAuthToken = null; // Clear token on error
          reject(err);
        }
      });

      this.server.listen(port, '127.0.0.1', () => {
        const proxyUrl = `http://127.0.0.1:${port}`;
        log.info({ port, targetServer: profile.serverUrl }, 'Local model proxy server started');
        resolve(proxyUrl);
      });
    });
  }

  /**
   * Start the proxy in multi-route mode for council mode.
   * Routes based on model name in the request body:
   * - claude-* models → passthrough to Anthropic API
   * - Other models → translate and forward to matching ModelProfile endpoint
   */
  async startMultiRoute(
    routeTable: ModelRouteTable,
    port: number = DEFAULT_PROXY_PORT,
    onError?: CouncilErrorCallback
  ): Promise<string> {
    if (this.server) {
      log.info('Proxy server already running, stopping first');
      await this.stop();
    }

    this.currentRouteTable = routeTable;
    this.councilErrorCallback = onError ?? null;
    this.proxyStats.clear();
    this.thoughtSignatures.clear();
    // Use a dummy profile for the request handler signature (routing is done by resolveRouteProfile)
    const dummyProfile: ModelProfile = {
      id: 'council-router',
      name: 'Council Router',
      serverUrl: 'https://api.anthropic.com',
      createdAt: Date.now(),
    };
    this.currentProfile = dummyProfile;
    this.currentPort = port;

    this.generateAuthToken();
    const routeNames = Array.from(routeTable.routes.keys());
    log.info({ routeCount: routeNames.length, routeNames }, 'Starting multi-route proxy for council mode');

    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.createRequestHandler(dummyProfile));
      attachBenignSocketErrorGuard(this.server);

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          log.warn({ port }, 'Port in use, trying next port');
          this.startMultiRoute(routeTable, port + 1, onError).then(resolve).catch(reject);
        } else {
          this.server = null;
          this.currentProfile = null;
          this.currentRouteTable = null;
          this.councilErrorCallback = null;
          this.proxyAuthToken = null;
          reject(err);
        }
      });

      this.server.listen(port, '127.0.0.1', () => {
        const proxyUrl = `http://127.0.0.1:${port}`;
        log.info({ port, routeCount: routeNames.length }, 'Multi-route proxy server started');
        resolve(proxyUrl);
      });
    });
  }

  async stop(): Promise<void> {
    // Cancel any pending auto-stop timer
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    return this.stopInternal();
  }

  getUrl(): string | null {
    if (!this.server) return null;
    return `http://127.0.0.1:${this.currentPort}`;
  }

  /**
   * Ensure the proxy is running and return its URL.
   * Used by BTS proxy providers — the proxy may have auto-stopped due to the
   * 3s idle timer, so BTS tasks call this to restart it on demand.
   */
  async ensureRunningForBts(): Promise<string> {
    return this.ensureRunning();
  }

  isRunning(): boolean {
    return this.server !== null;
  }
}

// ── Module-level singleton instance ─────────────────────────────────

/** @internal Exported for testing — do not use outside of localModelProxyServer and its tests. */
export const proxyManager = new ProxyManager();

// ── Thin wrapper functions (preserve existing public API) ───────────
