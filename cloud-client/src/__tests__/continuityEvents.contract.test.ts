import { describe, expect, it } from 'vitest';
import {
  CONTINUITY_SAFE_KEYS,
  hashForBreadcrumb,
  type ContinuityEventFamily,
  type ContinuityTransitionEvent,
} from '../observability/continuityEvents';

/**
 * These tests guard the continuity-event observability contract.
 *
 * 1. Every declared family has a SAFE_KEYS allowlist.
 * 2. Every `data` field used by any event branch appears in the allowlist
 *    for that family (type-driven sample walk — adding a new branch without
 *    updating SAFE_KEYS will fail at sample-walk time).
 * 3. `hashForBreadcrumb` is deterministic, side-channel free, and does not
 *    leak the raw input.
 */

describe('ContinuityTransitionEvent contract', () => {
  it('SAFE_KEYS exists for every declared family', () => {
    const families: ContinuityEventFamily[] = [
      'session-merge',
      'outbox',
      'catch-up',
      'continuity-state',
      'conflict',
      'session-delta-push',
    ];
    for (const family of families) {
      expect(CONTINUITY_SAFE_KEYS[family]).toBeInstanceOf(Set);
      expect(CONTINUITY_SAFE_KEYS[family].size).toBeGreaterThan(0);
    }
  });

  it('all fields referenced by sample events are in the SAFE_KEYS allowlist', () => {
    // Sample events, one per branch. Adding a new branch without a sample
    // means the type error at construction; adding a new `data` field without
    // updating SAFE_KEYS means the assertion below fires.
    const samples: ContinuityTransitionEvent[] = [
      {
        family: 'session-merge',
        message: 'start',
        data: { direction: 'desktop-pull', sessionCount: 3 },
      },
      {
        family: 'session-merge',
        message: 'complete',
        data: {
          direction: 'cloud-push',
          sessionCount: 3,
          addedTurnCount: 5,
          droppedTurnCount: 0,
          conflictCount: 0,
          localOnlyCount: 1,
          durationMs: 42,
        },
      },
      {
        family: 'session-merge',
        message: 'dropped-turn',
        data: { direction: 'desktop-pull', sessionIdHash: 'abc123', reason: 'busy-session' },
      },
      {
        family: 'session-merge',
        message: 'envelope-rejected',
        level: 'warning',
        data: { direction: 'desktop-pull', sessionIdHash: 'abc123', reason: 'invalid-seq' },
      },
      {
        family: 'session-merge',
        message: 'event-overwrite-prevented',
        level: 'warning',
        data: {
          direction: 'cloud-push',
          sessionIdHash: 'abc123',
          turnIdHash: 'turn123',
          identityHash: 'event123',
          changedFields: ['text'],
        },
      },
      {
        family: 'outbox',
        message: 'queued',
        data: { sessionIdHash: 'a', turnIdHash: 'b', clientTurnId: 'ULID1' },
      },
      {
        family: 'outbox',
        message: 'sent',
        data: { sessionIdHash: 'a', turnIdHash: 'b', clientTurnId: 'ULID1', attempt: 1, latencyMs: 120 },
      },
      {
        family: 'outbox',
        message: 'failed',
        data: { sessionIdHash: 'a', turnIdHash: 'b', clientTurnId: 'ULID1', attempt: 2, errorCategory: 'network' },
      },
      {
        family: 'outbox',
        message: 'retry-exhausted',
        data: { sessionIdHash: 'a', turnIdHash: 'b', clientTurnId: 'ULID1', attempts: 5, errorCategory: 'server-5xx' },
      },
      {
        family: 'outbox',
        message: 'item-stuck-ack',
        data: { ageMs: 700_000, attempts: 4, errorCategory: 'timeout', itemKindHashed: 'kind1234' },
      },
      {
        family: 'outbox',
        message: 'ack-missing',
        data: { sessionIdHash: 'a', turnIdHash: 'b', clientTurnId: 'ULID1', waitedMs: 5_000 },
      },
      {
        family: 'outbox',
        message: 'turn-persisted',
        data: { clientTurnIdHash: 'ct1', turnIdHash: 't1', sessionIdHash: 's1', elapsedMs: 240 },
      },
      {
        family: 'outbox',
        message: 'persisted-ack-missing',
        level: 'warning',
        data: { clientTurnIdHash: 'ct2', elapsedMs: 60_000 },
      },
      {
        family: 'outbox',
        message: 'idempotent-replay',
        data: { clientTurnIdHash: 'ct3', turnIdHash: 't3' },
      },
      {
        family: 'outbox',
        message: 'in-flight-conflict',
        data: { clientTurnIdHash: 'ct4' },
      },
      {
        family: 'outbox',
        message: 'session-tombstoned',
        data: { clientTurnIdHash: 'ct5', sessionIdHash: 's5' },
      },
      {
        family: 'outbox',
        message: 'turn-persisted-error',
        level: 'warning',
        data: {
          clientTurnIdHash: 'ct6',
          turnIdHash: 't6',
          sessionIdHash: 's6',
          errorKind: 'connection-not-configured',
          provider: 'Mindstone',
          idempotentReplay: false,
        },
      },
      {
        family: 'catch-up',
        message: 'catch-up-started',
        data: { missedSince: 1700000000, sessionIdCount: 4 },
      },
      {
        family: 'catch-up',
        message: 'catch-up-success',
        data: { missedSince: 1700000000, addedEvents: 12, sessionIdCount: 4, latencyMs: 300 },
      },
      {
        family: 'catch-up',
        message: 'catch-up-failed',
        level: 'error',
        data: { missedSince: 1700000000, sessionIdCount: 4, attempts: 3, errorCategory: 'network', errorStatusCode: 503 },
      },
      {
        family: 'catch-up',
        message: 'catch-up-unavailable',
        level: 'warning',
        data: { missedSince: 1700000000, sessionIdCount: 4, errorCategory: 'server-4xx', errorStatusCode: 404 },
      },
      {
        family: 'catch-up',
        message: 'catch-up-session-tombstoned',
        data: { sessionIdHash: 'sess1', reason: 'session-tombstoned', deletedAt: 1_700_000_123_456 },
      },
      {
        family: 'catch-up',
        message: 'seq-already-applied',
        data: { sessionIdHash: 'sess1', reason: 'seq-already-applied', incomingSeq: 5, appliedSeq: 7 },
      },
      {
        family: 'catch-up',
        message: 'seq-gap-detected',
        level: 'warning',
        data: { sessionIdHash: 'sess1', reason: 'seq-gap-detected', seq: 9, appliedSeq: 4, missedCount: 4 },
      },
      {
        family: 'catch-up',
        message: 'catch-up-unusually-large',
        data: { addedEvents: 2000, missedSince: null },
      },
      {
        family: 'catch-up',
        message: 'session-catch-up:message-delta-applied',
        data: { sessionIdHash: 'sess1', messageCount: 2 },
      },
      {
        family: 'catch-up',
        message: 'session-catch-up:message-delete-applied',
        data: { sessionIdHash: 'sess1', messageDeleteCount: 1 },
      },
      {
        family: 'catch-up',
        message: 'session-catch-up:destructive-op-applied',
        level: 'warning',
        data: { sessionIdHash: 'sess1', truncatedTurnCount: 1, deletedEventIdentityCount: 2 },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        data: {
          sessionIdHash: 'sess1',
          from: 'local_only',
          to: 'cloud_active',
          reason: 'first-cloud-sync',
          direction: 'desktop-pull',
          tombstoneCount: 2,
          lastTombstoneSyncAt: 123456,
        },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'tombstone-cursor-missing-server-time',
          direction: 'mobile-delete',
        },
      },
      {
        family: 'continuity-state',
        message: 'state-transition',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'local_only',
          reason: 'cloud-disabled',
        },
      },
      {
        family: 'continuity-state',
        message: 'stuck-outbox',
        level: 'warning',
        data: {
          reason: 'stuck-outbox',
          deviceIdHash: 'device123',
          depth: 8,
          lastDrainAt: 1_700_000_000_000,
          ageMs: 700_000,
        },
      },
      {
        family: 'continuity-state',
        message: 'invariant-violation',
        data: { sessionIdHash: 'sess1', invariant: 'cloud_active-requires-ack' },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'server-clock-backwards',
          direction: 'cloud-write',
        },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'session-mutex-contention',
          kind: 'session-mutex-contention',
          waitedMs: 450,
          label: 'agent.persist-result',
        },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'lifecycle-drain-foreground',
          direction: 'mobile-foreground',
          label: 'online',
        },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'lifecycle-resume-post-reboot',
          direction: 'mobile-startup',
          label: 'offline',
        },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'server-restart-detected',
          direction: 'event-channel-reconnect',
          label: 'seq-gap-140',
        },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'workspace-toctou-retry',
          direction: 'forceSync',
          label: 'files:2',
        },
      },
      {
        family: 'continuity-state',
        message: 'transition',
        level: 'warning',
        data: {
          sessionIdHash: 'sess1',
          from: 'cloud_active',
          to: 'cloud_active',
          reason: 'attachment-orphan-detected',
          direction: 'meeting-chunk-drain',
          label: 'missing-companion-session',
        },
      },
      {
        family: 'conflict',
        message: 'detected',
        data: { sessionIdHash: 'sess1', conflictType: 'metadata-divergence', resolution: 'last-writer-wins' },
      },
      {
        family: 'conflict',
        message: 'stale-metadata',
        data: {
          sessionIdHash: 'sess1',
          conflictType: 'stale-metadata',
          fields: ['title'],
          serverCloudUpdatedAt: 1234,
          clientCloudUpdatedAt: 1200,
          staleBy: 'cloudUpdatedAt',
        },
      },
      {
        family: 'conflict',
        message: 'concurrent-edit',
        data: {
          sessionIdHash: 'sess1',
          conflictType: 'concurrent-edit',
          fields: ['title'],
          previousValue: 'a1b2c3d4',
          newValue: 'd4c3b2a1',
          previousValueHash: 'a1b2c3d4',
          newValueHash: 'd4c3b2a1',
        },
      },
      {
        family: 'session-delta-push',
        message: 'applied',
        data: {
          sessionIdHash: 'sess1',
          appliedCount: 3,
          serverSeq: 42,
          cloudUpdatedAt: 1_700_000_000_000,
          baseSeq: 39,
          payloadBytes: 2048,
          gzipBytes: 512,
        },
      },
      {
        family: 'session-delta-push',
        message: 'needs-reconcile',
        level: 'warning',
        data: {
          sessionIdHash: 'sess1',
          baseSeq: 39,
          serverSeq: 44,
          cloudUpdatedAt: 1_700_000_000_100,
        },
      },
      {
        family: 'session-delta-push',
        message: 'needs-bootstrap',
        data: { sessionIdHash: 'sess1', baseSeq: 0 },
      },
      {
        family: 'session-delta-push',
        message: 'capability-missing-fallback',
        data: { sessionIdHash: 'sess1', baseSeq: 12 },
      },
      {
        family: 'session-delta-push',
        message: 'drift-detected',
        level: 'warning',
        data: { sessionIdHash: 'sess1', baseSeq: 90, serverSeq: 50 },
      },
      {
        family: 'session-delta-push',
        message: 'bootstrap-fallback',
        data: { sessionIdHash: 'sess1', baseSeq: 0 },
      },
      {
        family: 'session-delta-push',
        message: 'metadata-patch-applied',
        data: { sessionIdHash: 'sess1', baseSeq: 42, cloudUpdatedAt: 1_700_000_000_200 },
      },
    ];

    for (const event of samples) {
      const allowed = CONTINUITY_SAFE_KEYS[event.family];
      for (const key of Object.keys(event.data)) {
        expect(
          allowed.has(key),
          `Field "${key}" used in family "${event.family}" is not in SAFE_KEYS (${Array.from(allowed).join(', ')}).`,
        ).toBe(true);
      }
    }
  });

  it('allowlists Stage 3 catch-up auxiliary breadcrumb fields', () => {
    const allowed = CONTINUITY_SAFE_KEYS['catch-up'];

    expect(allowed.has('messageCount')).toBe(true);
    expect(allowed.has('messageDeleteCount')).toBe(true);
    expect(allowed.has('truncatedTurnCount')).toBe(true);
    expect(allowed.has('deletedEventIdentityCount')).toBe(true);
  });
});

describe('hashForBreadcrumb', () => {
  it('returns deterministic output for the same input', () => {
    const a = hashForBreadcrumb('session_abc');
    const b = hashForBreadcrumb('session_abc');
    expect(a).toBe(b);
  });

  it('returns different output for different inputs', () => {
    const a = hashForBreadcrumb('session_abc');
    const b = hashForBreadcrumb('session_xyz');
    expect(a).not.toBe(b);
  });

  it('never returns the raw input as a prefix or substring', () => {
    const raw = 'session_abcdef123';
    const hashed = hashForBreadcrumb(raw);
    expect(raw.includes(hashed)).toBe(false);
    expect(hashed.includes(raw)).toBe(false);
  });

  it('produces short stable-width output (≤ 8 chars)', () => {
    const inputs = [
      'a',
      'session_12345',
      'turn_' + 'x'.repeat(200),
      '',
    ];
    for (const input of inputs) {
      const h = hashForBreadcrumb(input);
      expect(h.length).toBeLessThanOrEqual(8);
    }
  });
});
