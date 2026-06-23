/**
 * Community Video Recordings API Client
 *
 * Fetches past community event recordings from the GraphQL API.
 * Filters to video recordings only and enriches with parent event context.
 * Separated from the service for testability (the service uses injected deps).
 * All outbound hosts are hardcoded per security review requirements.
 *
 * @see docs/plans/260404_spark_community_video_recommendations.md
 */

import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import type { CommunityVideo } from './communityVideoRecsTypes';

const log = createScopedLogger({ service: 'communityVideoRecsApiClient' });

// ─── Hardcoded Outbound Hosts (security review requirement) ─────────

const EVENTS_GRAPHQL_URL = 'https://community.mindstone.com/graphql';

// ─── Zod Schemas ────────────────────────────────────────────────────

const RecordingSchema = z.object({
  id: z.string(),
  headline: z.string(),
  type: z.string(),
  url: z.string(),
});

const AgendaItemSchema = z.object({
  title: z.string(),
  speakerName: z.string().nullable(),
  recording: RecordingSchema.nullable(),
});

const GraphQLEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  startDatetime: z.string(),
  locationShort: z.string().nullable().optional(),
  agenda: z.array(AgendaItemSchema),
});

const GraphQLResponseSchema = z.object({
  data: z.object({
    defaultPlatformSpace: z.object({
      events: z.object({
        list: z.object({
          list: z.array(GraphQLEventSchema),
        }),
      }),
    }),
  }),
});

// ─── GraphQL Query ──────────────────────────────────────────────────

const VIDEOS_GRAPHQL_QUERY = `{
  defaultPlatformSpace {
    events {
      list(size: 250, filter: PAST) {
        list {
          id
          slug
          name
          startDatetime
          locationShort
          agenda {
            title
            speakerName
            recording {
              id
              headline
              type
              url
            }
          }
        }
      }
    }
  }
}`;

// ─── API Function ───────────────────────────────────────────────────

/**
 * Fetch all community video recordings from past events.
 * Filters to agenda items with non-null video recordings and enriches
 * each recording with parent event context (name, city, date).
 * No auth required.
 */
export async function fetchCommunityVideos(): Promise<CommunityVideo[]> {
  log.info('Fetching community video recordings from GraphQL API');

  const response = await fetch(EVENTS_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: VIDEOS_GRAPHQL_QUERY }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const parsed = GraphQLResponseSchema.parse(json);
  const rawEvents = parsed.data.defaultPlatformSpace.events.list.list;

  const videos: CommunityVideo[] = [];

  for (const event of rawEvents) {
    for (const agendaItem of event.agenda) {
      if (agendaItem.recording !== null && agendaItem.recording.type === 'video') {
        videos.push({
          id: agendaItem.recording.id,
          headline: agendaItem.recording.headline,
          speakerName: agendaItem.speakerName ?? '',
          eventName: event.name,
          eventCity: event.locationShort ?? '',
          eventDate: event.startDatetime,
          url: agendaItem.recording.url,
          eventUrl: `https://community.mindstone.com/annotate/${agendaItem.recording.id}`,
        });
      }
    }
  }

  log.info({ videoCount: videos.length, eventCount: rawEvents.length }, 'Fetched community video recordings');

  return videos;
}
