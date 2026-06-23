/**
 * useStagedToolCalls Hook
 *
 * Manages staged tool calls awaiting user approval.
 * Similar to useToolApproval but uses the staging pattern (execute later)
 * instead of deny-then-retry pattern.
 *
 * Flow:
 * 1. Tool is evaluated as requiring approval
 * 2. If it's an MCP side-effect tool, it gets staged (not denied)
 * 3. Agent receives "staged" message and can continue
 * 4. User sees staged calls in UI, can execute or reject
 * 5. On execute: call runs via MCP, result sent as continuation message
 */

import { useState, useEffect, useCallback } from 'react';
import { summarizeStagedExecutionResult } from '@shared/utils/stagedExecutionSummary';
import {
  AUTOMATION_RUN_TOOL_ID,
  STAGED_CALL_NOT_FOUND_ERROR,
  type StagedToolCallPayload,
} from '@shared/ipc/channels/safety';
import {
  approvalOutcomeMessage,
  classifyStagedError,
  ARG_RECOVERING_CONVERSATION_LINE,
  ARG_NEEDS_DETAIL_CONVERSATION_LINE,
  CONNECTOR_UNAVAILABLE_CONVERSATION_LINE,
} from '../../inbox/hooks/usePendingApprovals';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

/**
 * Extract a clean summary from MCP tool execution output.
 * The raw content is a JSON envelope from super-mcp (package_id, tool_id, args_used,
 * result, telemetry). We strip the envelope and return just the inner result text,
 * or a simple success message if the inner result is also opaque.
 */
export function summarizeExecutionResult(rawContent: string): string {
  return summarizeStagedExecutionResult(rawContent);
}

export interface UseStagedToolCallsReturn {
  /** Staged calls pending approval for current session (with optional allowPermanentTrust) */
  stagedCalls: Array<StagedToolCallPayload & { allowPermanentTrust?: boolean }>;
  /** Execute a single staged call */
  execute: (id: string) => Promise<void>;
  /** Execute all pending staged calls for session */
  executeAll: () => Promise<void>;
  /** Reject a staged call (don't run) */
  reject: (id: string) => void;
  /** Reject all pending staged calls */
  rejectAll: () => void;
  /** Whether any execution is in progress */
  isExecuting: boolean;
}

export function useStagedToolCalls(
  currentSessionId: string | null,
  sendMessage?: (text: string, targetSessionId?: string, receiptText?: string) => void
): UseStagedToolCallsReturn {
  const [stagedCalls, setStagedCalls] = useState<Array<StagedToolCallPayload & { allowPermanentTrust?: boolean }>>([]);
  const [isExecuting, setIsExecuting] = useState(false);

  // Load staged calls when session changes
  useEffect(() => {
    if (!currentSessionId) {
      setStagedCalls([]);
      return;
    }

    let isCurrent = true;

    window.safetyApi.stagedGetAll({ sessionId: currentSessionId }).then((calls) => {
      if (!isCurrent) return;
      setStagedCalls(calls.filter((c) => c.status === 'pending'));
    }).catch((err) => {
      console.error('Failed to load staged calls:', err);
    });

    return () => { isCurrent = false; };
  }, [currentSessionId]);

  // Listen for new staged calls
  useIpcEvent(window.api.onStagedToolCall, (data) => {
    if (data.sessionId !== currentSessionId) return;

    // Add to list (the full payload will be fetched or constructed)
    setStagedCalls((prev) => {
      if (prev.some((c) => c.id === data.id)) return prev;
      // Construct a minimal payload from the broadcast
      const newCall: StagedToolCallPayload & { allowPermanentTrust?: boolean } = {
        id: data.id,
        sessionId: data.sessionId,
        turnId: '',
        timestamp: data.timestamp,
        expiresAt: data.timestamp + 24 * 60 * 60 * 1000,
        status: 'pending',
        mcpPayload: {
          packageId: data.packageId,
          toolId: data.toolId,
          args: {},
        },
        displayName: data.displayName,
        toolCategory: 'side-effect',
        riskLevel: data.riskLevel,
        reason: data.reason,
        allowPermanentTrust: data.allowPermanentTrust,
        automationName: data.automationName,
      };
      return [...prev, newCall];
    });
  }, [currentSessionId]);

  // Listen for staged call updates (status changes)
  useIpcEvent(window.api.onStagedToolCallUpdated, (data) => {
    if (data.sessionId !== currentSessionId) return;

    setStagedCalls((prev) => {
      // Keep only pending and executing calls; remove all terminal states
      // (executed, rejected, expired, failed). Failed calls are removed
      // because the failure is already reported as a conversation message.
      if (data.status !== 'pending' && data.status !== 'executing') {
        return prev.filter((c) => c.id !== data.id);
      }
      return prev.map((c) =>
        c.id === data.id ? { ...c, status: data.status, result: data.result } : c
      );
    });
  }, [currentSessionId]);

  // Execute a single staged call
  // NOTE: We look up the call in stagedCalls for display name, but proceed with IPC even if not found.
  // This handles edge cases where state is stale (e.g., session switch timing, hot reload).
  const execute = useCallback(async (id: string) => {
    const call = stagedCalls.find((c) => c.id === id);
    if (call && call.status !== 'pending') return;
    // Proceed even if call not found in local state - the main process is the source of truth
    const displayName = call?.displayName || 'action';

    setIsExecuting(true);

    try {
      const result = await window.safetyApi.stagedExecute({ id });

      // Handle stale call (already executed/rejected/expired in main process).
      // Use exact match — MCP errors like "Tool not found: ..." must NOT trigger this.
      if (!result.success && result.error === STAGED_CALL_NOT_FOUND_ERROR) {
        console.warn('Staged call no longer exists in main process:', id);
        setStagedCalls((prev) => prev.filter((c) => c.id !== id));
        return;
      }

      if (result.success) {
        // Automation-run tools handle their own execution pipeline (scheduler.runNow).
        // Sending a continuation would create a duplicate queued turn.
        const isAutomationRun = call?.mcpPayload.toolId === AUTOMATION_RUN_TOOL_ID;

        // Send continuation message with clean summary (not the full MCP JSON envelope)
        // Route to the originating session so switching conversations doesn't misroute
        if (sendMessage && !isAutomationRun) {
          const summary = summarizeExecutionResult(result.content || 'Operation completed successfully.');
          const message = `Executed: ${displayName}\n\nResult:\n${summary}`;
          const receipt = `Executed: ${displayName}`;
          sendMessage(message, call?.sessionId, receipt);
        }
        setStagedCalls((prev) => prev.filter((c) => c.id !== id));
      } else {
        // Remove the failed call from UI — the failure message sent to
        // the conversation below is sufficient feedback for the user.
        setStagedCalls((prev) => prev.filter((c) => c.id !== id));
        const outcome = classifyStagedError(result.error);
        if (outcome.reason !== 'already-handled' && outcome.reason !== 'already-executing') {
          if (sendMessage) {
            // In-conversation surface: Rebel narrates its own work in the
            // first person. For the arg-validation class use the calm
            // first-person lines (FOX-3519) — recovering ("give me a moment")
            // vs terminal ("tell me what you had in mind"); the toast copy is
            // third-person system status, wrong for the transcript. Non-empty
            // by construction so we never render a bare "<DisplayName>: ".
            const userMessage = outcome.reason === 'arg-recovering'
              ? ARG_RECOVERING_CONVERSATION_LINE
              : outcome.reason === 'arg-needs-detail'
                ? ARG_NEEDS_DETAIL_CONVERSATION_LINE
                : outcome.reason === 'connector-unavailable'
                  ? CONNECTOR_UNAVAILABLE_CONVERSATION_LINE
                  : approvalOutcomeMessage(outcome);
            sendMessage(`${displayName}: ${userMessage}`, call?.sessionId);
          }
        }
      }
    } catch (err) {
      console.error('Failed to execute staged call:', err);
      setStagedCalls((prev) => prev.filter((c) => c.id !== id));
      if (sendMessage) {
        sendMessage(`${displayName}: Couldn't reach Rebel. Try again in a moment.`, call?.sessionId);
      }
    } finally {
      setIsExecuting(false);
    }
  }, [stagedCalls, sendMessage]);

  // Execute all pending calls
  const executeAll = useCallback(async () => {
    const pendingCalls = stagedCalls.filter((c) => c.status === 'pending');
    if (pendingCalls.length === 0) return;

    setIsExecuting(true);
    const ids = pendingCalls.map((c) => c.id);

    try {
      const result = await window.safetyApi.stagedExecuteBatch({ ids });

      // Build continuation message with all results.
      // Automation-run tools are excluded — they handle their own execution pipeline.
      if (sendMessage) {
        const messages: string[] = [];

        for (const executed of result.executed) {
          const call = pendingCalls.find((c) => c.id === executed.id);
          if (!call) continue; // stale local state — can't build a message without display name
          // Automation-run tools handle their own execution pipeline (scheduler.runNow)
          if (call.mcpPayload.toolId === AUTOMATION_RUN_TOOL_ID) continue;

          if (executed.result.success) {
            const summary = summarizeExecutionResult(executed.result.content || 'Completed');
            messages.push(`✓ ${call.displayName}: ${summary}`);
          } else {
            const outcome = classifyStagedError(executed.result.error);
            if (outcome.reason === 'already-handled' || outcome.reason === 'already-executing') {
              continue;
            }
            // Arg-validation class: not a `✗`-marked failure. Recovering →
            // calm "give me a moment"; terminal (exhausted) → "tell me what you
            // had in mind". Both first-person, jargon-free, so the transcript
            // doesn't read as a hard failure or leak validator text (FOX-3519).
            if (outcome.reason === 'arg-recovering') {
              messages.push(`${call.displayName}: ${ARG_RECOVERING_CONVERSATION_LINE}`);
            } else if (outcome.reason === 'arg-needs-detail') {
              messages.push(`${call.displayName}: ${ARG_NEEDS_DETAIL_CONVERSATION_LINE}`);
            } else if (outcome.reason === 'connector-unavailable') {
              // Lost-connection class: not a hard `✗` failure for the user — calm
              // first-person reconnect line, no raw transport dump (Stage 3 / B2).
              messages.push(`${call.displayName}: ${CONNECTOR_UNAVAILABLE_CONVERSATION_LINE}`);
            } else {
              messages.push(`✗ ${call.displayName}: ${approvalOutcomeMessage(outcome)}`);
            }
          }
        }

        if (messages.length > 0) {
          const receipt = messages.length === 1
            ? `Executed: ${pendingCalls.find((c) => c.mcpPayload.toolId !== AUTOMATION_RUN_TOOL_ID)?.displayName ?? 'action'}`
            : `Executed ${messages.length} queued actions`;
          sendMessage(`Executed ${messages.length} queued action(s):\n\n${messages.join('\n')}`, currentSessionId ?? undefined, receipt);
        }
      }

      // Remove all executed calls from UI (success, failure, or stale).
      // Failures are already reported in the conversation message above.
      const removeIds = new Set(result.executed.map((e) => e.id));
      setStagedCalls((prev) => prev.filter((c) => !removeIds.has(c.id)));
    } catch (err) {
      console.error('Failed to execute batch:', err);
      if (sendMessage) {
        sendMessage("Couldn't run queued actions. Try again in a moment.", currentSessionId ?? undefined);
      }
    } finally {
      setIsExecuting(false);
    }
  }, [stagedCalls, sendMessage, currentSessionId]);

  // Reject a single call
  const reject = useCallback((id: string) => {
    window.safetyApi.stagedReject({ id }).catch((err) => {
      console.error('Failed to reject staged call:', err);
    });
    setStagedCalls((prev) => prev.filter((c) => c.id !== id));
  }, []);

  // Reject all calls
  const rejectAll = useCallback(() => {
    for (const call of stagedCalls) {
      window.safetyApi.stagedReject({ id: call.id }).catch((err) => {
        console.error('Failed to reject staged call:', err);
      });
    }
    setStagedCalls([]);
  }, [stagedCalls]);

  return {
    stagedCalls,
    execute,
    executeAll,
    reject,
    rejectAll,
    isExecuting,
  };
}
