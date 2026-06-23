/**
 * Calendar Domain IPC Handlers
 *
 * Handles the 24h meeting cache, calendar sync, and meeting history operations.
 */

import type { HandlerInvokeEvent } from '@core/handlerRegistry';
import { logger } from '@core/logger';
import { updateSettings } from '@core/services/settingsStore';
import { registerHandler } from './utils/registerHandler';
import {
  getCachedMeetings,
  getTodaysMeetings,
  getMeetingCacheState,
  updateMeetingPrepPath,
  SKIPPED_PREP_SENTINEL,
} from '../services/meetingCacheStore';
import {
  findMeetingByCalendarEvent,
  getMissedMeetings,
} from '../services/meetingHistoryStore';
import { triggerDirectCalendarSync } from '../services/calendarSyncScheduler';
import {
  discoverAllCalendarAccounts,
  listGoogleCalendars,
  listMicrosoftCalendars,
} from '../services/directCalendarSync';
import { isDemoModeActive } from '../services/demoModeService';
import type { AppSettings } from '@shared/types';
import type { MeetingTranscriptStatus } from '@shared/ipc/channels/calendar';

export interface CalendarHandlerDeps {
  getSettings: () => AppSettings;
  triggerCalendarSync?: () => Promise<void>; // LLM-based sync for other calendars
}

export function registerCalendarHandlers(deps: CalendarHandlerDeps): void {
  const { getSettings, triggerCalendarSync } = deps;

  registerHandler(
    'calendar:get-cached-meetings',
    async (_event: HandlerInvokeEvent, req: { todayOnly?: boolean }) => {
      try {
        const settings = getSettings();
        if (!settings.coreDirectory) {
          return {
            success: false,
            meetings: [],
            populatedAt: null,
            isStale: true,
          };
        }

        const cacheState = getMeetingCacheState();
        if (isDemoModeActive()) {
          return {
            success: true,
            meetings: [],
            populatedAt: cacheState.populatedAt,
            lastSyncError: cacheState.lastSyncError,
            syncWarnings: cacheState.syncWarnings,
            isStale: false,
          };
        }

        const cache = getCachedMeetings();
        const userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const meetings = req.todayOnly ? getTodaysMeetings(userTimeZone) : (cache?.meetings ?? []);

        return {
          success: true,
          meetings,
          populatedAt: cacheState.populatedAt,
          lastSyncError: cacheState.lastSyncError,
          syncWarnings: cacheState.syncWarnings,
          isStale: cacheState.isStale,
        };
      } catch (error) {
        logger.error({ err: error }, 'Failed to get cached meetings');
        return {
          success: false,
          meetings: [],
          populatedAt: null,
          isStale: true,
        };
      }
    }
  );

  registerHandler(
    'calendar:list-available-calendars',
    async (_event: HandlerInvokeEvent, req: { calendarSource: string }) => {
      try {
        const [provider, rawEmail, ...extraParts] = req.calendarSource.split(':');
        const email = rawEmail?.trim();
        if (extraParts.length > 0 || !email || (provider !== 'google' && provider !== 'microsoft')) {
          return {
            success: false,
            calendars: [],
            error: 'Invalid calendar source',
          };
        }

        if (provider === 'google') {
          const normalizedEmail = email.toLowerCase();
          const allAccounts = await discoverAllCalendarAccounts();
          const matchedAccount = allAccounts.find((account) => {
            return account.provider === 'google'
              && account.email.toLowerCase() === normalizedEmail
              && typeof account.accountSlug === 'string'
              && account.accountSlug.length > 0;
          });

          if (matchedAccount?.accountSlug) {
            const result = await listGoogleCalendars(matchedAccount.accountSlug);
            if (!result.ok) {
              const errorMessage = result.reason === 'reauth_required'
                ? `Google account ${email} needs to reconnect`
                : result.reason === 'transient'
                  ? `Google calendars are temporarily unavailable for ${email}`
                  : `No Google auth found for ${email}`;

              return {
                success: false,
                calendars: [],
                error: errorMessage,
              };
            }

            return {
              success: true,
              calendars: result.calendars,
            };
          }

          return {
            success: false,
            calendars: [],
            error: `No Google account found for ${email}`,
          };
        }

        const calendars = await listMicrosoftCalendars(email);
        return {
          success: true,
          calendars,
        };
      } catch (error) {
        logger.error({ err: error, calendarSource: req.calendarSource }, 'Failed to list available calendars');
        return {
          success: false,
          calendars: [],
          error: error instanceof Error ? error.message : 'Failed to list calendars',
        };
      }
    }
  );

  registerHandler(
    'calendar:trigger-sync',
    async (_event: HandlerInvokeEvent) => {
      try {
        if (isDemoModeActive()) {
          return { success: true, message: 'Calendar sync skipped in demo mode' };
        }

        const settings = getSettings();

        if (settings.calendar?.useOtherCalendarProvider) {
          // User has other calendars - use LLM-based sync
          if (!triggerCalendarSync) {
            return { success: false, message: 'Calendar sync not configured' };
          }
          void triggerCalendarSync().catch((err) => {
            logger.error({ err }, 'LLM calendar sync failed');
          });
          return { success: true, message: 'LLM sync started' };
        }

        // Default: use free direct MCP sync
        void triggerDirectCalendarSync().catch((err) => {
          logger.error({ err }, 'Direct calendar sync failed');
        });

        return { success: true, message: 'Sync started' };
      } catch (error) {
        logger.error({ err: error }, 'Failed to trigger calendar sync');
        return { success: false, message: 'Failed to trigger sync' };
      }
    }
  );

  registerHandler(
    'calendar:get-meeting-history-status',
    async (_event: HandlerInvokeEvent, req: { meetings: Array<{ calendarSource: string; calendarEventId: string }> }) => {
      try {
        const statuses = {} as Record<string, MeetingTranscriptStatus>;

        for (const { calendarSource, calendarEventId } of req.meetings) {
          const entry = findMeetingByCalendarEvent(calendarSource, calendarEventId);
          if (entry) {
            statuses[calendarEventId] = entry.transcriptStatus as MeetingTranscriptStatus;
          }
        }

        return { statuses } as { statuses: Record<string, MeetingTranscriptStatus> };
      } catch (error) {
        logger.error({ err: error }, 'Failed to get meeting history status');
        return { statuses: {} } as { statuses: Record<string, MeetingTranscriptStatus> };
      }
    }
  );

  registerHandler(
    'calendar:get-missed-meetings',
    async (_event: HandlerInvokeEvent, req: { days?: number }) => {
      try {
        const days = req.days ?? 7;
        const since = new Date();
        since.setDate(since.getDate() - days);

        const missed = getMissedMeetings(since);

        return {
          meetings: missed.map((m) => ({
            id: m.id,
            calendarEventId: m.calendarEventId,
            title: m.title,
            startTime: m.startTime,
            endTime: m.endTime,
            transcriptStatus: m.transcriptStatus,
            transcriptPath: m.transcriptPath,
            botScheduled: m.botScheduled,
          })),
          count: missed.length,
        };
      } catch (error) {
        logger.error({ err: error }, 'Failed to get missed meetings');
        return { meetings: [], count: 0 };
      }
    }
  );

  registerHandler(
    'calendar:skip-meeting-prep',
    async (_event: HandlerInvokeEvent, req: { meetingId: string }) => {
      try {
        updateMeetingPrepPath(req.meetingId, SKIPPED_PREP_SENTINEL);

        // Persist to settings so skip survives calendar re-syncs
        const settings = getSettings();
        const existing = settings.calendar?.skippedMeetingIds ?? [];
        if (!existing.includes(req.meetingId)) {
          updateSettings({
            calendar: {
              ...settings.calendar,
              skippedMeetingIds: [...existing, req.meetingId],
            },
          });
        }

        return { success: true };
      } catch (error) {
        logger.error({ err: error, meetingId: req.meetingId }, 'Failed to skip meeting prep');
        return { success: false };
      }
    }
  );

  registerHandler(
    'calendar:unskip-meeting-prep',
    async (_event: HandlerInvokeEvent, req: { meetingId: string }) => {
      try {
        // Clear sentinel from cache
        updateMeetingPrepPath(req.meetingId, '');

        // Remove from persisted skip list
        const settings = getSettings();
        const existing = settings.calendar?.skippedMeetingIds ?? [];
        if (existing.includes(req.meetingId)) {
          updateSettings({
            calendar: {
              ...settings.calendar,
              skippedMeetingIds: existing.filter(id => id !== req.meetingId),
            },
          });
        }

        return { success: true };
      } catch (error) {
        logger.error({ err: error, meetingId: req.meetingId }, 'Failed to unskip meeting prep');
        return { success: false };
      }
    }
  );
}
