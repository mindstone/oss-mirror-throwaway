import { z } from 'zod';

export const transcriptSegmentSchema = z.object({
  segmentId: z.string().trim().min(1),
  text: z.string(),
  speaker: z.string().trim().min(1).nullable(),
  timestamp: z.number().finite().int(),
  isFinal: z.boolean(),
  source: z.literal('recall-bot'),
});

export const transcriptSegmentPayloadSchema = z.object({
  recallBotId: z.string().trim().min(1),
  meetingTitle: z.string().trim().min(1).optional(),
  segments: z.array(transcriptSegmentSchema).min(1),
});

export type TranscriptSegment = z.infer<typeof transcriptSegmentSchema>;
export type TranscriptSegmentPayload = z.infer<typeof transcriptSegmentPayloadSchema>;
