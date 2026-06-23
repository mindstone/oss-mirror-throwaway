import { getErrorReporter } from '@core/errorReporter';
import { appendDiagnosticEvent } from '@core/services/diagnosticEventsLedger';
import type { AgentSession } from '@shared/types';
import { toDiagnosticContinuityTransition } from '@shared/diagnostics/continuityTransition';
import { fnvHashBase36 as hashForBreadcrumb } from '@rebel/shared';

const CLOCK_BACKWARDS_BREADCRUMB_THROTTLE_MS = 60 * 60 * 1000;

const lastStampedBySession = new Map<string, number>();
const lastBackwardsBreadcrumbAtBySession = new Map<string, number>();

let nowProvider: () => number = () => Date.now();

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function getServerNow(): number {
  return nowProvider();
}

function maybeEmitClockBackwardsBreadcrumb(sessionId: string, serverNow: number, lastStamped: number, nextCloudUpdatedAt: number): void {
  const lastEmittedAt = lastBackwardsBreadcrumbAtBySession.get(sessionId);
  if (lastEmittedAt !== undefined && serverNow - lastEmittedAt < CLOCK_BACKWARDS_BREADCRUMB_THROTTLE_MS) return;
  lastBackwardsBreadcrumbAtBySession.set(sessionId, serverNow);

  const data = {
    reason: 'server-clock-backwards',
    sessionIdHash: hashForBreadcrumb(sessionId),
    serverNow,
    lastStamped,
    nextCloudUpdatedAt,
  };

  getErrorReporter().addBreadcrumb({
    category: 'continuity.continuity-state',
    level: 'warning',
    message: 'server-clock-backwards',
    data,
  });
  appendDiagnosticEvent(toDiagnosticContinuityTransition({
    family: 'server_clock',
    category: 'continuity.continuity-state',
    level: 'warning',
    message: 'server-clock-backwards',
    data,
  }));
}

/**
 * Returns a copy of `session` with a server-stamped, per-session monotonic cloudUpdatedAt.
 */
export function stampCloudUpdatedAt<T extends Pick<AgentSession, 'id' | 'cloudUpdatedAt'>>(
  session: T,
): T & { cloudUpdatedAt: number } {
  const serverNow = getServerNow();
  const persistedCloudUpdatedAt = isFiniteTimestamp(session.cloudUpdatedAt) ? session.cloudUpdatedAt : Number.NEGATIVE_INFINITY;
  const cachedCloudUpdatedAt = lastStampedBySession.get(session.id) ?? Number.NEGATIVE_INFINITY;
  const baseline = Math.max(persistedCloudUpdatedAt, cachedCloudUpdatedAt);

  let nextCloudUpdatedAt = serverNow;
  if (serverNow <= baseline) {
    nextCloudUpdatedAt = baseline + 1;
    if (serverNow < baseline) {
      maybeEmitClockBackwardsBreadcrumb(session.id, serverNow, baseline, nextCloudUpdatedAt);
    }
  }

  lastStampedBySession.set(session.id, nextCloudUpdatedAt);
  return {
    ...session,
    cloudUpdatedAt: nextCloudUpdatedAt,
  };
}

/**
 * Seeds per-session monotonic clock state from persisted cloudUpdatedAt.
 */
export function seedServerClock(sessionId: string, cloudUpdatedAt: number | null | undefined): void {
  if (!isFiniteTimestamp(cloudUpdatedAt)) return;
  const previous = lastStampedBySession.get(sessionId) ?? Number.NEGATIVE_INFINITY;
  if (cloudUpdatedAt > previous) {
    lastStampedBySession.set(sessionId, cloudUpdatedAt);
  }
}

export function clearServerClockSession(sessionId: string): void {
  lastStampedBySession.delete(sessionId);
  lastBackwardsBreadcrumbAtBySession.delete(sessionId);
}

export function setServerNowForTests(provider: () => number): void {
  nowProvider = provider;
}

export function resetServerClockForTests(): void {
  nowProvider = () => Date.now();
  lastStampedBySession.clear();
  lastBackwardsBreadcrumbAtBySession.clear();
}
