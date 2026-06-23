import * as Sentry from '@sentry/react-native';
import {
  CONTINUITY_SAFE_KEYS,
  type ContinuityTransitionEvent,
  type ContinuityEventFamily,
} from '@rebel/cloud-client';
import { appendMobileDiagnosticEvent } from '../storage/diagnosticEventBufferStorage';

/**
 * Records a `ContinuityTransitionEvent` as a Sentry breadcrumb and, for a
 * curated subset of families/messages, escalates to `Sentry.captureMessage`
 * with throttled cooldowns.
 *
 * This is the cross-surface generalisation of `queueBreadcrumbs.ts`. The
 * offline-queue transitions (`recordQueueBreadcrumb`) continue to use their
 * own sanitizer because they predate this contract — but every new event
 * added from session-merge / outbox / catch-up / session-delta-push /
 * continuity-state / conflict families routes through this function.
 *
 * Design principles (mirrors `mobile/src/utils/queueBreadcrumbs.ts`):
 *
 * - **PII defence in depth**: values are filtered by
 *   `CONTINUITY_SAFE_KEYS[family]` *after* being typed by
 *   `ContinuityTransitionEvent`. Keys not on the allowlist are dropped, not
 *   just clipped. A developer who accidentally smuggles a raw sessionId in
 *   via a cast sees their field silently disappear from the breadcrumb.
 *
 * - **Exhaustive switch guards**: adding a new event family in
 *   `continuityEvents.ts` breaks compilation here unless handled. There are
 *   no default branches that accept unknown shapes.
 *
 * - **Escalation throttling**: high-noise events (per-turn outbox failures,
 *   per-session merge drops) escalate at most once per hour per
 *   cooldown key. The throttle map is in-memory; it resets on app restart,
 *   which is acceptable because escalation serves on-call visibility, not
 *   long-term dedupe.
 *
 * - **Sentry failures are swallowed**: the breadcrumb path already executed
 *   if `captureMessage` throws, so the continuity event is not lost.
 *
 * @see cloud-client/src/observability/continuityEvents.ts (contract)
 * @see mobile/src/utils/queueBreadcrumbs.ts (queue-specific companion)
 * @see docs/plans/260418_cloud_continuity_robustness_and_observability.md
 */

type BreadcrumbValue = string | number | boolean | null | Array<string | number>;

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isStringNumberArray(value: unknown): value is Array<string | number> {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' || typeof entry === 'number');
}

function sanitize(family: ContinuityEventFamily, data: unknown): Record<string, BreadcrumbValue> | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const allowed = CONTINUITY_SAFE_KEYS[family];
  const output: Record<string, BreadcrumbValue> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
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

const ESCALATION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const lastEscalatedAt = new Map<string, number>();

function shouldEscalate(cooldownKey: string, now: number): boolean {
  const last = lastEscalatedAt.get(cooldownKey);
  if (last !== undefined && now - last < ESCALATION_COOLDOWN_MS) return false;
  lastEscalatedAt.set(cooldownKey, now);
  return true;
}

/** Exported for tests — allows clearing throttle map between cases. */
export function __resetContinuityEscalationCooldownForTests(): void {
  lastEscalatedAt.clear();
}

type EscalationSpec = {
  level: 'warning' | 'error';
  cooldownKey: string;
  title: string;
  shouldThrottle?: boolean;
  tags?: Record<string, string>;
};

/**
 * Returns an escalation spec for events we want surfaced as Sentry messages,
 * not just breadcrumbs. Everything else is breadcrumb-only.
 *
 * Policy (matches queueBreadcrumbs.ts style):
 * - `session-merge/dropped-turn` → warning, cooldown per `direction + reason`
 * - `outbox/retry-exhausted`     → error, cooldown per errorCategory
 * - `outbox/item-stuck-ack`      → warning, cooldown 1/hour/device
 * - `catch-up/catch-up-unusually-large` → warning, shared cooldown
 * - `catch-up/catch-up-failed`   → error, no throttle
 * - `session-delta-push/needs-reconcile` → warning, cooldown 1/hour/device
 * - `session-delta-push/drift-detected`  → warning, cooldown 1/hour/device
 * - `continuity-state/stuck-outbox` → warning, cooldown 1/hour/device
 * - `continuity-state/invariant-violation` → error, no throttle
 * - `conflict/concurrent-edit`   → warning, cooldown 1/hour
 */
function getEscalationSpec(event: ContinuityTransitionEvent): EscalationSpec | null {
  switch (event.family) {
    case 'session-merge':
      if (event.message === 'dropped-turn') {
        return {
          level: 'warning',
          cooldownKey: `session-merge:dropped-turn:${event.data.direction}:${event.data.reason}`,
          title: `Session merge dropped turn (${event.data.reason})`,
          tags: {
            continuity_event: 'session-merge:dropped-turn',
            session_merge_direction: event.data.direction,
            session_merge_drop_reason: event.data.reason,
          },
        };
      }
      return null;
    case 'outbox':
      if (event.message === 'retry-exhausted') {
        return {
          level: 'error',
          cooldownKey: `outbox:retry-exhausted:${event.data.errorCategory}`,
          title: `Outbox retries exhausted (${event.data.errorCategory})`,
          tags: {
            continuity_event: 'outbox:retry-exhausted',
            outbox_error_category: event.data.errorCategory,
          },
        };
      }
      if (event.message === 'item-stuck-ack') {
        return {
          level: 'warning',
          cooldownKey: 'outbox-stuck-ack',
          title: 'Outbox item has been waiting for turn_persisted acknowledgement',
          tags: {
            continuity_event: 'outbox:item-stuck-ack',
          },
        };
      }
      if (event.message === 'persisted-ack-missing') {
        return {
          level: 'error',
          cooldownKey: 'outbox:persisted-ack-missing',
          title: 'Outbox did not receive turn_persisted acknowledgement',
          tags: {
            continuity_event: 'outbox:persisted-ack-missing',
          },
        };
      }
      return null;
    case 'catch-up':
      if (event.message === 'catch-up-unusually-large') {
        return {
          level: 'warning',
          cooldownKey: 'catch-up:unusually-large',
          title: 'Catch-up fetch returned unusually many events',
          tags: { continuity_event: 'catch-up:unusually-large' },
        };
      }
      if (event.message === 'catch-up-failed') {
        return {
          level: 'error',
          cooldownKey: 'catch-up:failed',
          title: 'Catch-up fetch failed after retries',
          shouldThrottle: false,
          tags: { continuity_event: 'catch-up:failed' },
        };
      }
      return null;
    case 'session-delta-push':
      if (event.message === 'needs-reconcile' || event.message === 'drift-detected') {
        return {
          level: 'warning',
          cooldownKey: `delta-push-${event.message}`,
          title: `Session delta push ${event.message}`,
          tags: {
            continuity_event: `session-delta-push:${event.message}`,
            delta_push_reason: event.message,
          },
        };
      }
      return null;
    case 'continuity-state':
      if (event.message === 'invariant-violation') {
        return {
          level: 'error',
          cooldownKey: `continuity-state:invariant-violation:${event.data.invariant}`,
          title: `Continuity invariant violation (${event.data.invariant})`,
          shouldThrottle: false,
          tags: {
            continuity_event: 'continuity-state:invariant-violation',
            invariant: event.data.invariant,
          },
        };
      }
      if (event.message === 'stuck-outbox') {
        return {
          level: 'warning',
          cooldownKey: `continuity-state:stuck-outbox:${event.data.deviceIdHash}`,
          title: 'Continuity outbox appears stuck',
          tags: {
            continuity_event: 'continuity-state:stuck-outbox',
            device_id_hash: event.data.deviceIdHash,
          },
        };
      }
      if ((event.message === 'transition' || event.message === 'state-transition') && event.data.reason === 'tombstone-race-detected') {
        return {
          level: 'warning',
          cooldownKey: `continuity-state:tombstone-race-detected:${event.data.direction ?? 'unknown'}`,
          title: 'Tombstone race detected while applying continuity update',
          tags: {
            continuity_event: 'continuity-state:tombstone-race-detected',
            direction: event.data.direction ?? 'unknown',
          },
        };
      }
      return null;
    case 'conflict':
      if (event.message !== 'concurrent-edit') {
        return null;
      }
      return {
        level: 'warning',
        cooldownKey: 'conflict-edit',
        title: `Continuity conflict detected (${event.data.conflictType})`,
        tags: {
          continuity_event: 'conflict:concurrent-edit',
          conflict_type: event.data.conflictType,
        },
      };
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

function addBreadcrumb(args: {
  family: ContinuityEventFamily;
  message: string;
  level: 'info' | 'warning' | 'error';
  data?: Record<string, BreadcrumbValue>;
}): void {
  Sentry.addBreadcrumb({
    category: `continuity.${args.family}`,
    level: args.level,
    message: args.message,
    data: args.data,
    timestamp: Date.now() / 1000,
  });
}

/**
 * Main entry point — emits breadcrumb and, where the policy dictates,
 * escalates to Sentry.captureMessage. Never throws: Sentry failures are
 * silently swallowed because the breadcrumb has already been recorded.
 */
export function recordContinuityBreadcrumb(event: ContinuityTransitionEvent): void {
  // Exhaustive family check — compile-time guard against silent drops.
  switch (event.family) {
    case 'session-merge':
    case 'outbox':
    case 'catch-up':
    case 'session-delta-push':
    case 'continuity-state':
    case 'conflict':
      break;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return;
    }
  }

  const sanitizedData = sanitize(event.family, event.data);
  addBreadcrumb({
    family: event.family,
    message: event.message,
    level: event.level ?? 'info',
    data: sanitizedData,
  });

  // Mirror into the local mobile-only diagnostic-event buffer so the bundle
  // ZIP/Markdown can show "the last N continuity events" alongside Sentry
  // breadcrumbs. CRITICAL: this uses the mobile-local emit symbol
  // `appendMobileDiagnosticEvent`, NOT the cloud-shipped `appendDiagnosticEvent`,
  // because mobile diagnostic events stay mobile-only per the
  // I-mobile-emit-transport decision and the AST guard test enforces it.
  try {
    appendMobileDiagnosticEvent({
      ts: Date.now(),
      surface: 'mobile',
      source: 'continuity_breadcrumb',
      family: event.family,
      message: event.message,
      level: event.level,
      data: sanitizedData,
    });
  } catch {
    // Buffer must NEVER take down the breadcrumb path. The Sentry breadcrumb
    // above has already been recorded — losing the local-buffer mirror is
    // strictly worse than crashing here.
  }

  const spec = getEscalationSpec(event);
  if (!spec) return;
  if (spec.shouldThrottle !== false && !shouldEscalate(spec.cooldownKey, Date.now())) return;

  try {
    Sentry.withScope((scope) => {
      scope.setTag('continuity_escalation', 'true');
      if (spec.tags) {
        for (const [k, v] of Object.entries(spec.tags)) scope.setTag(k, v);
      }
      scope.setLevel(spec.level);
      const data = sanitize(event.family, event.data);
      if (data) scope.setContext('continuity_event_data', data as Record<string, unknown>);
      Sentry.captureMessage(spec.title, spec.level);
    });
  } catch {
    // Sentry failures must never take out the app — breadcrumb above is preserved.
  }
}
