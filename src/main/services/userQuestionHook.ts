/**
 * User Question PreToolUse Hook
 *
 * Intercepts the built-in `AskUserQuestion` tool using the
 * deny-and-retry pattern. When the agent calls AskUserQuestion:
 *
 * 1. Validates the payload
 * 2. Generates a batchId and persists the question batch
 * 3. Dispatches a `user_question` AgentEvent to the renderer
 * 4. Returns `{ continue: false }` to end the turn cleanly
 *
 * The renderer shows an inline question card. When the user submits,
 * answers flow back via IPC and a continuation message resumes the agent.
 */

import { randomUUID } from 'node:crypto';
import type { HookCallback } from '@core/agentRuntimeTypes';
import { createScopedLogger } from '@core/logger';
import { agentTurnRegistry } from '@core/services/agentTurnRegistry';
import type { AgentEvent } from '@shared/types';
import type { UserQuestion, QuestionOption, UserQuestionPurpose } from '@shared/types/userQuestion';
import {
  inferApprovalClarificationPurpose,
  isChatApprovalQuestionBatch,
  QUESTION_PURPOSE_APPROVAL_CLARIFICATION,
} from '@shared/types/userQuestion';
import type { SequencedAgentEvent } from '@shared/utils/eventIdentity';
import { broadcastSequencedAgentEvent } from './agentEventDispatcher';

const logger = createScopedLogger({ service: 'userQuestionHook' });

const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

interface SdkQuestionOption {
  label: string;
  description: string;
  requiresInput?: boolean;
  inputPlaceholder?: string;
  url?: string;
}

interface SdkQuestion {
  question: string;
  header: string;
  context?: string;
  options: SdkQuestionOption[];
  multiSelect: boolean;
  /**
   * Optional semantic discriminator authored by the agent. Stage 2 of
   * `docs/plans/260518_reduce_approval_clarification_branch_scope.md` only
   * recognises `approval_clarification`; any other value is rejected so a
   * future, broader `purpose` enum cannot silently shed semantics here.
   */
  purpose?: UserQuestionPurpose;
}

interface AskUserQuestionInput {
  questions: SdkQuestion[];
}

/**
 * Validate the AskUserQuestion tool input from the agent.
 * Returns null if invalid, or the parsed input if valid.
 *
 * Stage 2 hardening: also enforces single-purpose batches. If any question
 * carries `purpose: 'approval_clarification'`, ALL questions in the batch
 * must carry the same purpose. Mixed-purpose batches are rejected
 * fail-closed — see
 * `docs/plans/260518_reduce_approval_clarification_branch_scope.md`.
 */
function validatePayload(toolInput: unknown): AskUserQuestionInput | null {
  if (!toolInput || typeof toolInput !== 'object') return null;

  const input = toolInput as Record<string, unknown>;
  if (!Array.isArray(input.questions) || input.questions.length === 0) return null;

  const purposes = new Set<string | undefined>();

  for (const q of input.questions) {
    if (!q || typeof q !== 'object') return null;
    const question = q as Record<string, unknown>;
    if (typeof question.question !== 'string' || !question.question.trim()) return null;
    if (typeof question.header !== 'string') return null;
    if (question.context !== undefined && typeof question.context !== 'string') return null;
    if (!Array.isArray(question.options)) return null;
    for (const opt of question.options) {
      if (!opt || typeof opt !== 'object') return null;
      const option = opt as Record<string, unknown>;
      if (typeof option.label !== 'string' || !option.label.trim()) return null;
      if (typeof option.description !== 'string') return null;
      if (option.requiresInput !== undefined && typeof option.requiresInput !== 'boolean') return null;
      if (option.inputPlaceholder !== undefined && typeof option.inputPlaceholder !== 'string') return null;
      if (option.url !== undefined && typeof option.url !== 'string') return null;
    }
    if (question.purpose !== undefined) {
      // Stage 2 only recognises `approval_clarification`. Any other value
      // is a contract drift signal — reject the batch fail-closed rather
      // than silently dropping the unknown semantic.
      if (question.purpose !== QUESTION_PURPOSE_APPROVAL_CLARIFICATION) return null;
      purposes.add(QUESTION_PURPOSE_APPROVAL_CLARIFICATION);
    } else {
      purposes.add(undefined);
    }
  }

  // Reject mixed-purpose batches: either every question is approval-context
  // clarification, or none are. Mixing trust semantics in one batch breaks
  // the UI receipt/cancel guarantees and is rejected before the event is
  // ever broadcast.
  if (purposes.size > 1) return null;

  return input as unknown as AskUserQuestionInput;
}

/**
 * Transform question options into our internal format with stable IDs.
 */
function transformOptions(sdkOptions: SdkQuestionOption[], questionIndex: number): QuestionOption[] {
  return sdkOptions.map((opt, optIndex) => ({
    id: `q${questionIndex}-opt${optIndex}`,
    label: opt.label,
    description: opt.description,
    ...(opt.requiresInput && { requiresInput: true }),
    ...(opt.inputPlaceholder && { inputPlaceholder: opt.inputPlaceholder }),
    ...(opt.url && { url: opt.url }),
  }));
}

/**
 * Transform agent questions into our internal format.
 */
function transformQuestions(sdkQuestions: SdkQuestion[]): UserQuestion[] {
  const inferredBatchPurpose = sdkQuestions.every(
    (question) => inferApprovalClarificationPurpose(question) === QUESTION_PURPOSE_APPROVAL_CLARIFICATION,
  )
    ? QUESTION_PURPOSE_APPROVAL_CLARIFICATION
    : undefined;

  return sdkQuestions.map((q, index) => {
    const purpose = q.purpose ?? inferredBatchPurpose;

    return {
      id: `q${index}`,
      question: q.question,
      header: q.header,
      ...(q.context ? { context: q.context } : {}),
      options: transformOptions(q.options, index),
      multiSelect: q.multiSelect ?? false,
      ...(purpose ? { purpose } : {}),
    };
  });
}

/**
 * Creates a PreToolUse hook that intercepts AskUserQuestion tool calls.
 *
 * @param sessionId - The current session ID
 * @param turnId - The current turn ID
 */
export function createUserQuestionHook(
  sessionId: string,
  turnId: string,
): HookCallback {
  return async (input, toolUseId) => {
    // Only intercept AskUserQuestion
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (input.tool_name !== ASK_USER_QUESTION_TOOL) return {};

    logger.info(
      { toolUseId, sessionId, turnId },
      'Intercepting AskUserQuestion tool call',
    );

    // Validate the payload
    const parsed = validatePayload(input.tool_input);
    if (!parsed) {
      logger.warn(
        { toolUseId, toolInput: JSON.stringify(input.tool_input).slice(0, 500) },
        'Invalid AskUserQuestion payload — allowing default handling',
      );
      return {};
    }

    if (isChatApprovalQuestionBatch(parsed)) {
      logger.warn(
        { toolUseId, sessionId, turnId },
        'Blocked approval-like AskUserQuestion payload — use action-tool approval path',
      );
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            'AskUserQuestion cannot be used for approval or Send/Edit/Cancel confirmation. Use the normal action tool with the resolved inputs so Safety Rules can stage, block, or show the approval in the drawer.',
        },
      };
    }

    // Transform into our internal types
    const questions = transformQuestions(parsed.questions);
    const batchId = randomUUID();

    const userQuestionEvent = {
      type: 'user_question' as const,
      batchId,
      toolUseId: toolUseId ?? batchId,
      questions,
      // Stamp the authoritative origin sessionId on the event itself so
      // downstream consumers (extractQuestionBatches, server-side response
      // validation) don't have to rely on render-props that can race with
      // session switches. See
      // docs-private/investigations/260424_user_question_cross_session_routing_leak.md.
      sessionId,
      timestamp: Date.now(),
    };

    // REBEL-1GE: also append to the turn's accumulator so downstream consumers
    // (empty-result anomaly classification in agentMessageHandler.ts) can see the
    // event via `eventsByTurn[turnId]` and classify the pause as `user_question`
    // rather than `ambiguous`. `dispatchAgentEvent` would do this automatically
    // but this hook uses `sendToAllWindows` for broadcast semantics and must
    // accumulate explicitly.
    let stampedUserQuestionEvent: SequencedAgentEvent<Extract<AgentEvent, { type: 'user_question' }>> | undefined;
    try {
      const accumulator = agentTurnRegistry.getOrCreateAccumulator(turnId, sessionId);
      stampedUserQuestionEvent = accumulator.appendEvent(userQuestionEvent, sessionId);
    } catch (err) {
      // Accumulator append failures must not produce an unstamped `agent:event`.
      // Without a sequenced event identity, the user-question pause cannot be
      // safely rehydrated or deduplicated across surfaces.
      logger.warn(
        { err, turnId, batchId },
        'Failed to append user_question event to turn accumulator',
      );
      return {
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason:
            'AskUserQuestion could not be prepared because the event stream could not be sequenced.',
        },
      };
    }

    agentTurnRegistry.recordUserQuestionProvenance(
      turnId,
      stampedUserQuestionEvent,
    );

    // Mark pending before broadcast so any synchronous cleanup triggered by
    // listeners preserves the accumulator and dedicated provenance index.
    agentTurnRegistry.markUserQuestionPending(turnId);

    // Dispatch the user_question event to all renderer windows.
    broadcastSequencedAgentEvent({
      turnId,
      event: stampedUserQuestionEvent,
      sessionId,
    });

    logger.info(
      { batchId, questionCount: questions.length, toolUseId, sessionId },
      'Dispatched user_question event — ending turn (deny-and-retry)',
    );

    // Deny the tool call and end the turn
    return {
      continue: false,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: `TOOL PAUSED — WAITING FOR USER RESPONSE

"AskUserQuestion" requires the user to answer ${questions.length} question${questions.length > 1 ? 's' : ''} before proceeding. The questions have been presented to the user in the conversation.

Do NOT retry this tool or rephrase the questions — the user will respond when ready.`,
      },
    };
  };
}
