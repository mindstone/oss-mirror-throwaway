import type { Logger } from '@core/logger';
import { describe, expect, it, vi } from 'vitest';
import type { EnrichmentQuery } from '../../types';
import { enrichWithCalendar, type EnrichmentDeps } from '../enrichWithCalendar';

type CalendarMeeting = Exclude<
  Awaited<ReturnType<EnrichmentDeps['listCachedMeetings']>>,
  null | undefined
>[number];

const FIXED_CLOCK = new Date('2026-05-19T12:00:00.000Z');

function normalizeMeetingUrl(url: string): string {
  const zoomMatch = url.match(/\/j\/([^/?]+)/i);
  if (zoomMatch) {
    return zoomMatch[1].toLowerCase();
  }

  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return url.trim().toLowerCase();
  }
}

function createLoggerSpies() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

function createDeps(options: {
  meetings?: CalendarMeeting[];
  listError?: Error;
  listCachedMeetings?: EnrichmentDeps['listCachedMeetings'];
  normalizeUrl?: EnrichmentDeps['normalizeUrl'];
} = {}): {
  deps: EnrichmentDeps;
  logger: ReturnType<typeof createLoggerSpies>;
} {
  const logger = createLoggerSpies();
  const listCachedMeetings = options.listCachedMeetings
    ?? (options.listError
      ? vi.fn(async () => {
          throw options.listError;
        })
      : vi.fn(async () => options.meetings ?? []));

  return {
    deps: {
      listCachedMeetings,
      normalizeUrl: options.normalizeUrl ?? normalizeMeetingUrl,
      logger: logger as unknown as Logger,
      clock: () => FIXED_CLOCK,
    },
    logger,
  };
}

function makeMeeting(
  overrides: Partial<CalendarMeeting> & Pick<CalendarMeeting, 'calendarEventId' | 'startTime'>,
): CalendarMeeting {
  return {
    calendarEventId: overrides.calendarEventId,
    calendarSource: overrides.calendarSource ?? 'google',
    title: overrides.title ?? `Meeting ${overrides.calendarEventId}`,
    meetingUrl: overrides.meetingUrl,
    startTime: overrides.startTime,
    endTime: overrides.endTime,
    participants: overrides.participants ?? [],
    invitees: overrides.invitees ?? [],
  };
}

function makeQuery(overrides: Partial<EnrichmentQuery> = {}): EnrichmentQuery {
  return {
    startTime: '2026-05-19T10:00:00.000Z',
    durationMs: 30 * 60 * 1000,
    participants: [],
    ...overrides,
  };
}

describe('enrichWithCalendar', () => {
  it('returns enrichment on exact URL match within candidate window (h)', async () => {
    const { deps, logger } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-1',
          startTime: '2026-05-19T10:01:00.000Z',
          meetingUrl: 'https://zoom.us/j/123456789?pwd=test',
          title: 'Product Sync',
        }),
        makeMeeting({
          calendarEventId: 'event-2',
          startTime: '2026-05-19T10:02:00.000Z',
          meetingUrl: 'https://zoom.us/j/222222222',
          title: 'Other Meeting',
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ meetingUrl: 'https://zoom.us/j/123456789' }),
      deps,
    );

    expect(result).toEqual({
      matched: true,
      title: 'Product Sync',
      meetingUrl: 'https://zoom.us/j/123456789?pwd=test',
      calendarEventId: 'event-1',
      calendarSource: 'google',
      startTime: '2026-05-19T10:01:00.000Z',
    });
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateCount: 1,
        matched: 'url',
        ambiguous: false,
        durationMs: expect.any(Number),
        candidates: [
          expect.objectContaining({
            calendarEventId: 'event-1',
            participantOverlap: 0,
          }),
        ],
      }),
      'calendar_enrichment_result',
    );
  });

  it('matches by URL across the full cached list even outside the time window', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-url-far',
          startTime: '2026-05-19T10:40:00.000Z',
          meetingUrl: 'https://zoom.us/j/123123123?pwd=abc',
          title: 'Recurring Team Sync',
        }),
        makeMeeting({
          calendarEventId: 'event-nearby',
          startTime: '2026-05-19T10:01:00.000Z',
          meetingUrl: 'https://zoom.us/j/999999999',
          title: 'Nearby Different Meeting',
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ meetingUrl: 'https://zoom.us/j/123123123' }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-url-far',
        title: 'Recurring Team Sync',
      }),
    );
  });

  it('uses single time-window candidate when URL misses (i)', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-time',
          startTime: '2026-05-19T10:03:00.000Z',
          title: 'Time Window Match',
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ meetingUrl: 'https://zoom.us/j/does-not-match' }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-time',
        title: 'Time Window Match',
      }),
    );
  });

  it('matches overlapping windows using query duration and event end time', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-overlap',
          startTime: '2026-05-19T09:10:00.000Z',
          endTime: '2026-05-19T10:10:00.000Z',
          title: 'Late Join Overlap',
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ durationMs: 60 * 60 * 1000 }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-overlap',
      }),
    );
  });

  it('prefers the participant-overlap candidate when multiple time-window matches exist (j)', async () => {
    const { deps, logger } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-a',
          startTime: '2026-05-19T09:58:00.000Z',
          participants: ['No Match'],
        }),
        makeMeeting({
          calendarEventId: 'event-b',
          startTime: '2026-05-19T10:02:00.000Z',
          participants: ['Pat Morgan'],
        }),
        makeMeeting({
          calendarEventId: 'event-c',
          startTime: '2026-05-19T10:04:00.000Z',
          participants: ['Another Person'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['Pat Morgan'] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-b',
      }),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'calendar_matcher_ambiguous',
    );
  });

  it('uses participant first-name title confirmation when overlap does not narrow candidates', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-title-confirmed',
          startTime: '2026-05-19T10:03:00.000Z',
          title: 'Pat project sync',
          participants: ['Alex Johnson'],
        }),
        makeMeeting({
          calendarEventId: 'event-not-confirmed',
          startTime: '2026-05-19T10:01:00.000Z',
          title: 'Roadmap review',
          participants: ['Casey Lee'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['Pat Morgan'] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-title-confirmed',
      }),
    );
  });

  it('uses participant first-name invitee confirmation when overlap does not narrow candidates', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-invitee-confirmed',
          startTime: '2026-05-19T10:03:00.000Z',
          title: 'Roadmap review',
          invitees: ['Pat'],
          participants: ['Alex Johnson'],
        }),
        makeMeeting({
          calendarEventId: 'event-not-confirmed',
          startTime: '2026-05-19T10:01:00.000Z',
          title: 'Team update',
          invitees: ['Taylor'],
          participants: ['Casey Lee'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['Pat Morgan'] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-invitee-confirmed',
      }),
    );
  });

  it('uses participant first-name participant-field confirmation when full-name overlap does not narrow candidates', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-participant-confirmed',
          startTime: '2026-05-19T10:03:00.000Z',
          title: 'Roadmap review',
          participants: ['Pat'],
        }),
        makeMeeting({
          calendarEventId: 'event-not-confirmed',
          startTime: '2026-05-19T10:01:00.000Z',
          title: 'Team update',
          participants: ['Taylor'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['Pat Morgan'] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-participant-confirmed',
      }),
    );
  });

  it('ignores empty and one-letter first-name confirmation tokens', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-one-letter-title',
          startTime: '2026-05-19T10:04:00.000Z',
          title: 'A leadership sync',
          invitees: ['A'],
        }),
        makeMeeting({
          calendarEventId: 'event-closest',
          startTime: '2026-05-19T10:01:00.000Z',
          title: 'Team update',
          invitees: ['Taylor'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['A', '   '] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-closest',
      }),
    );
  });

  it('uses deterministic tiebreaker among participant-confirmed candidates when confirmation narrows to multiple', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-unconfirmed-closest',
          startTime: '2026-05-19T10:00:30.000Z',
          title: 'Roadmap review',
          invitees: ['Taylor'],
        }),
        makeMeeting({
          calendarEventId: 'event-confirmed-far',
          startTime: '2026-05-19T10:04:00.000Z',
          title: 'Pat leadership sync',
          invitees: ['Jamie'],
        }),
        makeMeeting({
          calendarEventId: 'event-confirmed-close',
          startTime: '2026-05-19T10:02:00.000Z',
          title: 'Status update',
          invitees: ['Pat'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['Pat Morgan'] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-confirmed-close',
      }),
    );
  });

  it('falls back to deterministic tiebreaker across all candidates when participant confirmation narrows to none', async () => {
    const { deps, logger } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-far',
          startTime: '2026-05-19T10:05:00.000Z',
          title: 'Roadmap review',
          invitees: ['Taylor'],
        }),
        makeMeeting({
          calendarEventId: 'event-close',
          startTime: '2026-05-19T10:01:00.000Z',
          title: 'Team update',
          invitees: ['Jordan'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['Pat Morgan'] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-close',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        matched: 'tiebreaker',
        ambiguous: true,
        resolution: 'tiebreaker',
        chosenCalendarEventId: 'event-close',
      }),
      'calendar_matcher_ambiguous',
    );
  });

  it('uses deterministic tiebreaker by closest start time and logs warning (p)', async () => {
    const { deps, logger } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-far',
          startTime: '2026-05-19T10:04:00.000Z',
          participants: ['Ava'],
        }),
        makeMeeting({
          calendarEventId: 'event-close',
          startTime: '2026-05-19T10:02:00.000Z',
          participants: ['Ava'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['Ava'] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-close',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        candidateCount: 2,
        matched: 'tiebreaker',
        ambiguous: true,
        chosenCalendarEventId: 'event-close',
      }),
      'calendar_matcher_ambiguous',
    );
  });

  it('keeps URL provenance for ambiguous URL matches resolved by tiebreaker', async () => {
    const { deps, logger } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-url-farther',
          startTime: '2026-05-19T10:04:00.000Z',
          meetingUrl: 'https://zoom.us/j/777777777',
        }),
        makeMeeting({
          calendarEventId: 'event-url-closer',
          startTime: '2026-05-19T10:01:00.000Z',
          meetingUrl: 'https://zoom.us/j/777777777',
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ meetingUrl: 'https://zoom.us/j/777777777' }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-url-closer',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        matched: 'url',
        ambiguous: true,
        resolution: 'tiebreaker',
        chosenCalendarEventId: 'event-url-closer',
      }),
      'calendar_matcher_ambiguous',
    );
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        matched: 'url',
        ambiguous: true,
        resolution: 'tiebreaker',
      }),
      'calendar_enrichment_result',
    );
  });

  it('keeps URL provenance when participant confirmation narrows URL ambiguity to multiple candidates', async () => {
    const { deps, logger } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-url-unconfirmed-closest',
          startTime: '2026-05-19T10:00:30.000Z',
          meetingUrl: 'https://zoom.us/j/123123123',
          title: 'Roadmap review',
          invitees: ['Taylor'],
        }),
        makeMeeting({
          calendarEventId: 'event-url-confirmed-close',
          startTime: '2026-05-19T10:02:00.000Z',
          meetingUrl: 'https://zoom.us/j/123123123',
          title: 'Team update',
          invitees: ['Pat'],
        }),
        makeMeeting({
          calendarEventId: 'event-url-confirmed-far',
          startTime: '2026-05-19T10:04:00.000Z',
          meetingUrl: 'https://zoom.us/j/123123123',
          title: 'Pat leadership sync',
          invitees: ['Jordan'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({
        meetingUrl: 'https://zoom.us/j/123123123',
        participants: ['Pat Morgan'],
      }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-url-confirmed-close',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        matched: 'url',
        ambiguous: true,
        resolution: 'tiebreaker',
        candidateCount: 2,
        chosenCalendarEventId: 'event-url-confirmed-close',
      }),
      'calendar_matcher_ambiguous',
    );
  });

  it('uses lexicographically smallest event id when time distance ties and logs warning (p\')', async () => {
    const { deps, logger } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'z-event',
          startTime: '2026-05-19T09:58:00.000Z',
          participants: ['Ava'],
        }),
        makeMeeting({
          calendarEventId: 'a-event',
          startTime: '2026-05-19T10:02:00.000Z',
          participants: ['Ava'],
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ participants: ['Ava'] }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'a-event',
      }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        matched: 'tiebreaker',
        ambiguous: true,
        chosenCalendarEventId: 'a-event',
      }),
      'calendar_matcher_ambiguous',
    );
  });

  it('normalizes empty titles to undefined at matcher boundary', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-empty-title',
          startTime: '2026-05-19T10:01:00.000Z',
          title: '   ',
        }),
      ],
    });

    const result = await enrichWithCalendar(makeQuery(), deps);

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-empty-title',
      }),
    );
    expect(result).toHaveProperty('title', undefined);
  });

  it('returns empty result when no candidates are found (k)', async () => {
    const { deps } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-late',
          startTime: '2026-05-19T11:30:00.000Z',
        }),
      ],
    });

    await expect(enrichWithCalendar(makeQuery(), deps)).resolves.toEqual({ matched: false });
  });

  it('handles undefined cache payload as empty meeting list', async () => {
    const { deps } = createDeps({
      listCachedMeetings: vi.fn(async () => undefined),
    });

    await expect(enrichWithCalendar(makeQuery(), deps)).resolves.toEqual({ matched: false });
  });

  it('returns empty result and logs invalid start time context', async () => {
    const { deps, logger } = createDeps({
      meetings: [
        makeMeeting({
          calendarEventId: 'event-any',
          startTime: '2026-05-19T10:01:00.000Z',
        }),
      ],
    });

    await expect(
      enrichWithCalendar(makeQuery({ startTime: 'not-a-timestamp' }), deps),
    ).resolves.toEqual({ matched: false });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        meetingUrl: null,
        startTime: 'not-a-timestamp',
        durationMs: 30 * 60 * 1000,
        participantCount: 0,
      }),
      'calendar_enrichment_invalid_start_time',
    );
  });

  it('falls back to raw URL when normalizeUrl throws and logs once per side', async () => {
    const normalizeError = new Error('normalize failed');
    const { deps, logger } = createDeps({
      normalizeUrl: vi.fn(() => {
        throw normalizeError;
      }),
      meetings: [
        makeMeeting({
          calendarEventId: 'event-raw-match',
          startTime: '2026-05-19T10:01:00.000Z',
          meetingUrl: 'https://example.com/meeting/raw-id',
        }),
        makeMeeting({
          calendarEventId: 'event-raw-other',
          startTime: '2026-05-19T10:02:00.000Z',
          meetingUrl: 'https://example.com/meeting/other-id',
        }),
      ],
    });

    const result = await enrichWithCalendar(
      makeQuery({ meetingUrl: 'https://example.com/meeting/raw-id' }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        matched: true,
        calendarEventId: 'event-raw-match',
      }),
    );

    const normalizeWarnings = logger.warn.mock.calls.filter(
      ([, message]) => message === 'calendar_enrichment_normalize_url_failed',
    );

    expect(normalizeWarnings).toHaveLength(2);
    expect(
      normalizeWarnings
        .map(([payload]) => (payload as { side?: string }).side)
        .sort(),
    ).toEqual(['event', 'query']);
  });

  it('catches listCachedMeetings errors, logs, and returns empty result', async () => {
    const listError = new Error('cache unavailable');
    const { deps, logger } = createDeps({ listError });

    await expect(enrichWithCalendar(makeQuery(), deps)).resolves.toEqual({ matched: false });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        meetingUrl: null,
        startTime: '2026-05-19T10:00:00.000Z',
        durationMs: 30 * 60 * 1000,
        participantCount: 0,
      }),
      'calendar_enrichment_failed',
    );
  });
});
