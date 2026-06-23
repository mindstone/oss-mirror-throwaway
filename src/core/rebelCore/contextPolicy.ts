import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'contextPolicy' });

export interface ProviderCapabilities {
  hasNativeContextEditing: boolean; // Anthropic: true (clear_tool_uses handled by API)
  hasNativeCompaction: boolean; // Reserved for compact_20260112
  cacheStrategy: 'ephemeral' | 'implicit' | 'none';
  cacheHeuristicTtlMs: number; // Anthropic: 300_000, OpenAI: 600_000, others: 0
  /**
   * Whether image content may be sent in model-facing messages for the given
   * model. A FUNCTION of the per-request model BY DESIGN (kill-by-construction,
   * 260610 image-unsupported-by-model incident): one client instance serves
   * many models (managed/OpenRouter proxy, route-table, BTS), so a
   * construction-time boolean was a provider-level claim that lied for
   * text-only models (deepseek on the managed route). The function shape makes
   * it impossible to consult image capability without supplying the model.
   *
   * Deliberate asymmetry: the PROVIDER-level term stays fail-CLOSED for
   * OpenAI-compat providers (closed-world set — see
   * `providerFeatureGuards.supportsInlineImageContent`), while the MODEL-level
   * term (`modelSupportsImageInput`) is fail-OPEN (open-world: server-seeded
   * managed roster + future models must never silently lose vision; a missed
   * text-only model degrades to the classified `image_input_unsupported`
   * error). Don't "fix" either direction.
   *
   * WARNING: a function member makes `ProviderCapabilities` non-JSON-
   * serializable and non-structured-cloneable — logging or IPC'ing the
   * capabilities object will silently drop/break this field.
   */
  supportsImageContent: (model: string) => boolean;
}

export interface CompactionConfig {
  clearToolUsesThreshold: number; // 0.75 (75% utilization)
  btsThreshold: number; // 0.90 (90% utilization)
  emergencyThreshold: number; // 0.95 (95% utilization)
}

export const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
  clearToolUsesThreshold: 0.75,
  btsThreshold: 0.90,
  emergencyThreshold: 0.95,
};

export type CompactionDecision =
  | { action: 'none' }
  | { action: 'clear_tool_uses' } // Anthropic: already handled server-side. Emit for observability.
  | { action: 'client_prune_tool_pairs' } // Non-Anthropic: client-side removal of old tool pairs
  | { action: 'native_compact' } // Provider-native server-side compaction
  | { action: 'bts_deferred'; reason: string } // Cache still warm — defer until cold
  | { action: 'bts_immediate'; reason: string }; // Emergency or cache-cold

/**
 * Pure policy function that decides what compaction action to take based on
 * context utilization, cache state, and provider capabilities.
 *
 * Tiered thresholds:
 *   - <75%: no action
 *   - 75–90%: clear old tool uses (server-side for Anthropic, client-side for others)
 *   - 90–95%: native compaction when available, otherwise BTS compression
 *   - ≥95%: native compaction when available, otherwise emergency BTS compression
 */
export function decideCompaction(
  inputTokens: number,
  contextWindow: number,
  msSinceLastApiCall: number,
  config: CompactionConfig,
  capabilities: ProviderCapabilities,
): CompactionDecision {
  // No data = no decision
  if (!inputTokens || !contextWindow || inputTokens <= 0 || contextWindow <= 0) {
    return { action: 'none' };
  }

  const utilization = inputTokens / contextWindow;

  let decision: CompactionDecision;

  if (utilization < config.clearToolUsesThreshold) {
    return { action: 'none' };
  } else if (utilization >= config.emergencyThreshold) {
    // Emergency tier: >=95%
    decision = capabilities.hasNativeCompaction
      ? { action: 'native_compact' }
      : {
        action: 'bts_immediate',
        reason: `Emergency: context utilization at ${(utilization * 100).toFixed(1)}% (threshold: ${(config.emergencyThreshold * 100).toFixed(0)}%)`,
      };
  } else if (utilization >= config.btsThreshold) {
    // BTS tier: >=90%
    if (capabilities.hasNativeCompaction) {
      decision = { action: 'native_compact' };
    } else {
      const cacheIsCold =
        capabilities.cacheHeuristicTtlMs === 0 ||
        msSinceLastApiCall > capabilities.cacheHeuristicTtlMs;

      decision = cacheIsCold
        ? {
          action: 'bts_immediate',
          reason: `Cache cold (${msSinceLastApiCall}ms since last call, TTL: ${capabilities.cacheHeuristicTtlMs}ms). Utilization: ${(utilization * 100).toFixed(1)}%`,
        }
        : {
          action: 'bts_deferred',
          reason: `Cache warm (${msSinceLastApiCall}ms since last call, TTL: ${capabilities.cacheHeuristicTtlMs}ms). Utilization: ${(utilization * 100).toFixed(1)}%`,
        };
    }
  } else {
    // Clear tool uses tier: >=75%
    decision = capabilities.hasNativeContextEditing
      ? { action: 'clear_tool_uses' }
      : { action: 'client_prune_tool_pairs' };
  }

  log.debug({
    utilization: +(utilization * 100).toFixed(1),
    action: decision.action,
    ...('reason' in decision ? { reason: decision.reason } : {}),
    inputTokens,
    contextWindow,
    msSinceLastApiCall,
    cacheStrategy: capabilities.cacheStrategy,
  }, 'Context compaction decision');

  return decision;
}
