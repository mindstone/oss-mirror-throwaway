import { z } from 'zod';

export const MEETING_TRIGGER_DETECTED_CHANNEL = 'meeting:trigger-detected' as const;

export const MeetingTriggerSourceSpeakerSchema = z.union([
  z.literal('unknown'),
  z.literal('user'),
  z.string().min(1),
]);

export const MeetingTriggerDetectedPayloadSchema = z.object({
  sessionId: z.string().min(1),
  extracted: z.string().min(1),
  segmentTimestamp: z.number().int(),
  triggerSourceSpeaker: MeetingTriggerSourceSpeakerSchema,
});

export type MeetingTriggerDetectedPayload = z.infer<typeof MeetingTriggerDetectedPayloadSchema>;
