import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TopSessionInfo } from '@shared/types';
import type { CommunityEvent, GeoCoordinates } from '../communityEventsTypes';
import type { CommunityEventsServiceDeps } from '../communityEventsService';

// ─── In-memory store mock (same pattern as heroChoiceStore.test.ts) ──

let storeData: Record<string, unknown> = {};

vi.mock('@core/storeFactory', () => ({
  createStore: vi.fn(() => ({
    get(key: string) { return storeData[key]; },
    set(keyOrObj: string | Record<string, unknown>, value?: unknown) {
      if (typeof keyOrObj === 'string') {
        storeData[keyOrObj] = value;
      } else {
        Object.assign(storeData, keyOrObj);
      }
    },
    has(key: string) { return key in storeData; },
    delete(key: string) { delete storeData[key]; },
    clear() { storeData = {}; },
    get store() { return storeData; },
    set store(val: Record<string, unknown>) { storeData = val; },
    path: '/mock/path',
  })),
}));

// Import after mocks
import {
  haversineDistanceKm,
  formatDistanceLabel,
  formatDaysUntil,
  qualifySpeakerCta,
  getCommunityEventCardData,
} from '../communityEventsService';
import { _resetStore } from '../communityEventsStore';

// ─── Test Fixtures ──────────────────────────────────────────────────

function makeEvent(overrides?: Partial<CommunityEvent>): CommunityEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    slug: 'test-event',
    name: 'Test AI Meetup',
    startDatetime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days from now
    endDatetime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000 + 3 * 60 * 60 * 1000).toISOString(),
    locationShort: 'London',
    address: '123 Test Street, London, UK',
    imageUrl: 'https://example.com/image.jpg',
    publicUrl: 'https://community.mindstone.com/events/test-event',
    registered: 39,
    capacity: 50,
    ...overrides,
  };
}

function makeTopSession(overrides?: Partial<TopSessionInfo>): TopSessionInfo {
  return {
    sessionId: 'session-1',
    totalMinutes: 45,
    taskType: 'analysis',
    reasoning: 'Competitive analysis across 5 vendors with full pricing matrix',
    entryCount: 3,
    latestTimestamp: Date.now(),
    highestImpact: 'high',
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<CommunityEventsServiceDeps>): CommunityEventsServiceDeps {
  const londonCoords: GeoCoordinates = { lat: 51.5074, lng: -0.1278 };
  return {
    fetchEvents: vi.fn().mockResolvedValue([makeEvent()]),
    lookupUserLocation: vi.fn().mockResolvedValue({
      coords: londonCoords,
      city: 'London',
      country: 'GB',
    }),
    geocodeAddress: vi.fn().mockResolvedValue({ lat: 51.51, lng: -0.13 }), // ~0.3km from londonCoords
    getTopSession: vi.fn().mockReturnValue(makeTopSession()),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  storeData = {};
  _resetStore();
});

describe('haversineDistanceKm', () => {
  it('returns 0 for identical coordinates', () => {
    const p = { lat: 51.5074, lng: -0.1278 };
    expect(haversineDistanceKm(p, p)).toBeCloseTo(0, 1);
  });

  it('computes London to Paris (~344km)', () => {
    const london = { lat: 51.5074, lng: -0.1278 };
    const paris = { lat: 48.8566, lng: 2.3522 };
    const distance = haversineDistanceKm(london, paris);
    expect(distance).toBeGreaterThan(330);
    expect(distance).toBeLessThan(360);
  });

  it('computes NYC to London (~5570km)', () => {
    const nyc = { lat: 40.7128, lng: -74.006 };
    const london = { lat: 51.5074, lng: -0.1278 };
    const distance = haversineDistanceKm(nyc, london);
    expect(distance).toBeGreaterThan(5500);
    expect(distance).toBeLessThan(5600);
  });

  it('handles coordinates near the poles', () => {
    const northPole = { lat: 89.99, lng: 0 };
    const nearPole = { lat: 89.0, lng: 0 };
    const distance = haversineDistanceKm(northPole, nearPole);
    expect(distance).toBeGreaterThan(100);
    expect(distance).toBeLessThan(120);
  });

  it('handles coordinates crossing the antimeridian', () => {
    const east = { lat: 0, lng: 179.9 };
    const west = { lat: 0, lng: -179.9 };
    const distance = haversineDistanceKm(east, west);
    // Should be ~22km, not ~40,000km
    expect(distance).toBeLessThan(30);
  });
});

describe('formatDistanceLabel', () => {
  it('returns "Right in your city" for distances under 3km', () => {
    expect(formatDistanceLabel(0)).toBe('Right in your city');
    expect(formatDistanceLabel(1.5)).toBe('Right in your city');
    expect(formatDistanceLabel(2.99)).toBe('Right in your city');
  });

  it('returns "{N}km away" for distances >= 3km', () => {
    expect(formatDistanceLabel(3)).toBe('3km away');
    expect(formatDistanceLabel(12.4)).toBe('12km away');
    expect(formatDistanceLabel(49.7)).toBe('50km away');
  });

  it('rounds to nearest integer', () => {
    expect(formatDistanceLabel(5.4)).toBe('5km away');
    expect(formatDistanceLabel(5.5)).toBe('6km away');
  });
});

describe('formatDaysUntil', () => {
  it('returns 0 for today', () => {
    const today = new Date();
    today.setHours(18, 0, 0, 0); // 6pm today
    expect(formatDaysUntil(today.toISOString())).toBe(0);
  });

  it('returns positive for future dates', () => {
    const future = new Date();
    future.setDate(future.getDate() + 7);
    expect(formatDaysUntil(future.toISOString())).toBe(7);
  });

  it('returns negative for past dates', () => {
    const past = new Date();
    past.setDate(past.getDate() - 3);
    expect(formatDaysUntil(past.toISOString())).toBe(-3);
  });

  it('returns 1 for tomorrow', () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(formatDaysUntil(tomorrow.toISOString())).toBe(1);
  });
});

describe('qualifySpeakerCta', () => {
  it('returns undefined for null session', () => {
    expect(qualifySpeakerCta(null)).toBeUndefined();
  });

  it('returns personalized CTA for high-impact session >= 15 minutes', () => {
    const session = makeTopSession({ highestImpact: 'high', totalMinutes: 45 });
    const result = qualifySpeakerCta(session);
    expect(result).toBeDefined();
    expect(result!.isPersonalized).toBe(true);
    expect(result!.reasoning).toBe(session.reasoning);
    expect(result!.totalMinutes).toBe(45);
  });

  it('returns personalized CTA for critical-impact session >= 15 minutes', () => {
    const session = makeTopSession({ highestImpact: 'critical', totalMinutes: 30 });
    const result = qualifySpeakerCta(session);
    expect(result).toBeDefined();
    expect(result!.isPersonalized).toBe(true);
  });

  it('returns generic CTA for high-impact session < 15 minutes', () => {
    const session = makeTopSession({ highestImpact: 'high', totalMinutes: 10 });
    const result = qualifySpeakerCta(session);
    expect(result).toBeDefined();
    expect(result!.isPersonalized).toBe(false);
  });

  it('returns generic CTA for medium-impact session', () => {
    const session = makeTopSession({ highestImpact: 'medium', totalMinutes: 60 });
    const result = qualifySpeakerCta(session);
    expect(result).toBeDefined();
    expect(result!.isPersonalized).toBe(false);
  });

  it('returns generic CTA for low-impact session', () => {
    const session = makeTopSession({ highestImpact: 'low', totalMinutes: 30 });
    const result = qualifySpeakerCta(session);
    expect(result).toBeDefined();
    expect(result!.isPersonalized).toBe(false);
  });

  it('returns generic CTA when impact is undefined', () => {
    const session = makeTopSession({ highestImpact: undefined, totalMinutes: 30 });
    const result = qualifySpeakerCta(session);
    expect(result).toBeDefined();
    expect(result!.isPersonalized).toBe(false);
  });

  it('returns generic CTA for exactly 15 minutes with high impact', () => {
    const session = makeTopSession({ highestImpact: 'high', totalMinutes: 15 });
    const result = qualifySpeakerCta(session);
    expect(result).toBeDefined();
    expect(result!.isPersonalized).toBe(true);
  });

  it('handles empty reasoning gracefully', () => {
    const session = makeTopSession({ reasoning: undefined, highestImpact: 'high', totalMinutes: 20 });
    const result = qualifySpeakerCta(session);
    expect(result).toBeDefined();
    expect(result!.isPersonalized).toBe(true);
    expect(result!.reasoning).toBe('');
  });
});

describe('getCommunityEventCardData', () => {
  it('returns suppressed when user has opted out', async () => {
    storeData = { suppressCommunityEvents: true };
    const deps = makeDeps();

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('suppressed');
    expect(result.organizerUrl).toBe('https://community-admin.mindstone.ai/interest');
    // Should not call any fetch functions
    expect(deps.fetchEvents).not.toHaveBeenCalled();
    expect(deps.lookupUserLocation).not.toHaveBeenCalled();
  });

  it('returns nearby-event when event is within 50km', async () => {
    const deps = makeDeps();

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('nearby-event');
    expect(result.nearbyEvent).toBeDefined();
    expect(result.nearbyEvent!.distanceKm).toBeLessThan(50);
    expect(result.nearbyEvent!.distanceLabel).toBeDefined();
    expect(result.speakerCta).toBeDefined();
    expect(result.organizerUrl).toBe('https://community-admin.mindstone.ai/interest');
  });

  it('returns no-event when no events are within 50km', async () => {
    // Event in Paris, user in London (~344km)
    const parisEvent = makeEvent({ address: '1 Rue de Rivoli, Paris, France' });
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([parisEvent]),
      geocodeAddress: vi.fn().mockResolvedValue({ lat: 48.8566, lng: 2.3522 }),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('no-event');
  });

  it('filters out dismissed events', async () => {
    const event = makeEvent({ id: 'dismissed-1' });
    storeData = { dismissedEventIds: ['dismissed-1'] };
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([event]),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('no-event');
  });

  it('filters out past events', async () => {
    const pastEvent = makeEvent({
      startDatetime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([pastEvent]),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('no-event');
  });

  it('filters out events more than 30 days away', async () => {
    const farFutureEvent = makeEvent({
      startDatetime: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString(),
    });
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([farFutureEvent]),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('no-event');
  });

  it('uses cached events when cache is fresh', async () => {
    // Pre-populate cache with fresh data
    const cachedEvent = makeEvent();
    storeData = {
      cachedEvents: [cachedEvent],
      eventsLastFetchedAt: Date.now(), // Just now — fresh cache
    };
    const deps = makeDeps();

    await getCommunityEventCardData(deps);

    // Should NOT call fetchEvents since cache is fresh
    expect(deps.fetchEvents).not.toHaveBeenCalled();
  });

  it('fetches fresh events when cache is stale', async () => {
    // Pre-populate cache with stale data (25 hours ago)
    storeData = {
      cachedEvents: [makeEvent()],
      eventsLastFetchedAt: Date.now() - 25 * 60 * 60 * 1000,
    };
    const deps = makeDeps();

    await getCommunityEventCardData(deps);

    expect(deps.fetchEvents).toHaveBeenCalled();
  });

  it('uses cached user location when cache is fresh', async () => {
    storeData = {
      userLocation: { coords: { lat: 51.5074, lng: -0.1278 }, city: 'London', country: 'GB' },
      userLocationFetchedAt: Date.now(), // Fresh
    };
    const deps = makeDeps();

    await getCommunityEventCardData(deps);

    expect(deps.lookupUserLocation).not.toHaveBeenCalled();
  });

  it('returns no-event gracefully on fetch failure', async () => {
    const deps = makeDeps({
      fetchEvents: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const result = await getCommunityEventCardData(deps);

    // Falls back to cache (empty), so no-event
    expect(result.type).toBe('no-event');
  });

  it('returns no-event gracefully on location failure', async () => {
    const deps = makeDeps({
      lookupUserLocation: vi.fn().mockRejectedValue(new Error('IP lookup failed')),
    });

    const result = await getCommunityEventCardData(deps);

    // No user location → can't compute distance → no-event
    expect(result.type).toBe('no-event');
  });

  it('skips events that fail to geocode', async () => {
    const goodEvent = makeEvent({ address: 'Good Address' });
    const badEvent = makeEvent({ address: 'Bad Address' });
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([goodEvent, badEvent]),
      geocodeAddress: vi.fn().mockImplementation((address: string) => {
        if (address === 'Bad Address') return Promise.resolve(null);
        return Promise.resolve({ lat: 51.51, lng: -0.13 });
      }),
    });

    const result = await getCommunityEventCardData(deps);

    // Good event should still be found
    expect(result.type).toBe('nearby-event');
  });

  it('prefers soonest event among multiple nearby ones', async () => {
    const soonerEvent = makeEvent({
      id: 'sooner',
      name: 'Sooner Event',
      startDatetime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days
      address: 'Address A',
    });
    const laterEvent = makeEvent({
      id: 'later',
      name: 'Later Event',
      startDatetime: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), // 14 days
      address: 'Address B',
    });
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([laterEvent, soonerEvent]),
      geocodeAddress: vi.fn().mockResolvedValue({ lat: 51.51, lng: -0.13 }), // Both nearby
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('nearby-event');
    expect(result.nearbyEvent!.event.id).toBe('sooner');
  });

  it('computes spotsLeft correctly', async () => {
    const event = makeEvent({ capacity: 50, registered: 43 });
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([event]),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('nearby-event');
    expect(result.nearbyEvent!.spotsLeft).toBe(7);
  });

  it('returns null spotsLeft when capacity is 0', async () => {
    const event = makeEvent({ capacity: 0, registered: 10 });
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([event]),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('nearby-event');
    expect(result.nearbyEvent!.spotsLeft).toBeNull();
  });

  it('includes speaker CTA when top session qualifies', async () => {
    const deps = makeDeps({
      getTopSession: vi.fn().mockReturnValue(
        makeTopSession({ highestImpact: 'high', totalMinutes: 45 }),
      ),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('nearby-event');
    expect(result.speakerCta).toBeDefined();
    expect(result.speakerCta!.isPersonalized).toBe(true);
  });

  it('includes generic speaker CTA when session does not qualify', async () => {
    const deps = makeDeps({
      getTopSession: vi.fn().mockReturnValue(
        makeTopSession({ highestImpact: 'low', totalMinutes: 5 }),
      ),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('nearby-event');
    expect(result.speakerCta).toBeDefined();
    expect(result.speakerCta!.isPersonalized).toBe(false);
  });

  it('handles no top session gracefully', async () => {
    const deps = makeDeps({
      getTopSession: vi.fn().mockReturnValue(null),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('nearby-event');
    expect(result.speakerCta).toBeUndefined();
  });

  it('returns no-event when fetchEvents returns empty array', async () => {
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([]),
    });

    const result = await getCommunityEventCardData(deps);

    expect(result.type).toBe('no-event');
  });

  it('uses cached geocode for known addresses', async () => {
    const event = makeEvent({ address: 'Known Address' });
    storeData = {
      geocodedAddresses: {
        'known address': { lat: 51.51, lng: -0.13 },
      },
    };
    const deps = makeDeps({
      fetchEvents: vi.fn().mockResolvedValue([event]),
    });

    await getCommunityEventCardData(deps);

    // Should NOT call geocodeAddress since it's cached
    expect(deps.geocodeAddress).not.toHaveBeenCalled();
  });
});
