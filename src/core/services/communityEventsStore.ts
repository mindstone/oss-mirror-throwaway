/**
 * Community Events Store
 *
 * Persists cached events, geocoded addresses, user location,
 * and user preferences (suppress/dismiss) for community events.
 * Uses lazy getStore() pattern following heroChoiceStore.
 *
 * @see docs/plans/260402_spark_community_events_nearby.md
 */

import { createStore } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { createScopedLogger } from '@core/logger';
import type { CommunityEvent, GeoCoordinates } from './communityEventsTypes';

const log = createScopedLogger({ service: 'communityEventsStore' });

export type CommunityEventsStoreState = {
  version: number;
  /** Cached events from GraphQL (refreshed daily). */
  cachedEvents: CommunityEvent[];
  /** Epoch ms when events were last fetched. */
  eventsLastFetchedAt: number;
  /** Cached geocoded coordinates keyed by normalized address. */
  geocodedAddresses: Record<string, { lat: number; lng: number }>;
  /** Cached user location from IP geolocation. */
  userLocation: { coords: { lat: number; lng: number }; city: string; country: string } | null;
  /** Epoch ms when user location was last fetched. */
  userLocationFetchedAt: number;
  /** User opted out of community events. */
  suppressCommunityEvents: boolean;
  /** Event IDs the user has dismissed. */
  dismissedEventIds: string[];
};

const COMMUNITY_EVENTS_STORE_VERSION = 1;

const createDefaultState = (): CommunityEventsStoreState => ({
  version: COMMUNITY_EVENTS_STORE_VERSION,
  cachedEvents: [],
  eventsLastFetchedAt: 0,
  geocodedAddresses: {},
  userLocation: null,
  userLocationFetchedAt: 0,
  suppressCommunityEvents: false,
  dismissedEventIds: [],
});

let _store: KeyValueStore<CommunityEventsStoreState> | null = null;

function getStore(): KeyValueStore<CommunityEventsStoreState> {
  if (!_store) {
    _store = createStore<CommunityEventsStoreState>({
      name: 'community-events',
      defaults: createDefaultState(),
    });
  }
  return _store;
}

// ─── Cached Events ──────────────────────────────────────────────────

export function getCachedEvents(): CommunityEvent[] {
  return getStore().get('cachedEvents') ?? [];
}

export function setCachedEvents(events: CommunityEvent[], timestamp: number): void {
  const store = getStore();
  store.set('cachedEvents', events);
  store.set('eventsLastFetchedAt', timestamp);
  log.info({ eventCount: events.length }, 'Cached community events');
}

export function isEventsCacheStale(maxAgeMs: number): boolean {
  const lastFetched = getStore().get('eventsLastFetchedAt') ?? 0;
  return Date.now() - lastFetched > maxAgeMs;
}

// ─── Geocoded Addresses ─────────────────────────────────────────────

function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

export function getCachedGeocode(address: string): GeoCoordinates | null {
  const cached = getStore().get('geocodedAddresses') ?? {};
  const entry = cached[normalizeAddress(address)];
  return entry ? { lat: entry.lat, lng: entry.lng } : null;
}

export function setCachedGeocode(address: string, coords: GeoCoordinates): void {
  const store = getStore();
  const existing = store.get('geocodedAddresses') ?? {};
  store.set('geocodedAddresses', {
    ...existing,
    [normalizeAddress(address)]: { lat: coords.lat, lng: coords.lng },
  });
  log.debug({ address: normalizeAddress(address) }, 'Cached geocoded address');
}

// ─── User Location ──────────────────────────────────────────────────

export function getCachedUserLocation(): { coords: GeoCoordinates; city: string; country: string } | null {
  return getStore().get('userLocation') ?? null;
}

export function setCachedUserLocation(location: { coords: GeoCoordinates; city: string; country: string }): void {
  const store = getStore();
  store.set('userLocation', {
    coords: { lat: location.coords.lat, lng: location.coords.lng },
    city: location.city,
    country: location.country,
  });
  store.set('userLocationFetchedAt', Date.now());
  log.info({ city: location.city, country: location.country }, 'Cached user location');
}

export function isUserLocationStale(maxAgeMs: number): boolean {
  const lastFetched = getStore().get('userLocationFetchedAt') ?? 0;
  return Date.now() - lastFetched > maxAgeMs;
}

// ─── User Preferences ───────────────────────────────────────────────

export function isSuppressed(): boolean {
  return getStore().get('suppressCommunityEvents') ?? false;
}

export function setSuppressed(value: boolean): void {
  getStore().set('suppressCommunityEvents', value);
  log.info({ suppressed: value }, 'Community events suppression toggled');
}

export function isDismissed(eventId: string): boolean {
  const dismissed = getStore().get('dismissedEventIds') ?? [];
  return dismissed.includes(eventId);
}

export function dismissEvent(eventId: string): void {
  const store = getStore();
  const existing = store.get('dismissedEventIds') ?? [];
  if (!existing.includes(eventId)) {
    store.set('dismissedEventIds', [...existing, eventId]);
    log.info({ eventId }, 'Dismissed community event');
  }
}

// ─── Testing ────────────────────────────────────────────────────────

/** Reset store for testing. */
export function _resetStore(): void {
  _store = null;
}
