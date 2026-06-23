/**
 * useAutomationApprovals
 *
 * Hook that loads pending approvals and maps them to automations via sessionId.
 * Automation runs have sessionIds that link to conversations, and pending
 * approvals also have sessionIds pointing to their source conversation.
 * This allows us to show which approvals belong to which automation.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { AutomationRun } from '@shared/types';
import { isGenericReason } from '@rebel/shared/approvalUtils';
import { summarizeToolForApproval } from '@renderer/features/agent-session/utils/toolChips';
import { buildToolContinuationMessage } from '@renderer/features/agent-session/utils/buildToolContinuationMessage';
import { dispatchAgentTurn } from '@renderer/features/agent-session/utils/dispatchAgentTurn';
import { saveMemoryApproval, type MemoryApprovalResult } from '@renderer/utils/saveMemoryApproval';
import { notifyOptimisticRemoval, type ApprovalOutcome } from '@renderer/features/inbox/hooks/usePendingApprovals';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';
import { classifySessionKind } from '@shared/sessionKind';

const SAFETY_RULES_BLOCKED_PREFIX = 'Safety Rules blocked:';

/** Strip the "Safety Rules blocked:" prefix for user-facing display */
export function stripSafetyPrefix(reason: string): string {
  if (reason.startsWith(SAFETY_RULES_BLOCKED_PREFIX)) {
    return reason.slice(SAFETY_RULES_BLOCKED_PREFIX.length).trim();
  }
  return reason;
}

/** Prefer specific reasons; generic safety-eval errors fall back to a tool label. */
export function getAutomationReasonDisplayText(reason: string | undefined, fallbackLabel: string): string {
  if (!reason) return fallbackLabel;
  const strippedReason = stripSafetyPrefix(reason);
  return isGenericReason(strippedReason) ? fallbackLabel : strippedReason;
}

// =============================================================================
// Types
// =============================================================================

/** Simplified approval item for display on automation cards */
export interface AutomationApprovalItem {
  /** Composite key: `tool:${id}` or `memory:${id}` */
  id: string;
  /** Approval type */
  type: 'tool' | 'memory';
  /** Human-readable description of what the tool/memory wants to do */
  description: string;
  /** When the approval was requested */
  timestamp: number;
  /** Session to navigate to for review */
  sessionId: string | null;
  /** Risk level (tool approvals only) */
  riskLevel?: 'low' | 'medium' | 'high';
  /** Package name e.g. "Gmail" (tool approvals only) */
  packageName?: string;
  /** Space name (memory approvals only) */
  spaceName?: string;
  /** Original tool approval data (for type='tool') */
  toolApproval?: {
    toolUseID: string;
    turnId: string;
    toolName: string;
    input: Record<string, unknown>;
    reason?: string;
  };
  /** Original memory approval data (for type='memory') */
  memoryApproval?: {
    toolUseId: string;
    originalSessionId: string;
    filePath: string;
    spaceName: string;
    summary: string;
    content: string;
    contentPreview?: string;
    sensitivityReason?: string;
    sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
    privateMode?: boolean;
    hasSpaceOverride?: boolean;
  };
}

export interface UseAutomationApprovalsReturn {
  /** Map of automationId to pending approvals */
  approvalsByAutomation: Map<string, AutomationApprovalItem[]>;
  /** Total count of all pending approvals across all automations */
  totalCount: number;
  /** Whether initial load is in progress */
  isLoading: boolean;
  /** Refresh approvals (called on window focus) */
  refresh: () => Promise<void>;
  /** Dismiss an approval */
  dismissApproval: (approval: AutomationApprovalItem) => Promise<boolean>;
  /** Approve a tool approval directly. Returns ApprovalOutcome with failure reason. */
  approveToolApproval: (approval: AutomationApprovalItem) => Promise<ApprovalOutcome>;
  /** Approve a memory approval directly */
  approveMemoryApproval: (approval: AutomationApprovalItem) => Promise<MemoryApprovalResult>;
}

// =============================================================================
// Hook Implementation
// =============================================================================

/**
 * Hook to load pending approvals and map them to automations.
 * @param runs - Current automation runs from the automations store
 */
export function useAutomationApprovals(
  runs: AutomationRun[],
  options?: { onSendContinuation?: (sessionId: string, message: string) => Promise<void> | void },
): UseAutomationApprovalsReturn {
  const [toolApprovals, setToolApprovals] = useState<AutomationApprovalItem[]>([]);
  const [memoryApprovals, setMemoryApprovals] = useState<AutomationApprovalItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Build a lookup: sessionId -> automationId
  const sessionToAutomation = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of runs) {
      if (run.sessionId) {
        map.set(run.sessionId, run.automationId);
      }
    }
    return map;
  }, [runs]);

  // Transform tool approval to our format
  const transformToolApproval = useCallback(
    (approval: {
      toolUseID: string;
      turnId: string;
      sessionId?: string;
      toolName: string;
      input: Record<string, unknown>;
      reason?: string;
      timestamp: number;
      riskLevel?: 'low' | 'medium' | 'high';
      packageName?: string;
    }): AutomationApprovalItem => {
      const summary = summarizeToolForApproval(approval.toolName, approval.input);
      return {
        id: `tool:${approval.toolUseID}`,
        type: 'tool',
        description: getAutomationReasonDisplayText(approval.reason, summary.label),
        timestamp: approval.timestamp,
        sessionId: approval.sessionId || null,
        riskLevel: approval.riskLevel,
        packageName: approval.packageName,
        toolApproval: {
          toolUseID: approval.toolUseID,
          turnId: approval.turnId,
          toolName: approval.toolName,
          input: approval.input,
          reason: approval.reason,
        },
      };
    },
    []
  );

  // Transform memory approval to our format
  const transformMemoryApproval = useCallback(
    (approval: {
      toolUseId: string;
      originalSessionId: string;
      filePath: string;
      spaceName: string;
      summary: string;
      content: string;
      timestamp: number;
      contentPreview?: string;
      sensitivityReason?: string;
      sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
      privateMode?: boolean;
      hasSpaceOverride?: boolean;
    }): AutomationApprovalItem => {
      return {
        id: `memory:${approval.toolUseId}`,
        type: 'memory',
        description: approval.summary || `Save to "${approval.spaceName}"`,
        timestamp: approval.timestamp,
        sessionId: approval.originalSessionId,
        spaceName: approval.spaceName,
        memoryApproval: {
          toolUseId: approval.toolUseId,
          originalSessionId: approval.originalSessionId,
          filePath: approval.filePath,
          spaceName: approval.spaceName,
          summary: approval.summary,
          content: approval.content,
          contentPreview: approval.contentPreview,
          sensitivityReason: approval.sensitivityReason,
          sharing: approval.sharing,
          privateMode: approval.privateMode,
          hasSpaceOverride: approval.hasSpaceOverride,
        },
      };
    },
    []
  );

  // Load all approvals with abort support
  const loadApprovals = useCallback(async (signal?: AbortSignal) => {
    try {
      // Load tool approvals
      const toolPending = await window.safetyApi.pending();
      if (signal?.aborted) return;
      const transformedTool = toolPending.map(transformToolApproval);
      setToolApprovals(transformedTool);

      // Load memory approvals
      const memoryPending = await window.memoryApi.getPendingApprovals({});
      if (signal?.aborted) return;
      const transformedMemory = memoryPending.map(transformMemoryApproval);
      setMemoryApprovals(transformedMemory);
    } catch (err) {
      if (signal?.aborted) return;
      console.error('Failed to load automation approvals:', err);
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }, [transformToolApproval, transformMemoryApproval]);

  // Initial load with cleanup
  useEffect(() => {
    const abortController = new AbortController();
    setIsLoading(true);
    void loadApprovals(abortController.signal);
    return () => abortController.abort();
  }, [loadApprovals]);

  // Subscribe to new tool approval requests
  useIpcEvent(window.api.onToolSafetyApprovalRequest, (request) => {
    setToolApprovals((prev) => {
      const id = `tool:${request.toolUseID}`;
      if (prev.some((a) => a.id === id)) {
        return prev;
      }
      return [...prev, transformToolApproval(request)];
    });
  }, [transformToolApproval]);

  // Subscribe to new memory approval requests
  useIpcEvent(window.api.onMemoryWriteApprovalRequest, (request) => {
    setMemoryApprovals((prev) => {
      const id = `memory:${request.toolUseId}`;
      if (prev.some((a) => a.id === id)) {
        return prev;
      }
      // Guard: cloud catch-up sends flat format (filePath/spaceName at top level)
      // while real-time broadcasts use nested destination object
      const dest = request.destination;
      const flat = request as Record<string, unknown>;
      return [
        ...prev,
        transformMemoryApproval({
          toolUseId: request.toolUseId,
          originalSessionId: request.originalSessionId,
          filePath: dest?.path ?? (flat.filePath as string) ?? '',
          spaceName: dest?.spaceName ?? (flat.spaceName as string) ?? '',
          summary: request.summary,
          content: '',
          timestamp: request.timestamp,
          contentPreview: request.contentPreview,
          sensitivityReason: request.sensitivityReason,
          sharing: dest?.sharing ?? (flat.sharing as 'private' | 'restricted' | 'company-wide' | 'public'),
          privateMode: request.privateMode,
          hasSpaceOverride: request.hasSpaceOverride,
        }),
      ];
    });
  }, [transformMemoryApproval]);

  // Subscribe to resolved approvals for real-time sync
  useEffect(() => {
    const unsubMemory = window.api.onMemoryWriteApprovalResolved((data) => {
      setMemoryApprovals((prev) => prev.filter((a) => a.memoryApproval?.toolUseId !== data.toolUseId));
    });
    const unsubTool = window.api.onToolSafetyApprovalResolved((data) => {
      setToolApprovals((prev) => prev.filter((a) => a.toolApproval?.toolUseID !== data.toolUseID));
    });
    return () => {
      unsubMemory();
      unsubTool();
    };
  }, []);

  // Poll on window focus for removals
  useEffect(() => {
    let abortController: AbortController | null = null;
    const handleFocus = () => {
      // Abort any previous in-flight request
      abortController?.abort();
      abortController = new AbortController();
      void loadApprovals(abortController.signal);
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      abortController?.abort();
    };
  }, [loadApprovals]);

  // Map approvals to automations via sessionId
  const approvalsByAutomation = useMemo(() => {
    const map = new Map<string, AutomationApprovalItem[]>();
    const allApprovals = [...toolApprovals, ...memoryApprovals];

    for (const approval of allApprovals) {
      if (!approval.sessionId) continue;
      const automationId = sessionToAutomation.get(approval.sessionId);
      if (!automationId) continue;

      const existing = map.get(automationId) || [];
      existing.push(approval);
      map.set(automationId, existing);
    }

    // Sort each automation's approvals by timestamp (newest first)
    for (const [id, approvals] of map) {
      map.set(
        id,
        approvals.sort((a, b) => b.timestamp - a.timestamp)
      );
    }

    return map;
  }, [toolApprovals, memoryApprovals, sessionToAutomation]);

  // Total count across all automations
  const totalCount = useMemo(() => {
    let count = 0;
    for (const approvals of approvalsByAutomation.values()) {
      count += approvals.length;
    }
    return count;
  }, [approvalsByAutomation]);

  // Remove an approval from local state.
  // Also signals usePendingApprovalCount to decrement immediately.
  const removeApproval = useCallback((id: string) => {
    notifyOptimisticRemoval(id);
    if (id.startsWith('tool:')) {
      setToolApprovals((prev) => prev.filter((a) => a.id !== id));
    } else if (id.startsWith('memory:')) {
      setMemoryApprovals((prev) => prev.filter((a) => a.id !== id));
    }
  }, []);

  // Restore an approval to local state (for rollback after failed optimistic update)
  const restoreApproval = useCallback((approval: AutomationApprovalItem) => {
    if (approval.type === 'tool') {
      setToolApprovals((prev) => {
        // Avoid duplicates if already restored
        if (prev.some((a) => a.id === approval.id)) return prev;
        // Insert in sorted position by timestamp (newest first)
        const next = [...prev, approval];
        return next.sort((a, b) => b.timestamp - a.timestamp);
      });
    } else if (approval.type === 'memory') {
      setMemoryApprovals((prev) => {
        if (prev.some((a) => a.id === approval.id)) return prev;
        const next = [...prev, approval];
        return next.sort((a, b) => b.timestamp - a.timestamp);
      });
    }
  }, []);

  // Dismiss an approval
  const dismissApproval = useCallback(
    async (approval: AutomationApprovalItem): Promise<boolean> => {
      try {
        if (approval.type === 'tool' && approval.toolApproval) {
          await window.agentApi.toolSafetyResponse({
            toolUseID: approval.toolApproval.toolUseID,
            approved: false,
            input: approval.toolApproval.input,
          });
        } else if (approval.type === 'memory' && approval.memoryApproval) {
          await window.api.sendMemoryWriteApprovalResponse({
            toolUseId: approval.memoryApproval.toolUseId,
            approved: false,
          });
        }
        removeApproval(approval.id);
        return true;
      } catch (err) {
        console.error('Failed to dismiss approval:', err);
        return false;
      }
    },
    [removeApproval]
  );

  // Approve a tool approval and trigger agent retry via continuation message.
  // Returns ApprovalOutcome with failure reason for contextual error handling (REBEL-10T).
  const approveToolApproval = useCallback(
    async (approval: AutomationApprovalItem): Promise<ApprovalOutcome> => {
      if (approval.type !== 'tool' || !approval.toolApproval) {
        return { ok: false, reason: 'unknown' };
      }

      // Optimistic removal
      removeApproval(approval.id);

      // Step 1: Store approval via IPC (so retry will be auto-approved).
      // If this fails, the approval was never stored — restore and report.
      try {
        await window.agentApi.toolSafetyResponse({
          toolUseID: approval.toolApproval.toolUseID,
          approved: true,
          input: approval.toolApproval.input,
        });
      } catch (err) {
        console.error('Failed to store tool approval:', err);
        restoreApproval(approval);
        return { ok: false, reason: 'ipc-unavailable' };
      }

      // Step 2: Send continuation message to trigger agent retry (best-effort).
      // The approval is already stored, so a continuation failure should not
      // revert the approval or show "Failed to approve" (REBEL-10T).
      // Skip continuation for automation sessions — the auto-restart flow
      // will re-run the automation after all staged items are resolved.
      try {
        const sessionKind = approval.sessionId
          ? classifySessionKind(approval.sessionId)
          : null;
        const isAutomationSession =
          sessionKind === 'automation' || sessionKind === 'automation-insight';
        if (approval.sessionId && !isAutomationSession) {
          const message = buildToolContinuationMessage(
            approval.toolApproval.toolName,
            approval.toolApproval.input
          );
          if (options?.onSendContinuation) {
            await Promise.resolve(options.onSendContinuation(approval.sessionId, message));
          } else {
            // 'reject': an approval continuation must never cancel a turn the
            // user has since started — the approval is already stored, so the
            // agent retries on its next interaction instead.
            await dispatchAgentTurn({
              sessionId: approval.sessionId,
              prompt: message,
              isSystemContinuation: true,
            }, { policy: 'reject' });
          }
        }
      } catch (err) {
        console.warn('Tool approved but continuation failed — agent will retry on next interaction:', err);
      }

      return { ok: true };
    },
    [removeApproval, restoreApproval, options]
  );

  // Approve a memory approval and trigger agent retry via continuation message
  const approveMemoryApproval = useCallback(
    async (approval: AutomationApprovalItem): Promise<MemoryApprovalResult> => {
      if (approval.type !== 'memory' || !approval.memoryApproval) {
        return { ok: false, reason: 'ipc-failed' };
      }

      // Optimistic removal
      removeApproval(approval.id);

      // Use shared utility which handles IPC + continuation message — pass through callback.
      // For automation sessions, suppress the continuation — the auto-restart flow (Stage 4)
      // will re-run the automation after all staged items are resolved.
      const memorySessionKind = classifySessionKind(approval.memoryApproval.originalSessionId);
      const isAutomationSession =
        memorySessionKind === 'automation' || memorySessionKind === 'automation-insight';
      const continuationCallback = isAutomationSession
        ? () => {} // No-op: suppress continuation for automation sessions
        : options?.onSendContinuation;
      const result = await saveMemoryApproval(
        {
          toolUseId: approval.memoryApproval.toolUseId,
          originalSessionId: approval.memoryApproval.originalSessionId,
          filePath: approval.memoryApproval.filePath,
          spaceName: approval.memoryApproval.spaceName,
          content: approval.memoryApproval.content,
        },
        continuationCallback,
      );

      if (!result.ok) {
        // Restore the specific approval instead of reloading all
        restoreApproval(approval);
      }

      return result;
    },
    [removeApproval, restoreApproval, options?.onSendContinuation]
  );

  return {
    approvalsByAutomation,
    totalCount,
    isLoading,
    refresh: loadApprovals,
    dismissApproval,
    approveToolApproval,
    approveMemoryApproval,
  };
}
