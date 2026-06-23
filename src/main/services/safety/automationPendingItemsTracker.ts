/**
 * Automation Pending Items Tracker
 *
 * Lightweight in-memory coordination service that tracks all pending approval
 * items (staged tool calls, deny-then-retry approvals, pending memory writes)
 * for each automation run.
 *
 * When all items are resolved (approved or rejected) AND the run is complete,
 * fires an onAllResolved callback so access rules can be auto-updated with
 * the approved actions.
 *
 * This tracker is in-memory only — staged items persist in their own stores
 * (stagedToolCallsService, pendingApprovalsStore, cosPendingService).
 * The rebuildFromStores function provides best-effort reconstruction after
 * app restart for staged tool calls that have automationId.
 */

import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'automationPendingItemsTracker' });

// =============================================================================
// Types
// =============================================================================

export type PendingItemType = 'staged-tool' | 'memory-write' | 'deny-retry';
export type PendingItemResolution = 'approved' | 'rejected';

export interface TrackedItem {
  itemId: string;
  itemType: PendingItemType;
  resolution?: PendingItemResolution;
  toolName?: string;
  inputSummary?: string;
}

interface AutomationTracking {
  items: Map<string, TrackedItem>;
  runComplete: boolean;
}

export interface AllResolvedResult {
  automationId: string;
  approved: TrackedItem[];
  rejected: TrackedItem[];
}

// =============================================================================
// State
// =============================================================================

/** In-memory tracking map: automationId → tracking data */
const tracking = new Map<string, AutomationTracking>();

/** Callbacks for when all items are resolved: automationId → callbacks */
const onAllResolvedCallbacks = new Map<string, Array<(result: AllResolvedResult) => void>>();

// =============================================================================
// Core API
// =============================================================================

/**
 * Track a pending item for an automation.
 * Called when a tool call is staged, a deny-retry approval is created,
 * or a memory write is staged to CoS pending.
 */
export function trackItem(
  automationId: string,
  itemId: string,
  itemType: PendingItemType,
  metadata?: { toolName?: string; inputSummary?: string }
): void {
  let data = tracking.get(automationId);
  if (!data) {
    data = { items: new Map(), runComplete: false };
    tracking.set(automationId, data);
  }
  data.items.set(itemId, {
    itemId,
    itemType,
    toolName: metadata?.toolName,
    inputSummary: metadata?.inputSummary,
  });
  log.info({ automationId, itemId, itemType }, 'Tracking pending item for automation');
}

/**
 * Resolve a pending item (user approved or rejected it).
 * If all items are resolved and the run is complete, fires onAllResolved callbacks.
 */
export function resolveItem(
  automationId: string,
  itemId: string,
  resolution: PendingItemResolution
): void {
  const data = tracking.get(automationId);
  if (!data) {
    log.warn({ automationId, itemId }, 'No tracking data found for automation');
    return;
  }
  const item = data.items.get(itemId);
  if (!item) {
    log.warn({ automationId, itemId }, 'Item not found in tracking');
    return;
  }
  item.resolution = resolution;
  log.info({ automationId, itemId, resolution }, 'Resolved pending item');

  checkAllResolved(automationId, data);
}

/**
 * Mark an automation run as complete (post-run processing finished).
 * If all items are already resolved, fires onAllResolved callbacks immediately.
 */
export function markRunComplete(automationId: string): void {
  const data = tracking.get(automationId);
  if (!data) return;
  data.runComplete = true;
  log.info({ automationId, itemCount: data.items.size }, 'Marked automation run as complete');
  checkAllResolved(automationId, data);
}

/**
 * Register a callback to fire when all pending items for an automation are resolved.
 * Multiple callbacks can be registered per automation.
 */
export function onAllResolved(
  automationId: string,
  callback: (result: AllResolvedResult) => void
): void {
  const existing = onAllResolvedCallbacks.get(automationId) || [];
  existing.push(callback);
  onAllResolvedCallbacks.set(automationId, existing);
}

/**
 * Get current resolution status for an automation.
 */
export function getStatus(automationId: string): {
  pending: number;
  approved: number;
  rejected: number;
  allResolved: boolean;
} {
  const data = tracking.get(automationId);
  if (!data) return { pending: 0, approved: 0, rejected: 0, allResolved: false };
  const items = [...data.items.values()];
  const approved = items.filter((i) => i.resolution === 'approved').length;
  const rejected = items.filter((i) => i.resolution === 'rejected').length;
  const pending = items.length - approved - rejected;
  return { pending, approved, rejected, allResolved: pending === 0 && items.length > 0 };
}

/**
 * Clean up all tracking data and callbacks for an automation.
 */
export function clearAutomation(automationId: string): void {
  tracking.delete(automationId);
  onAllResolvedCallbacks.delete(automationId);
}

/** Reset all tracker state. Only for testing. */
export function _resetForTesting(): void {
  tracking.clear();
  onAllResolvedCallbacks.clear();
}

// =============================================================================
// Rebuild from persisted stores (best-effort after restart)
// =============================================================================

/**
 * Rebuild tracker state from persisted stores on startup.
 *
 * Only rebuilds from staged tool calls (which have automationId).
 * Deny-retry and memory items don't store automationId directly, so they
 * require reverse lookups that are fragile. They will be tracked when new
 * runs happen post-restart.
 *
 * TODO: Wire deny-retry and memory items into rebuild once they store automationId.
 */
export function rebuildFromStores(
  stagedCalls: Array<{
    id: string;
    automationId?: string;
    mcpPayload: { toolId: string };
    input?: Record<string, unknown>;
  }>
): void {
  for (const call of stagedCalls) {
    if (call.automationId) {
      trackItem(call.automationId, call.id, 'staged-tool', {
        toolName: call.mcpPayload.toolId,
        inputSummary: JSON.stringify(call.input ?? {}).slice(0, 200),
      });
    }
  }

  const totalTracked = [...tracking.values()].reduce((sum, t) => sum + t.items.size, 0);
  if (totalTracked > 0) {
    log.info(
      { totalTracked, automations: tracking.size },
      'Rebuilt tracker state from persisted stores'
    );
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

function checkAllResolved(automationId: string, data: AutomationTracking): void {
  if (!data.runComplete) return;
  if (data.items.size === 0) return;

  const allResolved = [...data.items.values()].every((item) => item.resolution !== undefined);
  if (!allResolved) return;

  const approved = [...data.items.values()].filter((i) => i.resolution === 'approved');
  const rejected = [...data.items.values()].filter((i) => i.resolution === 'rejected');

  log.info(
    { automationId, approvedCount: approved.length, rejectedCount: rejected.length },
    'All pending items resolved'
  );

  const callbacks = onAllResolvedCallbacks.get(automationId) || [];
  const result: AllResolvedResult = { automationId, approved, rejected };
  for (const cb of callbacks) {
    try {
      cb(result);
    } catch (err) {
      log.error({ err, automationId }, 'Error in onAllResolved callback');
    }
  }

  // Clean up after firing
  tracking.delete(automationId);
  onAllResolvedCallbacks.delete(automationId);
}
