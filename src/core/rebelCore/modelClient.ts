import type { ChatMessage, ContentBlock, SystemPrompt, ToolDefinition, TokenUsage } from './modelTypes';
import type { RebelCoreThinkingConfig } from './modelLimits';
import type { ProviderCapabilities } from './contextPolicy';
import type { RuntimeActivityEvent } from './runtimeActivity';
import type { TurnScopedHydrationCache } from '../services/imageHydrationCache';
import type { TurnScopedContentHydrationCache } from '../services/contentHydrationCache';
import type { ContentDownloader } from '../services/contentHydration';
import type { RoutingModelId } from '@shared/utils/modelChoiceCodec';
import { assertNever } from '@shared/utils/assertNever';

export interface ModelClientConfig {
  provider?: string;
  apiKey?: string;
  authToken?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /** Enable Anthropic context_management (clear_tool_uses) for server-side pruning of old tool pairs. Defaults to false. */
  enableContextManagement?: boolean;
  /** Enable server-side context compaction (compact_20260112). Experimental — API may not support it yet. Defaults to false. */
  enableCompact?: boolean;
  /** Override the Anthropic SDK's default retry count (default 2). Set to 0 for
   *  providers like Codex where rate limits are subscription-tier-based and retries
   *  just amplify load. */
  maxRetries?: number;
}

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  errorKind: string;
  provider?: string;
}

/**
 * Provider-neutral structured-output schema. Maps to Anthropic's
 * `output_config.format` (constrained decoding, JSON-schema grammar) and
 * OpenAI's `response_format: { type: 'json_schema' }` (strict mode).
 *
 * Providers that don't support structured outputs (e.g. Codex Responses
 * passthrough) silently ignore this field; callers must keep prompt-level
 * schema instructions as a fallback.
 */
export interface JsonSchemaFormat {
  type: 'json_schema';
  /** Stable identifier for the schema; surfaces in OpenAI's `json_schema.name`. */
  name: string;
  /** Standard JSON Schema (subject to provider-specific complexity limits). */
  schema: Record<string, unknown>;
}

export interface OutputConfig {
  format?: JsonSchemaFormat;
}

export interface StreamParams {
  model: RoutingModelId;
  systemPrompt: SystemPrompt;
  messages: ChatMessage[];
  /**
   * Destination capability bit used by OpenAI-compatible translators to decide
   * whether assistant-history reasoning_content can be replayed safely.
   * Computed at the layer that has activeProfile context (rebelCoreQuery.ts).
   */
  supportsReasoningReplay?: boolean;
  tools?: ToolDefinition[];
  maxTokens: number;
  thinking?: RebelCoreThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Optional provider-neutral structured-output enforcement (JSON schema). */
  outputConfig?: OutputConfig;
  signal?: AbortSignal;
  onRetry?: (params: RetryInfo) => void;
  /** Diagnostic callback fired for every raw SDK stream event. Used by the watchdog to distinguish active generation from API stalls. */
  onStreamActivity?: (event: RuntimeActivityEvent) => void;
  sessionId?: string;
  hydrationCache?: TurnScopedHydrationCache;
  /** Per-turn opaque-content (`content_ref`) hydration cache. Stage B1b. */
  contentHydrationCache?: TurnScopedContentHydrationCache;
  /** Cloud fallback for content_ref hydration. Stage B1b. */
  contentCloudClient?: ContentDownloader;
}

export interface StreamResult {
  content: ContentBlock[];
  stopReason: string;
  usage: TokenUsage;
  /** Actual model that served the request (may differ from requested model due to proxy routing). */
  model?: string;
  /** Number of context_management edits applied by the server (Anthropic-specific). */
  contextManagementEdits?: number;
}

export interface CreateParams {
  model: RoutingModelId;
  systemPrompt: SystemPrompt;
  messages: ChatMessage[];
  /**
   * Destination capability bit used by OpenAI-compatible translators to decide
   * whether assistant-history reasoning_content can be replayed safely.
   * Computed at the layer that has activeProfile context (rebelCoreQuery.ts).
   */
  supportsReasoningReplay?: boolean;
  maxTokens: number;
  thinking?: RebelCoreThinkingConfig;
  effort?: 'low' | 'medium' | 'high' | 'max';
  /** Optional provider-neutral structured-output enforcement (JSON schema). */
  outputConfig?: OutputConfig;
  signal?: AbortSignal;
  onRetry?: (params: RetryInfo) => void;
  sessionId?: string;
  hydrationCache?: TurnScopedHydrationCache;
  /** Per-turn opaque-content (`content_ref`) hydration cache. Stage B1b. */
  contentHydrationCache?: TurnScopedContentHydrationCache;
  /** Cloud fallback for content_ref hydration. Stage B1b. */
  contentCloudClient?: ContentDownloader;
}

export interface CreateResult {
  content: ContentBlock[];
  stopReason: string;
  usage: TokenUsage;
  /** Actual model that served the request (may differ from requested model due to proxy routing). */
  model?: string;
  /** Number of context_management edits applied by the server (Anthropic-specific). */
  contextManagementEdits?: number;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'degraded-status'; reason: 'late-reasoning-buffer-cap'; cap: 'bytes' | 'chunks' | 'time' };

/**
 * Whether a streamed event contributes to the persisted turn `result` (it enters
 * the adapter's accumulatedText). Result-affecting events make a stream retry
 * unsafe — re-running doStream would re-emit and duplicate them (see
 * docs/plans/260616_proxy-transient-retry). The exhaustive switch is the
 * by-construction guard: a NEW StreamEvent variant fails to compile here until it
 * is explicitly classified, so it cannot silently reopen the duplication class.
 */
export function isResultAffectingStreamEvent(event: StreamEvent): boolean {
  switch (event.type) {
    case 'text_delta':
      return true;
    case 'thinking_delta':
    case 'degraded-status':
      return false;
    default:
      return assertNever(event, 'isResultAffectingStreamEvent');
  }
}

export interface ModelClient {
  create(params: CreateParams): Promise<CreateResult>;
  stream(
    params: StreamParams,
    onEvent: (event: StreamEvent) => void,
  ): Promise<StreamResult>;
  readonly capabilities: ProviderCapabilities;
}
