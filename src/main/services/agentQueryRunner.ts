/**
 * Agent Query Runner — Unified iteration loop for agent message streams.
 *
 * Replaces 8 near-identical `for await` loops in the executor with a single
 * configurable function. Each call site specifies its own rethrow policy,
 * message callbacks, and error handling via `AgentQueryConfig`.
 *
 * Extracted from agentTurnExecutor.ts as Phase 3 Stage 1. See:
 * - docs/plans/260329_agent_turn_executor_hardening.md (Phase 3 § Stage 1)
 */

import {
  queryWithRuntime as query,
  type TurnParams,
  type QueryRouterContext,
} from '@core/rebelCore/queryRouter';
import type { AgentMessage } from '@core/agentRuntimeTypes';
import type { EventWindow } from '@core/types';
import type { TurnSessionLogger } from '@core/logger';
import { handleAgentMessage, buildCompactModelUsage } from './agentMessageHandler';
import { agentTurnRegistry } from './agentTurnRegistry';
import { appendCostEntry } from './costLedgerService';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import { getErrorKind } from '@shared/utils/agentErrorCatalog';
import { timeoutAsyncIterator, type TimeoutOptions, type RearmInfo } from '@core/utils/timeoutAsyncIterator';
import { STREAMING_STALL_ABORT_MS } from './watchdogTracker';
import { isApiOutputMessage } from '../utils/agentTurnUtils';
import { fireAndForget } from '@shared/utils/fireAndForget';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentQueryConfig {
  queryOptions: Omit<TurnParams, 'prompt'>;
  prompt: TurnParams['prompt'];
  abortController: AbortController;
  routerContext?: QueryRouterContext;
  turnId: string;
  win: EventWindow | null;
  turnLogger: TurnSessionLogger;

  /** Error kinds to re-throw from inner message handler (per-call-site). */
  rethrowKinds: Set<string>;

  /** Additional re-throw predicates (e.g., isExtendedContextUnavailableError).
   *  Checked after rethrowKinds. If any returns true, the error is re-thrown. */
  rethrowPredicates?: Array<(error: unknown) => boolean>;

  /** Called on each agent message before abort check and handleAgentMessage.
   *  Used by the primary loop for watchdog activity and tool-in-flight tracking.
   *  NOT for activity tracking — see onApiOutput, which is the source-of-truth
   *  for "real API output happened" classification. */
  onMessage?: (message: unknown) => void;

  /** Called whenever the runner classifies a message as real API output
   *  (assistant text, tool_use/tool_result, result). Filtered via the
   *  shared `isApiOutputMessage` helper.
   *
   *  REQUIRED to prevent silent activity-tracking gaps in retry guards.
   *  Synthetic system:* messages (init/status/warning) are filtered out and
   *  do NOT trigger this callback — see docs-private/postmortems/260427_outer_retry_guard_*.md
   *  for the bug class this prevents. Pass `() => {}` only if the call site
   *  genuinely doesn't gate retries on prior output (rare). */
  onApiOutput: (message: AgentMessage) => void;

  /** Called on inner catch BEFORE default error routing.
   *  Return 'rethrow' to re-throw, 'continue' to skip, 'terminate' to break
   *  out of the loop. Return undefined to fall through to rethrowKinds/predicates. */
  onError?: (error: unknown) => 'rethrow' | 'continue' | 'terminate' | undefined;

  /** Called when a non-fatal error is being continued past (for extended
   *  logging, Sentry capture, renderer notifications in the primary loop).
   *  If not provided, logs a simple warning. */
  onContinueError?: (error: unknown, message: unknown) => void;

  /** Label for log messages (e.g., 'primary', 'Max 200K fallback'). */
  label?: string;

  /** Per-message streaming timeout in ms. If no agent message is received within
   *  this duration, the iterator throws MessageTimeoutError.
   *  Default: STREAMING_STALL_ABORT_MS (600s). Set to 0 or Infinity to disable. */
  messageTimeoutMs?: number;
  /** Optional dynamic timeout getter. When provided, the timeout wrapper
   *  re-evaluates this on every timeout cycle/re-arm. */
  getMessageTimeoutMs?: () => number;

  /** Returns the age in ms since the last upstream activity (raw SSE event, etc).
   *  When provided, the timeout re-arms if upstream activity is recent, preventing
   *  false timeouts during extended thinking. */
  getLastActivityAgeMs?: () => number;

  /** Returns true while a tool (including subagent Task) is in flight. Surfaces
   *  the same signal the watchdog uses (`watchdogTracker.toolInFlightSince`) so
   *  Layer 1 (this iterator) and Layer 2 (watchdog) agree on what counts as
   *  legitimate work. Without this, long MCP tool calls trip MessageTimeoutError
   *  at 10 min even though the watchdog would correctly wait 15 min for them.
   *  See REBEL-1AF and docs/plans/260506_layer1_layer2_tool_in_flight_alignment.md. */
  isToolInFlight?: () => boolean;
}

export interface AgentQueryResult {
  /** True if the abort controller was signaled during iteration. */
  abortedByUser: boolean;
  /** True if onError returned 'terminate' (e.g., API key rate-limit inline handling). */
  terminatedByHandler: boolean;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Run a single agent query, iterating the message stream with configurable
 * error routing. Handles iterator creation, close callback registration,
 * abort detection, and inner error classification.
 *
 * Post-loop logic (abort dispatch, cleanup, fallback recording) is left
 * to the caller — this function only handles the iteration itself.
 */
export async function runAgentQuery(config: AgentQueryConfig): Promise<AgentQueryResult> {
  const {
    queryOptions,
    prompt,
    abortController,
    routerContext,
    turnId,
    win,
    turnLogger,
    rethrowKinds,
    rethrowPredicates,
    onMessage,
    onApiOutput,
    onError,
    onContinueError,
    label,
  } = config;
  const resolveMessageTimeoutMs = (): number =>
    config.getMessageTimeoutMs?.() ?? config.messageTimeoutMs ?? STREAMING_STALL_ABORT_MS;

  // 1. Create iterator and register close callback
  type ClosableAgentIterator = AsyncGenerator<AgentMessage, void, undefined> & {
    close?: () => void | Promise<void>;
  };

  const iterator = query(
    { ...queryOptions, prompt, abortController },
    routerContext,
  ) as ClosableAgentIterator;
  agentTurnRegistry.setTurnCloseCallback(turnId, () => {
    fireAndForget(iterator.close?.(), 'agentQueryRunner.line150');
  });

  // 2. Iterate messages with per-message timeout protection.
  // When getLastActivityAgeMs OR isToolInFlight is provided, the timeout re-arms
  // on recent upstream activity (raw SSE events during extended thinking) or while
  // a tool/subagent Task is in flight. The dynamic ceiling (getMessageTimeoutMs)
  // raises the cap when the watchdog enters tool-in-flight mode; the isToolInFlight
  // callback is defense-in-depth observability for the same signal (REBEL-1AF).
  const effectiveTimeout = resolveMessageTimeoutMs();
  const hasLivenessSignal = Boolean(config.getLastActivityAgeMs || config.isToolInFlight);
  // REBEL-1AF observability: differentiate WHY the iterator re-armed so
  // production triage can tell at a glance which signal kept the turn alive.
  // Stable across re-arms within a single isStillProcessing() call.
  let lastRearmReason: 'upstream_activity' | 'tool_in_flight' | 'unknown' = 'unknown';
  const onRearm = hasLivenessSignal
    ? (info: RearmInfo) => {
        turnLogger.debug(
          { activityAgeMs: info.activityAgeMs, remainingMs: info.remainingMs, totalWaitMs: info.totalWaitMs, rearmCount: info.rearmCount, label: config.label ?? 'primary', reason: lastRearmReason },
          'Streaming timeout re-armed',
        );
      }
    : undefined;
  let isToolInFlightWarnedOnce = false;
  const timeoutOpts: TimeoutOptions = {
    timeoutMs: effectiveTimeout,
    ...(config.getMessageTimeoutMs && { getTimeoutMs: config.getMessageTimeoutMs }),
    ...(config.getLastActivityAgeMs && { getLastActivityAgeMs: config.getLastActivityAgeMs }),
    ...(hasLivenessSignal && {
      isStillProcessing: () => {
        const activityAgeMs = config.getLastActivityAgeMs?.();
        // F20: re-evaluate the ceiling per cycle so a watchdog-driven dynamic
        // raise (tool-in-flight, judge fail-open) takes effect without restart.
        const timeoutForCycleMs = resolveMessageTimeoutMs();
        const activityRecent =
          activityAgeMs !== undefined &&
          Number.isFinite(activityAgeMs) &&
          activityAgeMs < timeoutForCycleMs;
        if (activityRecent) {
          lastRearmReason = 'upstream_activity';
          return true;
        }
        try {
          if (config.isToolInFlight?.() === true) {
            lastRearmReason = 'tool_in_flight';
            return true;
          }
          return false;
        } catch (err) {
          // Silent-failure rule (AGENTS.md): callback throws should not be
          // hidden. We bias toward fail-closed (return false → MessageTimeoutError
          // fires at hardCap), but log warn-once so production triage notices.
          if (!isToolInFlightWarnedOnce) {
            isToolInFlightWarnedOnce = true;
            turnLogger.warn(
              { err, label: config.label ?? 'primary' },
              'isToolInFlight callback threw; treating as no tool in flight',
            );
          }
          return false;
        }
      },
    }),
    ...(onRearm && { onRearm }),
  };
  const timedIterator = timeoutAsyncIterator(
    iterator,
    timeoutOpts,
    abortController.signal,
  );

  let abortedByUser = false;
  let terminatedByHandler = false;

  // Local usage accumulator — each runAgentQuery() call gets its own
  // accumulator so fallback chains estimate costs independently.
  const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  let costRecorded = false;

  try {
    for await (const message of timedIterator) {
      // Call onMessage before abort check (watchdog/tool tracking in primary loop)
      if (onMessage) {
        onMessage(message);
      }

      // Activity tracking — single source of truth for "real API output happened".
      // Synthetic system:* messages (init/status/warning) are filtered out by
      // isApiOutputMessage so they never satisfy retry-blocking activity guards.
      // See docs-private/postmortems/260427_outer_retry_guard_*.md for the bug class.
      if (isApiOutputMessage(message)) {
        onApiOutput(message);
      }

      // Accumulate usage from assistant messages (before abort check so
      // even the last assistant message before abort is counted).
      const messageType = (message as { type?: string }).type;
      if (messageType === 'assistant') {
        try {
          const usage = (message as { message?: { usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          } } }).message?.usage;
          if (usage) {
            accumulatedUsage.inputTokens += usage.input_tokens ?? 0;
            accumulatedUsage.outputTokens += usage.output_tokens ?? 0;
            accumulatedUsage.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
            accumulatedUsage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          }
        } catch {
          // Best-effort accumulation — never block message processing
        }
      }

      // Check abort signal
      if (abortController.signal.aborted) {
        // Late result cost recovery — if the current message is a result
        // with cost data, extract it inline. Do NOT call handleAgentMessage() which
        // triggers memory updates, badges, streak tracking, and renderer dispatch.
        if (messageType === 'result') {
          try {
            const result = message as { cost_usd?: number; total_cost_usd?: number };
            const totalCost = result.total_cost_usd ?? result.cost_usd;
            if (totalCost != null && totalCost > 0) {
              const sid = agentTurnRegistry.getRendererSession(turnId);
              const cat = agentTurnRegistry.getTurnCategory(turnId);
              const model = agentTurnRegistry.getTurnModel(turnId);
              const auth = agentTurnRegistry.getTurnAuthMethod(turnId);
              const mu = buildCompactModelUsage(message);
              appendCostEntry({
                ts: Date.now(),
                cost: totalCost,
                sid,
                tid: turnId,
                cat,
                m: model,
                auth: auth ?? undefined,
                outcome: { kind: 'aborted', reason: 'user_cancel' },
                ...(mu ? { mu } : {}),
              });
              costRecorded = true;
            }
          } catch {
            // Best-effort cost recovery — never block abort
          }
        }
        abortedByUser = true;
        break;
      }

      try {
        handleAgentMessage(win, turnId, message);
      } catch (messageError: unknown) {
        // Step 1: Check onError callback first
        if (onError) {
          const action = onError(messageError);
          if (action === 'rethrow') throw messageError;
          if (action === 'continue') continue;
          if (action === 'terminate') {
            terminatedByHandler = true;
            break;
          }
          // undefined → fall through to default routing
        }

        // Step 2: Check rethrowKinds
        const messageErrorKind = getErrorKind(messageError);
        if (rethrowKinds.has(messageErrorKind)) {
          throw messageError;
        }

        // Step 3: Check rethrowPredicates
        if (rethrowPredicates) {
          for (const predicate of rethrowPredicates) {
            if (predicate(messageError)) {
              throw messageError;
            }
          }
        }

        // Step 4: Non-fatal — log and continue
        if (onContinueError) {
          onContinueError(messageError, message);
        } else {
          turnLogger.warn(
            { err: messageError, messageType: (message as Record<string, unknown>).type },
            `Error processing agent message during ${label ?? 'query'} - continuing`,
          );
        }
      }

      // Stop the iterator after the first successful result has been dispatched.
      // Breaking a for-await loop calls .return() on the async iterator, which
      // terminates the query — no more post-result tool execution or token waste.
      // Error results throw (handled above) and never reach here.
      if (agentTurnRegistry.hasSuccessResultDispatched(turnId)) {
        turnLogger.info(
          { turnId },
          'Stopping agent iterator — first successful result dispatched'
        );
        break;
      }
    }
  } finally {
    // Estimate cost from accumulated tokens when no exact cost was recorded.
    // Check both local flag (late result in this function) and registry flag
    // (handleAgentMessage recorded cost for a result before abort was signaled).
    const registryCostRecorded = agentTurnRegistry.hasCostRecorded(turnId);
    if (!costRecorded && !registryCostRecorded && abortedByUser && accumulatedUsage.outputTokens > 0) {
      try {
        const model = agentTurnRegistry.getTurnModel(turnId);
        if (model) {
          const estimated = calculateCostOrWarn(
            model,
            accumulatedUsage.inputTokens,
            accumulatedUsage.outputTokens,
            turnLogger,
            'agent-query',
            accumulatedUsage.cacheCreationTokens || undefined,
            accumulatedUsage.cacheReadTokens || undefined,
          );
          if (estimated != null && estimated > 0) {
            const sid = agentTurnRegistry.getRendererSession(turnId);
            const cat = agentTurnRegistry.getTurnCategory(turnId);
            const auth = agentTurnRegistry.getTurnAuthMethod(turnId);
            appendCostEntry({
              ts: Date.now(),
              cost: estimated,
              sid,
              tid: turnId,
              cat,
              m: model,
              auth: auth ?? undefined,
              outcome: { kind: 'aborted', reason: 'user_cancel' },
              inTok: accumulatedUsage.inputTokens,
              outTok: accumulatedUsage.outputTokens,
              cacheReadTok: accumulatedUsage.cacheReadTokens || undefined,
              cacheCreateTok: accumulatedUsage.cacheCreationTokens || undefined,
              est: true,
            });
          }
        }
      } catch {
        // Best-effort estimation — never block cleanup
      }
    }
  }

  return { abortedByUser, terminatedByHandler };
}
