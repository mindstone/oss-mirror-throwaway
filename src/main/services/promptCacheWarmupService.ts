/**
 * Prompt Cache Warmup Service
 *
 * JIT (Just-In-Time) warmup for Anthropic's prompt cache.
 * Warms the cache on composer focus if >5 min since last API call,
 * so the user's first real message benefits from cache reads (~90% cheaper).
 *
 * @see docs/plans/finished/260131_jit_prompt_cache_warming.md
 */

import type { BetaTextBlockParam, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import { captureKnownCondition } from '@core/sentry/captureKnownCondition';
import { CODEX_CONNECTIVITY_UNKNOWN } from '@core/rebelCore/codexConnectivity';
import { getAuthForDirectUse, hasValidAuth, isDirectAnthropicConfig } from '@core/utils/authEnvUtils';
import { buildConnectedPackages, resolveSystemPrompt } from './mcpService';
import { ENV_EXECUTION_MODEL, resolveModelConfig } from '@shared/utils/modelNormalization';
import { getWorkingModelProfile } from '@shared/types';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import { appendCostEntry } from './costLedgerService';
import { listRegisteredTools } from '@core/rebelCore/toolRegistry';
import { createMcpSession, type McpSession, type McpToolDefinition } from '@core/rebelCore/mcpClient';
import { buildAgentToolDefinition } from '@core/rebelCore/agentTool';
import {
  MISSION_SET_TOOL_DEFINITION,
  GET_PREVIOUS_TASKS_TOOL_DEFINITION,
} from '@core/rebelCore/builtinTools';
import { buildForagerAgentDef, FORAGER_AGENT_NAME } from '@core/rebelCore/foragerPrompt';
import { resolveCapabilities } from '@core/services/capabilityResolutionService';
import { superMcpHttpManager } from './superMcpHttpManager';
import {
  KNOWLEDGE_WORKER_AGENT_DESCRIPTION,
  KNOWLEDGE_WORKER_AGENT_NAME,
} from '@core/constants';
import { createAnthropicSdkClientForDirectPlan } from '@core/rebelCore/clients/anthropicClient';
import { ensureDirectAnthropicCapable } from '@core/rebelCore/ensureDirectAnthropicCapable';
import { resolveProviderRoutePlan, type ProviderRouteSettings } from '@core/rebelCore/providerRouting';
import { getApiKey, getCurrentModel } from '@core/rebelCore/settingsAccessors';
import { getDefaultModelForProvider } from '@shared/utils/getDefaultModelForProvider';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import { onTurnIdleStateChange } from './visibilityAwareScheduler';

const log = createScopedLogger({ service: 'promptCacheWarmup' });

// Cache TTL from Anthropic: 5 minutes for ephemeral cache
const CACHE_TTL_MS = 5 * 60 * 1000;

// Cooldown after failed warmup to prevent rapid retries
const FAILURE_COOLDOWN_MS = 30 * 1000; // 30 seconds

type WarmupSystemPrompt = Awaited<ReturnType<typeof resolveSystemPrompt>>;

function toBetaSystemPrompt(systemPrompt: WarmupSystemPrompt): string | BetaTextBlockParam[] {
  if (typeof systemPrompt === 'string') return systemPrompt;
  return systemPrompt
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => ({
      type: 'text',
      text: block.text ?? '',
      ...(block.cache_control ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));
}

/**
 * Module-level state for tracking when we last made an API call.
 * Updated after each agent turn completion.
 */
let lastApiCallTime: number | null = null;

/**
 * Timestamp of last failed warmup attempt.
 * Used to prevent rapid retries on persistent failures.
 */
let lastFailedWarmupTime: number | null = null;

/**
 * In-flight warmup promise to prevent concurrent warmups.
 * If a warmup is already in progress, subsequent calls will wait for it.
 */
let inFlightWarmup: Promise<WarmupResult> | null = null;

/**
 * Update the timestamp of the last API call.
 * Called from agentTurnExecutor on turn completion.
 */
export function updateLastApiCallTime(): void {
  lastApiCallTime = Date.now();
  log.debug({ lastApiCallTime }, 'Updated last API call time');
}

/**
 * Get the timestamp of the last API call.
 */
export function getLastApiCallTime(): number | null {
  return lastApiCallTime;
}

/**
 * Check if the cache has likely expired (>5 min since last call).
 */
export function isCacheExpired(): boolean {
  if (lastApiCallTime === null) {
    // Never made a call, cache is cold
    return true;
  }
  return Date.now() - lastApiCallTime > CACHE_TTL_MS;
}

/**
 * Check if we're in failure cooldown (to prevent rapid retries).
 */
export function isInFailureCooldown(): boolean {
  if (lastFailedWarmupTime === null) {
    return false;
  }
  return Date.now() - lastFailedWarmupTime < FAILURE_COOLDOWN_MS;
}

export interface WarmupResult {
  success: boolean;
  error?: string;
}

/**
 * Warm the Anthropic prompt cache with a minimal API call.
 *
 * This makes a lightweight direct Anthropic API request that:
 * - Uses the current system prompt
 * - Resolves and includes tools for cache-prefix parity with real turns
 * - Uses max_tokens: 10 to minimize cost
 * - Uses a simple prompt that elicits a brief response
 *
 * The goal is to populate the prompt cache so subsequent real
 * conversations benefit from cache reads (~90% cheaper input tokens).
 *
 * @param settings - Current app settings
 * @param signal - Optional AbortSignal for cancellation
 * @returns Result indicating success or failure
 */
export async function warmPromptCache(
  settings: AppSettings,
  signal?: AbortSignal
): Promise<WarmupResult> {
  // If warmup is already in progress, return the existing promise
  // This prevents concurrent warmups from multiple IPC calls
  if (inFlightWarmup) {
    log.debug('Warmup already in progress, returning existing promise');
    return inFlightWarmup;
  }

  const warmupPromise = executeWarmup(settings, signal);
  inFlightWarmup = warmupPromise;

  try {
    return await warmupPromise;
  } finally {
    inFlightWarmup = null;
  }
}

/**
 * Internal warmup execution (separated for in-flight guard).
 *
 * Stage 6 Phase 6 (260508): mid-call race closure. The entry check below
 * blocks warm-up while a turn is already active, but a turn that *starts*
 * mid-call (during prompt assembly or the Anthropic request) would otherwise
 * compete with streaming. We subscribe to the registry's turn-idle state
 * change for the duration of `executeWarmup` and abort an internal controller
 * the moment the active-turn signal goes high. The internal controller is
 * linked to the external `signal` so existing abort callers continue to work.
 */
async function executeWarmup(
  settings: AppSettings,
  signal?: AbortSignal
): Promise<WarmupResult> {
  const startTime = Date.now();
  log.info('Starting prompt cache warmup');

  // Stage 6 (260508): backstop gate. Caller (`agentHandlers.warm-cache`)
  // already pre-checks `isAnyTurnActive` but a future caller may forget — the
  // warm-up path itself competes with streaming if both happen simultaneously
  // so we fail-closed inside the service too.
  if (agentTurnRegistry.hasAnyActiveTurn()) {
    log.debug('Cache warmup skipped - active agent turn in flight');
    return { success: false, error: 'Active agent turn in flight' };
  }

  // Stage 6 Phase 6 mid-call abort: combined controller links the caller's
  // signal AND a turn-active mid-call abort source. Aborts within microtask
  // latency once a turn starts.
  const combinedController = new AbortController();
  const abortForTurnActive = (): void => {
    if (combinedController.signal.aborted) return;
    if (!agentTurnRegistry.hasAnyActiveTurn()) return;
    log.debug('Cache warmup aborted mid-call - active agent turn started');
    combinedController.abort('active_turn_started_mid_warmup');
  };
  const unsubscribeTurnIdle = onTurnIdleStateChange(abortForTurnActive);
  let externalAbortHandler: (() => void) | null = null;
  if (signal) {
    if (signal.aborted) {
      combinedController.abort(signal.reason);
    } else {
      externalAbortHandler = (): void => {
        if (!combinedController.signal.aborted) {
          combinedController.abort(signal.reason);
        }
      };
      signal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }
  const effectiveSignal = combinedController.signal;
  const cleanupAbortListeners = (): void => {
    unsubscribeTurnIdle();
    if (signal && externalAbortHandler) {
      signal.removeEventListener('abort', externalAbortHandler);
      externalAbortHandler = null;
    }
  };

  try {
    // Validate auth
    if (!hasValidAuth(settings)) {
      log.warn('Cannot warm cache - no valid auth');
      return { success: false, error: 'No valid authentication' };
    }

    const activeProfile = getWorkingModelProfile(settings);
    if (activeProfile?.providerType) {
      log.debug({ model: activeProfile.model, provider: activeProfile.providerType }, 'Skipping prompt cache warmup for non-direct-Anthropic provider');
      return { success: true };
    }

    // Active-provider guard. Even when `resolveProviderRoutePlan` would route a
    // native-Claude model directly to Anthropic (e.g. Codex-active + lingering
    // Anthropic key), prompt-cache warmup must not run unless the user has
    // *explicitly* selected direct Anthropic as the active provider. Otherwise
    // we would silently misattribute warmup cost to a provider the user did not
    // pick. Fails closed for `openrouter`, `codex`, and any future proxied
    // provider.
    if (!isDirectAnthropicConfig(settings)) {
      log.debug(
        { activeProvider: settings.activeProvider },
        'Skipping prompt cache warmup for non-direct-Anthropic active provider',
      );
      return { success: true };
    }

    // Validate core directory
    if (!settings.coreDirectory) {
      log.warn('Cannot warm cache - no core directory');
      return { success: false, error: 'Core directory not configured' };
    }

    // Check if already aborted (external signal pre-aborted, or turn already
    // active and we landed here via a race after the entry guard)
    if (effectiveSignal.aborted) {
      log.debug('Warmup aborted before start');
      return { success: false, error: 'Aborted' };
    }

    const auth = getAuthForDirectUse(settings);

    // Resolve model config (use default model from settings)
    const requestedModel = getCurrentModel(settings) ?? getDefaultModelForProvider(settings, 'working');
    const modelConfig = resolveModelConfig(requestedModel, null, false);

    // In plan mode, resolveModelConfig() returns the planner alias.
    // Direct API calls must use a concrete Claude model.
    const effectiveModel = activeProfile?.model
      || modelConfig.envOverrides?.[ENV_EXECUTION_MODEL]
      || modelConfig.model;

    // Skip warmup for non-direct-Anthropic routes — prompt caching requires
    // direct Anthropic API. The provider route plan catches OR/Codex/proxy
    // paths and proxy-dialect models so we do not warm a cache the active
    // provider will never read.
    const directApiKeyForPlan = getApiKey(settings) ?? auth.apiKey;
    // eslint-disable-next-line no-restricted-properties -- Provider-route planning here intentionally snapshots the canonical models block before injecting a direct Anthropic API key override.
    const currentModels = settings.models ?? {};
    const routingSettings: ProviderRouteSettings = {
      ...settings,
      models: {
        ...(currentModels ?? {}),
        ...(directApiKeyForPlan ? { apiKey: directApiKeyForPlan } : {}),
      },
    };
    const plan = await resolveProviderRoutePlan(
      {
        kind: 'forBTS',
        input: {
          settings: routingSettings,
          model: effectiveModel,
          category: 'prompt-cache-warmup',
          codexConnectivity: CODEX_CONNECTIVITY_UNKNOWN,
        },
      },
      { ...(auth.apiKey ? { anthropicApiKey: auth.apiKey } : {}), logLevel: 'debug' },
    );
    const directCapability = ensureDirectAnthropicCapable(plan);
    if (!directCapability.ok) {
      log.debug(
        {
          activeProvider: settings.activeProvider,
          reason: directCapability.reason,
          transport: plan.decision.transport,
          modelDialect: plan.decision.modelDialect,
          wireModelId: plan.decision.wireModelId,
        },
        'Skipping prompt cache warmup for non-direct-Anthropic route',
      );
      return { success: true };
    }

    if (!auth.apiKey) {
      log.warn('Cannot warm cache - no API key available for direct API use');
      return { success: false, error: 'No API key available' };
    }

    let mcpSession: McpSession | null = null;
    try {
      // Resolve system prompt (this is what we want to cache)
      let systemPrompt = await resolveSystemPrompt(settings);
      const builtinTools = listRegisteredTools();
      let mcpToolDefs: McpToolDefinition[] = [];
      const superMcpState = superMcpHttpManager.getState();

      if (superMcpState.isRunning && superMcpState.url) {
        try {
          mcpSession = await createMcpSession(superMcpState.url);
          mcpToolDefs = mcpSession ? await mcpSession.listTools() : [];
          log.debug({ mcpToolCount: mcpToolDefs.length }, 'Resolved MCP tools for warmup');
        } catch (mcpError: unknown) {
          const errorMessage = mcpError instanceof Error ? mcpError.message : String(mcpError);
          log.warn({ err: errorMessage }, 'Failed to resolve MCP tools for warmup, continuing with builtin tools only');
        }
      } else {
        log.debug('Super-MCP not running, continuing warmup with builtin tools only');
      }

      let capabilityResolution: ReturnType<typeof resolveCapabilities> = {
        disallowedTools: [],
        promptGuidance: [],
        activeCapabilities: [],
      };

      if (superMcpState.isRunning) {
        const connectedPackages = await buildConnectedPackages();
        capabilityResolution = resolveCapabilities(connectedPackages);
      }

      if (capabilityResolution.promptGuidance.length > 0 && typeof systemPrompt === 'string') {
        const guidanceBlock = capabilityResolution.promptGuidance.map(g => `- ${g}`).join('\n');
        systemPrompt = `${systemPrompt}\n\n**Active capability upgrades:**\n${guidanceBlock}`;
      }

      const foragerDef = buildForagerAgentDef();
      foragerDef.tools = ['Read', ...mcpToolDefs.map((toolDef) => toolDef.apiToolName)];

      const agents = {
        [KNOWLEDGE_WORKER_AGENT_NAME]: {
          description: KNOWLEDGE_WORKER_AGENT_DESCRIPTION,
          prompt: typeof systemPrompt === 'string' ? systemPrompt : '',
        },
        [FORAGER_AGENT_NAME]: foragerDef,
      };

      const suppressedSet = new Set(capabilityResolution.disallowedTools);

      // INVARIANT: Tool ordering must match rebelCoreQuery.ts (builtins → MCP → agent → mission/task)
      const allTools = [
        ...builtinTools,
        ...mcpToolDefs.map((toolDef) => toolDef.tool),
        buildAgentToolDefinition(agents),
        MISSION_SET_TOOL_DEFINITION,
        GET_PREVIOUS_TASKS_TOOL_DEFINITION,
      ].filter((tool) => !suppressedSet.has(tool.name));

      // Check abort after potentially slow MCP/tool resolution
      if (effectiveSignal.aborted) {
        log.debug('Warmup aborted after MCP resolution');
        return { success: false, error: 'Aborted' };
      }

      // Intentionally does NOT send the `compact-2026-01-12` beta (unlike real
      // turns on compact-capable models): this warmup sends no `context_management`
      // body (just a tiny max_tokens:10 cache-warm), so there's no compact edit to
      // enable, and Anthropic's prompt-cache key is content-based (system + tools +
      // messages prefix), not header-based — so the missing compact beta does not
      // cause a cache miss against real turns. No parity fix needed. (REBEL-52B follow-up.)
      const client = createAnthropicSdkClientForDirectPlan(plan, {
        defaultHeaders: { 'anthropic-beta': 'context-management-2025-06-27' },
      });

      const warmupPrompt = 'Respond with only the word "ready"';

      log.debug({ model: effectiveModel, toolCount: allTools.length, mcpToolCount: mcpToolDefs.length }, 'Executing warmup request');

      const response = await client.beta.messages.create({
        model: effectiveModel,
        max_tokens: 10,
        system: toBetaSystemPrompt(systemPrompt),
        ...(allTools.length > 0 ? { tools: allTools } : {}),
        cache_control: { type: 'ephemeral' },
        messages: [{ role: 'user', content: warmupPrompt }],
      } satisfies MessageCreateParamsNonStreaming, {
        signal: effectiveSignal,
        timeout: 30000,
      });

      if (response.usage) {
        const cost = calculateCostOrWarn(
          effectiveModel,
          response.usage.input_tokens,
          response.usage.output_tokens,
          log,
          'warmup',
          response.usage.cache_creation_input_tokens ?? undefined,
          response.usage.cache_read_input_tokens ?? undefined,
        );
        if (cost != null && cost > 0) {
          appendCostEntry({
            ts: Date.now(),
            cost,
            cat: 'warmup',
            m: effectiveModel,
            auth: 'api-key',
            inTok: response.usage.input_tokens,
            outTok: response.usage.output_tokens,
            cacheReadTok: response.usage.cache_read_input_tokens ?? undefined,
            cacheCreateTok: response.usage.cache_creation_input_tokens ?? undefined,
            est: true,
            outcome: { kind: 'auxiliary_success' },
          });
          log.debug({ cost, model: effectiveModel }, 'Warmup cost tracked');
        }
      }

      // Check abort after request completes for responsiveness
      if (effectiveSignal.aborted) {
        log.debug('Warmup aborted during request');
        return { success: false, error: 'Aborted' };
      }

      // Update last API call time on success
      // Clear any failure cooldown
      updateLastApiCallTime();
      lastFailedWarmupTime = null;

      const elapsedMs = Date.now() - startTime;
      log.info({ elapsedMs }, 'Prompt cache warmup completed');

      return { success: true };
    } finally {
      if (mcpSession) {
        try {
          await mcpSession.close();
        } catch (closeError: unknown) {
          log.warn({ err: closeError }, 'Failed to close warmup MCP session');
        }
      }
    }
  } catch (error: unknown) {
    // Check if this was an abort (external signal or mid-call turn-active abort)
    if (effectiveSignal.aborted) {
      log.debug('Warmup aborted');
      return { success: false, error: 'Aborted' };
    }

    // Set failure cooldown to prevent rapid retries
    lastFailedWarmupTime = Date.now();

    const errorMessage = error instanceof Error ? error.message : String(error);
    log.error({ err: error }, 'Prompt cache warmup failed');
    captureKnownCondition(
      'bts_warmup_failure',
      {},
      error instanceof Error ? error : undefined,
    );
    return { success: false, error: errorMessage };
  } finally {
    cleanupAbortListeners();
  }
}
