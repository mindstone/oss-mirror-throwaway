import type { Logger } from '@core/logger';
import type { JsonValue } from '@shared/ipc/schemas/common';
import type {
  AssetResolutionContext,
  AssetResolutionReason,
  ResolutionFailure,
} from '@shared/types/agent';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';

const RECENT_FAILURE_LIMIT = 100;
const recentFailuresBySession = new Map<string, ResolutionFailure[]>();

export interface RecordAssetResolutionFailureOptions {
  sessionId: string;
  assetId?: string;
  reason: AssetResolutionReason;
  context: AssetResolutionContext;
  metadata?: Record<string, JsonValue>;
  log: Logger;
}

function appendRecentFailure(sessionId: string, failure: ResolutionFailure): void {
  const existing = recentFailuresBySession.get(sessionId) ?? [];
  const next = [...existing, failure];
  if (next.length > RECENT_FAILURE_LIMIT) {
    next.splice(0, next.length - RECENT_FAILURE_LIMIT);
  }
  recentFailuresBySession.set(sessionId, next);
}

export function recordAssetResolutionFailure(options: RecordAssetResolutionFailureOptions): void {
  const sessionIdHash = hashSessionIdForBreadcrumb(options.sessionId);
  const assetIdHash = options.assetId ? hashSessionIdForBreadcrumb(options.assetId) : undefined;
  const timestamp = Date.now();

  const failure: ResolutionFailure = {
    timestamp,
    sessionIdHash,
    ...(assetIdHash ? { assetIdHash } : {}),
    reason: options.reason,
    context: options.context,
    ...(options.metadata ? { metadata: options.metadata } : {}),
  };

  appendRecentFailure(options.sessionId, failure);

  options.log.warn(
    {
      ...(options.metadata ?? {}),
      sessionIdHash,
      ...(assetIdHash ? { assetIdHash } : {}),
      reason: options.reason,
      context: options.context,
    },
    'asset-resolution-failure',
  );
}

export function getRecentResolutionFailures(sessionId: string): ResolutionFailure[] {
  return [...(recentFailuresBySession.get(sessionId) ?? [])];
}

export function resetAssetResolutionFailuresForTests(): void {
  recentFailuresBySession.clear();
}
