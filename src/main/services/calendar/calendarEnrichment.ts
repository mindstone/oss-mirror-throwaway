// A15 verified: getCachedMeetings is imported from @main/services/meetingCacheStore.
// A15 verified: URL normalization helper path is @main/services/meetingBot/urlUtils (extractMeetingId via urlsMatchSameMeeting).
import { createScopedLogger } from '@core/logger';
import { enrichWithCalendar } from '@core/meetingSource/calendar/enrichWithCalendar';
import type { EnrichmentQuery, EnrichmentResult } from '@core/meetingSource';
import { getCachedMeetings } from '@main/services/meetingCacheStore';
import { extractMeetingId } from '@main/services/meetingBot/urlUtils';

const log = createScopedLogger({ service: 'calendar-enrichment' });

function normalizeMeetingUrl(url: string): string {
  const meetingId = extractMeetingId(url);
  return meetingId ?? url;
}

export async function enrichMeetingFromCalendarCache(
  query: EnrichmentQuery,
): Promise<EnrichmentResult> {
  return enrichWithCalendar(query, {
    listCachedMeetings: async () => getCachedMeetings()?.meetings ?? [],
    normalizeUrl: normalizeMeetingUrl,
    logger: log,
    clock: () => new Date(),
  });
}
