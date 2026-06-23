// cloud-client/src/stores/approvalStore.ts

import { create } from 'zustand';
import { FileLocationSchema, legacyMissingLocation } from '@rebel/shared';
import type {
  MemoryWriteApprovalResolvedBroadcast,
  ToolSafetyApprovalResolvedBroadcast,
} from '@rebel/shared';
import * as cloudClient from '../cloudClient';
import { createLogger } from '../utils/logger';
import type { ToolApproval, MemoryWriteApproval, CloudStagedToolCall } from '../types';

const log = createLogger('approvalStore');
const warnedInvalidLocationKeys = new Set<string>();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function warnInvalidLocationOnce(toolUseId: string | null, fallbackPath: string | null): void {
  const warnKey = `${toolUseId ?? 'unknown'}|${fallbackPath ?? 'unknown'}`;
  if (warnedInvalidLocationKeys.has(warnKey)) {
    return;
  }
  warnedInvalidLocationKeys.add(warnKey);
  log.warn('approvalStore received invalid location; falling back to legacy shim', {
    toolUseId: toolUseId ?? undefined,
    reason: 'invalid-location',
  });
}

function parseLocation(payload: unknown) {
  if (payload === undefined) {
    return undefined;
  }
  const parsed = FileLocationSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

function getLegacySpacePath(
  location: MemoryWriteApproval['location'],
  fallback: string,
): string {
  if (!location) {
    return fallback;
  }
  switch (location.kind) {
    case 'in-space':
      return location.workspaceRelativePath;
    case 'outside-workspace':
      return location.absolutePath;
    case 'legacy-missing-location':
      return location.legacyPath || fallback;
    default: {
      const _exhaustive: never = location;
      void _exhaustive;
      return fallback;
    }
  }
}

function toMemoryApproval(payload: unknown): MemoryWriteApproval | null {
  if (!isObject(payload)) return null;

  const destination = isObject(payload.destination) ? payload.destination : null;

  const toolUseId = typeof payload.toolUseId === 'string' ? payload.toolUseId : null;
  const originalTurnId =
    typeof payload.originalTurnId === 'string'
      ? payload.originalTurnId
      : typeof payload.turnId === 'string'
        ? payload.turnId
        : null;
  const originalSessionId =
    typeof payload.originalSessionId === 'string'
      ? payload.originalSessionId
      : typeof payload.sessionId === 'string'
        ? payload.sessionId
        : null;
  const spaceName =
    typeof payload.spaceName === 'string'
      ? payload.spaceName
      : destination && typeof destination.spaceName === 'string'
        ? destination.spaceName
        : null;
  const spacePath =
    typeof payload.spacePath === 'string'
      ? payload.spacePath
      : destination && typeof destination.spacePath === 'string'
        ? destination.spacePath
        : '';
  const filePath =
    typeof payload.filePath === 'string'
      ? payload.filePath
      : destination && typeof destination.path === 'string'
        ? destination.path
        : null;
  const summary = typeof payload.summary === 'string' ? payload.summary : null;
  const payloadLocation = parseLocation(payload.location);
  const destinationLocation = parseLocation(destination?.location);
  const parsedLocation = payloadLocation ?? destinationLocation;
  if (!parsedLocation && (payloadLocation === null || destinationLocation === null)) {
    warnInvalidLocationOnce(toolUseId, spacePath || filePath);
  }
  const location = parsedLocation
    ?? legacyMissingLocation({
      spaceName: spaceName ?? undefined,
      legacyPath: spacePath || filePath || undefined,
    });

  if (!toolUseId || !originalTurnId || !originalSessionId || !spaceName || !filePath || !summary) {
    return null;
  }

  const sharing =
    typeof payload.sharing === 'string'
      ? payload.sharing
      : destination && typeof destination.sharing === 'string'
        ? destination.sharing
        : undefined;

  return {
    toolUseId,
    originalTurnId,
    originalSessionId,
    spaceName,
    spacePath: getLegacySpacePath(location, spacePath),
    location,
    filePath,
    summary,
    contentPreview: typeof payload.contentPreview === 'string' ? payload.contentPreview : undefined,
    sharing,
    isNewFile:
      typeof payload.isNewFile === 'boolean'
        ? payload.isNewFile
        : destination && typeof destination.isNew === 'boolean'
          ? destination.isNew
          : false,
    blockedBy: typeof payload.blockedBy === 'string' ? payload.blockedBy : 'unknown',
    timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
    staged: typeof payload.staged === 'boolean' ? payload.staged : undefined,
    // Round-2 F3-3: forward the author label and approval kind so mobile cards
    // can disambiguate "who authored this" and branch on skill-checkpoint rows.
    authorLabel: typeof payload.authorLabel === 'string' ? payload.authorLabel : undefined,
    approvalKind: typeof payload.approvalKind === 'string' ? payload.approvalKind : undefined,
  };
}

function toMemoryApprovals(payload: unknown): MemoryWriteApproval[] {
  if (!Array.isArray(payload)) return [];
  const approvals: MemoryWriteApproval[] = [];

  for (const item of payload) {
    const approval = toMemoryApproval(item);
    if (approval) approvals.push(approval);
  }

  return approvals;
}

export const __approvalStoreTestUtils = {
  toMemoryApproval,
  resetInvalidLocationWarnings(): void {
    warnedInvalidLocationKeys.clear();
  },
};

interface ApprovalState {
  toolApprovals: ToolApproval[];
  stagedCalls: CloudStagedToolCall[];
  memoryApprovals: MemoryWriteApproval[];
  isLoading: boolean;
  error: string | null;

  resetStore: () => void;
  fetchPending: () => Promise<void>;
  respondToApproval: (toolUseID: string, approved: boolean, allowForSession?: boolean) => Promise<void>;
  executeStagedCall: (id: string) => Promise<void>;
  rejectStagedCall: (id: string) => Promise<void>;
  handleApprovalEvent: (channel: string, args: unknown[]) => void;
  handleMemoryEvent: (channel: string, args: unknown[]) => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  toolApprovals: [],
  stagedCalls: [],
  memoryApprovals: [],
  isLoading: false,
  error: null,

  resetStore: () => set({
    toolApprovals: [],
    stagedCalls: [],
    memoryApprovals: [],
    isLoading: false,
    error: null,
  }),

  fetchPending: async () => {
    set({ isLoading: true, error: null });
    const [approvalsResult, stagedResult, memoryResult] = await Promise.allSettled([
      cloudClient.ipcCall<ToolApproval[]>('tool-safety:pending'),
      cloudClient.ipcCall<CloudStagedToolCall[]>('tool-safety:staged-get-all'),
      cloudClient.ipcCall<unknown>('memory:get-pending-approvals'),
    ]);

    const allFailed =
      approvalsResult.status === 'rejected'
      && stagedResult.status === 'rejected'
      && memoryResult.status === 'rejected';

    const approvals = approvalsResult.status === 'fulfilled' ? approvalsResult.value ?? [] : [];
    const staged = stagedResult.status === 'fulfilled' ? stagedResult.value ?? [] : [];
    const memoryApprovals =
      memoryResult.status === 'fulfilled' ? toMemoryApprovals(memoryResult.value) : [];

    set({
      toolApprovals: approvals,
      stagedCalls: staged.filter((s) => s.status === 'pending'),
      memoryApprovals,
      isLoading: false,
      error: allFailed ? 'Failed to load approvals' : null,
    });
  },

  respondToApproval: async (toolUseID: string, approved: boolean, allowForSession = false) => {
    try {
      await cloudClient.ipcCall('agent:tool-safety-response', {
        toolUseID,
        approved,
        allowForSession,
        input: {},
      });
      set((state) => ({
        toolApprovals: state.toolApprovals.filter((a) => a.toolUseID !== toolUseID),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to respond' });
      throw err;
    }
  },

  executeStagedCall: async (id: string) => {
    try {
      await cloudClient.ipcCall('tool-safety:staged-execute', { id });
      set((state) => ({
        stagedCalls: state.stagedCalls.filter((s) => s.id !== id),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to execute' });
      throw err;
    }
  },

  rejectStagedCall: async (id: string) => {
    try {
      await cloudClient.ipcCall('tool-safety:staged-reject', { id });
      set((state) => ({
        stagedCalls: state.stagedCalls.filter((s) => s.id !== id),
      }));
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to reject' });
      throw err;
    }
  },

  handleApprovalEvent: (channel: string, args: unknown[]) => {
    if (channel === 'tool-safety:approval-request') {
      const req = args[0] as ToolApproval;
      if (req?.toolUseID) {
        set((state) => ({
          toolApprovals: [...state.toolApprovals.filter((a) => a.toolUseID !== req.toolUseID), req],
        }));
      }
    } else if (channel === 'tool-safety:approval-resolved') {
      const payload = args[0] as ToolSafetyApprovalResolvedBroadcast;
      if (payload?.toolUseID) {
        set((state) => ({
          toolApprovals: state.toolApprovals.filter((a) => a.toolUseID !== payload.toolUseID),
        }));
      }
    } else if (channel === 'tool-safety:staged-call') {
      const call = args[0] as CloudStagedToolCall;
      if (call?.id && call.status === 'pending') {
        set((state) => ({
          stagedCalls: [...state.stagedCalls.filter((s) => s.id !== call.id), call],
        }));
      }
    } else if (channel === 'tool-safety:staged-call-updated') {
      const call = args[0] as CloudStagedToolCall;
      if (call?.id) {
        if (call.status !== 'pending') {
          set((state) => ({ stagedCalls: state.stagedCalls.filter((s) => s.id !== call.id) }));
        } else {
          set((state) => ({
            stagedCalls: state.stagedCalls.map((s) => (s.id === call.id ? call : s)),
          }));
        }
      }
    }
  },

  handleMemoryEvent: (channel: string, args: unknown[]) => {
    if (channel === 'memory:write-approval-request') {
      const request = toMemoryApproval(args[0]);
      if (request) {
        set((state) => ({
          memoryApprovals: [
            ...state.memoryApprovals.filter((approval) => approval.toolUseId !== request.toolUseId),
            request,
          ],
        }));
      }
      return;
    }

    if (channel === 'memory:write-approval-resolved') {
      const payload = args[0] as MemoryWriteApprovalResolvedBroadcast;
      if (payload?.toolUseId) {
        set((state) => ({
          memoryApprovals: state.memoryApprovals.filter((approval) => approval.toolUseId !== payload.toolUseId),
        }));
      }
    }
  },
}));
