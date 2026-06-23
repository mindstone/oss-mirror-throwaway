/**
 * usePendingMemoryApprovals
 *
 * Hook to manage pending memory approvals from the Library (Show: Memory).
 * Unlike useMemoryApproval (which is session-scoped), this shows ALL pending
 * approvals across all sessions and triggers agent turns without navigation.
 */

import { useState, useEffect, useCallback } from 'react';
import type { FileLocation } from '@rebel/shared';
import { saveMemoryApproval } from '@renderer/utils/saveMemoryApproval';
import { useIpcEvent } from '@renderer/hooks/useIpcEvent';

export interface PendingMemoryRequest {
  toolUseId: string;
  originalSessionId: string;
  filePath: string;
  spaceName: string;
  /**
   * Stage-3/5A FileLocation discriminated union. Optional until Stage 5B
   * (mobile app-store rollout). Consumers MUST apply `legacyMissingLocation(...)`
   * when undefined — see Invariant #4.
   */
  location?: FileLocation;
  /** Workspace-relative path (fallback shim input for legacyMissingLocation) */
  spacePath?: string;
  summary: string;
  content: string;
  timestamp: number;
  approvalIdentifier?: string;
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  staged?: boolean;
}

export interface UsePendingMemoryApprovalsReturn {
  requests: PendingMemoryRequest[];
  isLoading: boolean;
  save: (toolUseId: string) => Promise<void>;
  skip: (toolUseId: string) => Promise<void>;
  saveAll: () => Promise<void>;
  skipAll: () => Promise<void>;
}



export function usePendingMemoryApprovals(): UsePendingMemoryApprovalsReturn {
  const [requests, setRequests] = useState<PendingMemoryRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load all pending approvals on mount
  useEffect(() => {
    setIsLoading(true);
    window.memoryApi
      .getPendingApprovals({})
      .then((pending) => {
        const transformed: PendingMemoryRequest[] = pending.map((p) => ({
          toolUseId: p.toolUseId,
          originalSessionId: p.originalSessionId,
          filePath: p.filePath,
          spaceName: p.spaceName,
          location: p.location,
          spacePath: p.spacePath,
          summary: p.summary,
          content: p.content,
          timestamp: p.timestamp,
          approvalIdentifier: p.approvalIdentifier,
          approvalKind: p.approvalKind,
          staged: p.staged,
        }));
        setRequests(transformed);
      })
      .catch((err) => {
        console.error('Failed to load pending memory approvals:', err);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, []);

  // Subscribe to new approval requests
  useIpcEvent(window.api.onMemoryWriteApprovalRequest, (request) => {
    setRequests((prev) => {
      if (prev.some((r) => r.toolUseId === request.toolUseId)) {
        return prev;
      }
      // Guard: cloud catch-up sends flat format (filePath/spaceName at top level)
      // while real-time broadcasts use nested destination object
      const dest = request.destination;
      const flat = request as Record<string, unknown>;
      const transformed: PendingMemoryRequest = {
        toolUseId: request.toolUseId,
        originalSessionId: request.originalSessionId,
        filePath: dest?.path ?? (flat.filePath as string) ?? '',
        spaceName: dest?.spaceName ?? (flat.spaceName as string) ?? '',
        location: dest?.location ?? (flat.location as FileLocation | undefined),
        spacePath: dest?.spacePath ?? (flat.spacePath as string | undefined),
        summary: request.summary,
        content: request.contentPreview || '',
        timestamp: request.timestamp,
        approvalIdentifier: request.approvalIdentifier,
        approvalKind: request.approvalKind,
        staged: request.staged,
      };
      return [...prev, transformed];
    });
  }, []);

  // Subscribe to resolved approvals (from other surfaces) for real-time sync
  useIpcEvent(window.api.onMemoryWriteApprovalResolved, (data) => {
    setRequests((prev) => prev.filter((r) => r.toolUseId !== data.toolUseId));
  }, []);

  // Save: store approval + trigger agent turn (no navigation)
  const save = useCallback(
    async (toolUseId: string) => {
      const request = requests.find((r) => r.toolUseId === toolUseId);
      if (!request) return;

      // Optimistic removal - don't wait for broadcast
      setRequests((prev) => prev.filter((r) => r.toolUseId !== toolUseId));

      // Use shared utility for save logic
      await saveMemoryApproval({
        toolUseId: request.toolUseId,
        originalSessionId: request.originalSessionId,
        filePath: request.filePath,
        spaceName: request.spaceName,
        content: request.content,
        approvalKind: request.approvalKind,
        staged: request.staged,
      });
    },
    [requests]
  );

  // Skip: just remove (no agent turn needed)
  const skip = useCallback(async (toolUseId: string) => {
    await window.api.sendMemoryWriteApprovalResponse({ toolUseId, approved: false });
    setRequests((prev) => prev.filter((r) => r.toolUseId !== toolUseId));
  }, []);

  // Save all: process each sequentially
  const saveAll = useCallback(async () => {
    const currentRequests = [...requests];
    for (const request of currentRequests) {
      await save(request.toolUseId);
    }
  }, [requests, save]);

  // Skip all: process each sequentially
  const skipAll = useCallback(async () => {
    const currentRequests = [...requests];
    for (const request of currentRequests) {
      await skip(request.toolUseId);
    }
  }, [requests, skip]);

  return {
    requests,
    isLoading,
    save,
    skip,
    saveAll,
    skipAll,
  };
}
