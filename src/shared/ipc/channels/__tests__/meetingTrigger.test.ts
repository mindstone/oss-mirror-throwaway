import { describe, expect, it } from 'vitest';
import { MeetingTriggerDetectedPayloadSchema } from '../meetingTrigger';

describe('MeetingTriggerDetectedPayloadSchema', () => {
  it('accepts unknown speaker payload', () => {
    const parsed = MeetingTriggerDetectedPayloadSchema.parse({
      sessionId: 'local-upload-1',
      extracted: 'What are the next steps?',
      segmentTimestamp: 1_715_204_800_000,
      triggerSourceSpeaker: 'unknown',
    });

    expect(parsed.triggerSourceSpeaker).toBe('unknown');
  });

  it('accepts user speaker payload', () => {
    const parsed = MeetingTriggerDetectedPayloadSchema.parse({
      sessionId: 'local-upload-2',
      extracted: 'Can you summarise this so far?',
      segmentTimestamp: 1_715_204_800_123,
      triggerSourceSpeaker: 'user',
    });

    expect(parsed.triggerSourceSpeaker).toBe('user');
  });

  it('accepts named speaker payload', () => {
    const parsed = MeetingTriggerDetectedPayloadSchema.parse({
      sessionId: 'local-upload-3',
      extracted: 'What did we decide?',
      segmentTimestamp: 1_715_204_800_456,
      triggerSourceSpeaker: 'Alex',
    });

    expect(parsed.triggerSourceSpeaker).toBe('Alex');
  });

  it('rejects empty extracted text', () => {
    expect(() =>
      MeetingTriggerDetectedPayloadSchema.parse({
        sessionId: 'local-upload-4',
        extracted: '',
        segmentTimestamp: 1_715_204_800_789,
        triggerSourceSpeaker: 'unknown',
      }),
    ).toThrow();
  });
});
