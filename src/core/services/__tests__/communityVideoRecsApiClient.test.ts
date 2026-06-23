import { describe, it, expect, vi, beforeEach } from 'vitest';

import { fetchCommunityVideos } from '../communityVideoRecsApiClient';

// ─── Test Fixtures ──────────────────────────────────────────────────

function makeGraphQLResponse(events: unknown[]) {
  return {
    data: {
      defaultPlatformSpace: {
        events: {
          list: {
            list: events,
          },
        },
      },
    },
  };
}

function makeEvent(overrides?: Record<string, unknown>) {
  return {
    id: 'evt-1',
    slug: 'test-event',
    name: 'AI Meetup London',
    startDatetime: '2026-03-15T18:00:00Z',
    locationShort: 'London',
    agenda: [],
    ...overrides,
  };
}

function makeAgendaItem(overrides?: Record<string, unknown>) {
  return {
    title: 'Building AI Workflows',
    speakerName: 'Sarah Chen',
    recording: {
      id: 'rec-1',
      headline: 'Building AI Workflows for Sales Teams',
      type: 'video',
      url: 'https://www.dropbox.com/s/abc123/video.mp4',
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('fetchCommunityVideos', () => {
  it('returns video recordings with event context', async () => {
    const agenda = [makeAgendaItem()];
    const events = [makeEvent({ agenda })];
    const mockResponse = makeGraphQLResponse(events);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const videos = await fetchCommunityVideos();

    expect(videos).toHaveLength(1);
    expect(videos[0]).toEqual({
      id: 'rec-1',
      headline: 'Building AI Workflows for Sales Teams',
      speakerName: 'Sarah Chen',
      eventName: 'AI Meetup London',
      eventCity: 'London',
      eventDate: '2026-03-15T18:00:00Z',
      url: 'https://www.dropbox.com/s/abc123/video.mp4',
      eventUrl: 'https://community.mindstone.com/annotate/rec-1',
    });
  });

  it('filters out agenda items with null recordings', async () => {
    const agenda = [
      makeAgendaItem(),
      makeAgendaItem({ recording: null, title: 'Panel Discussion', speakerName: 'John' }),
    ];
    const events = [makeEvent({ agenda })];
    const mockResponse = makeGraphQLResponse(events);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const videos = await fetchCommunityVideos();

    expect(videos).toHaveLength(1);
    expect(videos[0].headline).toBe('Building AI Workflows for Sales Teams');
  });

  it('filters out non-video recording types', async () => {
    const agenda = [
      makeAgendaItem(),
      makeAgendaItem({
        recording: {
          id: 'rec-audio',
          headline: 'Audio Recording',
          type: 'audio',
          url: 'https://example.com/audio.mp3',
        },
      }),
    ];
    const events = [makeEvent({ agenda })];
    const mockResponse = makeGraphQLResponse(events);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const videos = await fetchCommunityVideos();

    expect(videos).toHaveLength(1);
    expect(videos[0].id).toBe('rec-1');
  });

  it('maps null speakerName to empty string', async () => {
    const agenda = [makeAgendaItem({ speakerName: null })];
    const events = [makeEvent({ agenda })];
    const mockResponse = makeGraphQLResponse(events);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const videos = await fetchCommunityVideos();

    expect(videos).toHaveLength(1);
    expect(videos[0].speakerName).toBe('');
  });

  it('maps null locationShort to empty string', async () => {
    const agenda = [makeAgendaItem()];
    const events = [makeEvent({ agenda, locationShort: null })];
    const mockResponse = makeGraphQLResponse(events);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const videos = await fetchCommunityVideos();

    expect(videos).toHaveLength(1);
    expect(videos[0].eventCity).toBe('');
  });

  it('correctly maps event context onto each video', async () => {
    const event1 = makeEvent({
      name: 'Berlin AI Summit',
      locationShort: 'Berlin',
      startDatetime: '2026-02-10T14:00:00Z',
      agenda: [
        makeAgendaItem({
          recording: { id: 'rec-b1', headline: 'Talk A', type: 'video', url: 'https://dropbox.com/a' },
          speakerName: 'Alice',
        }),
      ],
    });
    const event2 = makeEvent({
      name: 'NYC Workshop',
      locationShort: 'New York',
      startDatetime: '2026-01-20T10:00:00Z',
      agenda: [
        makeAgendaItem({
          recording: { id: 'rec-n1', headline: 'Talk B', type: 'video', url: 'https://dropbox.com/b' },
          speakerName: 'Bob',
        }),
      ],
    });
    const mockResponse = makeGraphQLResponse([event1, event2]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const videos = await fetchCommunityVideos();

    expect(videos).toHaveLength(2);

    expect(videos[0].eventName).toBe('Berlin AI Summit');
    expect(videos[0].eventCity).toBe('Berlin');
    expect(videos[0].eventDate).toBe('2026-02-10T14:00:00Z');
    expect(videos[0].speakerName).toBe('Alice');

    expect(videos[1].eventName).toBe('NYC Workshop');
    expect(videos[1].eventCity).toBe('New York');
    expect(videos[1].eventDate).toBe('2026-01-20T10:00:00Z');
    expect(videos[1].speakerName).toBe('Bob');
  });

  it('returns empty array for empty events list', async () => {
    const mockResponse = makeGraphQLResponse([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const videos = await fetchCommunityVideos();

    expect(videos).toEqual([]);
  });

  it('throws on HTTP error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }));

    await expect(fetchCommunityVideos()).rejects.toThrow(
      'GraphQL request failed: 500 Internal Server Error',
    );
  });

  it('throws on malformed response (missing data field)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ errors: [{ message: 'bad query' }] }),
    }));

    await expect(fetchCommunityVideos()).rejects.toThrow();
  });

  it('throws on malformed response (invalid event shape)', async () => {
    const malformed = {
      data: {
        defaultPlatformSpace: {
          events: {
            list: {
              list: [{ id: 123, name: null }], // wrong types
            },
          },
        },
      },
    };

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(malformed),
    }));

    await expect(fetchCommunityVideos()).rejects.toThrow();
  });

  it('handles multiple agenda items per event with mixed recordings', async () => {
    const agenda = [
      makeAgendaItem({
        recording: { id: 'rec-v1', headline: 'Video Talk 1', type: 'video', url: 'https://dropbox.com/v1' },
        speakerName: 'Speaker A',
      }),
      makeAgendaItem({ recording: null, speakerName: 'Moderator' }),
      makeAgendaItem({
        recording: { id: 'rec-v2', headline: 'Video Talk 2', type: 'video', url: 'https://dropbox.com/v2' },
        speakerName: 'Speaker B',
      }),
      makeAgendaItem({
        recording: { id: 'rec-a1', headline: 'Audio Only', type: 'audio', url: 'https://dropbox.com/a1' },
        speakerName: 'Speaker C',
      }),
    ];
    const events = [makeEvent({ agenda })];
    const mockResponse = makeGraphQLResponse(events);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockResponse),
    }));

    const videos = await fetchCommunityVideos();

    expect(videos).toHaveLength(2);
    expect(videos[0].id).toBe('rec-v1');
    expect(videos[1].id).toBe('rec-v2');
  });
});
