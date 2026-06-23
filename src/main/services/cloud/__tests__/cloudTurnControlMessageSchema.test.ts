/**
 * Pure parse tests for the cloud agent-turn WS control-message schema.
 *
 * Closes the F2 contract-drift finding (PLAN.md Stage 2c): the desktop
 * CloudServiceClient WS parser must recognise the `session_tombstoned` control
 * frame the cloud now emits (cloud-service/src/routes/agent.ts:305), so it can
 * route it through the lifecycle branch rather than degrading to a generic
 * `WS_CLOSED_EARLY` if/when a desktop caller reuses this path.
 */

import { describe, expect, it } from 'vitest';

import { CloudTurnControlMessageSchema } from '../cloudTurnControlMessageSchema';

describe('CloudTurnControlMessageSchema', () => {
  it('parses session_tombstoned with sessionId and optional clientTurnId', () => {
    const result = CloudTurnControlMessageSchema.safeParse({
      type: 'session_tombstoned',
      sessionId: 'sess-1',
      clientTurnId: 'turn-1',
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.type === 'session_tombstoned') {
      expect(result.data.sessionId).toBe('sess-1');
      expect(result.data.clientTurnId).toBe('turn-1');
    }
  });

  it('parses session_tombstoned without clientTurnId (optional)', () => {
    const result = CloudTurnControlMessageSchema.safeParse({
      type: 'session_tombstoned',
      sessionId: 'sess-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects session_tombstoned missing the required sessionId', () => {
    const result = CloudTurnControlMessageSchema.safeParse({
      type: 'session_tombstoned',
    });
    expect(result.success).toBe(false);
  });

  it('rejects session_tombstoned with unknown keys (.strict guard)', () => {
    // Mirrors the existing control-frame discipline: a real AgentEvent error
    // (extra envelope fields) must NOT pass control-frame parsing.
    const result = CloudTurnControlMessageSchema.safeParse({
      type: 'session_tombstoned',
      sessionId: 'sess-1',
      timestamp: 123,
      rawError: 'nope',
    });
    expect(result.success).toBe(false);
  });

  it('still parses the pre-existing control frames', () => {
    expect(
      CloudTurnControlMessageSchema.safeParse({ type: 'turn_started', turnId: 't1' }).success,
    ).toBe(true);
    expect(
      CloudTurnControlMessageSchema.safeParse({
        type: 'turn_persisted',
        clientTurnId: 'c1',
        turnId: 't1',
        sessionId: 's1',
        status: 'ok',
      }).success,
    ).toBe(true);
    expect(
      CloudTurnControlMessageSchema.safeParse({
        type: 'turn_in_flight',
        clientTurnId: 'c1',
        sessionId: 's1',
        status: 'busy',
      }).success,
    ).toBe(true);
    expect(
      CloudTurnControlMessageSchema.safeParse({ type: 'error', error: 'boom' }).success,
    ).toBe(true);
  });
});
