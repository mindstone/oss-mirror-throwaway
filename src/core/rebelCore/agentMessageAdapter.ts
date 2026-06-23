import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@core/agentRuntimeTypes';
import { getErrorReporter } from '@core/errorReporter';
import { createScopedLogger } from '@core/logger';
import type { FulfillmentProvider } from '@shared/types/providerMetadata';
import { calculateCostOrWarn } from '@shared/utils/pricingCalculator';
import { stripLeakedInvokeXml } from '@shared/utils/assistantNarration';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { RebelCoreEvent, TokenUsage } from './types';
import { ZERO_TOKEN_USAGE, addUsage, getEffectiveInputTokens } from './types';

const log = createScopedLogger({ service: 'agentMessageAdapter' });

interface AgentMessageAdapterOptions {
  model: string;
  tools?: string[];
  sessionId?: string;
  cwd?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'delegate' | 'dontAsk';
  /** Resolved context window for model usage reporting */
  contextWindow?: number;
  /** Resolved max output tokens for model usage reporting */
  maxOutputTokens?: number;
}

const toAgentUsage = (usage: TokenUsage) => ({
  input_tokens: usage.inputTokens,
  output_tokens: usage.outputTokens,
  cache_creation_input_tokens: usage.cacheCreationTokens,
  cache_read_input_tokens: usage.cacheReadTokens,
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  server_tool_use: {
    web_fetch_requests: 0,
    web_search_requests: 0,
  },
  inference_geo: 'unknown',
  service_tier: 'standard',
});

const CONTENT_REF_SUMMARY_CHAR_LIMIT = 500;

const buildContentRefSummary = (output: string): string =>
  output.slice(0, CONTENT_REF_SUMMARY_CHAR_LIMIT);

const hasPresentContentRef = (
  refs: ReadonlyArray<unknown> | undefined,
): boolean => Array.isArray(refs) && refs.some((ref) => ref !== null && ref !== undefined);

const toToolResultContent = (event: Extract<RebelCoreEvent, { type: 'tool_use:result' }>) => {
  const imageContent = event.imageContent ?? [];
  const imageRef = event.imageRef ?? [];
  const contentRef = event.contentRef ?? [];
  const hasContentRef = hasPresentContentRef(contentRef);

  if (imageContent.length === 0 && imageRef.length === 0 && !hasContentRef) {
    return event.output;
  }

  const imageBlocks: Array<Record<string, unknown>> = imageContent.map((image, index) => ({
    type: 'image' as const,
    data: image.data,
    mimeType: image.mimeType,
    ...(imageRef[index] ? { imageRef: imageRef[index] } : {}),
  }));

  if (imageRef.length > imageContent.length) {
    imageBlocks.push(
      ...imageRef.slice(imageContent.length).filter((ref) => ref !== null).map((ref) => ({
        type: 'image' as const,
        imageRef: ref,
      })),
    );
  }

  const outputBlocks: Array<Record<string, unknown>> = [
    { type: 'text' as const, text: event.output },
    ...imageBlocks,
  ];

  if (!hasContentRef) {
    return outputBlocks;
  }

  const summary = buildContentRefSummary(event.output);
  for (const [index, ref] of contentRef.entries()) {
    if (ref === null || ref === undefined) continue;
    const refBlock = {
      type: 'content_ref' as const,
      contentRef: ref,
      ...(summary.length > 0 ? { summary } : {}),
    };
    if (index < outputBlocks.length) {
      outputBlocks[index] = refBlock;
    } else {
      outputBlocks.push(refBlock);
    }
  }

  return outputBlocks;
};

const toToolResultBlock = (event: Extract<RebelCoreEvent, { type: 'tool_use:result' }>) => ({
  type: 'tool_result' as const,
  tool_use_id: event.toolUseId,
  content: toToolResultContent(event),
  is_error: event.isError,
  ...(event.imageRef && event.imageRef.length > 0 ? { imageRef: event.imageRef } : {}),
  ...(hasPresentContentRef(event.contentRef) ? { contentRef: event.contentRef } : {}),
  ...(typeof event.outputChars === 'number' ? { output_chars: event.outputChars } : {}),
  ...(event.meta !== undefined ? { _meta: event.meta } : {}),
  ...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
});

const resolveProvidersSeen = (usage: TokenUsage): string[] => {
  const providers = [
    ...(usage.providersSeen ?? []),
    usage.openRouterProvider,
    usage.fulfillmentProvider?.name ?? undefined,
  ].filter((provider): provider is string => typeof provider === 'string' && provider.length > 0);

  return Array.from(new Set(providers));
};

export class RebelCoreAgentMessageAdapter {
  private readonly model: string;
  private readonly tools: string[];
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'delegate' | 'dontAsk';
  private readonly contextWindow: number;
  private readonly maxOutputTokens: number;

  private accumulatedText = '';
  private lastClearedText = '';
  // Option-Z residual diagnostic (docs/plans/260616_stream-result-source-hardening).
  // The context-overflow recovery path (compaction/fallback/skeleton) reuses this
  // same adapter and re-streams; recovery events deliberately do NOT clear
  // accumulatedText. If a re-streaming recovery ever fires AFTER assistant text
  // was emitted, the post-recovery re-stream appends to the stale partial → the
  // persisted result becomes pre_recovery_partial + post_recovery_text. We snapshot
  // the high-water accumulatedText length at the FIRST such recovery (set-if-null)
  // so loop:complete can detect a stale fold. Lengths only — never the text.
  private accumulatedLenAtRestreamingRecovery: number | null = null;
  private turns = 0;
  private latestStopReason: string | null = 'end_turn';
  private latestUsage: TokenUsage = { ...ZERO_TOKEN_USAGE };
  private readonly usageByModel = new Map<string, TokenUsage>();
  private actualToolCount = 0;

  // Session-level cache & context observability (Stage 1)
  private turnsWithCacheHit = 0;
  private totalCacheReadTokens = 0;
  private totalCacheCreationTokens = 0;
  private totalInputTokens = 0;
  private peakInputTokens = 0;
  private contextManagementEdits = 0;

  constructor(options: AgentMessageAdapterOptions) {
    this.model = options.model;
    this.tools = options.tools ?? [];
    this.sessionId = options.sessionId ?? randomUUID();
    this.cwd = options.cwd ?? process.cwd();
    this.permissionMode = options.permissionMode ?? 'bypassPermissions';
    this.contextWindow = options.contextWindow ?? 200_000;
    this.maxOutputTokens = options.maxOutputTokens ?? 0;
  }

  /**
   * Merge sub-agent token usage into the parent adapter's usageByModel.
   *
   * Called from the Agent tool after a sub-agent completes. This is the ONLY
   * mutation path for sub-agent costs — handleSubAgentEvent() remains state-free.
   * Sub-agent usage is keyed by the sub-agent's actual model, so multi-model
   * sub-agents (e.g., forager on Haiku, council member on Opus) are tracked
   * separately in the parent's cost breakdown.
   */
  mergeSubAgentUsage(model: string, usage: TokenUsage): void {
    this.usageByModel.set(
      model,
      addUsage(this.usageByModel.get(model) ?? ZERO_TOKEN_USAGE, usage),
    );
  }

  createInitMessage(): AgentMessage {
    return {
      type: 'system',
      subtype: 'init',
      model: this.model,
      tools: this.tools,
      apiKeySource: 'user',
      claude_code_version: 'rebel-core',
      cwd: this.cwd,
      mcp_servers: [],
      permissionMode: this.permissionMode,
      slash_commands: [],
      output_style: 'default',
      skills: [],
      plugins: [],
      uuid: randomUUID(),
      // session_id is omitted from the init message because Rebel Core
      // is stateless — there is no server-side session to reference.
    } as unknown as AgentMessage;
  }

  handleEvent(event: RebelCoreEvent): AgentMessage[] {
    switch (event.type) {
      case 'assistant:text': {
        this.accumulatedText += event.text;
        return [
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'text_delta',
                text: event.text,
              },
            },
            parent_tool_use_id: null,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'assistant:message': {
        // When the model produces tool_use alongside text, the text is pre-tool
        // narration (planning, reasoning) not the user-facing response. Reset
        // accumulatedText so only the final post-tool response survives in the
        // result. Without this, plan JSON or process narration becomes the
        // displayed message. See: rebel://conversation/1010dfd2-8915-4962-8730-e83a3b8adff1
        //
        // We save the cleared text as a fallback: if the agent loop ends
        // without producing any further text (e.g., the model's last turn was
        // text + TaskUpdate with no post-tool follow-up), the result would be
        // empty — triggering the empty_result_anomaly retry and a duplicate
        // reply. Using lastClearedText as a fallback prevents this.
        // See: rebel://conversation/c75180b3-a3c3-4aa3-b637-0efa162f9fa1
        const hasToolUse = event.content.some(b => b.type === 'tool_use');
        if (hasToolUse) {
          if (this.accumulatedText) {
            // Sanitize before storing — pre-tool text may contain leaked
            // <invoke> XML that would otherwise become the fallback result.
            const stripped = stripLeakedInvokeXml(this.accumulatedText);
            if (stripped.length === 0 && this.accumulatedText.length > 0) {
              // XML stripping emptied the entire fallback. Log for diagnostics
              // but don't preserve raw XML — the handler's anomaly detector
              // (using last_turn_output_tokens) correctly classifies "done after
              // tools" as legitimate even with empty fallback text.
              log.info(
                { originalLength: this.accumulatedText.length },
                'stripLeakedInvokeXml emptied lastClearedText — fallback will be empty'
              );
            }
            this.lastClearedText = stripped;
          }
          this.accumulatedText = '';
          // A tool-use clear starts a fresh accumulation segment, so a snapshot
          // armed in an EARLIER segment is no longer comparable — invalidate it.
          // A real stale fold is only "pre-recovery text + post-recovery
          // re-stream within the SAME segment (no clear between)". Without this
          // reset, a longer final answer after a tool turn would falsely trip
          // the stale-fold diagnostic even though the pre-recovery text was
          // already cleared and is NOT in the result.
          // See docs/plans/260616_stream-result-source-hardening.
          this.accumulatedLenAtRestreamingRecovery = null;
        }

        // Final complete assistant message — emitted after streaming finishes.
        // The API sends both stream_event deltas AND then a final 'assistant' message.
        return [
          {
            type: 'assistant',
            message: {
              content: event.content,
            },
            parent_tool_use_id: null,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'assistant:thinking': {
        return [
          {
            type: 'stream_event',
            event: {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'thinking_delta',
                thinking: event.thinking,
              },
            },
            parent_tool_use_id: null,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'status': {
        return [
          {
            type: 'system',
            subtype: 'status',
            status: null,
            permissionMode: this.permissionMode,
            message: event.message,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'tool_use:start': {
        this.actualToolCount += 1;
        // Tool use events are already included in the assistant:message content blocks.
        // We still emit them so downstream can dispatch tool progress events.
        return [];
      }

      case 'tool_use:result': {
        return [
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                toToolResultBlock(event),
              ],
            },
            parent_tool_use_id: null,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'turn:complete': {
        this.turns += 1;
        this.latestUsage = event.usage;
        this.latestStopReason = event.stopReason;
        const model = event.model ?? this.model;
        this.usageByModel.set(
          model,
          addUsage(this.usageByModel.get(model) ?? ZERO_TOKEN_USAGE, event.usage),
        );

        // Accumulate session-level cache/context metrics.
        const turnPromptTokens = getEffectiveInputTokens(event.usage);
        this.totalInputTokens += turnPromptTokens;
        this.totalCacheReadTokens += event.usage.cacheReadTokens;
        this.totalCacheCreationTokens += event.usage.cacheCreationTokens;
        if (event.usage.cacheReadTokens > 0) {
          this.turnsWithCacheHit += 1;
        }
        if (turnPromptTokens > this.peakInputTokens) {
          this.peakInputTokens = turnPromptTokens;
        }
        if (event.contextManagementEdits) {
          this.contextManagementEdits += event.contextManagementEdits;
        }

        return [];
      }

      case 'turn:error': {
        this.logSessionCacheMetrics();

        const usage = this.usageByModel.size > 0
          ? Array.from(this.usageByModel.values()).reduce(addUsage, { ...ZERO_TOKEN_USAGE })
          : this.latestUsage;
        const modelUsage = this.buildModelUsage();
        const totalCost = Object.values(modelUsage).reduce((sum, entry) => sum + entry.costUSD, 0);

        return [
          {
            type: 'result',
            subtype: 'error_during_execution',
            duration_ms: 0,
            duration_api_ms: 0,
            is_error: true,
            num_turns: this.turns,
            stop_reason: this.latestStopReason,
            total_cost_usd: totalCost,
            usage: toAgentUsage(usage),
            modelUsage,
            permission_denials: [],
            errors: [event.error.message],
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'loop:complete': {
        // Option-Z residual diagnostic: a re-streaming recovery fired with
        // pre-recovery text present, and the result now carries MORE text than
        // was present at that recovery → the post-recovery re-stream appended on
        // top of the stale partial (the same doubling class as the original bug,
        // one level above the client guard). Non-fatal, observable, lengths only.
        // The result is NOT altered. See docs/plans/260616_stream-result-source-hardening.
        if (
          this.accumulatedLenAtRestreamingRecovery !== null &&
          this.accumulatedText.length > this.accumulatedLenAtRestreamingRecovery
        ) {
          const preRecoveryLen = this.accumulatedLenAtRestreamingRecovery;
          const finalLen = this.accumulatedText.length;
          log.warn(
            { preRecoveryLen, finalLen },
            'Stale-fold risk: turn result carries pre-recovery accumulated text after a re-streaming recovery (Option Z residual — see docs/plans/260616_stream-result-source-hardening). Result NOT altered; investigate if this fires.',
          );
          try {
            getErrorReporter().captureException(
              new Error('rebel-core stale-fold risk: pre-recovery accumulated text folded into post-recovery re-stream'),
              {
                tags: { area: 'rebel-core', invariant: 'recovery-stale-fold' },
                // Lengths only — NEVER the text content.
                extra: { preRecoveryLen, finalLen },
                fingerprint: ['rebel-core-recovery-stale-fold'],
              },
            );
          } catch (captureError) {
            ignoreBestEffortCleanup(captureError, {
              operation: 'agentMessageAdapter.recoveryStaleFoldDiagnostic',
              reason: 'Observability must never break the result path; the result is unchanged regardless.',
            });
          }
        }

        const usage = this.usageByModel.size > 0
          ? Array.from(this.usageByModel.values()).reduce(addUsage, { ...ZERO_TOKEN_USAGE })
          : event.totalUsage;
        const modelUsage = this.buildModelUsage();
        const totalCost = Object.values(modelUsage).reduce((sum, entry) => sum + entry.costUSD, 0);

        this.logSessionCacheMetrics();

        return [
          {
            type: 'result',
            subtype: 'success',
            duration_ms: 0,
            duration_api_ms: 0,
            is_error: false,
            num_turns: this.turns,
            result: this.accumulatedText || this.lastClearedText,
            stop_reason: this.latestStopReason,
            total_cost_usd: totalCost,
            usage: toAgentUsage(usage),
            // Final turn's output tokens (vs loop-total in usage.output_tokens).
            // Used by agentMessageHandler to avoid false-positive empty_result_anomaly
            // when earlier tool-use turns consumed tokens but the final turn was empty.
            last_turn_output_tokens: this.latestUsage.outputTokens,
            executor_tool_count: this.actualToolCount,
            modelUsage,
            permission_denials: [],
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'warning': {
        return [
          {
            type: 'system',
            subtype: 'warning',
            category: event.category,
            warningMessage: event.message,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'recovery:compaction':
      case 'recovery:fallback':
      case 'recovery:skeleton': {
        // These are RE-STREAMING recoveries — the adapter is reused and will
        // re-stream after this event. We do NOT mutate accumulatedText (recovery
        // events are pre-output by design; a test locks that in). Snapshot the
        // high-water accumulatedText length at the FIRST recovery that carried
        // pre-recovery text, so loop:complete can detect a stale fold. Lengths
        // only — never the text content.
        if (this.accumulatedLenAtRestreamingRecovery === null && this.accumulatedText.length > 0) {
          this.accumulatedLenAtRestreamingRecovery = this.accumulatedText.length;
        }
        return [
          {
            type: 'system',
            subtype: 'status',
            status: null,
            permissionMode: this.permissionMode,
            message: event.message,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      case 'context:warning': {
        return [
          {
            type: 'system',
            subtype: 'status',
            status: null,
            permissionMode: this.permissionMode,
            message: event.message,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as unknown as AgentMessage,
        ];
      }

      // Tolerant default: events handled elsewhere (e.g. tool_use:* flow through
      // handleSubAgentEvent, not this builder) and any unknown/future RebelCoreEvent
      // type must yield no AgentMessages here — never throw. (The named events
      // are all handled in explicit cases above; this default is the runtime
      // safety net for out-of-band / future events.)
      default:
        return [];
    }
  }

  private logSessionCacheMetrics(): void {
    if (this.turns === 0) return;

    const cacheHitRate = Math.round((this.turnsWithCacheHit / this.turns) * 100);
    const avgPromptTokens = Math.round(this.totalInputTokens / this.turns);
    const peakUtilization = this.contextWindow > 0
      ? Math.round((this.peakInputTokens / this.contextWindow) * 100)
      : 0;
    const avgUtilization = this.contextWindow > 0
      ? Math.round((avgPromptTokens / this.contextWindow) * 100)
      : 0;

    log.info(
      {
        turns: this.turns,
        turnsWithCacheHit: this.turnsWithCacheHit,
        cacheHitRate,
        totalCacheReadTokens: this.totalCacheReadTokens,
        totalCacheCreationTokens: this.totalCacheCreationTokens,
        totalPromptTokens: this.totalInputTokens,
        peakPromptTokens: this.peakInputTokens,
        avgPromptTokens,
        peakUtilization,
        avgUtilization,
        contextWindow: this.contextWindow,
        contextManagementEdits: this.contextManagementEdits,
      },
      'Session cache & context metrics',
    );
  }

  /**
   * Create a synthetic tool call pair (start + result) for direct channel injection.
   *
   * Unlike handleSubAgentEvent(), this method manufactures top-level tool events
   * that don't originate from model responses (e.g., post-planning seed events).
   * Returns both start and result messages in one call for caller convenience.
   *
   * CRITICAL: This method is state-free — it MUST NOT mutate `accumulatedText`,
   * `turns`, `latestUsage`, `usageByModel`, or `latestStopReason`.
   */
  createSyntheticToolCallPair(
    toolName: string,
    toolUseId: string,
    input: unknown,
    output: string,
    isError = false,
    origin?: 'real' | 'synthetic-plan-seed' | 'pre-turn-context',
  ): AgentMessage[] {
    return [
      {
        type: 'assistant',
        message: {
          content: [{
            type: 'tool_use',
            id: toolUseId,
            name: toolName,
            input,
            ...(origin ? { _meta: { origin } } : {}),
          }],
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: this.sessionId,
      } as AgentMessage,
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: output,
            is_error: isError,
            ...(origin ? { _meta: { origin } } : {}),
          }],
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: this.sessionId,
      } as AgentMessage,
    ];
  }

  /**
   * Map a sub-agent event to AgentMessage shapes for the parent's stream.
   *
   * CRITICAL: This method is state-free — it MUST NOT mutate `accumulatedText`,
   * `turns`, `latestUsage`, `usageByModel`, or `latestStopReason`. Sub-agent
   * events flow through a separate path to avoid corrupting the parent's
   * result tracking.
   *
   * Only handles `tool_use:start` and `tool_use:result`. Other event types
   * must NOT be forwarded (they would corrupt parent turn state in agentMessageHandler).
   */
  handleSubAgentEvent(event: RebelCoreEvent, parentToolUseId: string): AgentMessage[] {
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- intentional allowlist: only tool_use:* events may be forwarded to the parent; ALL other event types (current and future) must be ignored (return []) to avoid corrupting parent turn state, so an exhaustive assertNever would be wrong here.
    switch (event.type) {
      case 'tool_use:start': {
        return [
          {
            type: 'assistant',
            message: {
              content: [
                {
                  type: 'tool_use',
                  id: event.toolUseId,
                  name: event.toolName,
                  input: event.input,
                },
              ],
            },
            parent_tool_use_id: parentToolUseId,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as AgentMessage,
        ];
      }

      case 'tool_use:result': {
        return [
          {
            type: 'user',
            message: {
              role: 'user',
              content: [
                toToolResultBlock(event),
              ],
            },
            parent_tool_use_id: parentToolUseId,
            uuid: randomUUID(),
            session_id: this.sessionId,
          } as AgentMessage,
        ];
      }

      default:
        return [];
    }
  }

  private buildModelUsage(): Record<string, {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    webSearchRequests: number;
    costUSD: number;
    contextWindow: number;
    maxOutputTokens: number;
    providersSeen: string[];
    openRouterProvider?: string;
    fulfillmentProvider?: FulfillmentProvider | null;
  }> {
    if (this.usageByModel.size === 0) {
      const usage = this.latestUsage;
      const costSource = usage.exactCostUsd != null ? 'exactCostUsd' : 'calculated';
      const cost = usage.exactCostUsd ?? calculateCostOrWarn(
        this.model,
        usage.inputTokens,
        usage.outputTokens,
        log,
        'rebel-core',
        usage.cacheCreationTokens,
        usage.cacheReadTokens,
      ) ?? 0;
      log.debug({ model: this.model, costUSD: cost, costSource }, 'buildModelUsage cost resolved');

      return {
        [this.model]: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadTokens,
          cacheCreationInputTokens: usage.cacheCreationTokens,
          webSearchRequests: 0,
          costUSD: cost,
          contextWindow: this.contextWindow,
          maxOutputTokens: this.maxOutputTokens,
          providersSeen: resolveProvidersSeen(usage),
          ...(usage.openRouterProvider ? { openRouterProvider: usage.openRouterProvider } : {}),
          ...(usage.fulfillmentProvider !== undefined ? { fulfillmentProvider: usage.fulfillmentProvider } : {}),
        },
      };
    }

    return Object.fromEntries(
      Array.from(this.usageByModel.entries()).map(([model, usage]) => {
        const costSource = usage.exactCostUsd != null ? 'exactCostUsd' : 'calculated';
        const cost = usage.exactCostUsd ?? calculateCostOrWarn(
          model,
          usage.inputTokens,
          usage.outputTokens,
          log,
          'rebel-core',
          usage.cacheCreationTokens,
          usage.cacheReadTokens,
        ) ?? 0;
        log.debug({ model, costUSD: cost, costSource }, 'buildModelUsage cost resolved');

        return [
          model,
          {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadInputTokens: usage.cacheReadTokens,
            cacheCreationInputTokens: usage.cacheCreationTokens,
            webSearchRequests: 0,
            costUSD: cost,
            contextWindow: this.contextWindow,
            maxOutputTokens: this.maxOutputTokens,
            providersSeen: resolveProvidersSeen(usage),
            ...(usage.openRouterProvider ? { openRouterProvider: usage.openRouterProvider } : {}),
            ...(usage.fulfillmentProvider !== undefined ? { fulfillmentProvider: usage.fulfillmentProvider } : {}),
          },
        ];
      }),
    );
  }
}

export const createAgentMessageAdapter = (
  options: AgentMessageAdapterOptions,
): RebelCoreAgentMessageAdapter => new RebelCoreAgentMessageAdapter(options);
