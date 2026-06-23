import type { Logger } from '@core/logger';
import { hashSessionIdForBreadcrumb } from '@shared/utils/hashSessionIdForBreadcrumb';
import { createScopedLogger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import type { ContentResolutionReason } from '@core/types/contentResolutionReason';

const RECENT_FAILURE_LIMIT = 100;
const log = createScopedLogger({ service: 'contentResolutionFailureRecorder' });

export interface ContentResolutionFailure {
  timestamp: number;
  sessionIdHash: string;
  contentIdHash?: string;
  reason: ContentResolutionReason;
  details?: Record<string, unknown>;
}

const recentFailures: ContentResolutionFailure[] = [];

export interface RecordContentResolutionFailureOptions {
  sessionId: string;
  contentId?: string;
  reason: ContentResolutionReason;
  details?: Record<string, unknown>;
  log?: Pick<Logger, 'warn'>;
}

function hashContentId(contentId: string): string {
  return hashSessionIdForBreadcrumb(contentId);
}

function appendRecentFailure(failure: ContentResolutionFailure): void {
  recentFailures.push(failure);
  if (recentFailures.length > RECENT_FAILURE_LIMIT) {
    recentFailures.splice(0, recentFailures.length - RECENT_FAILURE_LIMIT);
  }
}

function breadcrumbLevel(reason: ContentResolutionReason): 'info' | 'warning' | 'error' {
  if (reason === 'missing' || reason === 'pending-upload') {
    return 'warning';
  }
  return 'error';
}

export function recordContentResolutionFailure(
  options: RecordContentResolutionFailureOptions,
): void {
  const sessionIdHash = hashSessionIdForBreadcrumb(options.sessionId);
  const contentIdHash = options.contentId ? hashContentId(options.contentId) : undefined;
  const timestamp = Date.now();

  const failure: ContentResolutionFailure = {
    timestamp,
    sessionIdHash,
    ...(contentIdHash ? { contentIdHash } : {}),
    reason: options.reason,
    ...(options.details ? { details: options.details } : {}),
  };

  appendRecentFailure(failure);

  const logger = options.log ?? log;
  logger.warn(
    {
      ...(options.details ?? {}),
      sessionIdHash,
      ...(contentIdHash ? { contentIdHash } : {}),
      reason: options.reason,
    },
    'content-resolution-failure',
  );

  getErrorReporter().addBreadcrumb({
    category: 'content-resolution',
    message: 'content-resolution-failure',
    level: breadcrumbLevel(options.reason),
    data: {
      sessionIdHash,
      ...(contentIdHash ? { contentIdHash } : {}),
      reason: options.reason,
      ...(options.details ? { details: options.details } : {}),
    },
  });
}

export function getRecentFailures(): readonly ContentResolutionFailure[] {
  return [...recentFailures];
}

export function resetContentResolutionFailuresForTests(): void {
  recentFailures.splice(0, recentFailures.length);
}
