/**
 * Community Video Recommendations Types
 *
 * Types for the community video recommendations feature.
 * Used by the service, store, API client, and renderer card.
 *
 * @see docs/plans/260404_spark_community_video_recommendations.md
 */

/** A community event talk video fetched from the GraphQL API. */
export interface CommunityVideo {
  id: string;
  headline: string;       // talk title from recording.headline
  speakerName: string;    // speaker from agenda item (may be empty)
  eventName: string;      // parent event name
  eventCity: string;      // from event.locationShort
  eventDate: string;      // ISO string from event.startDatetime
  url: string;            // Dropbox link from recording.url (raw video file)
  eventUrl: string;       // community.mindstone.com event page URL
}

/** A video with LLM-generated relevance context. */
export interface VideoRecommendation extends CommunityVideo {
  relevanceHint: string;  // one-line "why this was picked" from LLM
}

/** View model for the video recs card in the Spark. */
export interface VideoRecsCardData {
  type: 'recommendations' | 'empty' | 'suppressed';
  recommendations: VideoRecommendation[];
}
