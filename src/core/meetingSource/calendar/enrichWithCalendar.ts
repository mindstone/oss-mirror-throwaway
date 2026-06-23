import type { Logger } from '@core/logger';
import type { EnrichmentQuery, EnrichmentResult } from '../types';

const DEFAULT_TIME_WINDOW_MINUTES = 5;
const DEFAULT_MIN_PARTICIPANT_OVERLAP = 1;
const DEFAULT_EVENT_DURATION_MS = 60 * 60 * 1000;
const MIN_FIRST_NAME_CONFIRM_LENGTH = 2;
const EMPTY_ENRICHMENT_RESULT: EnrichmentResult = { matched: false };

type MatchType = 'url' | 'time-window' | 'tiebreaker' | 'none';
type UrlNormalizationSide = 'query' | 'event';

interface CalendarMeeting {
  calendarEventId: string;
  calendarSource: string;
  title: string;
  startTime: string;
  endTime?: string;
  meetingUrl?: string;
  participants?: string[];
  invitees?: string[];
}

interface Candidate {
  event: CalendarMeeting;
  participantOverlap: number;
  participantConfirmed: boolean;
  startDistanceMs: number;
  overlapsTimeWindow: boolean;
}

interface CandidateLogEntry {
  calendarEventId: string;
  meetingUrl?: string;
  participantOverlap: number;
  participantConfirmed: boolean;
}

interface MatcherLogFields {
  candidateCount: number;
  matched: MatchType;
  durationMs: number;
  ambiguous: boolean;
  resolution?: 'tiebreaker';
  candidates: CandidateLogEntry[];
}

export interface EnrichmentDeps {
  listCachedMeetings: () => Promise<CalendarMeeting[] | null | undefined>;
  normalizeUrl: (url: string) => string;
  sanitizeNameForMatch?: (name: string) => string;
  logger: Logger;
  clock: () => Date;
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function toTimestamp(isoString: string): number | null {
  const value = Date.parse(isoString);
  return Number.isNaN(value) ? null : value;
}

function normalizeParticipantName(name: string): string {
  return name.trim().toLowerCase();
}

function defaultSanitizeNameForMatch(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNameForMatch(
  name: string,
  sanitize: (value: string) => string,
): string {
  const sanitized = sanitize(name);
  if (!sanitized) {
    return '';
  }
  const [firstToken] = sanitized.split(/\s+/);
  return firstToken ?? '';
}

function textContainsAnyFirstName(
  value: string | undefined,
  firstNames: Set<string>,
  sanitize: (name: string) => string,
): boolean {
  if (!value || firstNames.size === 0) {
    return false;
  }

  const normalizedTokens = sanitize(value)
    .split(/\s+/)
    .filter((token) => token.length > 0);
  return normalizedTokens.some((token) => firstNames.has(token));
}

function candidateHasParticipantConfirm(
  queryParticipants: string[] | undefined,
  event: CalendarMeeting,
  sanitize: (name: string) => string,
): boolean {
  if (!queryParticipants?.length) {
    return false;
  }

  const queryFirstNames = new Set(
    queryParticipants
      .map((participant) => firstNameForMatch(participant, sanitize))
      .filter((name) => name.length >= MIN_FIRST_NAME_CONFIRM_LENGTH),
  );
  if (queryFirstNames.size === 0) {
    return false;
  }

  const participantFields = [...(event.participants ?? []), ...(event.invitees ?? [])];
  for (const participant of participantFields) {
    if (textContainsAnyFirstName(participant, queryFirstNames, sanitize)) {
      return true;
    }
  }

  return textContainsAnyFirstName(event.title, queryFirstNames, sanitize);
}

function getParticipantOverlap(queryParticipants: string[] | undefined, eventParticipants: string[] | undefined): number {
  if (!queryParticipants?.length || !eventParticipants?.length) {
    return 0;
  }

  const querySet = new Set(
    queryParticipants
      .map(normalizeParticipantName)
      .filter((participant) => participant.length > 0)
  );

  if (querySet.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const eventParticipant of eventParticipants) {
    const normalized = normalizeParticipantName(eventParticipant);
    if (normalized.length > 0 && querySet.has(normalized)) {
      overlap += 1;
      querySet.delete(normalized);
    }
  }

  return overlap;
}

function buildCandidateLogs(candidates: Candidate[]): CandidateLogEntry[] {
  return candidates.map(({ event, participantOverlap, participantConfirmed }) => ({
    calendarEventId: event.calendarEventId,
    meetingUrl: event.meetingUrl,
    participantOverlap,
    participantConfirmed,
  }));
}

function buildLogFields(
  deps: EnrichmentDeps,
  startedAtMs: number,
  matched: MatchType,
  ambiguous: boolean,
  candidates: Candidate[],
  resolution?: 'tiebreaker',
): MatcherLogFields {
  return {
    candidateCount: candidates.length,
    matched,
    durationMs: Math.max(0, deps.clock().getTime() - startedAtMs),
    ambiguous,
    resolution,
    candidates: buildCandidateLogs(candidates),
  };
}

function createSafeUrlNormalizer(deps: EnrichmentDeps): (url: string, side: UrlNormalizationSide) => string {
  const warnedSides = new Set<UrlNormalizationSide>();

  return (url: string, side: UrlNormalizationSide): string => {
    try {
      const normalized = deps.normalizeUrl(url);
      return normalized || url;
    } catch (error) {
      if (!warnedSides.has(side)) {
        deps.logger.warn(
          {
            err: error,
            side,
          },
          'calendar_enrichment_normalize_url_failed',
        );
        warnedSides.add(side);
      }
      return url;
    }
  };
}

function filterByParticipantOverlap(candidates: Candidate[], minOverlap: number): Candidate[] {
  return candidates.filter((candidate) => candidate.participantOverlap >= minOverlap);
}

function filterByParticipantConfirm(
  candidates: Candidate[],
  queryParticipants: string[] | undefined,
  sanitize: (name: string) => string,
): Candidate[] {
  if (!queryParticipants?.length) {
    return [];
  }

  return candidates.filter((candidate) => (
    candidateHasParticipantConfirm(queryParticipants, candidate.event, sanitize)
  ));
}

function pickDeterministicCandidate(candidates: Candidate[]): Candidate {
  return candidates.reduce((best, current) => {
    if (current.startDistanceMs < best.startDistanceMs) {
      return current;
    }
    if (current.startDistanceMs > best.startDistanceMs) {
      return best;
    }

    return current.event.calendarEventId.localeCompare(best.event.calendarEventId) < 0
      ? current
      : best;
  });
}

function toEnrichmentResult(candidate: Candidate, query: EnrichmentQuery): EnrichmentResult {
  const title = candidate.event.title?.trim() ? candidate.event.title : undefined;
  return {
    matched: true,
    title,
    meetingUrl: candidate.event.meetingUrl ?? query.meetingUrl,
    calendarEventId: candidate.event.calendarEventId,
    calendarSource: candidate.event.calendarSource,
    startTime: candidate.event.startTime,
  };
}

function resolveEventEndMs(event: CalendarMeeting, eventStartMs: number): number {
  const parsedEndMs = event.endTime ? toTimestamp(event.endTime) : null;
  if (parsedEndMs !== null && parsedEndMs >= eventStartMs) {
    return parsedEndMs;
  }
  return eventStartMs + DEFAULT_EVENT_DURATION_MS;
}

function hasOverlapWithSlack(
  eventStartMs: number,
  eventEndMs: number,
  queryStartMs: number,
  queryEndMs: number,
  slackMs: number,
): boolean {
  const eventWindowStartMs = eventStartMs - slackMs;
  const eventWindowEndMs = eventEndMs + slackMs;
  return eventWindowStartMs <= queryEndMs && queryStartMs <= eventWindowEndMs;
}

function buildCandidates(
  meetings: CalendarMeeting[],
  queryStartMs: number,
  queryEndMs: number,
  timeWindowMs: number,
  queryParticipants: string[] | undefined,
  sanitizeNameForMatch: (name: string) => string,
): Candidate[] {
  const candidates: Candidate[] = [];

  for (const meeting of meetings) {
    const meetingStartMs = toTimestamp(meeting.startTime);
    if (meetingStartMs === null) {
      continue;
    }

    const startDistanceMs = Math.abs(meetingStartMs - queryStartMs);
    const meetingEndMs = resolveEventEndMs(meeting, meetingStartMs);
    const overlapsTimeWindow = hasOverlapWithSlack(
      meetingStartMs,
      meetingEndMs,
      queryStartMs,
      queryEndMs,
      timeWindowMs,
    );

    candidates.push({
      event: meeting,
      participantOverlap: getParticipantOverlap(queryParticipants, meeting.participants),
      participantConfirmed: candidateHasParticipantConfirm(
        queryParticipants,
        meeting,
        sanitizeNameForMatch,
      ),
      startDistanceMs,
      overlapsTimeWindow,
    });
  }

  return candidates;
}

function buildQueryLogContext(query: EnrichmentQuery): {
  meetingUrl: string | null;
  startTime: string;
  durationMs: number;
  participantCount: number;
} {
  return {
    meetingUrl: query.meetingUrl ? '<redacted>' : null,
    startTime: query.startTime,
    durationMs: query.durationMs,
    participantCount: query.participants?.length ?? 0,
  };
}

function selectWithParticipantAndTiebreaker(
  candidates: Candidate[],
  queryParticipants: string[] | undefined,
  minParticipantOverlap: number,
  sanitizeNameForMatch: (name: string) => string,
  matchType: 'url' | 'time-window',
): {
  selected: Candidate;
  matched: MatchType;
  ambiguous: boolean;
  consideredCandidates: Candidate[];
} {
  const participantMatched = filterByParticipantOverlap(candidates, minParticipantOverlap);
  if (participantMatched.length === 1) {
    return {
      selected: participantMatched[0],
      matched: matchType,
      ambiguous: false,
      consideredCandidates: participantMatched,
    };
  }

  let narrowed = participantMatched.length > 1 ? participantMatched : candidates;
  const participantConfirmed = filterByParticipantConfirm(
    narrowed,
    queryParticipants,
    sanitizeNameForMatch,
  );
  if (participantConfirmed.length === 1) {
    return {
      selected: participantConfirmed[0],
      matched: matchType,
      ambiguous: false,
      consideredCandidates: participantConfirmed,
    };
  }
  if (participantConfirmed.length > 1) {
    narrowed = participantConfirmed;
  }

  if (narrowed.length === 1) {
    return {
      selected: narrowed[0],
      matched: matchType,
      ambiguous: false,
      consideredCandidates: narrowed,
    };
  }

  return {
    selected: pickDeterministicCandidate(narrowed),
    matched: matchType === 'url' ? 'url' : 'tiebreaker',
    ambiguous: true,
    consideredCandidates: narrowed,
  };
}

export async function enrichWithCalendar(
  query: EnrichmentQuery,
  deps: EnrichmentDeps,
): Promise<EnrichmentResult> {
  const startedAtMs = deps.clock().getTime();
  const timeWindowMinutes = normalizePositiveInt(
    query.timeWindowMinutes,
    DEFAULT_TIME_WINDOW_MINUTES,
  );
  const minParticipantOverlap = normalizePositiveInt(
    query.minParticipantOverlap,
    DEFAULT_MIN_PARTICIPANT_OVERLAP,
  );
  const sanitizeNameForMatch = deps.sanitizeNameForMatch ?? defaultSanitizeNameForMatch;

  try {
    const queryStartMs = toTimestamp(query.startTime);
    if (queryStartMs === null) {
      deps.logger.warn(
        buildQueryLogContext(query),
        'calendar_enrichment_invalid_start_time',
      );
      deps.logger.debug(
        buildLogFields(deps, startedAtMs, 'none', false, []),
        'calendar_enrichment_result',
      );
      return EMPTY_ENRICHMENT_RESULT;
    }

    const meetings = (await deps.listCachedMeetings()) ?? [];
    const normalizeUrl = createSafeUrlNormalizer(deps);
    const timeWindowMs = timeWindowMinutes * 60_000;
    const queryDurationMs = Math.max(0, query.durationMs);
    const queryEndMs = queryStartMs + queryDurationMs;
    const allCandidates = buildCandidates(
      meetings,
      queryStartMs,
      queryEndMs,
      timeWindowMs,
      query.participants,
      sanitizeNameForMatch,
    );

    if (query.meetingUrl) {
      const normalizedQueryUrl = normalizeUrl(query.meetingUrl, 'query');
      const urlCandidates = allCandidates.filter((candidate) => {
        if (!candidate.event.meetingUrl) {
          return false;
        }
        return normalizeUrl(candidate.event.meetingUrl, 'event') === normalizedQueryUrl;
      });

      if (urlCandidates.length === 1) {
        deps.logger.debug(
          buildLogFields(deps, startedAtMs, 'url', false, urlCandidates),
          'calendar_enrichment_result',
        );
        return toEnrichmentResult(urlCandidates[0], query);
      }

      if (urlCandidates.length > 1) {
        const resolution = selectWithParticipantAndTiebreaker(
          urlCandidates,
          query.participants,
          minParticipantOverlap,
          sanitizeNameForMatch,
          'url',
        );
        const selected = resolution.selected;
        if (!resolution.ambiguous) {
          deps.logger.debug(
            buildLogFields(
              deps,
              startedAtMs,
              resolution.matched,
              false,
              resolution.consideredCandidates,
            ),
            'calendar_enrichment_result',
          );
          return toEnrichmentResult(selected, query);
        }

        const warningFields = buildLogFields(
          deps,
          startedAtMs,
          resolution.matched,
          true,
          resolution.consideredCandidates,
          'tiebreaker',
        );
        deps.logger.warn(
          {
            ...warningFields,
            chosenCalendarEventId: selected.event.calendarEventId,
          },
          'calendar_matcher_ambiguous',
        );
        deps.logger.debug(warningFields, 'calendar_enrichment_result');
        return toEnrichmentResult(selected, query);
      }
    }

    const timeWindowCandidates = allCandidates.filter((candidate) => candidate.overlapsTimeWindow);

    if (timeWindowCandidates.length === 0) {
      deps.logger.debug(
        buildLogFields(deps, startedAtMs, 'none', false, []),
        'calendar_enrichment_result',
      );
      return EMPTY_ENRICHMENT_RESULT;
    }

    if (timeWindowCandidates.length === 1) {
      deps.logger.debug(
        buildLogFields(deps, startedAtMs, 'time-window', false, timeWindowCandidates),
        'calendar_enrichment_result',
      );
      return toEnrichmentResult(timeWindowCandidates[0], query);
    }

    const resolution = selectWithParticipantAndTiebreaker(
      timeWindowCandidates,
      query.participants,
      minParticipantOverlap,
      sanitizeNameForMatch,
      'time-window',
    );

    if (resolution.ambiguous) {
      const warningFields = buildLogFields(
        deps,
        startedAtMs,
        resolution.matched,
        true,
        resolution.consideredCandidates,
        'tiebreaker',
      );
      deps.logger.warn(
        {
          ...warningFields,
          chosenCalendarEventId: resolution.selected.event.calendarEventId,
        },
        'calendar_matcher_ambiguous',
      );
      deps.logger.debug(warningFields, 'calendar_enrichment_result');
    } else {
      deps.logger.debug(
        buildLogFields(
          deps,
          startedAtMs,
          resolution.matched,
          false,
          resolution.consideredCandidates,
        ),
        'calendar_enrichment_result',
      );
    }

    return toEnrichmentResult(resolution.selected, query);
  } catch (error) {
    deps.logger.warn(
      {
        err: error,
        ...buildQueryLogContext(query),
      },
      'calendar_enrichment_failed',
    );
    deps.logger.debug(
      buildLogFields(deps, startedAtMs, 'none', false, []),
      'calendar_enrichment_result',
    );
    return EMPTY_ENRICHMENT_RESULT;
  }
}
