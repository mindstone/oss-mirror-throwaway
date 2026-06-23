import type { FulfillmentProvider } from '@shared/types/providerMetadata';

/**
 * Rebel Core internal wire format types.
 *
 * These are Rebel Core's own types, not imports from any provider SDK.
 * The naming (tool_use, tool_result, input_schema, etc.) is Anthropic-inspired
 * because Rebel Core was originally Anthropic-only — renaming was evaluated and
 * explicitly rejected due to 40+ file blast radius for zero functional gain.
 * Provider clients (anthropicClient, openaiClient) translate between these
 * neutral types and each provider's native API format.
 *
 * See docs/plans/260405_rebelcore_model_independence_final_cleanup.md (Principle 4).
 */

import type { ImageRef } from '@shared/types/agent';

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock;

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ToolResultContentBlock[];
  is_error?: boolean;
  imageRef?: (ImageRef | null)[];
}

export interface ToolResultTextContentBlock {
  type: 'text';
  text: string;
}

export interface ToolResultImageContentBlock {
  type: 'image';
  data?: string;
  mimeType?: string;
  imageRef?: ImageRef;
}

export type ToolResultContentBlock =
  | ToolResultTextContentBlock
  | ToolResultImageContentBlock;

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

export type SystemPrompt = string | ContentBlock[];

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Exact cost in USD from the provider API (e.g. OpenRouter usage.cost). When present, preferred over local calculation. */
  exactCostUsd?: number;
  /** OpenRouter upstream provider that served the request (e.g. 'Anthropic', 'Google'). Only present for OpenRouter-routed requests. */
  openRouterProvider?: string;
  /** Structured fulfillment provider metadata for this usage observation (optional, additive). */
  fulfillmentProvider?: FulfillmentProvider | null;
  /** Ordered, deduped provider names observed across merged usage entries. */
  providersSeen?: ReadonlyArray<string>;
}

export const ZERO_TOKEN_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  exactCostUsd: 0,
};

/**
 * Effective input tokens for context utilization: raw input + all cache tokens.
 * Centralized to prevent callsite divergence (see postmortem 260408_betweenTurns_effective_tokens).
 */
export function getEffectiveInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

const mergeProvidersSeen = (left: TokenUsage, right: TokenUsage): string[] => {
  const providers = [
    ...(left.providersSeen ?? []),
    left.openRouterProvider,
    left.fulfillmentProvider?.name ?? undefined,
    ...(right.providersSeen ?? []),
    right.openRouterProvider,
    right.fulfillmentProvider?.name ?? undefined,
  ].filter((provider): provider is string => typeof provider === 'string' && provider.length > 0);

  return Array.from(new Set(providers));
};

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const providersSeen = mergeProvidersSeen(left, right);

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheCreationTokens: (left.cacheCreationTokens ?? 0) + (right.cacheCreationTokens ?? 0),
    cacheReadTokens: (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0),
    exactCostUsd:
      left.exactCostUsd !== undefined && right.exactCostUsd !== undefined
        ? left.exactCostUsd + right.exactCostUsd
        : undefined,
    // `providersSeen` is the divergence signal; keep legacy provider fields first-wins for back-compat.
    providersSeen,
    // Preserve the first non-undefined provider (consistent within a turn, and expected by cost-ledger consumers).
    openRouterProvider: left.openRouterProvider ?? right.openRouterProvider,
    fulfillmentProvider: left.fulfillmentProvider ?? right.fulfillmentProvider,
  };
}
