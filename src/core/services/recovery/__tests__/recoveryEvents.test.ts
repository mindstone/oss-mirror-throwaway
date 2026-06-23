import { describe, expect, it } from 'vitest';

import {
  RECOVERY_OUTBOUND_EVENT_TYPES,
  RecoveryOutboundEventSchema,
  makeRecoveryCompactingEvent,
  makeRecoveryDepth4AttemptingEvent,
  makeRecoveryFailedEvent,
  makeRecoveryFallbackAttemptingEvent,
  makeRecoveryFallbackSucceededEvent,
  makeRecoveryLastResortSkippedEvent,
  makeRecoveryRetryingEvent,
  makeRecoverySkeletonAttemptingEvent,
  makeRecoveryStartedEvent,
  makeRecoverySucceededEvent,
  makeRecoverySummaryReadyEvent,
  type RecoveryOutboundEvent,
} from '../recoveryEvents';
import type { RecoveryContext } from '../recoveryStateMachine';

const ctx = (): RecoveryContext => ({
  phase: 'post_activity',
  depth: 2,
  attempt: 1,
  longContextFallbackAttempted: false,
  skeletonAttempted: false,
  isRecoveryModelAttempt: false,
  enableRecovery: true,
  sessionId: 'session-1',
  turnId: 'turn-1',
  originalSessionId: 'original-session-1',
  originalPrompt: 'Prompt',
  abortSignal: new AbortController().signal,
});

const makeAllEvents = (): RecoveryOutboundEvent[] => {
  const base = ctx();
  return [
    makeRecoveryStartedEvent(base, 1),
    makeRecoveryCompactingEvent(base, 2),
    makeRecoverySummaryReadyEvent(base, 2, 'summary'),
    makeRecoveryRetryingEvent(base, 2, 123),
    makeRecoveryFallbackAttemptingEvent(base, 1, { kind: 'model', modelName: 'Opus' }),
    makeRecoveryFallbackSucceededEvent(base, 2, { kind: 'model', modelName: 'Opus' }),
    makeRecoverySkeletonAttemptingEvent(base, 2, 3),
    makeRecoveryDepth4AttemptingEvent(base, 3, 'profile-1', 'Opus Recovery'),
    makeRecoverySucceededEvent(base, 3),
    makeRecoveryFailedEvent(base, 3, 'depth_limit_reached'),
    makeRecoveryLastResortSkippedEvent(base, 3, 'no_qualifying_profile'),
  ];
};

describe('recoveryEvents', () => {
  it('T3.1 round-trips every event kind through the Zod schema', () => {
    const events = makeAllEvents();

    expect(events.map((event) => event.type).sort()).toEqual([...RECOVERY_OUTBOUND_EVENT_TYPES].sort());
    for (const event of events) {
      expect(RecoveryOutboundEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });

  it('T3.2 every producer helper carries turnId, sessionId, and originalSessionId from context', () => {
    for (const event of makeAllEvents()) {
      expect(event.turnId).toBe('turn-1');
      expect(event.sessionId).toBe('session-1');
      expect(event.originalSessionId).toBe('original-session-1');
    }
  });

  it('T3.3 every event includes totalCalls', () => {
    for (const event of makeAllEvents()) {
      expect(Number.isInteger(event.totalCalls)).toBe(true);
      expect(event.totalCalls).toBeGreaterThanOrEqual(0);
    }
  });

  it('T3.4 recovery:last_resort_skipped requires a no-profile or rate-limit reason', () => {
    expect(() => RecoveryOutboundEventSchema.parse({
      type: 'recovery:last_resort_skipped',
      turnId: 'turn-1',
      sessionId: 'session-1',
      originalSessionId: 'session-1',
      depth: 4,
      attempt: 1,
      totalCalls: 2,
      timestamp: Date.now(),
    })).toThrow();

    const skipped = makeRecoveryLastResortSkippedEvent(ctx(), 2, 'rate_limited');
    expect(skipped.reason).toBe('rate_limited');
    expect(skipped.userFacingTitle).toBeTruthy();
    expect(skipped.userFacingMessage).toBeTruthy();
    expect(skipped.action).toBeTruthy();
  });

  it('accepts recovery:fallback_succeeded events with profile targets through the manifest schema', () => {
    const event = makeRecoveryFallbackSucceededEvent(ctx(), 2, {
      kind: 'profile',
      profileId: 'profile-1',
      profileName: 'Recovery Opus',
      modelName: 'claude-opus-4-7',
    });

    expect(RecoveryOutboundEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(event.type).toBe('recovery:fallback_succeeded');
    if (event.type === 'recovery:fallback_succeeded') {
      expect(event.target).toMatchObject({ kind: 'profile', profileId: 'profile-1' });
    }
  });

  it('round-trips agent_loop_error_before_recovery exhausted reason through the schema', () => {
    const event = makeRecoveryFailedEvent(ctx(), 1, 'agent_loop_error_before_recovery');

    expect(RecoveryOutboundEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(event).toMatchObject({ exhaustedReason: 'agent_loop_error_before_recovery' });
  });

  it('REBEL-5BM round-trips agent_loop_error_after_recovery exhausted reason through the schema', () => {
    const event = makeRecoveryFailedEvent(ctx(), 1, 'agent_loop_error_after_recovery');

    expect(RecoveryOutboundEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(event).toMatchObject({ exhaustedReason: 'agent_loop_error_after_recovery' });
  });

  it('REBEL-5BM backfill — round-trips long_context_fallback_failed exhausted reason through the schema', () => {
    // Pre-fix this reason was in the core ExhaustedReason type but missing from
    // the event schema, so makeRecoveryFailedEvent threw synchronously. The
    // backfill ensures the event now parses cleanly.
    const event = makeRecoveryFailedEvent(ctx(), 1, 'long_context_fallback_failed');

    expect(RecoveryOutboundEventSchema.parse(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(event).toMatchObject({ exhaustedReason: 'long_context_fallback_failed' });
  });

  it('T3.5 schema rejects missing provenance fields', () => {
    const event = makeRecoveryStartedEvent(ctx(), 1);
    const { originalSessionId: _originalSessionId, ...withoutOriginalSessionId } = event;

    expect(() => RecoveryOutboundEventSchema.parse(withoutOriginalSessionId)).toThrow();
  });
});
