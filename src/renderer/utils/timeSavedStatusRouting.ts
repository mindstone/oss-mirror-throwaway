import type { TimeSavedStatus } from '@shared/types';
import { recordRendererBreadcrumb } from '@renderer/src/sentry';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';

export type TimeSavedStatusRouteDecision = 'apply' | 'route' | 'drop';

type TimeSavedStatusConsumer =
  | 'TimeSavedMilestoneChecker'
  | 'useProgressData'
  | 'useIpcListeners'
  | 'ConversationPane';

const warnedLegacyDrops = new Set<string>();

function getSafeActiveSessionId(activeSessionId: string): string {
  return activeSessionId || 'unknown-session';
}

export function classifyTimeSavedStatusRoute(
  status: TimeSavedStatus,
  activeSessionId: string,
): TimeSavedStatusRouteDecision {
  const safeActiveSessionId = getSafeActiveSessionId(activeSessionId);
  const originalSessionId = status.originalSessionId;

  if (!originalSessionId) {
    return 'drop';
  }
  if (originalSessionId !== safeActiveSessionId) {
    return 'route';
  }
  return 'apply';
}

export function recordLegacyTimeSavedDrop(params: {
  consumer: TimeSavedStatusConsumer;
  activeSessionId: string;
  turnId: string;
}): void {
  const safeActiveSessionId = getSafeActiveSessionId(params.activeSessionId);
  const dedupKey = `${params.consumer}:${safeActiveSessionId}:${params.turnId}`;
  if (warnedLegacyDrops.has(dedupKey)) {
    return;
  }
  warnedLegacyDrops.add(dedupKey);

  const activeSessionIdHash = hashSessionIdForBreadcrumb(safeActiveSessionId);
  const turnIdHash = hashSessionIdForBreadcrumb(params.turnId);

  recordRendererBreadcrumb({
    category: 'legacy-broadcast-without-originalSessionId',
    level: 'warning',
    data: {
      eventType: 'time-saved:status',
      consumer: params.consumer,
      activeSessionIdHash,
      turnIdHash,
    },
  });
}

function shouldHandleSuccessForConsumer(params: {
  status: TimeSavedStatus;
  activeSessionId: string;
  consumer: TimeSavedStatusConsumer;
}): boolean {
  const { status, activeSessionId, consumer } = params;
  const decision = classifyTimeSavedStatusRoute(status, activeSessionId);
  if (decision === 'drop') {
    recordLegacyTimeSavedDrop({
      consumer,
      activeSessionId,
      turnId: status.turnId,
    });
    return false;
  }
  if (decision !== 'apply') {
    return false;
  }
  return status.status === 'success';
}

export function shouldHandleMilestoneTimeSavedStatus(
  status: TimeSavedStatus,
  activeSessionId: string,
): boolean {
  return shouldHandleSuccessForConsumer({
    status,
    activeSessionId,
    consumer: 'TimeSavedMilestoneChecker',
  });
}

export function shouldRefreshProgressTimeSavedStatus(
  status: TimeSavedStatus,
  activeSessionId: string,
): boolean {
  return shouldHandleSuccessForConsumer({
    status,
    activeSessionId,
    consumer: 'useProgressData',
  });
}

export function shouldRefreshTimeSavedBySessionStatus(
  status: TimeSavedStatus,
  activeSessionId: string,
): boolean {
  return shouldHandleSuccessForConsumer({
    status,
    activeSessionId,
    consumer: 'useIpcListeners',
  });
}

export function shouldHandleConversationPaneTimeSavedStatus(
  status: TimeSavedStatus,
  activeSessionId: string,
): boolean {
  return shouldHandleSuccessForConsumer({
    status,
    activeSessionId,
    consumer: 'ConversationPane',
  });
}

export function resetTimeSavedStatusRoutingWarningsForTests(): void {
  warnedLegacyDrops.clear();
}
