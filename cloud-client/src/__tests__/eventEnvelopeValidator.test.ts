import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getUnknownEventTypeCountForTests,
  isValidAgentEventEnvelope,
  REBEL_EVENT_ENVELOPE_UNKNOWN_TYPE_MARKER,
  resetUnknownEventTypeCountForTests,
} from '../utils/eventEnvelopeValidator';
import { setLogPersistCallback } from '../utils/logger';

interface CapturedLog {
  level: string;
  tag: string;
  msg: string;
  data?: Record<string, unknown>;
}

const validEvent = {
  type: 'status',
  message: 'working',
  timestamp: 1_700_000_000_000,
  seq: 1,
  turnId: 'turn-1',
};

describe('isValidAgentEventEnvelope', () => {
  let captured: CapturedLog[] = [];

  beforeEach(() => {
    resetUnknownEventTypeCountForTests();
    captured = [];
    setLogPersistCallback((level, tag, msg, data) => {
      captured.push({ level, tag, msg, data });
    });
    // Silence the underlying console output so test runs stay quiet; the
    // assertions go through the persist-callback capture above.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    resetUnknownEventTypeCountForTests();
    setLogPersistCallback(() => {});
    vi.restoreAllMocks();
  });

  it('accepts a valid known event envelope and returns a defensive clone', () => {
    const result = isValidAgentEventEnvelope(validEvent);

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.event).toEqual(validEvent);
      expect(result.event).not.toBe(validEvent);
      expect(result.unknownType).not.toBe(true);
      expect((result.event as unknown as Record<string, unknown>)[REBEL_EVENT_ENVELOPE_UNKNOWN_TYPE_MARKER])
        .toBeUndefined();
    }
  });

  it('rejects non-object inputs', () => {
    expect(isValidAgentEventEnvelope(null)).toEqual({ valid: false, reason: 'not-object' });
    expect(isValidAgentEventEnvelope('nope')).toEqual({ valid: false, reason: 'not-object' });
  });

  it('rejects missing or invalid seq values', () => {
    expect(isValidAgentEventEnvelope({ ...validEvent, seq: undefined })).toEqual({ valid: false, reason: 'invalid-seq' });
    expect(isValidAgentEventEnvelope({ ...validEvent, seq: 0 })).toEqual({ valid: false, reason: 'invalid-seq' });
    expect(isValidAgentEventEnvelope({ ...validEvent, seq: 1.5 })).toEqual({ valid: false, reason: 'invalid-seq' });
  });

  it('rejects missing or blank turn ids', () => {
    expect(isValidAgentEventEnvelope({ ...validEvent, turnId: undefined })).toEqual({ valid: false, reason: 'invalid-turn-id' });
    expect(isValidAgentEventEnvelope({ ...validEvent, turnId: '   ' })).toEqual({ valid: false, reason: 'invalid-turn-id' });
  });

  it('rejects missing or non-finite timestamps', () => {
    expect(isValidAgentEventEnvelope({ ...validEvent, timestamp: undefined })).toEqual({ valid: false, reason: 'invalid-timestamp' });
    expect(isValidAgentEventEnvelope({ ...validEvent, timestamp: Number.POSITIVE_INFINITY })).toEqual({ valid: false, reason: 'invalid-timestamp' });
  });

  it('rejects missing or empty type strings (still structural)', () => {
    expect(isValidAgentEventEnvelope({ ...validEvent, type: undefined })).toEqual({ valid: false, reason: 'invalid-type' });
    expect(isValidAgentEventEnvelope({ ...validEvent, type: '' })).toEqual({ valid: false, reason: 'invalid-type' });
  });

  it('passes structurally-valid unknown event types through with sentinel marker (Stage 0.B non-dropping)', () => {
    const result = isValidAgentEventEnvelope({ ...validEvent, type: 'mystery_event' });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.unknownType).toBe(true);
      expect(
        (result.event as unknown as Record<string, unknown>)[REBEL_EVENT_ENVELOPE_UNKNOWN_TYPE_MARKER],
      ).toBe(true);
      expect((result.event as unknown as { type: string }).type).toBe('mystery_event');
    }
    expect(getUnknownEventTypeCountForTests()).toBe(1);
  });

  it('emits a structured warn log when encountering an unknown event type', () => {
    isValidAgentEventEnvelope({ ...validEvent, type: 'mystery_event', seq: 7, turnId: 'turn-7' });

    const unknownLogs = captured.filter(
      entry => entry.level === 'warn' && entry.msg === 'eventEnvelopeValidator.unknown-event-type',
    );
    expect(unknownLogs).toHaveLength(1);
    expect(unknownLogs[0]?.tag).toBe('eventEnvelopeValidator');
    expect(unknownLogs[0]?.data).toMatchObject({
      eventType: 'mystery_event',
      seq: 7,
      turnId: 'turn-7',
      schemaVersion: null,
    });
    expect(typeof unknownLogs[0]?.data?.knownTypeCount).toBe('number');
  });

  it('does not emit the unknown-event warn log for a known event', () => {
    isValidAgentEventEnvelope(validEvent);
    const unknownLogs = captured.filter(
      entry => entry.msg === 'eventEnvelopeValidator.unknown-event-type',
    );
    expect(unknownLogs).toHaveLength(0);
  });

  it('counts unknown events independently across multiple calls', () => {
    isValidAgentEventEnvelope({ ...validEvent, type: 'mystery_event_a' });
    isValidAgentEventEnvelope({ ...validEvent, type: 'mystery_event_b', seq: 2 });
    isValidAgentEventEnvelope({ ...validEvent, type: 'status' });

    expect(getUnknownEventTypeCountForTests()).toBe(2);
  });
});
