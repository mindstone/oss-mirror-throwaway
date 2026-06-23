/**
 * Community Events Types
 *
 * Types for the community events nearby feature.
 * Used by the service, store, API client, and renderer card.
 *
 * @see docs/plans/260402_spark_community_events_nearby.md
 */

/** A community event fetched from the GraphQL API. */
export interface CommunityEvent {
  id: string;
  slug: string;
  name: string;
  startDatetime: string; // ISO string
  endDatetime: string;
  locationShort: string; // city name
  address: string;
  imageUrl: string; // backgroundImage.medium
  publicUrl: string;
  registered: number;
  capacity: number;
}

/** Latitude/longitude coordinates. Core-internal only — never exposed to renderer. */
export interface GeoCoordinates {
  lat: number;
  lng: number;
}

/** An event enriched with distance and temporal info for the card. */
export interface NearbyEvent {
  event: CommunityEvent;
  distanceKm: number;
  distanceLabel: string; // "12km away" or "Right in your city"
  daysUntil: number;
  spotsLeft: number | null; // null if capacity unknown/zero
  registered: number;
}

/** Personalized speaker CTA derived from time-saved data. */
export interface SpeakerCta {
  reasoning: string; // from time-saved top session
  totalMinutes: number;
  taskType: string;
  isPersonalized: boolean; // false = generic fallback
}

/** View model for the community event card in the Spark. */
export interface CommunityEventCardData {
  type: 'nearby-event' | 'no-event' | 'suppressed';
  nearbyEvent?: NearbyEvent;
  speakerCta?: SpeakerCta;
  organizerUrl: string; // https://community-admin.mindstone.ai/interest
}
