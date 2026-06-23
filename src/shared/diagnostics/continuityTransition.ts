import { z } from 'zod';

export const CONTINUITY_FAMILIES = [
  'state',
  'metadata',
  'outbox',
  'workspace_sync',
  'router',
  'server_clock',
  'outbox_stall',
  'session_mutex',
  'merge',
  'session_delta_push',
] as const;

export type ContinuityFamily = (typeof CONTINUITY_FAMILIES)[number];

export const CONTINUITY_MESSAGES = [
  'cloud-removal-intent-cleared',
  'concurrent-edit',
  'continuity-intent-incoherent',
  'continuity-merge-refused',
  'invariant-violation',
  'server-clock-backwards',
  'event-overwrite-prevented',
  'session-delta-push:applied',
  'session-delta-push:needs-reconcile',
  'session-delta-push:needs-bootstrap',
  'session-delta-push:capability-missing-fallback',
  'session-delta-push:drift-detected',
  'session-delta-push:bootstrap-fallback',
  'session-delta-push:metadata-patch-applied',
  'session-delta-push:reconcile-via-patch',
  'session-delta-push:reconcile-patch:generation-bumped-defer',
  'session-delta-push:reconcile-patch:needs-bootstrap',
  'session-delta-push:reconcile-patch:capability-missing-fallback',
  'session-delta-push:reconcile-patch:needs-reconcile',
  'session-delta-push:reconcile-handshake:matched',
  'session-delta-push:reconcile-handshake:drift-detected',
  'session-delta-push:reconcile-handshake:capability-missing-fallback',
  'session-delta-push:chunked',
  'session-delta-push:chunk-applied',
  'session-delta-push:destructive-op-applied',
  'session-delta-push:message-delete-rescinded',
  'session-mutex-contention',
  'session-mutex-deadlock',
  'stale-metadata',
  'state-map-gc-protected',
  'state-transition',
  'stuck-outbox',
  'surface-tiebreaker',
  'tombstone-added',
  'tombstone-applied',
  'tombstone-race-detected',
] as const;

export type ContinuityMessage = (typeof CONTINUITY_MESSAGES)[number];

export const CONTINUITY_REASONS = [
  'cloud-active-promotion',
  'cloud-active-with-removal-intent',
  'cloud-disabled',
  'cloud-enabled',
  'concurrent-edit',
  'first-cloud-sync',
  'manual-reset',
  'no-intent',
  'no-removal-intent',
  'retention-policy-visibility-only',
  'server-clock-backwards',
  'session-mutex-contention',
  'session-mutex-deadlock',
  'stale-metadata',
  'stuck-outbox',
  'surface-tiebreaker',
  'tombstone-added',
  'tombstone-applied',
  'tombstone-race-detected',
  'workspace-toctou-retry',
] as const;

export type ContinuityReason = (typeof CONTINUITY_REASONS)[number];

export const ContinuityFamilySchema = z.enum(CONTINUITY_FAMILIES);
export const ContinuityMessageSchema = z.enum(CONTINUITY_MESSAGES);
export const ContinuityReasonSchema = z.enum(CONTINUITY_REASONS);

export type ContinuityBreadcrumbLevel = 'info' | 'warning' | 'error';
export type ContinuityBreadcrumbSurface = 'desktop' | 'cloud' | 'mobile' | 'unknown';

export interface DiagnosticContinuityBreadcrumbInput {
  family: ContinuityFamily;
  category: string;
  message: string;
  level?: ContinuityBreadcrumbLevel;
  surface?: ContinuityBreadcrumbSurface;
  data?: Record<string, unknown>;
}

export interface DiagnosticContinuityTransitionPayload {
  kind: 'continuity_transition';
  surface?: ContinuityBreadcrumbSurface;
  data: {
    family: ContinuityFamily;
    message: ContinuityMessage;
    reason?: ContinuityReason;
    level?: ContinuityBreadcrumbLevel;
    sessionIdHash?: string;
  };
}

export const CONTINUITY_TRANSITION_TUPLES = [
  {
    family: 'state',
    category: 'continuity.sanitizer',
    message: 'continuity-intent-incoherent',
    reason: 'cloud-active-with-removal-intent',
  },
  {
    family: 'state',
    category: 'continuity.merge-guard',
    message: 'continuity-merge-refused',
    reason: 'no-intent',
  },
  {
    family: 'state',
    category: 'continuity.gc-guard',
    message: 'state-map-gc-protected',
    reason: 'retention-policy-visibility-only',
  },
  {
    family: 'state',
    category: 'continuity.gc-guard',
    message: 'state-map-gc-protected',
    reason: 'no-removal-intent',
  },
  {
    family: 'metadata',
    category: 'continuity.continuity-state',
    message: 'state-transition',
    reason: 'cloud-enabled',
  },
  {
    family: 'metadata',
    category: 'continuity.continuity-state',
    message: 'state-transition',
    reason: 'cloud-disabled',
  },
  {
    family: 'metadata',
    category: 'continuity.continuity-state',
    message: 'state-transition',
    reason: 'first-cloud-sync',
  },
  {
    family: 'metadata',
    category: 'continuity.continuity-state',
    message: 'state-transition',
    reason: 'manual-reset',
  },
  {
    family: 'metadata',
    category: 'continuity.continuity-state',
    message: 'invariant-violation',
  },
  {
    family: 'metadata',
    category: 'continuity.intent-cleared',
    message: 'cloud-removal-intent-cleared',
    reason: 'cloud-active-promotion',
  },
  {
    family: 'outbox',
    category: 'continuity.continuity-state',
    message: 'state-transition',
    reason: 'session-mutex-contention',
  },
  {
    family: 'outbox',
    category: 'continuity.continuity-state',
    message: 'stuck-outbox',
    reason: 'stuck-outbox',
  },
  {
    family: 'workspace_sync',
    category: 'continuity.continuity-state',
    message: 'state-transition',
    reason: 'workspace-toctou-retry',
  },
  {
    family: 'router',
    category: 'continuity.continuity-state',
    message: 'tombstone-applied',
    reason: 'tombstone-applied',
  },
  {
    family: 'router',
    category: 'continuity.continuity-state',
    message: 'tombstone-race-detected',
    reason: 'tombstone-race-detected',
  },
  {
    family: 'server_clock',
    category: 'continuity.continuity-state',
    message: 'server-clock-backwards',
    reason: 'server-clock-backwards',
  },
  {
    family: 'outbox_stall',
    category: 'continuity.continuity-state',
    message: 'stuck-outbox',
    reason: 'stuck-outbox',
  },
  {
    family: 'session_mutex',
    category: 'continuity.continuity-state',
    message: 'session-mutex-contention',
    reason: 'session-mutex-contention',
  },
  {
    family: 'session_mutex',
    category: 'continuity.continuity-state',
    message: 'session-mutex-deadlock',
    reason: 'session-mutex-deadlock',
  },
  {
    family: 'merge',
    category: 'continuity.continuity-state',
    message: 'tombstone-added',
    reason: 'tombstone-added',
  },
  {
    family: 'merge',
    category: 'continuity.continuity-state',
    message: 'tombstone-applied',
    reason: 'tombstone-applied',
  },
  {
    family: 'merge',
    category: 'continuity.continuity-state',
    message: 'tombstone-race-detected',
    reason: 'tombstone-race-detected',
  },
  {
    family: 'merge',
    category: 'continuity.conflict',
    message: 'stale-metadata',
    reason: 'stale-metadata',
  },
  {
    family: 'merge',
    category: 'continuity.conflict',
    message: 'concurrent-edit',
    reason: 'concurrent-edit',
  },
  {
    family: 'merge',
    category: 'continuity.conflict',
    message: 'surface-tiebreaker',
    reason: 'surface-tiebreaker',
  },
  {
    family: 'merge',
    category: 'continuity.session-merge',
    message: 'event-overwrite-prevented',
  },
  {
    family: 'merge',
    category: 'continuity.session-merge',
    message: 'session-delta-push:applied',
  },
  {
    family: 'merge',
    category: 'continuity.session-merge',
    message: 'session-delta-push:destructive-op-applied',
  },
  {
    family: 'merge',
    category: 'continuity.session-merge',
    message: 'session-delta-push:message-delete-rescinded',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:applied',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:needs-reconcile',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:needs-bootstrap',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:capability-missing-fallback',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:drift-detected',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:bootstrap-fallback',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:metadata-patch-applied',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:reconcile-via-patch',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:reconcile-patch:generation-bumped-defer',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:reconcile-patch:needs-bootstrap',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:reconcile-patch:capability-missing-fallback',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:reconcile-patch:needs-reconcile',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:reconcile-handshake:matched',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:reconcile-handshake:drift-detected',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:reconcile-handshake:capability-missing-fallback',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:chunked',
  },
  {
    family: 'session_delta_push',
    category: 'continuity.session-delta-push',
    message: 'session-delta-push:chunk-applied',
  },
] as const satisfies ReadonlyArray<{
  family: ContinuityFamily;
  category: `continuity.${string}`;
  message: ContinuityMessage;
  reason?: ContinuityReason;
}>;

const VALID_TUPLES = new Set(
  CONTINUITY_TRANSITION_TUPLES.map(tupleKey),
);

const OPAQUE_HASH_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export function toDiagnosticContinuityTransition(
  event: DiagnosticContinuityBreadcrumbInput,
): DiagnosticContinuityTransitionPayload {
  if (!event.category.startsWith('continuity.')) {
    throw new Error(`Unsupported continuity breadcrumb category: ${event.category}`);
  }

  const family = ContinuityFamilySchema.parse(event.family);
  const message = ContinuityMessageSchema.parse(event.message);
  const reason = extractReason(event.data);
  const key = tupleKey({ family, message, reason });
  if (!VALID_TUPLES.has(key)) {
    throw new Error(`Unsupported continuity transition tuple: ${key}`);
  }

  const data: DiagnosticContinuityTransitionPayload['data'] = { family, message };
  if (reason) data.reason = reason;
  if (event.level) data.level = event.level;

  const sessionIdHash = event.data?.sessionIdHash;
  if (sessionIdHash !== undefined) {
    if (typeof sessionIdHash !== 'string' || !OPAQUE_HASH_PATTERN.test(sessionIdHash)) {
      throw new Error('Invalid continuity sessionIdHash');
    }
    data.sessionIdHash = sessionIdHash;
  }

  return {
    kind: 'continuity_transition',
    ...(event.surface ? { surface: event.surface } : {}),
    data,
  };
}

function extractReason(data: Record<string, unknown> | undefined): ContinuityReason | undefined {
  if (!data) return undefined;
  const candidate =
    data.reason ??
    data.refusal ??
    data.protected ??
    data.conflictType;
  if (candidate === undefined) return undefined;
  if (typeof candidate !== 'string') {
    throw new Error('Invalid continuity reason');
  }
  return ContinuityReasonSchema.parse(candidate);
}

function tupleKey(tuple: {
  family: ContinuityFamily;
  message: ContinuityMessage;
  reason?: ContinuityReason;
}): string {
  return `${tuple.family}:${tuple.message}:${tuple.reason ?? 'none'}`;
}
