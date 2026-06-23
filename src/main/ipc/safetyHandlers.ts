/**
 * Safety Domain IPC Handlers
 *
 * Handles tool safety related operations including:
 * - Loading pending approvals (deny-then-retry pattern)
 * - Staged tool calls (staging pattern)
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { getBroadcastService } from '@core/broadcastService';
import { broadcastTypedPayload } from '@shared/ipc/broadcasts';
import { getPendingApprovals } from '../services/safety';
import {
  getStagedCalls,
  getPendingStagedCalls,
  executeStagedCall,
  executeStagedBatch,
  rejectStagedCall,
  clearSessionStagedCalls,
  cleanupExpiredStagedCalls,
  STAGED_CALL_NOT_FOUND_ERROR,
  type StagedToolCall,
  type StagedCallResult,
  type BatchExecutionResult,
} from '../services/safety/stagedToolCallsService';
import { sanitizeStagedToolCallForApproval } from '../services/safety/sanitizeApprovalInput';
import { registerHandler } from './utils/registerHandler';
import { createScopedLogger } from '@core/logger';
import { resolveItem, rebuildFromStores } from '../services/safety/automationPendingItemsTracker';


const log = createScopedLogger({ service: 'safetyHandlers' });

export interface SafetyHandlerDeps {
}

/**
 * Broadcast staged call update to all windows.
 */
function broadcastStagedCallUpdate(
  id: string,
  sessionId: string,
  status: StagedToolCall['status'],
  result?: StagedCallResult
): void {
  broadcastTypedPayload(getBroadcastService(), 'tool-safety:staged-call-updated', {
    id,
    sessionId,
    status,
    result,
  });
}

export function registerSafetyHandlers(_deps: SafetyHandlerDeps = {}): void {
  log.info('Registering safety handlers');

  // Clean up expired staged calls on startup
  const expiredCount = cleanupExpiredStagedCalls();
  if (expiredCount > 0) {
    log.info({ expiredCount }, 'Cleaned up expired staged calls on startup');
  }

  // Rebuild automation pending items tracker from persisted staged calls
  rebuildFromStores(getStagedCalls().filter((c) => c.status === 'pending'));

  // Legacy: Pending approvals (deny-then-retry pattern)
  registerHandler('tool-safety:pending', (_event: HandlerInvokeEvent) => {
    log.debug('tool-safety:pending handler called');
    return getPendingApprovals();
  });

  // Staged tool calls: Get all
  registerHandler(
    'tool-safety:staged-get-all',
    (_event: HandlerInvokeEvent, args?: { sessionId?: string }) => {
      log.debug({ sessionId: args?.sessionId }, 'tool-safety:staged-get-all handler called');
      return getStagedCalls(args?.sessionId).map(sanitizeStagedToolCallForApproval);
    }
  );

  // Staged tool calls: Execute single
  registerHandler(
    'tool-safety:staged-execute',
    async (_event: HandlerInvokeEvent, args: { id: string }): Promise<StagedCallResult> => {
      log.info({ id: args.id }, 'Executing staged tool call');

      // Get the staged call to find sessionId for broadcast
      const stagedCall = getStagedCalls().find((c) => c.id === args.id);
      if (!stagedCall) {
        return { success: false, error: STAGED_CALL_NOT_FOUND_ERROR, executedAt: Date.now() };
      }

      // No premature 'executing' broadcast — local UI spinner is sufficient.
      // Broadcast the authoritative final status only after execution completes.
      const outcome = await executeStagedCall(args.id);

      broadcastStagedCallUpdate(args.id, stagedCall.sessionId, outcome.status, outcome.result);

      // Track resolution in automation pending items tracker
      if (stagedCall.automationId) {
        resolveItem(stagedCall.automationId, args.id, 'approved');
      }

      return outcome.result;
    }
  );

  // Staged tool calls: Execute batch
  registerHandler(
    'tool-safety:staged-execute-batch',
    async (_event: HandlerInvokeEvent, args: { ids: string[] }): Promise<BatchExecutionResult> => {
      log.info({ ids: args.ids }, 'Executing staged tool calls batch');

      // Snapshot calls BEFORE execution to avoid stale reads after status updates
      const callsSnapshot = new Map<string, { sessionId: string; automationId?: string }>();
      for (const call of getStagedCalls()) {
        if (args.ids.includes(call.id)) {
          callsSnapshot.set(call.id, { sessionId: call.sessionId, automationId: call.automationId });
        }
      }

      // No premature 'executing' broadcasts — each call's final status is
      // broadcast after execution completes (or is skipped).
      const result = await executeStagedBatch(args.ids);

      // Broadcast final status for each call and resolve tracker items
      for (const executed of result.executed) {
        const call = callsSnapshot.get(executed.id);
        if (call) {
          const status = executed.result.success ? 'executed' : 'failed';
          broadcastStagedCallUpdate(executed.id, call.sessionId, status, executed.result);

          // Resolve tracker items for automation pending items
          if (call.automationId) {
            resolveItem(call.automationId, executed.id, 'approved');
          }
        }
      }

      return result;
    }
  );

  // Staged tool calls: Reject
  registerHandler(
    'tool-safety:staged-reject',
    (_event: HandlerInvokeEvent, args: { id: string }): { success: boolean } => {
      log.info({ id: args.id }, 'Rejecting staged tool call');

      const stagedCall = getStagedCalls().find((c) => c.id === args.id);
      if (!stagedCall) {
        return { success: false };
      }

      rejectStagedCall(args.id);
      broadcastStagedCallUpdate(args.id, stagedCall.sessionId, 'rejected');

      // Track rejection in automation pending items tracker
      if (stagedCall.automationId) {
        resolveItem(stagedCall.automationId, args.id, 'rejected');
      }

      return { success: true };
    }
  );

  // Staged tool calls: Clear session
  registerHandler(
    'tool-safety:staged-clear-session',
    (_event: HandlerInvokeEvent, args: { sessionId: string }): { cleared: number } => {
      log.info({ sessionId: args.sessionId }, 'Clearing staged calls for session');

      const pendingBefore = getPendingStagedCalls(args.sessionId).length;
      clearSessionStagedCalls(args.sessionId);

      return { cleared: pendingBefore };
    }
  );

  // Periodic cleanup of expired and old terminal-state staged calls (every 6 hours)
  setInterval(cleanupExpiredStagedCalls, 6 * 60 * 60 * 1000);

  log.info('Safety handlers registered successfully');
}
