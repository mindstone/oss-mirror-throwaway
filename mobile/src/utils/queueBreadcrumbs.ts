import * as Sentry from '@sentry/react-native';
import type { QueueTransitionEvent } from '@rebel/cloud-client';

const ENQUEUE_BATCH_WINDOW_MS = 500;

// PII-free fields allowed on breadcrumb `data`. Anything not on this list
// is dropped by the sanitizer. When you add a new field to a transition
// event, add it here too, or the breadcrumb will silently lose it.
const SAFE_KEYS = new Set([
  'itemId',
  'type',
  'totalSize',
  'pendingCount',
  'onlineStatus',
  'drainedCount',
  'failedCount',
  'skippedCount',
  'errorCategory',
  'attempts',
  'itemCount',
  'rejectedItemType',
  'errorCategories',
  'oldestEnqueuedAt',
  'oldNextRetryAt',
  'newNextRetryAt',
  // Used by the `enqueue` batcher below (Behavioral Safety lens: previously
  // dropped because it was not in SAFE_KEYS).
  'batchCount',
]);

let enqueueBatchCount = 0;
let enqueueBatchTimer: ReturnType<typeof setTimeout> | null = null;

type BreadcrumbValue = string | number | boolean | null | Array<string | number>;

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isStringNumberArray(value: unknown): value is Array<string | number> {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' || typeof entry === 'number');
}

function sanitize(data: unknown): Record<string, BreadcrumbValue> | undefined {
  if (!data || typeof data !== 'object') return undefined;

  const output: Record<string, BreadcrumbValue> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!SAFE_KEYS.has(key)) continue;
    if (isPrimitive(value)) {
      output[key] = value;
      continue;
    }
    if (isStringNumberArray(value)) {
      output[key] = value;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function addBreadcrumb(event: {
  level: 'info' | 'warning' | 'error';
  message: string;
  data?: Record<string, BreadcrumbValue>;
}): void {
  Sentry.addBreadcrumb({
    category: 'queue',
    level: event.level,
    message: event.message,
    data: event.data,
    timestamp: Date.now() / 1000,
  });
}

function flushEnqueueBatch(): void {
  if (enqueueBatchCount === 0) return;

  addBreadcrumb({
    level: 'info',
    message: 'enqueue',
    data: { batchCount: enqueueBatchCount },
  });

  enqueueBatchCount = 0;
  enqueueBatchTimer = null;
}

// Escalation — promoting breadcrumbs to Sentry issues.
//
// Breadcrumbs give us queryable context within issues captured elsewhere
// (e.g. a UI crash). But for events that have no accompanying crash —
// e.g. a drain is stuck for ten minutes — we also want a Sentry issue so
// the on-call sees them without going fishing in breadcrumbs.
//
// Policy (per Operational lens review):
// - stuck-drain: captureMessage(warning), 1/hour/device
// - item-permanent-failure: captureMessage(error) when errorCategory is
//   'permanent'; captureMessage(warning) for 'timeout' / 'retry-exhaustion';
//   1/hour/device per errorCategory to avoid flooding
// - everything else: breadcrumb only
//
// Throttling is in-memory: Map<cooldownKey, lastEscalatedAt>. Resets on
// app restart, which is acceptable because we're not trying to suppress
// across sessions — just within one run.
const ESCALATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const lastEscalatedAt = new Map<string, number>();

function shouldEscalate(cooldownKey: string, now: number): boolean {
  const last = lastEscalatedAt.get(cooldownKey);
  if (last !== undefined && now - last < ESCALATION_COOLDOWN_MS) return false;
  lastEscalatedAt.set(cooldownKey, now);
  return true;
}

type EscalationSpec = {
  level: 'warning' | 'error';
  cooldownKey: string;
  title: string;
  tags?: Record<string, string>;
};

function getEscalationSpec(event: QueueTransitionEvent): EscalationSpec | null {
  switch (event.message) {
    case 'stuck-drain':
      return {
        level: 'warning',
        cooldownKey: 'stuck-drain',
        title: 'Offline queue drain is stuck',
        tags: {
          queue_event: 'stuck-drain',
          stuck_drain_error_categories: event.data.errorCategories.join(',') || 'unknown',
        },
      };
    case 'item-permanent-failure': {
      const cat = event.data.errorCategory ?? 'unknown';
      const level: 'warning' | 'error' = cat === 'permanent' ? 'error' : 'warning';
      return {
        level,
        cooldownKey: `item-permanent-failure:${cat}`,
        title: `Offline queue item permanently failed (${cat})`,
        tags: {
          queue_event: 'item-permanent-failure',
          queue_error_category: cat,
          queue_item_type: event.data.type,
        },
      };
    }
    // Every other event is breadcrumb-only; the exhaustive switch below
    // guards against silent drops if a new variant is added.
    default:
      return null;
  }
}

// Exported for tests — allows clearing the throttle map between cases.
export function __resetEscalationCooldownForTests(): void {
  lastEscalatedAt.clear();
}

export function recordQueueBreadcrumb(event: QueueTransitionEvent): void {
  // Exhaustive check: TS errors if a new QueueTransitionEvent message
  // variant is added without a case here.
  switch (event.message) {
    case 'enqueue':
      enqueueBatchCount += 1;
      if (!enqueueBatchTimer) {
        enqueueBatchTimer = setTimeout(flushEnqueueBatch, ENQUEUE_BATCH_WINDOW_MS);
      }
      return;
    case 'drain-start':
    case 'drain-complete':
    case 'item-permanent-failure':
    case 'auth-expired':
    case 'queue-full':
    case 'identity-mismatch':
    case 'stuck-drain':
    case 'clock-jump-guard':
      break;
    default: {
      // Compile-time exhaustiveness guard.
      const _exhaustive: never = event;
      void _exhaustive;
    }
  }

  if (enqueueBatchTimer) {
    clearTimeout(enqueueBatchTimer);
    flushEnqueueBatch();
  }

  addBreadcrumb({
    level: event.level ?? 'info',
    message: event.message,
    data: sanitize(event.data),
  });

  // Escalation: only a subset of events, throttled.
  const spec = getEscalationSpec(event);
  if (!spec) return;
  if (!shouldEscalate(spec.cooldownKey, Date.now())) return;

  try {
    Sentry.withScope((scope) => {
      scope.setTag('queue_escalation', 'true');
      if (spec.tags) {
        for (const [k, v] of Object.entries(spec.tags)) scope.setTag(k, v);
      }
      scope.setLevel(spec.level);
      const data = sanitize(event.data);
      if (data) scope.setContext('queue_event_data', data as Record<string, unknown>);
      Sentry.captureMessage(spec.title, spec.level);
    });
  } catch {
    // Sentry failures must never take out the app — fall through silently.
    // The breadcrumb above was already recorded so the event isn't lost.
  }
}
