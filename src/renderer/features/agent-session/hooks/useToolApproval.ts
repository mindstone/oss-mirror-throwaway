/**
 * useToolApproval Hook
 *
 * Manages denied tool operations for the current session.
 * Listens for denial notifications from main process and provides
 * methods to approve and retry.
 * 
 * NON-BLOCKING Architecture (deny + retry):
 * 1. PreToolUse hook evaluates tool as high-risk
 * 2. Hook returns DENY immediately, sends notification to renderer
 * 3. User sees denial card with "Allow & Retry" button
 * 4. On click: store approval via IPC, send continuation message
 * 5. Agent receives continuation, retries tool
 * 6. Tool is now pre-approved, executes successfully
 * 
 * This design avoids timeout issues and handles parallel sub-agents.
 */

import { useState, useEffect, useCallback } from 'react';
import type { ToolApprovalRequest } from '../types';
import { summarizeToolForApproval } from '../utils/toolChips';
import { buildToolContinuationMessage } from '../utils/buildToolContinuationMessage';
import { tracking } from '@renderer/src/tracking';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

/**
 * Get the effective tool identifier for trusted tools storage.
 * For mcp__super-mcp-router__use_tool, returns the inner tool_id.
 * For other tools, returns the tool name.
 */
function _getEffectiveToolIdentifier(toolName: string, toolInput: Record<string, unknown>): string {
  if (toolName === 'mcp__super-mcp-router__use_tool' && toolInput) {
    const innerToolId = toolInput.tool_id as string | undefined;
    if (innerToolId) {
      return innerToolId;
    }
  }
  return toolName;
}

export interface UseToolApprovalReturn {
  /** Array of denied operations awaiting user action */
  deniedOperations: ToolApprovalRequest[];
  /** Approve a single operation and send continuation to retry */
  approveAndRetry: (toolUseID: string) => void;
  /** Dismiss a single operation without retry */
  dismiss: (toolUseID: string) => void;
  /** Approve all operations and send single continuation */
  approveAllAndRetry: () => void;
  /** Dismiss all operations */
  dismissAll: () => void;
}

export function useToolApproval(
  currentSessionId: string | null,
  sendMessage?: (text: string, targetSessionId?: string, receiptText?: string) => void
): UseToolApprovalReturn {
  const [deniedOperations, setDeniedOperations] = useState<ToolApprovalRequest[]>([]);

  // Load persisted pending approvals when session changes
  useEffect(() => {
    if (!currentSessionId) {
      setDeniedOperations([]);
      return;
    }
    
    let isCurrent = true; // Stale closure protection
    
    window.safetyApi.pending().then((pending) => {
      if (!isCurrent) return; // Prevent cross-session pollution on fast navigation
      
      // Filter to only show approvals for the current session
      const forSession = pending.filter(
        (r) => !r.sessionId || r.sessionId === currentSessionId
      );
      // MERGE with existing state - preserves IPC requests that arrived before load completed
      // This fixes a race condition where IPC events arrive before the async load finishes,
      // causing the persisted load to wipe out already-received requests.
      setDeniedOperations(prev => {
        const next = new Map<string, ToolApprovalRequest>();
        
        // Keep any already-received approvals for current session
        for (const r of prev) {
          if (r.sessionId && r.sessionId !== currentSessionId) continue;
          next.set(r.toolUseID, r);
        }
        
        // Persisted entries take precedence (canonical source)
        for (const r of forSession) {
          next.set(r.toolUseID, r);
        }
        
        return Array.from(next.values());
      });
    }).catch((err) => {
      console.error('Failed to load pending approvals:', err);
      // On error, filter to keep only current session requests (don't wipe state)
      if (isCurrent) {
        setDeniedOperations(prev => 
          prev.filter(r => !r.sessionId || r.sessionId === currentSessionId)
        );
      }
    });
    
    return () => { isCurrent = false; };
  }, [currentSessionId]);

  // Listen for denial notifications from main process
  useIpcEvent(window.api.onToolSafetyApprovalRequest, (request) => {
    // Filter by session: only show approval requests for the current session
    // If sessionId is missing (backward compat), show the request
    if (request.sessionId && request.sessionId !== currentSessionId) {
      return; // Belongs to a different session, don't show in this one
    }

    // Add to array, avoiding duplicates by toolUseID
    setDeniedOperations(prev => {
      if (prev.some(op => op.toolUseID === request.toolUseID)) {
        return prev; // Already have this one
      }
      // Track that a new approval prompt is being shown
      tracking.approvals.toolPromptShown(request.toolName, prev.length + 1);
      return [...prev, request];
    });
  }, [currentSessionId]);

  // Listen for resolved approvals (from other surfaces) for real-time sync
  // This removes items that were approved/dismissed from Inbox or another window
  useIpcEvent(window.api.onToolSafetyApprovalResolved, (data) => {
    // Only handle resolutions for the current session
    if (data.sessionId && data.sessionId !== currentSessionId) {
      return;
    }
    setDeniedOperations((prev) => prev.filter((op) => op.toolUseID !== data.toolUseID));
  }, [currentSessionId]);

  // Re-sync on window focus — corrects stale items when resolution events were missed
  // (e.g., approval resolved while app was backgrounded, or event had mismatched sessionId).
  // Mirrors the focus-sync pattern in usePendingApprovalCount and usePendingApprovals.
  useEffect(() => {
    if (!currentSessionId) return;
    let abortController: AbortController | null = null;
    const handleFocus = () => {
      abortController?.abort();
      abortController = new AbortController();
      const signal = abortController.signal;
      const sid = currentSessionId;
      window.safetyApi.pending().then((pending) => {
        if (signal.aborted) return;
        const forSession = pending.filter(
          (r) => !r.sessionId || r.sessionId === sid
        );
        const pendingIds = new Set(forSession.map(r => r.toolUseID));
        setDeniedOperations(prev => {
          const filtered = prev.filter(op => pendingIds.has(op.toolUseID));
          if (filtered.length === prev.length) return prev;
          const pruned = prev.length - filtered.length;
          if (pruned > 0) {
            console.warn(`[useToolApproval] Focus sync: pruned ${pruned} stale item(s)`);
          }
          return filtered;
        });
      }).catch((err) => {
        console.warn('[useToolApproval] Focus sync failed:', err);
      });
    };
    window.addEventListener('focus', handleFocus);
    return () => {
      window.removeEventListener('focus', handleFocus);
      abortController?.abort();
    };
  }, [currentSessionId]);

  // DEV ONLY: Expose test function to inject mock approval requests from DevTools console
  // Usage: window.__testToolApproval() - injects 2 sample requests
  useEffect(() => {
    if (process.env.NODE_ENV === 'development' || !process.env.NODE_ENV) {
      (window as unknown as Record<string, unknown>).__testToolApproval = () => {
        const mockRequests: ToolApprovalRequest[] = [
          {
            toolUseID: `test-1-${Date.now()}`,
            turnId: 'test-turn',
            toolName: 'mcp__linear__create_issue',
            input: { title: 'Review Q1 roadmap', team_id: 'eng-123', priority: 2 },
            reason: 'Creating a new Linear issue',
            timestamp: Date.now(),
          },
          {
            toolUseID: `test-2-${Date.now()}`,
            turnId: 'test-turn',
            toolName: 'mcp__gmail__send_email',
            input: { to: 'team@example.com', subject: 'Meeting notes', body: '...' },
            reason: 'Sending email on your behalf',
            timestamp: Date.now(),
          },
        ];
        setDeniedOperations(prev => [...prev, ...mockRequests]);
        console.warn('[DEV] Injected 2 test approval requests');
      };

      // Also expose a version with custom requests
      (window as unknown as Record<string, unknown>).__testToolApprovalCustom = (requests: ToolApprovalRequest[]) => {
        setDeniedOperations(prev => [...prev, ...requests]);
        console.warn(`[DEV] Injected ${requests.length} custom approval requests`);
      };
    }

    return () => {
      delete (window as unknown as Record<string, unknown>).__testToolApproval;
      delete (window as unknown as Record<string, unknown>).__testToolApprovalCustom;
    };
  }, []);

  // Approve single operation and trigger retry
  const approveAndRetry = useCallback((toolUseID: string) => {
    const operation = deniedOperations.find(op => op.toolUseID === toolUseID);
    if (!operation) return;

    // Track the decision
    tracking.approvals.toolDecision('allow', operation.toolName);

    // 1. Store approval via IPC (so retry will be auto-approved)
    window.api.sendToolSafetyResponse({
      toolUseID: operation.toolUseID,
      approved: true,
      input: operation.input,
    });

    // 2. Send continuation message to trigger retry (routed to the originating session)
    if (sendMessage) {
      const summary = summarizeToolForApproval(operation.toolName, operation.input);
      const receipt = `Approved: ${summary.label}`;
      sendMessage(buildToolContinuationMessage(operation.toolName, operation.input), operation.sessionId, receipt);
    }

    // 3. Remove from UI
    setDeniedOperations(prev => prev.filter(op => op.toolUseID !== toolUseID));
  }, [deniedOperations, sendMessage]);

  // Dismiss single operation without retry
  const dismiss = useCallback((toolUseID: string) => {
    // Notify main process (so it cleans up metadata)
    const operation = deniedOperations.find(op => op.toolUseID === toolUseID);
    if (operation) {
      // Track the denial
      tracking.approvals.toolDecision('deny', operation.toolName);
      
      window.api.sendToolSafetyResponse({
        toolUseID: operation.toolUseID,
        approved: false,
        input: operation.input,
      });
    }
    
    // Remove from UI
    setDeniedOperations(prev => prev.filter(op => op.toolUseID !== toolUseID));
  }, [deniedOperations]);

  // Approve all and send single continuation
  const approveAllAndRetry = useCallback(() => {
    if (deniedOperations.length === 0) return;

    // Snapshot IDs to remove — new arrivals during processing are preserved
    const processedIds = new Set(deniedOperations.map(op => op.toolUseID));

    // 1. Track + store all approvals
    deniedOperations.forEach(operation => {
      tracking.approvals.toolDecision('allow', operation.toolName);
      window.api.sendToolSafetyResponse({
        toolUseID: operation.toolUseID,
        approved: true,
        input: operation.input,
      });
    });

    // 2. Send single continuation message listing all approved operations
    // Use the first operation's sessionId to route to the originating session
    if (sendMessage) {
      const summaries = deniedOperations.map(op => {
        const summary = summarizeToolForApproval(op.toolName, op.input);
        return summary.label;
      });
      const message = deniedOperations.length === 1
        ? `Approved. Please retry: ${summaries[0]}`
        : `Approved ${deniedOperations.length} operations. Please retry: ${summaries.join(', ')}`;
      const receipt = deniedOperations.length === 1
        ? `Approved: ${summaries[0]}`
        : `Approved ${deniedOperations.length} operations`;
      sendMessage(message, deniedOperations[0].sessionId ?? currentSessionId ?? undefined, receipt);
    }

    // 3. Remove only processed items (preserves any that arrived mid-batch)
    setDeniedOperations(prev => prev.filter(op => !processedIds.has(op.toolUseID)));
  }, [currentSessionId, deniedOperations, sendMessage]);

  // Dismiss all
  const dismissAll = useCallback(() => {
    // Snapshot IDs to remove — new arrivals during processing are preserved
    const processedIds = new Set(deniedOperations.map(op => op.toolUseID));

    // Track + notify main process for each
    deniedOperations.forEach(operation => {
      tracking.approvals.toolDecision('deny', operation.toolName);
      window.api.sendToolSafetyResponse({
        toolUseID: operation.toolUseID,
        approved: false,
        input: operation.input,
      });
    });
    
    setDeniedOperations(prev => prev.filter(op => !processedIds.has(op.toolUseID)));
  }, [deniedOperations]);

  return { 
    deniedOperations, 
    approveAndRetry, 
    dismiss, 
    approveAllAndRetry, 
    dismissAll,
  };
}
