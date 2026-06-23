/**
 * Pending Approvals Store
 *
 * Persists tool safety approval requests to disk using electron-store.
 * This allows pending approvals to survive app crashes/restarts.
 *
 * When the app restarts, the renderer fetches pending approvals and
 * re-displays them to the user for action.
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import { backfillToolBlockSource, type BlockSource, type FileLocation, type ToolBlockSource } from '@rebel/shared';

const logger = createScopedLogger({ service: 'pendingApprovalsStore' });

/**
 * Tool approval request payload - matches the schema in subscriptions.ts
 */
export interface PersistedToolApprovalRequest {
  toolUseID: string;
  turnId: string;
  sessionId?: string;
  toolName: string;
  input: Record<string, unknown>;
  reason?: string;
  timestamp: number;
  allowPermanentTrust?: boolean;
  /** Effective tool ID for trustedTools writes (inner tool_id for use_tool wrappers) */
  effectiveToolId?: string;
  /** Discriminator for why the tool was blocked (optional for backwards compatibility) */
  blockedBy?: ToolBlockSource;
}

/**
 * Memory approval request payload - matches the schema in subscriptions.ts
 * Stores metadata for UI display and continuation message routing.
 * Content is stored in full to enable building continuation messages after app restart.
 */
export interface PersistedMemoryApprovalRequest {
  toolUseId: string;
  originalTurnId: string;
  originalSessionId: string; // Main conversation session (for UI filtering)
  turnId: string;            // Background memory turn
  sessionId: string;         // Background memory session
  filePath: string;
  spaceName: string;
  summary: string;
  content: string;
  timestamp: number;
  
  // Rich fields for UI consistency after restart (all optional for backwards compatibility)
  sensitivityReason?: string;
  hasSpaceOverride?: boolean;
  privateMode?: boolean;
  /** Which evaluation path blocked this write (optional for backwards compatibility) */
  blockedBy?: BlockSource;
  /** Workspace-relative path for per-space safety overrides (optional for backwards compatibility) */
  spacePath?: string;
  location?: FileLocation;
  sharing?: 'private' | 'restricted' | 'company-wide' | 'public';
  contentPreview?: string;
  approvalIdentifier?: string;
  approvalKind?: 'memory_write' | 'shared_skill_checkpoint';
  /** For shared_skill_checkpoint: the name of the person who owns/authored the skill. */
  authorLabel?: string;
  /** True when content has been staged to CoS pending — approval is informational */
  staged?: boolean;
  /** True when this approval creates a net-new file (optional for backwards compatibility). */
  isNewFile?: boolean;
}

type PendingApprovalsStoreShape = {
  version: number;
  pendingApprovals: PersistedToolApprovalRequest[];
  pendingMemoryApprovals: PersistedMemoryApprovalRequest[];
}

const STORE_VERSION = 1;

let _store: KeyValueStore<PendingApprovalsStoreShape> | null = null;
const getStore = (): KeyValueStore<PendingApprovalsStoreShape> => {
  if (!_store) {
    _store = createStore<PendingApprovalsStoreShape>({
      name: 'pending-tool-approvals',
      defaults: {
        version: STORE_VERSION,
        pendingApprovals: [],
        pendingMemoryApprovals: [],
      },
    });
  }
  return _store;
};

/**
 * Get all pending approval requests.
 */
export function getPendingApprovals(): PersistedToolApprovalRequest[] {
  try {
    return getStore().get('pendingApprovals', []).map((approval) => {
      const blockedBy = backfillToolBlockSource(approval.blockedBy, approval.reason);
      return blockedBy === approval.blockedBy ? approval : { ...approval, blockedBy };
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load pending approvals');
    return [];
  }
}

/**
 * Add a pending approval request.
 * Avoids duplicates by toolUseID.
 */
export function addPendingApproval(request: PersistedToolApprovalRequest): void {
  try {
    const current = getPendingApprovals();
    if (current.some((r) => r.toolUseID === request.toolUseID)) {
      logger.debug({ toolUseID: request.toolUseID }, 'Approval already exists, skipping');
      return;
    }
    getStore().set('pendingApprovals', [...current, request]);
    logger.info(
      { toolUseID: request.toolUseID, toolName: request.toolName, sessionId: request.sessionId },
      'Persisted pending approval'
    );
  } catch (error) {
    logger.error({ err: error, toolUseID: request.toolUseID }, 'Failed to persist pending approval');
  }
}

/**
 * Remove a pending approval by toolUseID.
 * Called when user responds to the approval request.
 */
export function removePendingApproval(toolUseID: string): void {
  try {
    const current = getPendingApprovals();
    const filtered = current.filter((r) => r.toolUseID !== toolUseID);
    if (filtered.length !== current.length) {
      getStore().set('pendingApprovals', filtered);
      logger.info({ toolUseID }, 'Removed pending approval');
    }
  } catch (error) {
    logger.error({ err: error, toolUseID }, 'Failed to remove pending approval');
  }
}

/**
 * Clear all pending approvals for a specific turn.
 * Called when a turn is aborted or completes without user responding to approval.
 * Returns the toolUseIDs that were removed (for cleaning up in-memory metadata).
 */
export function clearPendingApprovalsForTurn(turnId: string): string[] {
  try {
    const current = getPendingApprovals();
    const removed = current.filter((r) => r.turnId === turnId);
    if (removed.length > 0) {
      const filtered = current.filter((r) => r.turnId !== turnId);
      getStore().set('pendingApprovals', filtered);
      logger.info({ turnId, removedCount: removed.length }, 'Cleared pending approvals for turn');
      return removed.map((r) => r.toolUseID);
    }
    return [];
  } catch (error) {
    logger.error({ err: error, turnId }, 'Failed to clear pending approvals for turn');
    return [];
  }
}

/**
 * Clear all pending approvals for a specific session.
 * Called when a session is deleted.
 */
export function clearPendingApprovalsForSession(sessionId: string): void {
  try {
    const current = getPendingApprovals();
    const filtered = current.filter((r) => r.sessionId !== sessionId);
    if (filtered.length !== current.length) {
      const removedCount = current.length - filtered.length;
      getStore().set('pendingApprovals', filtered);
      logger.info({ sessionId, removedCount }, 'Cleared pending approvals for session');
    }
  } catch (error) {
    logger.error({ err: error, sessionId }, 'Failed to clear pending approvals for session');
  }
}

/**
 * Filter out stale approvals where the session no longer exists.
 * Called during session save to clean up orphaned approvals.
 */
export function filterStaleApprovals(validSessionIds: Set<string>): void {
  try {
    const current = getPendingApprovals();
    const filtered = current.filter((r) => {
      // Keep approvals without sessionId (backward compat) or with valid session
      if (!r.sessionId) return true;
      return validSessionIds.has(r.sessionId);
    });
    if (filtered.length !== current.length) {
      const removedCount = current.length - filtered.length;
      getStore().set('pendingApprovals', filtered);
      logger.info({ removedCount }, 'Filtered stale pending approvals');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to filter stale approvals');
  }
}

/**
 * Clear all pending approvals.
 * Useful for testing or complete reset.
 */
export function clearAllPendingApprovals(): void {
  try {
    getStore().set('pendingApprovals', []);
    logger.info('Cleared all pending approvals');
  } catch (error) {
    logger.error({ err: error }, 'Failed to clear all pending approvals');
  }
}

// ─────────────────────────────────────────────────────────────
// Memory Approval Persistence
// ─────────────────────────────────────────────────────────────

/**
 * Get all pending memory approval requests.
 */
export function getPendingMemoryApprovals(): PersistedMemoryApprovalRequest[] {
  try {
    return getStore().get('pendingMemoryApprovals', []);
  } catch (error) {
    logger.error({ err: error }, 'Failed to load pending memory approvals');
    return [];
  }
}

/**
 * Add a pending memory approval request.
 * Avoids duplicates by toolUseId.
 */
export function addPendingMemoryApproval(request: PersistedMemoryApprovalRequest): void {
  try {
    const current = getPendingMemoryApprovals();
    if (current.some((r) => r.toolUseId === request.toolUseId)) {
      logger.debug({ toolUseId: request.toolUseId }, 'Memory approval already exists, skipping');
      return;
    }
    getStore().set('pendingMemoryApprovals', [...current, request]);
    logger.info({ toolUseId: request.toolUseId, filePath: request.filePath }, 'Persisted pending memory approval');
  } catch (error) {
    logger.error({ err: error, toolUseId: request.toolUseId }, 'Failed to persist pending memory approval');
  }
}

/**
 * Remove a pending memory approval by toolUseId.
 * Called when user responds to the approval request.
 */
export function removePendingMemoryApproval(toolUseId: string): void {
  try {
    const current = getPendingMemoryApprovals();
    const filtered = current.filter((r) => r.toolUseId !== toolUseId);
    if (filtered.length !== current.length) {
      getStore().set('pendingMemoryApprovals', filtered);
      logger.info({ toolUseId }, 'Removed pending memory approval');
    }
  } catch (error) {
    logger.error({ err: error, toolUseId }, 'Failed to remove pending memory approval');
  }
}

/**
 * Clear all pending memory approvals that originated from a specific user
 * conversation. Called when the source session is deleted.
 */
export function clearPendingMemoryApprovalsForSession(sessionId: string): void {
  try {
    const current = getPendingMemoryApprovals();
    const filtered = current.filter((r) => (
      r.originalSessionId !== sessionId && r.sessionId !== sessionId
    ));
    if (filtered.length !== current.length) {
      const removedCount = current.length - filtered.length;
      getStore().set('pendingMemoryApprovals', filtered);
      logger.info({ sessionId, removedCount }, 'Cleared pending memory approvals for session');
    }
  } catch (error) {
    logger.error({ err: error, sessionId }, 'Failed to clear pending memory approvals for session');
  }
}

/**
 * Clear all pending memory approvals.
 */
export function clearAllPendingMemoryApprovals(): void {
  try {
    getStore().set('pendingMemoryApprovals', []);
    logger.info('Cleared all pending memory approvals');
  } catch (error) {
    logger.error({ err: error }, 'Failed to clear all pending memory approvals');
  }
}

/**
 * Result of `pruneStaleApprovals` — surfaces what was removed so the caller
 * can log structured diagnostics without re-reading the store.
 */
export interface PruneStaleApprovalsResult {
  removedTool: number;
  removedMemory: number;
  /** Age (ms) of the oldest removed entry, or null if nothing was removed. */
  oldestRemovedAgeMs: number | null;
}

/**
 * Drop pending tool + memory approvals older than `maxAgeMs`. Intended for a
 * single startup sweep — entries inside the (0, maxAgeMs) window are
 * untouched (the `approval_stuck` diagnostic tick already surfaces them via
 * structured events).
 *
 * `maxAgeMs` is deliberately conservative (a month or longer is recommended).
 * Sub-30-day TTLs risk destroying still-actionable approvals the user
 * intended to revisit.
 */
export function pruneStaleApprovals(
  maxAgeMs: number,
  now: number = Date.now(),
): PruneStaleApprovalsResult {
  let removedTool = 0;
  let removedMemory = 0;
  let oldestRemovedAgeMs: number | null = null;

  const noteAge = (timestamp: number): void => {
    const ageMs = now - timestamp;
    if (oldestRemovedAgeMs === null || ageMs > oldestRemovedAgeMs) {
      oldestRemovedAgeMs = ageMs;
    }
  };

  try {
    const currentTool = getPendingApprovals();
    const filteredTool = currentTool.filter((r) => {
      if (now - r.timestamp > maxAgeMs) {
        removedTool += 1;
        noteAge(r.timestamp);
        return false;
      }
      return true;
    });
    if (removedTool > 0) {
      getStore().set('pendingApprovals', filteredTool);
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to prune stale tool approvals');
  }

  try {
    const currentMemory = getPendingMemoryApprovals();
    const filteredMemory = currentMemory.filter((r) => {
      if (now - r.timestamp > maxAgeMs) {
        removedMemory += 1;
        noteAge(r.timestamp);
        return false;
      }
      return true;
    });
    if (removedMemory > 0) {
      getStore().set('pendingMemoryApprovals', filteredMemory);
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to prune stale memory approvals');
  }

  return { removedTool, removedMemory, oldestRemovedAgeMs };
}

/**
 * Filter out stale memory approvals where the original session no longer exists.
 * Called during session save to clean up orphaned approvals.
 */
export function filterStaleMemoryApprovals(validSessionIds: Set<string>): void {
  try {
    const current = getPendingMemoryApprovals();
    const filtered = current.filter((r) => {
      // Filter by originalSessionId (the main conversation session, not the background memory turn)
      return validSessionIds.has(r.originalSessionId);
    });
    if (filtered.length !== current.length) {
      const removedCount = current.length - filtered.length;
      getStore().set('pendingMemoryApprovals', filtered);
      logger.info({ removedCount }, 'Filtered stale pending memory approvals');
    }
  } catch (error) {
    logger.error({ err: error }, 'Failed to filter stale memory approvals');
  }
}
