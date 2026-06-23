/**
 * Community Events Service
 *
 * Orchestrates the community events pipeline: fetch events, geolocate user,
 * geocode event addresses, haversine distance matching, and card assembly.
 * All external I/O is injected via deps for testability.
 *
 * @see docs/plans/260402_spark_community_events_nearby.md
 */

import { createScopedLogger } from '@core/logger';
import type { TopSessionInfo } from '@shared/types';
import type {
  CommunityEvent,
  GeoCoordinates,
  NearbyEvent,
  SpeakerCta,
  CommunityEventCardData,
} from './communityEventsTypes';
import {
  getCachedEvents,
  setCachedEvents,
  getCachedGeocode,
  setCachedGeocode,
  getCachedUserLocation,
  setCachedUserLocation,
  isSuppressed,
  isDismissed,
  isEventsCacheStale,
  isUserLocationStale,
} from './communityEventsStore';

const log = createScopedLogger({ service: 'communityEventsService' });

const ORGANIZER_URL = 'https://community-admin.mindstone.ai/interest';

/** 24 hours in milliseconds. */
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Maximum distance in km for an event to be considered "nearby". */
const MAX_DISTANCE_KM = 50;

/** Maximum days in the future for an event to be shown. */
const MAX_DAYS_AHEAD = 30;

// ─── Dependency Injection ───────────────────────────────────────────

export interface CommunityEventsServiceDeps {
  fetchEvents: () => Promise<CommunityEvent[]>;
  lookupUserLocation: () => Promise<{ coords: GeoCoordinates; city: string; country: string }>;
  geocodeAddress: (address: string) => Promise<GeoCoordinates | null>;
  getTopSession: () => TopSessionInfo | null;
}

// ─── Pure Functions (exported for testing) ──────────────────────────

/**
 * Haversine distance between two coordinates in kilometers.
 * Standard great-circle distance formula.
 */
export function haversineDistanceKm(a: GeoCoordinates, b: GeoCoordinates): number {
  const R = 6371; // Earth radius in km
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinHalfDLat = Math.sin(dLat / 2);
  const sinHalfDLng = Math.sin(dLng / 2);

  const h =
    sinHalfDLat * sinHalfDLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinHalfDLng * sinHalfDLng;

  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Human-friendly distance label.
 * "Right in your city" if < 3km, otherwise "{N}km away".
 */
export function formatDistanceLabel(km: number): string {
  if (km < 3) return 'Right in your city';
  return `${Math.round(km)}km away`;
}

/**
 * Number of days until the given ISO date from now.
 * Returns 0 if the date is today, negative if in the past.
 */
export function formatDaysUntil(isoDate: string): number {
  const eventDate = new Date(isoDate);
  const now = new Date();

  // Compare dates at day boundaries (midnight local time)
  const eventDay = new Date(eventDate.getFullYear(), eventDate.getMonth(), eventDate.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const diffMs = eventDay.getTime() - today.getTime();
  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Qualify a top session for the personalized speaker CTA.
 * Returns a SpeakerCta only if the session has high/critical impact AND >= 15 minutes.
 * Falls back to a generic CTA otherwise.
 */
export function qualifySpeakerCta(topSession: TopSessionInfo | null): SpeakerCta | undefined {
  if (!topSession) return undefined;

  const isHighImpact =
    topSession.highestImpact === 'high' || topSession.highestImpact === 'critical';
  const hasEnoughMinutes = topSession.totalMinutes >= 15;

  if (isHighImpact && hasEnoughMinutes) {
    return {
      reasoning: topSession.reasoning ?? '',
      totalMinutes: topSession.totalMinutes,
      taskType: topSession.taskType,
      isPersonalized: true,
    };
  }

  // Generic fallback — still show CTA, just not personalized
  return {
    reasoning: "Got a workflow you're proud of? The stage is yours.",
    totalMinutes: topSession.totalMinutes,
    taskType: topSession.taskType,
    isPersonalized: false,
  };
}

// ─── Main Entry Point ───────────────────────────────────────────────

/**
 * Assemble community event card data.
 *
 * Pipeline:
 * 1. Check suppression → return early
 * 2. Fetch events (cached or fresh) + get user location (cached or fresh) in parallel
 * 3. Filter to upcoming, non-dismissed events within 30 days
 * 4. Geocode event addresses, compute haversine distances
 * 5. Find closest event within 50km
 * 6. Assemble card view model with optional speaker CTA
 */
export async function getCommunityEventCardData(
  deps: CommunityEventsServiceDeps,
): Promise<CommunityEventCardData> {
  // 1. Check if suppressed
  if (isSuppressed()) {
    return { type: 'suppressed', organizerUrl: ORGANIZER_URL };
  }

  try {
    // 2. Fetch events + user location in parallel (cache-first)
    const [events, userLocation] = await Promise.all([
      getOrFetchEvents(deps),
      getOrFetchUserLocation(deps),
    ]);

    if (events.length === 0 || !userLocation) {
      log.info('No events or no user location available');
      return { type: 'no-event', organizerUrl: ORGANIZER_URL };
    }

    // 3. Filter to upcoming, non-dismissed events within 30 days
    const upcomingEvents = events.filter((event) => {
      const daysUntil = formatDaysUntil(event.startDatetime);
      return daysUntil >= 0 && daysUntil <= MAX_DAYS_AHEAD && !isDismissed(event.id);
    });

    if (upcomingEvents.length === 0) {
      log.info('No upcoming non-dismissed events within 30 days');
      return { type: 'no-event', organizerUrl: ORGANIZER_URL };
    }

    // 4. Geocode event addresses and compute distances
    const eventsWithDistance = await geocodeAndDistance(
      upcomingEvents,
      userLocation.coords,
      deps,
    );

    // 5. Find closest event within 50km, prefer soonest among tied distances
    const nearbyEvents = eventsWithDistance
      .filter((e) => e.distanceKm <= MAX_DISTANCE_KM)
      .sort((a, b) => {
        // Primary: soonest event first
        const daysA = formatDaysUntil(a.event.startDatetime);
        const daysB = formatDaysUntil(b.event.startDatetime);
        return daysA - daysB;
      });

    if (nearbyEvents.length === 0) {
      log.info('No events within 50km');
      return { type: 'no-event', organizerUrl: ORGANIZER_URL };
    }

    const closest = nearbyEvents[0];

    // 6. Assemble card view model
    const daysUntil = formatDaysUntil(closest.event.startDatetime);
    const spotsLeft =
      closest.event.capacity > 0
        ? closest.event.capacity - closest.event.registered
        : null;

    const nearbyEvent: NearbyEvent = {
      event: closest.event,
      distanceKm: closest.distanceKm,
      distanceLabel: formatDistanceLabel(closest.distanceKm),
      daysUntil,
      spotsLeft,
      registered: closest.event.registered,
    };

    // Optional speaker CTA from time-saved data
    const topSession = deps.getTopSession();
    const speakerCta = qualifySpeakerCta(topSession);

    return {
      type: 'nearby-event',
      nearbyEvent,
      speakerCta,
      organizerUrl: ORGANIZER_URL,
    };
  } catch (error) {
    // Graceful degradation — never throw from this service
    log.warn({ error }, 'Failed to assemble community event card data');
    return { type: 'no-event', organizerUrl: ORGANIZER_URL };
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────

async function getOrFetchEvents(
  deps: CommunityEventsServiceDeps,
): Promise<CommunityEvent[]> {
  if (!isEventsCacheStale(CACHE_MAX_AGE_MS)) {
    const cached = getCachedEvents();
    if (cached.length > 0) {
      log.debug({ count: cached.length }, 'Using cached events');
      return cached;
    }
  }

  try {
    const events = await deps.fetchEvents();
    setCachedEvents(events, Date.now());
    return events;
  } catch (error) {
    log.warn({ error }, 'Failed to fetch events, falling back to cache');
    return getCachedEvents();
  }
}

async function getOrFetchUserLocation(
  deps: CommunityEventsServiceDeps,
): Promise<{ coords: GeoCoordinates; city: string; country: string } | null> {
  if (!isUserLocationStale(CACHE_MAX_AGE_MS)) {
    const cached = getCachedUserLocation();
    if (cached) {
      log.debug({ city: cached.city }, 'Using cached user location');
      return cached;
    }
  }

  try {
    const location = await deps.lookupUserLocation();
    setCachedUserLocation(location);
    return location;
  } catch (error) {
    log.warn({ error }, 'Failed to look up user location, falling back to cache');
    return getCachedUserLocation();
  }
}

interface EventWithDistance {
  event: CommunityEvent;
  distanceKm: number;
}

async function geocodeAndDistance(
  events: CommunityEvent[],
  userCoords: GeoCoordinates,
  deps: CommunityEventsServiceDeps,
): Promise<EventWithDistance[]> {
  const results: EventWithDistance[] = [];

  for (const event of events) {
    try {
      let coords = getCachedGeocode(event.address);

      if (!coords && event.address) {
        coords = await deps.geocodeAddress(event.address);
        if (coords) {
          setCachedGeocode(event.address, coords);
        }
      }

      if (coords) {
        const distanceKm = haversineDistanceKm(userCoords, coords);
        results.push({ event, distanceKm });
      }
    } catch (error) {
      log.debug({ eventId: event.id, error }, 'Failed to geocode event address');
      // Skip this event — don't let one bad geocode break the pipeline
    }
  }

  return results;
}
