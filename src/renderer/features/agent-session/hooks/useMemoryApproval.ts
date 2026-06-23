/**
 * useMemoryApproval
 *
 * Hook to manage memory write approval requests (Phase 2).
 * Listens for approval requests from main process and provides
 * methods to approve or skip memory writes.
 * 
 * Phase 2 design:
 * - Approval happens at file write time (not before memory update starts)
 * - Shows destination (space name + path) and Haiku-generated summary
 * - Persists across app restarts via electron-store
 * - On approval, sends continuation message to main session with full content
 */

import { useState, useEffect, useCallback } from 'react';
import { buildContinuationMessage, buildDiscardMessage } from '@renderer/features/agent-session/utils/buildContinuationMessage';
import { tracking } from '@renderer/src/tracking';
import type {
  FileLocation,
  MemoryBlockedBySource,
  MemoryWriteApprovalRequestBroadcast,
} from '@rebel/shared';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

type MemoryApprovalKind = NonNullable<MemoryWriteApprovalRequestBroadcast['approvalKind']>;
type MemoryApprovalDestination = MemoryWriteApprovalRequestBroadcast['destination'] & {
  /** Workspace-relative path for override matching */
  spacePath: string;
};

function getSharedSkillId(request: {
  approvalIdentifier?: string;
  destination?: { path: string };
  filePath?: string;
}): string {
  const identifier = request.approvalIdentifier;
  if (identifier?.startsWith('shared-skill:')) {
    return identifier.slice('shared-skill:'.length);
  }
  return request.destination?.path ?? request.filePath ?? '';
}

/** Memory write approval request with destination and sharing level */
export type MemoryWriteApprovalRequest = Omit<
  MemoryWriteApprovalRequestBroadcast,
  'blockedBy' | 'content' | 'destination'
> & {
  originalSessionId: string; // Main conversation session (for sidebar indicator)
  destination: MemoryApprovalDestination;
  content: string;
  /** Which evaluation path blocked this write */
  blockedBy: MemoryBlockedBySource;
  /** True when content was already staged to CoS pending — approval is informational */
  staged?: boolean;
};

/** Override to create when approving (for inline exception creation) */
export interface MemorySaveOverride {
  spacePath: string;
  /** Safety level to set for this space */
  level: 'permissive' | 'balanced' | 'cautious';
}

export interface UseMemoryApprovalReturn {
  /** Pending memory write approval requests (filtered to current session) */
  pendingRequests: MemoryWriteApprovalRequest[];
  /** All session IDs with pending memory approvals (for sidebar indicator) */
  allPendingSessionIds: Set<string>;
  /** Approve memory write and send continuation. Optional override creates permanent space exception. */
  save: (toolUseId: string, options?: { createOverride?: MemorySaveOverride }) => void;
  /** Approve all and send single continuation */
  saveAll: () => void;
  /** Skip memory write */
  skip: (toolUseId: string) => void;
  /** Skip all pending memory writes */
  skipAll: () => void;
}



export function useMemoryApproval(
  currentSessionId: string | null,
  sendMessage?: (text: string, targetSessionId?: string, receiptText?: string) => void
): UseMemoryApprovalReturn {
  const [pendingRequests, setPendingRequests] = useState<MemoryWriteApprovalRequest[]>([]);
  const [allPendingSessionIds, setAllPendingSessionIds] = useState<Set<string>>(new Set());

  // Load all pending approvals on mount for sidebar indicator
  useEffect(() => {
    window.memoryApi.getPendingApprovals({}).then((pending) => {
      // Track all session IDs with pending approvals
      const sessionIds = new Set(pending.map((p) => p.originalSessionId));
      setAllPendingSessionIds(sessionIds);
    }).catch((err) => {
      console.error('Failed to load pending memory approvals:', err);
    });
  }, []);

  // Load pending approvals for current session (for approval bar display)
  useEffect(() => {
    if (!currentSessionId) {
      setPendingRequests([]);
      return;
    }
    
    let isCurrent = true; // Stale closure protection
    
    window.memoryApi.getPendingApprovals({}).then((pending) => {
      if (!isCurrent) return; // Prevent cross-session pollution on fast navigation
      
      // Filter to approvals for this session (originalSessionId is the main conversation)
      const forThisSession = pending.filter((p) => p.originalSessionId === currentSessionId);
      
      // Transform persisted format to request format
      // Note: Persisted format may not have new fields (spacePath, sharing, etc.)
      // We handle this defensively with defaults
      const requests: MemoryWriteApprovalRequest[] = forThisSession.map((p) => ({
        toolUseId: p.toolUseId,
        originalTurnId: p.originalTurnId,
        originalSessionId: p.originalSessionId,
        destination: {
          path: p.filePath,
          spaceName: p.spaceName,
          spacePath: p.spacePath ?? '', // May be missing in old data
          location: p.location,
          sharing: p.sharing,
          isNew: false,
        },
        summary: p.summary,
        content: p.content,
        sensitivityReason: p.sensitivityReason,
        hasSpaceOverride: p.hasSpaceOverride,
        privateMode: p.privateMode,
        blockedBy: p.blockedBy ?? 'structural_policy',
        approvalIdentifier: p.approvalIdentifier,
        approvalKind: p.approvalKind,
        staged: (p as { staged?: boolean }).staged,
        timestamp: p.timestamp,
      }));
      
      // MERGE with existing state - preserves IPC requests that arrived before load completed
      // This fixes a race condition where IPC events arrive before the async load finishes,
      // causing the persisted load to wipe out already-received requests.
      setPendingRequests(prev => {
        const next = new Map<string, MemoryWriteApprovalRequest>();
        
        // Keep any already-received approvals for current session
        for (const r of prev) {
          if (r.originalSessionId && r.originalSessionId !== currentSessionId) continue;
          next.set(r.toolUseId, r);
        }
        
        // Persisted entries take precedence (canonical source)
        for (const r of requests) {
          next.set(r.toolUseId, r);
        }
        
        return Array.from(next.values());
      });
    }).catch((err) => {
      console.error('Failed to load pending memory approvals:', err);
      // On error, filter to keep only current session requests (don't wipe state)
      if (isCurrent) {
        setPendingRequests(prev => 
          prev.filter(r => !r.originalSessionId || r.originalSessionId === currentSessionId)
        );
      }
    });
    
    return () => { isCurrent = false; };
  }, [currentSessionId]);

  // Listen for new memory write approval requests
  useIpcEvent(window.api.onMemoryWriteApprovalRequest, (request) => {
    // Update sidebar indicator (all sessions)
    setAllPendingSessionIds((prev) => {
      if (prev.has(request.originalSessionId)) return prev;
      return new Set([...prev, request.originalSessionId]);
    });

    // Filter by session: only show approval requests for the current session
    // If originalSessionId is missing (for testing/backward compat), show the request
    if (request.originalSessionId && request.originalSessionId !== currentSessionId) return;

    setPendingRequests((prev) => {
      if (prev.some((r) => r.toolUseId === request.toolUseId)) {
        return prev;
      }
      // Guard: cloud catch-up sends flat format (filePath/spaceName at top level)
      // while real-time broadcasts use nested destination object
      const dest = request.destination;
      const flat = request as Record<string, unknown>;
      const spaceName = dest?.spaceName ?? (flat.spaceName as string) ?? '';
      // Track that a new memory approval prompt is being shown
      tracking.approvals.memoryPromptShown(spaceName, prev.length + 1);
      if (request.approvalKind === 'shared_skill_checkpoint') {
        tracking.skillCollaboration.nudgeShown({
          skillId: getSharedSkillId(request),
          surface: 'chat_checkpoint',
        });
      }
      // Transform broadcast format to our internal format
      const transformed: MemoryWriteApprovalRequest = {
        toolUseId: request.toolUseId,
        originalTurnId: request.originalTurnId ?? (flat.originalTurnId as string) ?? '',
        originalSessionId: request.originalSessionId,
        destination: {
          path: dest?.path ?? (flat.filePath as string) ?? '',
          spaceName,
          spacePath: dest?.spacePath ?? (flat.spacePath as string) ?? '',
          location: dest?.location ?? (flat.location as FileLocation | undefined),
          sharing: dest?.sharing ?? (flat.sharing as 'private' | 'restricted' | 'company-wide' | 'public'),
          isNew: dest?.isNew ?? false,
        },
        summary: request.summary,
        content: request.contentPreview || '', // Will be filled from IPC response
        contentPreview: request.contentPreview,
        sensitivityReason: request.sensitivityReason,
        hasSpaceOverride: request.hasSpaceOverride,
        privateMode: request.privateMode,
        blockedBy: (request as { blockedBy?: MemoryBlockedBySource }).blockedBy ?? 'structural_policy',
        approvalIdentifier: request.approvalIdentifier,
        approvalKind: request.approvalKind,
        staged: (request as { staged?: boolean }).staged,
        timestamp: request.timestamp,
      };
      return [...prev, transformed];
    });
  }, [currentSessionId]);

  // Listen for resolved approvals (from other surfaces) for real-time sync
  useIpcEvent(window.api.onMemoryWriteApprovalResolved, (data) => {
    // Remove from local state if present
    setPendingRequests((prev) => prev.filter((r) => r.toolUseId !== data.toolUseId));

    // Update sidebar indicator - remove session if this was its only pending approval
    // Note: We can't know for sure without re-fetching, but removing is safe
    // (worst case: indicator disappears slightly early, then reappears on next request)
    setAllPendingSessionIds((prev) => {
      // Only remove if this was the session's approval
      if (!prev.has(data.originalSessionId)) return prev;
      const next = new Set(prev);
      next.delete(data.originalSessionId);
      return next;
    });
  }, []);

  // Approve single request and send continuation
  const save = useCallback(async (toolUseId: string, options?: { createOverride?: MemorySaveOverride }) => {
    const request = pendingRequests.find((r) => r.toolUseId === toolUseId);
    if (!request) return;
    
    const { createOverride } = options ?? {};
    
    // Track the decision
    const decision = createOverride ? 'save_with_override' : 'save';
    tracking.approvals.memoryDecision(decision, request.destination.spaceName, createOverride?.level);
    if (request.approvalKind === 'shared_skill_checkpoint') {
      tracking.skillCollaboration.nudgeDecision({
        skillId: getSharedSkillId(request),
        surface: 'chat_checkpoint',
        decision: 'confirmed',
      });
    }
    
    // If user wants to set a permanent safety level for this space, do that first
    // Uses the new simplified spaceSafetyLevels structure (per-space settings)
    if (createOverride && createOverride.spacePath) {
      // Guard: don't save empty spacePath (could happen with old persisted data)
      try {
        // F-R3-7: Use narrow channel — avoids get→merge→update race.
        // Stage 4 R2: fail-loud — the narrow channel resolves with
        // { success: false, error } on READ_ONLY / UNKNOWN_SPACE_ID rather
        // than throwing, so we must inspect the response and surface the
        // failure. The memory write itself is still saved (user's primary
        // intent), but the override status is observable in logs.
        const result = await window.settingsApi.setSpaceSafetyLevel({
          spaceId: createOverride.spacePath,
          level: createOverride.level,
        });
        if (!result.success) {
          console.error(
            '[useMemoryApproval] setSpaceSafetyLevel rejected',
            { spacePath: createOverride.spacePath, error: result.error, spaceId: result.spaceId },
          );
        }
      } catch (err) {
        console.error('Failed to update space safety level:', err);
        // Continue with approval even if settings update fails — memory save
        // is the primary user intent; override is secondary.
      }
    }
    
    // Notify main process (returns full content)
    const result = await window.api.sendMemoryWriteApprovalResponse({ toolUseId, approved: true });
    
    // Send continuation message to the originating session (not whichever is currently active)
    // SKIP for staged items (FM #15): content is already in CoS pending, publishing happens
    // through the staged file flow. Sending a continuation would trigger a duplicate write.
    // Note: Check for undefined, not truthiness - empty string is valid content
    if (sendMessage && result.content !== undefined && !request.staged) {
      const message = buildContinuationMessage([{
        spaceName: result.spaceName || request.destination.spaceName,
        filePath: result.filePath || request.destination.path,
        content: result.content,
      approvalKind: request.approvalKind,
      }]);
      const effectiveSpaceName = result.spaceName || request.destination.spaceName;
      const receipt = `Approved: save to ${effectiveSpaceName}`;
      sendMessage(message, request.originalSessionId ?? currentSessionId ?? undefined, receipt);
    }
    
    // Update pending requests and sidebar indicator
    const remaining = pendingRequests.filter((r) => r.toolUseId !== toolUseId);
    setPendingRequests(remaining);
    
    // If no more pending for this session, remove from sidebar indicator
    if (remaining.length === 0 && currentSessionId) {
      setAllPendingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(currentSessionId);
        return next;
      });
    }
  }, [pendingRequests, sendMessage, currentSessionId]);

  // Approve all and send single continuation
  const saveAll = useCallback(async () => {
    if (pendingRequests.length === 0) return;
    
    // Collect all approvals with content
    const approvals: Array<{
      spaceName: string;
      filePath: string;
      content: string;
      approvalKind?: MemoryApprovalKind;
    }> = [];
    
    for (const request of pendingRequests) {
      const result = await window.api.sendMemoryWriteApprovalResponse({ 
        toolUseId: request.toolUseId, 
        approved: true,
      });
      
      // Only include non-staged items in continuation (FM #15)
      if (!request.staged) {
        approvals.push({
          spaceName: result.spaceName ?? request.destination.spaceName,
          filePath: result.filePath ?? request.destination.path,
          content: result.content ?? request.content,
          approvalKind: request.approvalKind,
        });
      }
    }
    
    // Send single continuation message to the originating session (non-staged items only)
    if (sendMessage && approvals.length > 0) {
      const message = buildContinuationMessage(approvals);
      const receipt = approvals.length === 1
        ? `Approved: save to ${approvals[0].spaceName}`
        : `Approved ${approvals.length} memory writes`;
      sendMessage(message, currentSessionId ?? undefined, receipt);
    }
    
    // Clear pending and remove from sidebar indicator
    setPendingRequests([]);
    if (currentSessionId) {
      setAllPendingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(currentSessionId);
        return next;
      });
    }
  }, [pendingRequests, sendMessage, currentSessionId]);

  const skip = useCallback(async (toolUseId: string) => {
    // Track the skip decision
    const request = pendingRequests.find((r) => r.toolUseId === toolUseId);
    if (request) {
      tracking.approvals.memoryDecision('skip', request.destination.spaceName);
      if (request.approvalKind === 'shared_skill_checkpoint') {
        tracking.skillCollaboration.nudgeDecision({
          skillId: getSharedSkillId(request),
          surface: 'chat_checkpoint',
          decision: 'declined',
        });
      }
    }
    
    // Update pending requests and sidebar indicator
    const remaining = pendingRequests.filter((r) => r.toolUseId !== toolUseId);
    setPendingRequests(remaining);
    
    // If no more pending for this session, remove from sidebar indicator
    if (remaining.length === 0 && currentSessionId) {
      setAllPendingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(currentSessionId);
        return next;
      });
    }
    
    // Persist the removal — only send discard feedback if IPC succeeds
    const result = await window.api.sendMemoryWriteApprovalResponse({ toolUseId, approved: false });
    
    // Send discard feedback to the originating session so the agent gets closure
    if (result.success && request && sendMessage) {
      const message = buildDiscardMessage([{
        spaceName: request.destination.spaceName,
        filePath: request.destination.path,
      }]);
      sendMessage(message, request.originalSessionId ?? currentSessionId ?? undefined);
    }
  }, [pendingRequests, currentSessionId, sendMessage]);

  const skipAll = useCallback(async () => {
    const toSkip = [...pendingRequests];
    // Clear UI and remove from sidebar indicator
    setPendingRequests([]);
    if (currentSessionId) {
      setAllPendingSessionIds((prev) => {
        const next = new Set(prev);
        next.delete(currentSessionId);
        return next;
      });
    }
    // Persist all removals and collect successfully denied items for discard feedback
    const denied: Array<{ spaceName: string; filePath: string }> = [];
    for (const r of toSkip) {
      const result = await window.api.sendMemoryWriteApprovalResponse({ toolUseId: r.toolUseId, approved: false });
      if (result.success) {
        denied.push({ spaceName: r.destination.spaceName, filePath: r.destination.path });
      }
    }
    // Send a single aggregated discard message for all declined writes to the originating session
    if (sendMessage && denied.length > 0) {
      const message = buildDiscardMessage(denied);
      sendMessage(message, currentSessionId ?? undefined);
    }
  }, [pendingRequests, currentSessionId, sendMessage]);

  return {
    pendingRequests,
    allPendingSessionIds,
    save,
    saveAll,
    skip,
    skipAll,
  };
}
