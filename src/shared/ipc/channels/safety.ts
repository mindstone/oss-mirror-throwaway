import { z } from 'zod';
import { ToolBlockSourceSchema } from '@rebel/shared';
import { defineInvokeChannel } from '../schemas';

/**
 * Schema for persisted tool approval requests.
 * Matches the shape stored in pendingApprovalsStore.
 *
 * Note: the display-metadata fields (`riskLevel`, `packageName`,
 * `conversationTitle`) are written by toolSafetyService when a cloud
 * approval is registered locally (see toolSafetyService.ts ~2326) and by the
 * live broadcast path. They are optional at rest because older records may
 * predate their introduction.
 */
export const ToolApprovalRequestSchema = z.object({
  toolUseID: z.string(),
  turnId: z.string(),
  sessionId: z.string().optional(),
  toolName: z.string(),
  input: z.record(z.string(), z.unknown()),
  reason: z.string().optional(),
  timestamp: z.number(),
  allowPermanentTrust: z.boolean().optional(),
  effectiveToolId: z.string().optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  packageName: z.string().optional(),
  conversationTitle: z.string().optional(),
  /** Block source discriminator — mirrors memory safety's blockedBy field.
   * 'safety_prompt': principled Safety Rules block. 'eval_error': evaluator unavailable (fail-closed). */
  blockedBy: ToolBlockSourceSchema.optional(),
});

export type ToolApprovalRequestPayload = z.infer<typeof ToolApprovalRequestSchema>;

/**
 * Schema for staged tool calls awaiting approval.
 * These are tool calls that have been queued for later execution.
 */
export const StagedToolCallSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  timestamp: z.number(),
  expiresAt: z.number(),
  status: z.enum(['pending', 'executing', 'executed', 'failed', 'rejected', 'expired']),
  mcpPayload: z.object({
    packageId: z.string(),
    toolId: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
  displayName: z.string(),
  toolCategory: z.enum(['side-effect', 'read-only']),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  reason: z.string().optional(),
  allowPermanentTrust: z.boolean().optional(),
  /** Block source discriminator — mirrors memory safety's blockedBy field.
   * 'safety_prompt': principled Safety Rules block. 'eval_error': evaluator unavailable (fail-closed). */
  blockedBy: ToolBlockSourceSchema.optional(),
  automationId: z.string().optional(),
  automationName: z.string().optional(),
  result: z.object({
    success: z.boolean(),
    content: z.string().optional(),
    error: z.string().optional(),
    executedAt: z.number(),
  }).optional(),
});

export type StagedToolCallPayload = z.infer<typeof StagedToolCallSchema>;

/**
 * Broadcast payload: fired on each attempt of an in-flight Safety Prompt
 * evaluation so the renderer can surface a "Checking this is safe…" subline on
 * the matching running-tool row. Attempt numbers are 1-indexed.
 *
 * Channel: `tool-safety:evaluating` (broadcast-only, no invoke counterpart).
 * Cleared by the paired `tool-safety:evaluating-complete` event below, with
 * belt-and-braces cleanup on `stage: 'end'` for the matching `toolUseId`.
 * Transient UI affordance — do NOT persist into `eventsByTurn`.
 */
export const ToolSafetyEvaluatingSchema = z.object({
  toolUseId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  toolName: z.string(),
  attempt: z.number().int().positive(),
  /** Epoch ms when this attempt began. */
  startedAt: z.number(),
});

export type ToolSafetyEvaluatingPayload = z.infer<typeof ToolSafetyEvaluatingSchema>;

/**
 * Broadcast payload: fired when a Safety Prompt evaluation exits (success,
 * block, abort, error). Paired with `tool-safety:evaluating` so the renderer
 * can clear the in-flight subline regardless of outcome.
 *
 * Channel: `tool-safety:evaluating-complete` (broadcast-only).
 */
export const ToolSafetyEvaluatingCompleteSchema = z.object({
  toolUseId: z.string(),
  sessionId: z.string(),
  turnId: z.string(),
  outcome: z.enum(['allowed', 'blocked', 'staged', 'aborted', 'error']),
});

export type ToolSafetyEvaluatingCompletePayload = z.infer<typeof ToolSafetyEvaluatingCompleteSchema>;

/** Channel name for the in-flight safety-eval progress broadcast. */
export const TOOL_SAFETY_EVALUATING_CHANNEL = 'tool-safety:evaluating';
/** Channel name for the safety-eval completion broadcast (paired with above). */
export const TOOL_SAFETY_EVALUATING_COMPLETE_CHANNEL = 'tool-safety:evaluating-complete';

/**
 * Tool ID for "run automation now". Continuation messages are suppressed for this
 * tool because the automation pipeline is self-contained (scheduler.runNow runs
 * async in the background). Sending a continuation would create a duplicate
 * approval/queued turn.
 */
export const AUTOMATION_RUN_TOOL_ID = 'rebel_automations_run';

/**
 * Error string returned by stagedToolCallsService when a staged call no longer exists
 * (already executed, rejected, or expired). Renderer hooks check this to distinguish
 * "call was already handled" from genuine MCP execution errors.
 * Must match STAGED_CALL_NOT_FOUND_ERROR in stagedToolCallsService.ts.
 */
export const STAGED_CALL_NOT_FOUND_ERROR = 'Staged call not found';

/**
 * Stable error constants for staged call failure modes.
 * Must match the constants in stagedToolCallsService.ts.
 * Used by renderer hooks to classify failures into user-friendly messages.
 */
export const STAGED_CALL_ALREADY_EXECUTING_ERROR = 'Already executing';
export const STAGED_CALL_EXPIRED_ERROR = 'This action has expired. Please ask the assistant to try again.';
export const STAGED_CALL_MCP_UNAVAILABLE_ERROR = 'MCP service unavailable. Please try again.';
export const STAGED_CALL_STATUS_PREFIX = 'Cannot execute call with status:';

/**
 * Schema for staged call execution result.
 */
export const StagedCallResultSchema = z.object({
  success: z.boolean(),
  content: z.string().optional(),
  error: z.string().optional(),
  executedAt: z.number(),
});

/**
 * Schema for batch execution result.
 */
export const BatchExecutionResultSchema = z.object({
  executed: z.array(z.object({
    id: z.string(),
    result: StagedCallResultSchema,
  })),
});

export const safetyChannels = {
  'tool-safety:pending': defineInvokeChannel({
    channel: 'tool-safety:pending',
    request: z.void(),
    response: z.array(ToolApprovalRequestSchema),
    description: 'Load pending tool approval requests (survives app restart)',
  }),

  // Staged tool calls channels
  'tool-safety:staged-get-all': defineInvokeChannel({
    channel: 'tool-safety:staged-get-all',
    request: z.object({ sessionId: z.string().optional() }).optional(),
    response: z.array(StagedToolCallSchema),
    description: 'Get all staged tool calls, optionally filtered by session',
  }),

  'tool-safety:staged-execute': defineInvokeChannel({
    channel: 'tool-safety:staged-execute',
    request: z.object({
      id: z.string(),
    }),
    response: StagedCallResultSchema,
    description: 'Execute a single staged tool call (single-use approval).',
  }),

  'tool-safety:staged-execute-batch': defineInvokeChannel({
    channel: 'tool-safety:staged-execute-batch',
    request: z.object({ ids: z.array(z.string()) }),
    response: BatchExecutionResultSchema,
    description: 'Execute multiple staged calls sequentially (stops on first failure)',
  }),

  'tool-safety:staged-reject': defineInvokeChannel({
    channel: 'tool-safety:staged-reject',
    request: z.object({ id: z.string() }),
    response: z.object({ success: z.boolean() }),
    description: 'Reject a staged tool call (user clicked "Don\'t run")',
  }),

  'tool-safety:staged-clear-session': defineInvokeChannel({
    channel: 'tool-safety:staged-clear-session',
    request: z.object({ sessionId: z.string() }),
    response: z.object({ cleared: z.number() }),
    description: 'Clear all staged calls for a session',
  }),
} as const;
