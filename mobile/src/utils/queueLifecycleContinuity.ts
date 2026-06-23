import { hashForBreadcrumb, type ContinuityTransitionEvent } from '@rebel/cloud-client';

const LIFECYCLE_BREADCRUMB_THROTTLE_MS = 60 * 60 * 1000;
const lastLifecycleBreadcrumbAt = new Map<string, number>();

export type QueueDrainLifecycleReason = 'lifecycle-drain-foreground' | 'lifecycle-resume-post-reboot';
export type QueueDrainLifecycleDirection = 'mobile-foreground' | 'mobile-startup';

export function estimateBootTimeMs(now = Date.now(), performanceNow = globalThis.performance?.now?.() ?? 0): number | null {
  if (!Number.isFinite(performanceNow) || performanceNow <= 0) return null;
  return Math.max(0, now - performanceNow);
}

export function didDeviceRebootSince(lastRecordedAt: number | null, bootTimeMs: number | null): boolean {
  return bootTimeMs !== null && lastRecordedAt !== null && lastRecordedAt < bootTimeMs;
}

export function shouldRecordLifecycleBreadcrumb(args: {
  reason: QueueDrainLifecycleReason;
  cloudUrl: string | null | undefined;
  now?: number;
}): boolean {
  const now = args.now ?? Date.now();
  const throttleKey = `${args.reason}:${args.cloudUrl ?? 'mobile-queue-lifecycle'}`;
  const lastRecordedAt = lastLifecycleBreadcrumbAt.get(throttleKey);
  if (lastRecordedAt !== undefined && now - lastRecordedAt < LIFECYCLE_BREADCRUMB_THROTTLE_MS) {
    return false;
  }
  lastLifecycleBreadcrumbAt.set(throttleKey, now);
  return true;
}

export function __resetQueueLifecycleContinuityForTests(): void {
  lastLifecycleBreadcrumbAt.clear();
}

export function buildQueueDrainLifecycleBreadcrumb(args: {
  reason: QueueDrainLifecycleReason;
  direction: QueueDrainLifecycleDirection;
  cloudUrl: string | null | undefined;
  online: boolean;
}): ContinuityTransitionEvent {
  return {
    family: 'continuity-state',
    message: 'transition',
    data: {
      sessionIdHash: hashForBreadcrumb(args.cloudUrl ?? 'mobile-queue-lifecycle'),
      from: 'cloud_active',
      to: 'cloud_active',
      reason: args.reason,
      direction: args.direction,
      label: args.online ? 'online' : 'offline',
    },
  };
}
