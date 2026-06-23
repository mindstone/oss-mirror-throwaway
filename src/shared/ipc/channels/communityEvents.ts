import { z } from 'zod';
import { defineInvokeChannel } from '../schemas';

/**
 * Community Events IPC Channels
 *
 * Desktop-only channels for fetching nearby community event card data
 * and managing user preferences (suppress/dismiss).
 *
 * @see src/core/services/communityEventsService.ts
 * @see docs/plans/260402_spark_community_events_nearby.md
 */

const CommunityEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  startDatetime: z.string(),
  endDatetime: z.string(),
  locationShort: z.string(),
  address: z.string(),
  imageUrl: z.string(),
  publicUrl: z.string(),
  registered: z.number(),
  capacity: z.number(),
});

const NearbyEventSchema = z.object({
  event: CommunityEventSchema,
  distanceKm: z.number(),
  distanceLabel: z.string(),
  daysUntil: z.number(),
  spotsLeft: z.number().nullable(),
  registered: z.number(),
});

const SpeakerCtaSchema = z.object({
  reasoning: z.string(),
  totalMinutes: z.number(),
  taskType: z.string(),
  isPersonalized: z.boolean(),
});

const CommunityEventCardDataSchema = z.object({
  type: z.enum(['nearby-event', 'no-event', 'suppressed']),
  nearbyEvent: NearbyEventSchema.optional(),
  speakerCta: SpeakerCtaSchema.optional(),
  organizerUrl: z.string(),
});

export const communityEventsChannels = {
  'communityEvents:get-card-data': defineInvokeChannel({
    channel: 'communityEvents:get-card-data',
    request: z.object({}),
    response: CommunityEventCardDataSchema,
    description: 'Get community event card data for the Spark (nearby event or no-event state)',
  }),

  'communityEvents:suppress': defineInvokeChannel({
    channel: 'communityEvents:suppress',
    request: z.object({
      suppress: z.boolean(),
    }),
    response: z.object({ success: z.boolean() }),
    description: 'Toggle community events suppression (opt-out/opt-in)',
  }),

  'communityEvents:dismiss-event': defineInvokeChannel({
    channel: 'communityEvents:dismiss-event',
    request: z.object({
      eventId: z.string(),
    }),
    response: z.object({ success: z.boolean() }),
    description: 'Dismiss a specific community event so it no longer appears',
  }),
} as const;
