import { useSyncExternalStore } from 'react';
import type { PendingApprovalItem } from './usePendingApprovals';
import type { StagedFileItem } from './useStagedFiles';
import type { DrawerRedirectEntry } from '../components/DrawerApprovalCard';

export const DEFAULT_REDIRECT_AUTO_DISMISS_MS = 4000;

export type RedirectShadowItem =
  | {
      kind: 'approval';
      id: string;
      timestamp: number;
      sessionId: string | null;
      groupTitle: string;
      approval: PendingApprovalItem;
    }
  | {
      kind: 'staged-file';
      id: string;
      timestamp: number;
      sessionId: string | null;
      groupTitle: string;
      file: StagedFileItem;
    };

export interface ApprovalRedirectShadowValue {
  item: RedirectShadowItem;
  entry: DrawerRedirectEntry;
}

let redirectOutcomeById = new Map<string, ApprovalRedirectShadowValue>();
const listeners = new Set<() => void>();
const autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
const inFlightItemIds = new Set<string>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Map<string, ApprovalRedirectShadowValue> {
  return redirectOutcomeById;
}

function clearAutoDismissTimer(itemId: string): void {
  const timer = autoDismissTimers.get(itemId);
  if (!timer) return;
  clearTimeout(timer);
  autoDismissTimers.delete(itemId);
}

export function setApprovalRedirectEntry(
  item: RedirectShadowItem,
  entry: DrawerRedirectEntry,
  options?: { autoDismissMs?: number },
): void {
  redirectOutcomeById = new Map(redirectOutcomeById).set(item.id, { item, entry });
  emitChange();

  if (entry.status !== 'sent') {
    clearAutoDismissTimer(item.id);
    return;
  }

  clearAutoDismissTimer(item.id);
  const dismissDelay = options?.autoDismissMs ?? DEFAULT_REDIRECT_AUTO_DISMISS_MS;
  const timer = setTimeout(() => {
    autoDismissTimers.delete(item.id);
    if (!redirectOutcomeById.has(item.id)) return;
    redirectOutcomeById = new Map(redirectOutcomeById);
    redirectOutcomeById.delete(item.id);
    emitChange();
  }, dismissDelay);
  autoDismissTimers.set(item.id, timer);
}

export function clearApprovalRedirectEntry(itemId: string): void {
  clearAutoDismissTimer(itemId);
  if (!redirectOutcomeById.has(itemId)) return;
  redirectOutcomeById = new Map(redirectOutcomeById);
  redirectOutcomeById.delete(itemId);
  emitChange();
}

export function beginApprovalRedirectSingleFlight(itemId: string): boolean {
  if (inFlightItemIds.has(itemId)) return false;
  inFlightItemIds.add(itemId);
  return true;
}

export function endApprovalRedirectSingleFlight(itemId: string): void {
  inFlightItemIds.delete(itemId);
}

export function useApprovalRedirectShadow(): {
  redirectOutcomeById: Map<string, ApprovalRedirectShadowValue>;
  setRedirectEntry: typeof setApprovalRedirectEntry;
  clearRedirectEntry: typeof clearApprovalRedirectEntry;
  beginSingleFlight: typeof beginApprovalRedirectSingleFlight;
  endSingleFlight: typeof endApprovalRedirectSingleFlight;
} {
  const redirectOutcomeByIdSnapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  return {
    redirectOutcomeById: redirectOutcomeByIdSnapshot,
    setRedirectEntry: setApprovalRedirectEntry,
    clearRedirectEntry: clearApprovalRedirectEntry,
    beginSingleFlight: beginApprovalRedirectSingleFlight,
    endSingleFlight: endApprovalRedirectSingleFlight,
  };
}

export function _resetApprovalRedirectShadowStore(): void {
  for (const timer of autoDismissTimers.values()) {
    clearTimeout(timer);
  }
  autoDismissTimers.clear();
  inFlightItemIds.clear();
  redirectOutcomeById = new Map();
  emitChange();
}

// Test-only helper — direct snapshot access for assertions.
export function _getApprovalRedirectShadowSnapshotForTests(): Map<string, ApprovalRedirectShadowValue> {
  return redirectOutcomeById;
}

export function _hasPendingAutoDismissTimerForTests(itemId: string): boolean {
  return autoDismissTimers.has(itemId);
}
