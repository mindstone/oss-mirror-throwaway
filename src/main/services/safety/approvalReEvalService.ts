import { randomUUID } from 'node:crypto';
import { getBroadcastService } from '@core/broadcastService';
import { broadcastTypedPayload } from '@shared/ipc/broadcasts';
import { evaluateSafetyPrompt, shouldAllow } from '@core/safetyPromptLogic';
import { getSafetyPromptVersion } from '@core/safetyPromptStore';
import { derivePolicy } from '@core/services/turnPolicy';
import type { ActionContext } from '@core/safetyPromptTypes';
import { createScopedLogger } from '@core/logger';
import { summarizeStagedExecutionResult } from '@shared/utils/stagedExecutionSummary';
import type { AuxiliaryTurnConfig } from '@shared/utils/auxiliaryTurnConfig';
import { resolveAuxiliaryTurnModelOverrides } from '@shared/utils/auxiliaryTurnConfig';
import { executeAgentTurn } from '../agentTurnExecutor';
import { resolveItem } from './automationPendingItemsTracker';
import { handleMemoryWriteApprovalResponse } from './memoryWriteHook';
import {
  getPendingApprovals,
  getPendingMemoryApprovals,
  removePendingApproval,
  type PersistedMemoryApprovalRequest,
  type PersistedToolApprovalRequest,
} from './pendingApprovalsStore';
import { storeSingleUseApproval } from './sessionApprovals';
import {
  executeStagedCall,
  getPendingStagedCalls,
  type StagedToolCall,
} from './stagedToolCallsService';

const log = createScopedLogger({ service: 'approvalReEvalService' });

const STAGED_SAFETY_BLOCK_PREFIX = 'Safety Rules blocked:';

interface ContinuationEntry {
  sessionId: string;
  message: string;
}

function hasExpectedPromptVersion(promptVersion: number): boolean {
  return getSafetyPromptVersion() === promptVersion;
}

function summarizeToolName(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'mcp__super-mcp-router__use_tool' || toolName === 'use_tool') {
    const innerToolName = input.tool_id;
    if (typeof innerToolName === 'string' && innerToolName.trim().length > 0) {
      return innerToolName;
    }
  }
  return toolName;
}

function getEffectiveToolId(approval: PersistedToolApprovalRequest): string {
  if (approval.effectiveToolId && approval.effectiveToolId.trim().length > 0) {
    return approval.effectiveToolId;
  }
  return summarizeToolName(approval.toolName, approval.input);
}

function sendGroupedContinuations(continuations: ContinuationEntry[]): void {
  const policy = derivePolicy(undefined);
  const auxiliaryTurnConfig = {
    mode: 'inherit_user_session',
    reason: 'Auto-approval re-eval resumes the user session and must preserve normal model and planning inheritance.',
  } satisfies AuxiliaryTurnConfig;
  const auxiliaryOverrides = resolveAuxiliaryTurnModelOverrides(auxiliaryTurnConfig);
  const bySession = new Map<string, string[]>();
  for (const c of continuations) {
    const existing = bySession.get(c.sessionId);
    if (existing) {
      existing.push(c.message);
    } else {
      bySession.set(c.sessionId, [c.message]);
    }
  }

  for (const [sessionId, messages] of bySession) {
    const combined = messages.length === 1
      ? messages[0]
      : messages.join('\n\n---\n\n');
    void executeAgentTurn(null, randomUUID(), combined, {
      sessionId,
      resetConversation: false,
      modelOverride: auxiliaryOverrides.modelOverride,
      workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId,
      thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride,
      policy,
      // Auto-approval re-eval resumes the user session on the app's behalf — a
      // system continuation, NOT a user-initiated turn. Exclude it from the
      // Chief-of-Staff admission gate (260622 Stage 3). See turnAdmission.admit.
      isSystemContinuation: true,
    }).catch((err) => {
      log.warn({ err, sessionId }, 'Failed to send grouped continuation after auto-approval re-eval');
    });
  }
}

async function reEvaluateToolApprovals(
  safetyPrompt: string,
  promptVersion: number,
  approvals: PersistedToolApprovalRequest[],
  continuations: ContinuationEntry[],
): Promise<number> {
  let resolved = 0;
  const broadcastService = getBroadcastService();

  for (const approval of approvals) {
    try {
      const actionContext: ActionContext = {
        toolName: approval.toolName,
        toolInput: approval.input,
      };
      const evalResult = await evaluateSafetyPrompt(safetyPrompt, promptVersion, actionContext);
      const effectiveToolId = getEffectiveToolId(approval);

      if (!shouldAllow(evalResult, effectiveToolId ?? approval.toolName)) {
        continue;
      }

      if (!hasExpectedPromptVersion(promptVersion)) {
        log.info('Version changed during tool approval re-eval; skipping remaining tool approvals');
        break;
      }

      if (!approval.sessionId) {
        log.warn(
          { toolUseID: approval.toolUseID, toolName: approval.toolName },
          'Skipping auto-resolve for tool approval without sessionId',
        );
        continue;
      }

      // expectExecution: this path pushes an "Approved. Please retry" continuation
      // below — same legacy model-mediated retry shape as user-clicked approvals,
      // so it opts into the approval-execution guard (FOX-2771 Stage 2).
      storeSingleUseApproval('tool', approval.sessionId, effectiveToolId, { expectExecution: true });
      removePendingApproval(approval.toolUseID);

      broadcastTypedPayload(broadcastService, 'tool-safety:approval-resolved', {
        toolUseID: approval.toolUseID,
        sessionId: approval.sessionId,
        approved: true,
      });

      continuations.push({
        sessionId: approval.sessionId,
        message: `Approved. Please retry: ${summarizeToolName(approval.toolName, approval.input)}`,
      });
      resolved += 1;
    } catch (err) {
      log.warn(
        { err, toolUseID: approval.toolUseID, toolName: approval.toolName },
        'Tool approval re-evaluation failed; leaving pending',
      );
    }
  }

  return resolved;
}

async function reEvaluateStagedCalls(
  safetyPrompt: string,
  promptVersion: number,
  stagedCalls: StagedToolCall[],
  continuations: ContinuationEntry[],
): Promise<number> {
  let resolved = 0;
  const broadcastService = getBroadcastService();

  for (const stagedCall of stagedCalls) {
    try {
      const actionContext: ActionContext = {
        toolName: 'mcp__super-mcp-router__use_tool',
        toolInput: {
          package_id: stagedCall.mcpPayload.packageId,
          tool_id: stagedCall.mcpPayload.toolId,
          args: stagedCall.mcpPayload.args,
        },
        sessionType: stagedCall.automationId ? 'automation' : undefined,
        automationName: stagedCall.automationName,
      };

      const evalResult = await evaluateSafetyPrompt(safetyPrompt, promptVersion, actionContext);
      if (!shouldAllow(evalResult, stagedCall.mcpPayload.toolId)) {
        continue;
      }

      if (!hasExpectedPromptVersion(promptVersion)) {
        log.info('Version changed during staged call re-eval; skipping remaining staged calls');
        break;
      }

      const outcome = await executeStagedCall(stagedCall.id);

      if (outcome.status !== 'executed') {
        log.warn(
          { stagedCallId: stagedCall.id, status: outcome.status },
          'Staged call execution did not succeed; leaving as-is',
        );
        broadcastTypedPayload(broadcastService, 'tool-safety:staged-call-updated', {
          id: stagedCall.id,
          sessionId: stagedCall.sessionId,
          status: outcome.status,
          result: outcome.result,
        });
        continue;
      }

      broadcastTypedPayload(broadcastService, 'tool-safety:staged-call-updated', {
        id: stagedCall.id,
        sessionId: stagedCall.sessionId,
        status: outcome.status,
        result: outcome.result,
      });

      if (stagedCall.automationId) {
        resolveItem(stagedCall.automationId, stagedCall.id, 'approved');
      } else {
        const resultText = summarizeStagedExecutionResult(
          outcome.result.content || 'Completed successfully'
        );
        continuations.push({
          sessionId: stagedCall.sessionId,
          message: `Executed: ${stagedCall.displayName}\n\nResult:\n${resultText}`,
        });
      }

      resolved += 1;
    } catch (err) {
      log.warn(
        {
          err,
          stagedCallId: stagedCall.id,
          packageId: stagedCall.mcpPayload.packageId,
          toolId: stagedCall.mcpPayload.toolId,
        },
        'Staged tool re-evaluation failed; leaving pending',
      );
    }
  }

  return resolved;
}

async function reEvaluateMemoryApprovals(
  safetyPrompt: string,
  promptVersion: number,
  approvals: PersistedMemoryApprovalRequest[],
  continuations: ContinuationEntry[],
): Promise<number> {
  let resolved = 0;
  const broadcastService = getBroadcastService();

  for (const approval of approvals) {
    try {
      const sharingLabel = approval.sharing ? ` (${approval.sharing} sharing)` : '';
      const actionContext: ActionContext = {
        toolName: 'memory_write',
        toolInput: {
          file_path: approval.filePath,
          space_name: approval.spaceName,
          content_preview: approval.content?.slice(0, 500),
        },
        toolDescription: `Memory write to "${approval.spaceName}" space${sharingLabel}`,
        spaceDescription: `${approval.spaceName}${sharingLabel}`,
      };

      const evalResult = await evaluateSafetyPrompt(safetyPrompt, promptVersion, actionContext);
      if (!shouldAllow(evalResult, 'memory_write')) {
        continue;
      }

      if (!hasExpectedPromptVersion(promptVersion)) {
        log.info('Version changed during memory approval re-eval; skipping remaining memory approvals');
        break;
      }

      const result = handleMemoryWriteApprovalResponse(approval.toolUseId, true);
      if (!result.success) {
        log.warn(
          { toolUseId: approval.toolUseId, originalSessionId: approval.originalSessionId },
          'Memory approval auto-resolution could not complete (may already be resolved)',
        );
        continue;
      }

      const continuationSessionId = result.originalSessionId ?? approval.originalSessionId;
      if (!continuationSessionId) {
        log.warn(
          { toolUseId: approval.toolUseId },
          'Skipping continuation for memory approval without originalSessionId',
        );
        continue;
      }

      broadcastTypedPayload(broadcastService, 'memory:write-approval-resolved', {
        toolUseId: approval.toolUseId,
        originalSessionId: continuationSessionId,
        approved: true,
      });

      const filePath = result.filePath ?? approval.filePath;
      const spaceName = result.spaceName ?? approval.spaceName;
      const content = result.content ?? approval.content;
      continuations.push({
        sessionId: continuationSessionId,
        message: `User approved this memory write. Please retry it now.\n\nSpace: ${spaceName}\nFile: ${filePath}\n\n${content}`,
      });

      resolved += 1;
    } catch (err) {
      log.warn(
        {
          err,
          toolUseId: approval.toolUseId,
          filePath: approval.filePath,
          originalSessionId: approval.originalSessionId,
        },
        'Memory approval re-evaluation failed; leaving pending',
      );
    }
  }

  return resolved;
}

export async function reEvaluatePendingApprovals(
  safetyPrompt: string,
  promptVersion: number,
): Promise<void> {
  const pendingToolApprovals = getPendingApprovals();
  const pendingStagedCalls = getPendingStagedCalls().filter((call) =>
    call.reason?.startsWith(STAGED_SAFETY_BLOCK_PREFIX),
  );
  const pendingMemoryApprovals = getPendingMemoryApprovals().filter(
    (approval) => approval.blockedBy === 'safety_prompt' || approval.blockedBy === 'eval_error',
  );

  const totalCandidates =
    pendingToolApprovals.length + pendingStagedCalls.length + pendingMemoryApprovals.length;

  if (totalCandidates === 0) {
    log.debug('No pending approvals eligible for auto re-evaluation');
    return;
  }

  log.info(
    {
      promptVersion,
      pendingToolApprovals: pendingToolApprovals.length,
      pendingStagedCalls: pendingStagedCalls.length,
      pendingMemoryApprovals: pendingMemoryApprovals.length,
    },
    'Starting pending approvals auto re-evaluation',
  );

  const continuations: ContinuationEntry[] = [];

  const resolvedTools = await reEvaluateToolApprovals(
    safetyPrompt,
    promptVersion,
    pendingToolApprovals,
    continuations,
  );

  const resolvedStaged = await reEvaluateStagedCalls(
    safetyPrompt,
    promptVersion,
    pendingStagedCalls,
    continuations,
  );

  const resolvedMemory = await reEvaluateMemoryApprovals(
    safetyPrompt,
    promptVersion,
    pendingMemoryApprovals,
    continuations,
  );

  const totalResolved = resolvedTools + resolvedStaged + resolvedMemory;

  if (continuations.length > 0) {
    sendGroupedContinuations(continuations);
  }

  log.info(
    {
      totalResolved,
      totalCandidates,
      resolvedTools,
      resolvedStaged,
      resolvedMemory,
    },
    `Auto-resolved ${totalResolved}/${totalCandidates} pending approvals after safety prompt update`,
  );
}
