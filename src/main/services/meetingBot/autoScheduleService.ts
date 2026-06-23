/**
 * Auto-Schedule Service
 *
 * Automatically schedules Rebel bots for upcoming meetings when joinMode is 'auto'.
 * Runs after calendar sync to schedule bots for meetings with video URLs.
 *
 * Key behaviors:
 * - Only runs when settings.meetingBot.joinMode === 'auto'
 * - Meetings >15 min away: scheduled via Recall (requires >10 min advance)
 * - Meetings 0–15 min away or started <10 min ago: instant join (no scheduledFor)
 * - Meetings started >10 min ago: skipped (likely ending soon or user handled it)
 * - Skips meetings without video URLs
 * - Worker handles deduplication - safe to call multiple times for same meeting
 */

import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import { getTodaysMeetings } from '../meetingCacheStore';
import type { MeetingBotService } from './meetingBotTypes';
import { getActiveBotState } from './meetingBotRuntimeRegistry';
import { getPendingTranscripts } from './pendingTranscriptsStore';
import { urlsMatchSameMeeting, isWithinDedupWindow } from './urlUtils';

const log = createScopedLogger({ service: 'auto-schedule' });

/** Recall requires >10 min advance for scheduled bots; we use 15 for safety margin */
const MIN_ADVANCE_MINUTES = 15;

/** Max minutes after start to still instant-join (beyond this, meeting is likely ending) */
const MAX_LATE_JOIN_MINUTES = 10;

export interface AutoScheduleResult {
  scheduled: number;
  skipped: number;
  errors: number;
}

/** Lazy-loaded reference to the meeting bot service getter */
let getMeetingBotServiceFn: (() => MeetingBotService) | null = null;

/**
 * Initialize the auto-schedule service with access to the meeting bot service.
 * Called once from main/index.ts after the meeting bot service is created.
 */
export function initializeAutoScheduleService(getMeetingBotService: () => MeetingBotService): void {
  getMeetingBotServiceFn = getMeetingBotService;
  log.info('Auto-schedule service initialized');
}

/**
 * Auto-schedule Rebel bots for upcoming meetings.
 * Should be called after successful calendar sync.
 */
export async function autoScheduleMeetingBots(): Promise<AutoScheduleResult> {
  const botServiceFn = getMeetingBotServiceFn;
  if (!botServiceFn) {
    log.warn('Auto-schedule service not initialized');
    return { scheduled: 0, skipped: 0, errors: 0 };
  }

  const settings = getSettings();

  // Only run if auto-join is enabled (default is 'prompt', not 'auto')
  if (settings.meetingBot?.joinMode !== 'auto') {
    log.debug('Auto-schedule skipped: joinMode is not "auto"');
    return { scheduled: 0, skipped: 0, errors: 0 };
  }

  // Check if meeting bot feature is enabled
  if (settings.meetingBot?.enabled === false) {
    log.debug('Auto-schedule skipped: meeting bot feature is disabled');
    return { scheduled: 0, skipped: 0, errors: 0 };
  }

  const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const meetings = getTodaysMeetings(userTimeZone);
  const now = Date.now();
  let scheduled = 0;
  let skipped = 0;
  let errors = 0;

  log.info({ meetingCount: meetings.length }, 'Starting auto-schedule for meetings');

  for (const meeting of meetings) {
    // Skip meetings without video URL
    if (!meeting.meetingUrl) {
      log.debug({ meetingId: meeting.id, title: meeting.title }, 'Skipped: no video URL');
      skipped++;
      continue;
    }

    // Calculate time until meeting
    const startTime = new Date(meeting.startTime).getTime();
    const minutesUntil = (startTime - now) / (1000 * 60);

    // Skip meetings that started too long ago (likely ending or user already handled it)
    if (minutesUntil < -MAX_LATE_JOIN_MINUTES) {
      log.debug({ meetingId: meeting.id, title: meeting.title, minutesUntil: Math.round(minutesUntil) }, 'Skipped: meeting started too long ago');
      skipped++;
      continue;
    }

    // Determine dispatch mode:
    // - >15 min away: schedule via Recall (future bot)
    // - 0–15 min away or started <10 min ago: instant join (no scheduledFor)
    const useInstantJoin = minutesUntil < MIN_ADVANCE_MINUTES;

    // Client-side deduplication: check if bot already scheduled for this meeting
    // Uses URL matching + time window to handle recurring meetings with same URL
    const pendingTranscripts = getPendingTranscripts();
    const activeBots = pendingTranscripts.filter(
      t => t.status === 'scheduled' || t.status === 'in_meeting' || t.status === 'processing'
    );
    
    // Log dedup check context
    log.info({
      meetingId: meeting.id,
      meetingUrl: meeting.meetingUrl,
      meetingStart: meeting.startTime,
      pendingCount: pendingTranscripts.length,
      activeCount: activeBots.length,
      activeBots: activeBots.map(t => ({
        botId: t.botId,
        url: t.meetingUrl,
        status: t.status,
        scheduledAt: t.scheduledAt,
        inWindow: isWithinDedupWindow(t.scheduledAt, meeting.startTime),
      })),
    }, 'autoSchedule: checking for existing bot');
    
    const existingBot = activeBots.find(
      t => meeting.meetingUrl && urlsMatchSameMeeting(t.meetingUrl, meeting.meetingUrl) &&
           isWithinDedupWindow(t.scheduledAt, meeting.startTime)
    );
    
    // Also check if there's an active bot for this URL (race condition guard)
    const activeBot = getActiveBotState();
    const activeForSameUrl = activeBot && urlsMatchSameMeeting(activeBot.meetingUrl, meeting.meetingUrl);

    if (existingBot || activeForSameUrl) {
      log.info({
        meetingId: meeting.id,
        title: meeting.title,
        meetingUrl: meeting.meetingUrl,
        existingBotId: existingBot?.botId,
        existingBotUrl: existingBot?.meetingUrl,
        activeBot: activeForSameUrl ? activeBot?.botId : undefined,
      }, 'autoSchedule: skipped - bot already scheduled or active');
      skipped++;
      continue;
    }
    
    log.info({
      meetingId: meeting.id,
      meetingUrl: meeting.meetingUrl,
      useInstantJoin,
      minutesUntil: Math.round(minutesUntil),
    }, `autoSchedule: no existing bot, will ${useInstantJoin ? 'instant-join' : 'schedule'}`);

    try {
      const result = await botServiceFn().sendBot({
        meetingUrl: meeting.meetingUrl,
        meetingTitle: meeting.title,
        // Omit scheduledFor for instant join (imminent or already-started meetings)
        scheduledFor: useInstantJoin ? undefined : meeting.startTime,
        calendarEventId: meeting.calendarEventId,
        calendarSource: meeting.calendarSource,
      });

      if (result.success) {
        scheduled++;
        log.info(
          { meetingId: meeting.id, title: meeting.title, botId: result.botId, instantJoin: useInstantJoin },
          useInstantJoin ? 'Auto-joined meeting bot (instant)' : 'Auto-scheduled meeting bot'
        );
      } else {
        errors++;
        log.warn(
          { meetingId: meeting.id, title: meeting.title, error: result.error },
          'Failed to auto-schedule bot'
        );
      }
    } catch (error) {
      errors++;
      log.warn({ meetingId: meeting.id, title: meeting.title, error }, 'Error auto-scheduling bot');
    }
  }

  log.info({ scheduled, skipped, errors }, 'Auto-schedule complete');
  return { scheduled, skipped, errors };
}
