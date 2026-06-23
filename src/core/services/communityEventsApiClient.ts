/**
 * Community Events API Client
 *
 * HTTP implementations for fetching events, user location, and geocoding.
 * Separated from the service for testability (the service uses injected deps).
 * All outbound hosts are hardcoded per security review requirements.
 *
 * @see docs/plans/260402_spark_community_events_nearby.md
 */

import { z } from 'zod';
import { createScopedLogger } from '@core/logger';
import type { CommunityEvent, GeoCoordinates } from './communityEventsTypes';

const log = createScopedLogger({ service: 'communityEventsApiClient' });

// ─── Hardcoded Outbound Hosts (security review requirement) ─────────

const EVENTS_GRAPHQL_URL = 'https://community.mindstone.com/graphql';
const IP_GEO_URL = 'https://ipinfo.io/json';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

// ─── Zod Schemas ────────────────────────────────────────────────────

const GraphQLEventSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  startDatetime: z.string(),
  endDatetime: z.string(),
  locationShort: z.string().nullable().optional(),
  publicUrl: z.string(),
  backgroundImage: z
    .object({
      medium: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  attendance: z
    .object({
      capacity: z.number().nullable().optional(),
      registered: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
  location: z
    .object({
      address: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
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

const IpInfoSchema = z.object({
  city: z.string(),
  region: z.string().optional(),
  country: z.string(),
  loc: z.string(), // "lat,lng"
});

const NominatimResultSchema = z.array(
  z.object({
    lat: z.string(),
    lon: z.string(),
  }),
);

// ─── Rate Limiting for Nominatim ────────────────────────────────────

let lastNominatimCallMs = 0;
const NOMINATIM_MIN_INTERVAL_MS = 1100; // > 1 second per Nominatim usage policy

async function enforceNominatimRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastNominatimCallMs;
  if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
    const waitMs = NOMINATIM_MIN_INTERVAL_MS - elapsed;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  lastNominatimCallMs = Date.now();
}

// ─── API Functions ──────────────────────────────────────────────────

const EVENTS_GRAPHQL_QUERY = `{
  defaultPlatformSpace {
    events {
      list(size: 50) {
        list {
          id
          slug
          name
          startDatetime
          endDatetime
          locationShort
          publicUrl
          backgroundImage { medium }
          attendance { capacity registered }
          location { ... on GeoLocation { address } }
        }
      }
    }
  }
}`;

/**
 * Fetch upcoming events from the community GraphQL API.
 * No auth required.
 */
export async function fetchEventsFromGraphQL(): Promise<CommunityEvent[]> {
  const response = await fetch(EVENTS_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: EVENTS_GRAPHQL_QUERY }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const parsed = GraphQLResponseSchema.parse(json);
  const rawEvents = parsed.data.defaultPlatformSpace.events.list.list;

  return rawEvents.map((raw): CommunityEvent => ({
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    startDatetime: raw.startDatetime,
    endDatetime: raw.endDatetime,
    locationShort: raw.locationShort ?? '',
    address: raw.location?.address ?? '',
    imageUrl: raw.backgroundImage?.medium ?? '',
    publicUrl: raw.publicUrl,
    registered: raw.attendance?.registered ?? 0,
    capacity: raw.attendance?.capacity ?? 0,
  }));
}

/**
 * Look up user's approximate location via IP geolocation.
 * Uses ipinfo.io free tier (HTTPS, no key needed).
 */
export async function lookupUserLocationFromIP(): Promise<{
  coords: GeoCoordinates;
  city: string;
  country: string;
}> {
  const response = await fetch(IP_GEO_URL);

  if (!response.ok) {
    throw new Error(`IP geolocation failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const parsed = IpInfoSchema.parse(json);

  // Parse "lat,lng" string into coordinates
  const [latStr, lngStr] = parsed.loc.split(',');
  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);

  if (isNaN(lat) || isNaN(lng)) {
    throw new Error(`Invalid coordinates in IP geolocation response: ${parsed.loc}`);
  }

  return {
    coords: { lat, lng },
    city: parsed.city,
    country: parsed.country,
  };
}

/**
 * Geocode an address string to coordinates via Nominatim (OpenStreetMap).
 * Returns null if the address cannot be geocoded.
 * Enforces a 1-second rate limit between calls per Nominatim usage policy.
 */
export async function geocodeAddressViaNominatim(
  address: string,
): Promise<GeoCoordinates | null> {
  if (!address.trim()) return null;

  await enforceNominatimRateLimit();

  const params = new URLSearchParams({
    q: address,
    format: 'json',
    limit: '1',
  });

  const response = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'rebel-app/1.0 (contact@mindstone.com)',
    },
  });

  if (!response.ok) {
    log.warn(
      { status: response.status, address },
      'Nominatim geocoding request failed',
    );
    return null;
  }

  const json = await response.json();
  const results = NominatimResultSchema.parse(json);

  if (results.length === 0) {
    log.debug({ address }, 'No geocoding results for address');
    return null;
  }

  const lat = parseFloat(results[0].lat);
  const lon = parseFloat(results[0].lon);

  if (isNaN(lat) || isNaN(lon)) {
    log.warn({ address, raw: results[0] }, 'Invalid coordinates from Nominatim');
    return null;
  }

  return { lat, lng: lon };
}
