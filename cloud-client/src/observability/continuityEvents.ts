/**
 * Continuity transition event contract.
 *
 * Generalises the pattern pioneered for the offline queue
 * (`QueueTransitionEvent` → `recordQueueBreadcrumb`, see
 * `cloud-client/src/offlineQueue/types.ts` and
 * `mobile/src/utils/queueBreadcrumbs.ts`) to cover the full cloud continuity
 * surface: session merges, outbox sends, catch-up fetches, continuity
 * state-machine transitions, and conflict detections.
 *
 * Design notes:
 * - Every event is a branch of a discriminated union keyed by `family` and
 *   `message`. Exhaustive-switch guards at the recording site prevent new
 *   variants from silently dropping.
 * - Each branch declares a strict `data` shape. Values are IDs, counts,
 *   reason codes, hashes — never raw user content, never URLs, never
 *   session titles. The companion `recordContinuityBreadcrumb()` enforces
 *   a per-family SAFE_KEYS allowlist on top of this type contract.
 * - `level` defaults to `info` for routine transitions and `warning` for
 *   anything that indicates user-visible degradation or a latent bug.
 * - Session/turn identifiers are emitted as `sessionIdHash` / `turnIdHash`
 *   so Sentry aggregations can group by entity without exposing the raw
 *   ID. Hashes are stable within a session run (short FNV-1a of the ID).
 *
 * @see docs/plans/260418_cloud_continuity_robustness_and_observability.md
 */

import { fnvHashBase36 } from '@rebel/shared';

type ContinuityInfoLevel = { level?: 'info' };
type ContinuityInfoOrWarningLevel = { level?: 'info' | 'warning' };
type ContinuityWarningLevel = { level?: 'warning' };
type ContinuityErrorLevel = { level?: 'error' };

/** Direction of a session merge operation. */
export type SessionMergeDirection = 'desktop-pull' | 'cloud-push';

/** Reason codes for continuity state-machine transitions. */
export type ContinuityStateReason =
  | 'cloud-enabled'
  | 'cloud-disabled'
  | 'first-cloud-sync'
  | 'stuck-outbox'
  | 'tombstone-cursor-missing-server-time'
  | 'tombstone-added'
  | 'tombstone-applied'
  | 'tombstone-broadcast-received'
  | 'tombstone-race-detected'
  | 'identity-changed'
  | 'migration'
  | 'server-clock-backwards'
  | 'server-restart-detected'
  | 'session-mutex-contention'
  | 'session-mutex-deadlock'
  | 'seq-unavailable'
  | 'lifecycle-drain-foreground'
  | 'lifecycle-resume-post-reboot'
  | 'workspace-toctou-retry'
  | 'foreground-drain-triggered'
  | 'post-reboot-drain-triggered'
  | 'attachment-orphan-detected'
  | 'manual-reset';

/** Outbox item lifecycle. */
export type OutboxTransition =
  | 'queued'
  | 'sent'
  | 'failed'
  | 'retry-exhausted'
  | 'item-stuck-ack'
  | 'ack-missing'
  | 'turn-persisted'
  | 'persisted-ack-missing'
  | 'idempotent-replay'
  | 'in-flight-conflict';

/** Classification of a detected conflict. */
export type ConflictType =
  | 'metadata-divergence'
  | 'title-divergence'
  | 'stale-metadata'
  | 'concurrent-edit'
  | 'turn-seq-gap'
  | 'tombstone-race'
  | 'clientTurnId-collision';

/** How the conflict was resolved by the server. */
export type ConflictResolution =
  | 'last-writer-wins'
  | 'server-authoritative'
  | 'client-retried'
  | 'dropped';

/** Broad error grouping; keeps breadcrumb cardinality bounded. */
export type ContinuityErrorCategory =
  | 'auth'
  | 'network'
  | 'timeout'
  | 'server-5xx'
  | 'server-4xx'
  | 'session-state'
  | 'unknown';

// -----------------------------------------------------------------------------
// Session-merge family
// -----------------------------------------------------------------------------

export type SessionMergeEvent =
  | ({
      family: 'session-merge';
      message: 'start';
      data: {
        direction: SessionMergeDirection;
        sessionCount: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'session-merge';
      message: 'complete';
      data: {
        direction: SessionMergeDirection;
        sessionCount: number;
        addedTurnCount: number;
        droppedTurnCount: number;
        conflictCount: number;
        localOnlyCount: number;
        durationMs: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'session-merge';
      message: 'dropped-turn';
      data: {
        direction: SessionMergeDirection;
        sessionIdHash: string;
        reason: 'busy-session' | 'seq-gap' | 'older-than-cloud' | 'schema-version';
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'session-merge';
      message: 'envelope-rejected' | 'envelope-rejected-on-catch-up';
      data: {
        direction: SessionMergeDirection;
        sessionIdHash: string;
        reason: string;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'session-merge';
      message: 'event-overwrite-prevented';
      data: {
        direction: 'cloud-push';
        sessionIdHash: string;
        turnIdHash: string;
        identityHash: string;
        changedFields: string[];
      };
    } & ContinuityWarningLevel);

// -----------------------------------------------------------------------------
// Outbox family
// -----------------------------------------------------------------------------

export type OutboxEvent =
  | ({
      family: 'outbox';
      message: 'queued';
      data: {
        sessionIdHash: string;
        turnIdHash: string;
        clientTurnId: string;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'outbox';
      message: 'sent';
      data: {
        sessionIdHash: string;
        turnIdHash: string;
        clientTurnId: string;
        attempt: number;
        latencyMs: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'outbox';
      message: 'failed';
      data: {
        sessionIdHash: string;
        turnIdHash: string;
        clientTurnId: string;
        attempt: number;
        errorCategory: ContinuityErrorCategory;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'outbox';
      message: 'retry-exhausted';
      data: {
        sessionIdHash: string;
        turnIdHash: string;
        clientTurnId: string;
        attempts: number;
        errorCategory: ContinuityErrorCategory;
      };
    } & ContinuityErrorLevel)
  | ({
      family: 'outbox';
      message: 'item-stuck-ack';
      data: {
        ageMs: number;
        attempts: number;
        errorCategory: ContinuityErrorCategory;
        itemKindHashed: string;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'outbox';
      message: 'ack-missing';
      data: {
        sessionIdHash: string;
        turnIdHash: string;
        clientTurnId: string;
        waitedMs: number;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'outbox';
      message: 'turn-persisted';
      data: {
        clientTurnIdHash: string;
        turnIdHash?: string;
        sessionIdHash?: string;
        elapsedMs: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'outbox';
      message: 'persisted-ack-missing';
      level: 'warning' | 'error';
      data: {
        clientTurnIdHash: string;
        elapsedMs: number;
      };
    })
  | ({
      family: 'outbox';
      message: 'idempotent-replay';
      data: {
        clientTurnIdHash: string;
        turnIdHash?: string;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'outbox';
      message: 'in-flight-conflict';
      data: {
        clientTurnIdHash: string;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'outbox';
      message: 'session-tombstoned';
      data: {
        clientTurnIdHash: string;
        sessionIdHash: string;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'outbox';
      message: 'turn-persisted-error';
      level: 'warning';
      data: {
        clientTurnIdHash: string;
        turnIdHash?: string;
        sessionIdHash?: string;
        /** Structural error classification (e.g. 'connection-not-configured'). */
        errorKind?: string;
        /** Provider name at the time of the terminal route decision. */
        provider?: string;
        /** Whether this persisted-error ack was an idempotent replay. */
        idempotentReplay?: boolean;
      };
    });

// -----------------------------------------------------------------------------
// Catch-up family (SSE reconnect backfill)
// -----------------------------------------------------------------------------

export type CatchUpEvent =
  | ({
      family: 'catch-up';
      message: 'catch-up-started';
      data: {
        missedSince: number | null;
        sessionIdCount: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'catch-up';
      message: 'catch-up-success';
      data: {
        missedSince: number | null;
        addedEvents: number;
        sessionIdCount: number;
        latencyMs: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'catch-up';
      message: 'catch-up-failed';
      data: {
        missedSince: number | null;
        sessionIdCount: number;
        attempts: number;
        errorCategory: ContinuityErrorCategory;
        errorStatusCode?: number;
      };
    } & ContinuityErrorLevel)
  | ({
      family: 'catch-up';
      message: 'catch-up-unavailable';
      data: {
        missedSince: number | null;
        sessionIdCount: number;
        errorCategory: ContinuityErrorCategory;
        errorStatusCode?: number;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'catch-up';
      message: 'catch-up-session-tombstoned';
      data: {
        sessionIdHash: string;
        reason: 'session-tombstoned';
        deletedAt: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'catch-up';
      message: 'seq-already-applied';
      data: {
        sessionIdHash: string;
        reason: 'seq-already-applied';
        incomingSeq: number;
        appliedSeq: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'catch-up';
      message: 'seq-gap-detected';
      data: {
        sessionIdHash: string;
        reason: 'seq-gap-detected';
        seq: number;
        appliedSeq: number;
        missedCount: number;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'catch-up';
      message: 'catch-up-unusually-large';
      data: {
        addedEvents: number;
        missedSince: number | null;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'catch-up';
      message: 'session-catch-up:message-delta-applied';
      data: {
        sessionIdHash: string;
        messageCount: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'catch-up';
      message: 'session-catch-up:message-delete-applied';
      data: {
        sessionIdHash: string;
        messageDeleteCount: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'catch-up';
      message: 'session-catch-up:destructive-op-applied';
      data: {
        sessionIdHash: string;
        truncatedTurnCount: number;
        deletedEventIdentityCount: number;
      };
    } & ContinuityWarningLevel);

// -----------------------------------------------------------------------------
// Continuity state-machine family
// -----------------------------------------------------------------------------

export type ContinuityStateEvent =
  | ({
      family: 'continuity-state';
      message: 'transition' | 'state-transition';
      data: {
        sessionIdHash: string;
        from: 'local_only' | 'cloud_active';
        to: 'local_only' | 'cloud_active';
        reason: ContinuityStateReason;
        kind?: 'session-mutex-contention' | 'session-mutex-deadlock';
        waitedMs?: number;
        label?: string;
        direction?: string;
        tombstoneCount?: number;
        lastTombstoneSyncAt?: number;
      };
    } & ContinuityInfoOrWarningLevel)
  | ({
      family: 'continuity-state';
      message: 'stuck-outbox';
      data: {
        reason: 'stuck-outbox';
        deviceIdHash: string;
        depth: number;
        lastDrainAt: number;
        ageMs: number;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'continuity-state';
      message: 'invariant-violation';
      data: {
        sessionIdHash: string;
        invariant: string;
      };
    } & ContinuityErrorLevel);

// -----------------------------------------------------------------------------
// Conflict family
// -----------------------------------------------------------------------------

export type ConflictEvent =
  | ({
      family: 'conflict';
      message: 'detected';
      data: {
        sessionIdHash: string;
        conflictType: ConflictType;
        resolution: ConflictResolution;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'conflict';
      message: 'stale-metadata';
      data: {
        sessionIdHash: string;
        conflictType: 'stale-metadata';
        fields: string[];
        serverCloudUpdatedAt?: number;
        clientCloudUpdatedAt?: number | null;
        staleBy?: 'cloudUpdatedAt' | 'seq' | null;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'conflict';
      message: 'concurrent-edit';
      data: {
        sessionIdHash: string;
        conflictType: 'concurrent-edit';
        fields: string[];
        previousValue?: string | number | boolean | null;
        newValue?: string | number | boolean | null;
        previousValueHash?: string;
        newValueHash?: string;
      };
    } & ContinuityWarningLevel);

// -----------------------------------------------------------------------------
// Session delta-push family
// -----------------------------------------------------------------------------

export type SessionDeltaPushEvent =
  | ({
      family: 'session-delta-push';
      message: 'applied';
      data: {
        sessionIdHash: string;
        appliedCount: number;
        serverSeq: number;
        cloudUpdatedAt: number;
        baseSeq: number;
        payloadBytes?: number;
        gzipBytes?: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'session-delta-push';
      message: 'needs-reconcile';
      data: {
        sessionIdHash: string;
        baseSeq: number;
        serverSeq?: number;
        cloudUpdatedAt?: number;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'session-delta-push';
      message: 'needs-bootstrap' | 'capability-missing-fallback' | 'bootstrap-fallback';
      data: {
        sessionIdHash: string;
        baseSeq: number;
      };
    } & ContinuityInfoLevel)
  | ({
      family: 'session-delta-push';
      message: 'drift-detected';
      data: {
        sessionIdHash: string;
        baseSeq: number;
        serverSeq: number;
      };
    } & ContinuityWarningLevel)
  | ({
      family: 'session-delta-push';
      message: 'metadata-patch-applied';
      data: {
        sessionIdHash: string;
        baseSeq: number;
        cloudUpdatedAt: number;
      };
    } & ContinuityInfoLevel);

// -----------------------------------------------------------------------------
// Union + helpers
// -----------------------------------------------------------------------------

/**
 * Every continuity transition event must be one of these branches. Adding a
 * new branch forces `recordContinuityBreadcrumb` to gain a matching case,
 * and its SAFE_KEYS allowlist to gain the new field names.
 */
export type ContinuityTransitionEvent =
  | SessionMergeEvent
  | OutboxEvent
  | CatchUpEvent
  | ContinuityStateEvent
  | ConflictEvent
  | SessionDeltaPushEvent;

/** Discriminant union of family tags. Used to gate SAFE_KEYS lookups. */
export type ContinuityEventFamily = ContinuityTransitionEvent['family'];

/**
 * Stable short hash for session/turn IDs. Deliberately not cryptographic —
 * the goal is to avoid leaking raw IDs into breadcrumbs while preserving
 * groupability within a Sentry session. FNV-1a 32-bit, base36.
 *
 * Re-exported from `@rebel/shared` (`fnvHashBase36`) which is the canonical
 * implementation used across cloud-client, main process, cloud-service,
 * mobile, and browser-extension. The delegation keeps the long-standing
 * `hashForBreadcrumb` import path stable for the 10+ downstream consumers.
 *
 * @see packages/shared/src/utils/fnvHash.ts
 */
export function hashForBreadcrumb(input: string): string {
  return fnvHashBase36(input);
}

/**
 * Allowlist of data-field names permitted on breadcrumbs, per family. Any key
 * not on the list is dropped by the sanitizer. This is a defence-in-depth on
 * top of the type contract — if a developer accidentally adds a field via a
 * cast or an `any`, SAFE_KEYS stops it from reaching Sentry.
 *
 * Keep this allowlist aligned with the branches above. CI should add a test
 * that walks the type graph and asserts every declared field is present.
 */
export const CONTINUITY_SAFE_KEYS: Record<ContinuityEventFamily, ReadonlySet<string>> = {
  'session-merge': new Set([
    'direction',
    'sessionCount',
    'addedTurnCount',
    'droppedTurnCount',
    'conflictCount',
    'localOnlyCount',
    'durationMs',
    'sessionIdHash',
    'turnIdHash',
    'identityHash',
    'changedFields',
    'reason',
  ]),
  outbox: new Set([
    'sessionIdHash',
    'turnIdHash',
    'clientTurnId',
    'clientTurnIdHash',
    'ageMs',
    'attempt',
    'attempts',
    'latencyMs',
    'errorCategory',
    'waitedMs',
    'elapsedMs',
    'itemKindHashed',
    'errorKind',
    'provider',
    'idempotentReplay',
  ]),
  'catch-up': new Set([
    'missedSince',
    'addedEvents',
    'sessionIdCount',
    'latencyMs',
    'attempts',
    'errorCategory',
    'errorStatusCode',
    'sessionIdHash',
    'reason',
    'deletedAt',
    'incomingSeq',
    'seq',
    'appliedSeq',
    'missedCount',
    'messageCount',
    'messageDeleteCount',
    'truncatedTurnCount',
    'deletedEventIdentityCount',
  ]),
  'continuity-state': new Set([
    'kind',
    'deviceIdHash',
    'depth',
    'sessionIdHash',
    'lastDrainAt',
    'ageMs',
    'from',
    'to',
    'reason',
    'invariant',
    'waitedMs',
    'label',
    'direction',
    'tombstoneCount',
    'lastTombstoneSyncAt',
  ]),
  conflict: new Set([
    'sessionIdHash',
    'conflictType',
    'resolution',
    'fields',
    'serverCloudUpdatedAt',
    'clientCloudUpdatedAt',
    'staleBy',
    'previousValue',
    'newValue',
    'previousValueHash',
    'newValueHash',
  ]),
  'session-delta-push': new Set([
    'sessionIdHash',
    'appliedCount',
    'serverSeq',
    'cloudUpdatedAt',
    'baseSeq',
    'payloadBytes',
    'gzipBytes',
  ]),
};
