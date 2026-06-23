/**
 * Calendar Sync Service
 *
 * Runs a headless agent turn that queries connected calendar MCPs and
 * populates today's meeting cache via the rebel_meetings_sync MCP tool (RebelMeetings).
 */

import type { AgentEvent, AppSettings } from '@shared/types';
import { createScopedLogger } from '@core/logger';
import type { HeadlessTurnOptions } from '@core/types/headlessTurnOptions';
import { resolveActiveWorkingSingleModelAuxiliaryTurnOverrides } from '@shared/utils/auxiliaryTurnConfig';
import { recordSyncError } from './meetingCacheStore';
import { markCalendarSyncAttempted } from './calendarSyncAttempt';
import { getPrompt, PROMPT_IDS } from '@core/services/promptFileService';

const log = createScopedLogger({ service: 'calendarSyncService' });

export type CalendarSyncResult = {
  success: boolean;
  meetingCount?: number;
  error?: string;
};

export type CalendarSyncDeps = {
  runHeadlessTurn: (params: {
    prompt: string;
    onEvent: (event: AgentEvent) => void;
    options: HeadlessTurnOptions;
  }) => Promise<void>;
  getSettings: () => AppSettings;
};

let deps: CalendarSyncDeps | null = null;

export const initializeCalendarSyncService = (dependencies: CalendarSyncDeps): void => {
  deps = dependencies;
  log.info('Calendar sync service initialized');
};

const MAX_SYNC_ATTEMPTS = 2;
const RETRY_DELAY_MS = 2000;

// Error patterns that indicate validation failures worth retrying
// (LLM may self-correct on retry after seeing the error message)
const RETRYABLE_ERROR_PATTERNS = [
  'validation',
  'must be string',
  'argument validation failed',
  'expected string',
  'received null',
  'invalid input',
  'required',
];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Check if an error message indicates a validation failure that's worth retrying.
 */
const isRetryableError = (error: string | undefined): boolean => {
  if (!error) return false;
  const lowerError = error.toLowerCase();
  return RETRYABLE_ERROR_PATTERNS.some(pattern => lowerError.includes(pattern));
};

/**
 * Run a single sync attempt.
 */
const runSyncAttempt = async (attempt: number): Promise<CalendarSyncResult> => {
  // Stage 3 fresh-profile gate (B1): the LLM-bridge path also counts as a
  // sync attempt (useOtherCalendarProvider users have no direct sync).
  markCalendarSyncAttempted();
  if (!deps) {
    return { success: false, error: 'Service not initialized' };
  }

  log.info({ attempt }, 'Running calendar sync attempt');

  let lastError: string | undefined;
  const auxiliaryOverrides = resolveActiveWorkingSingleModelAuxiliaryTurnOverrides(deps.getSettings());

  await deps.runHeadlessTurn({
    prompt: getPrompt(PROMPT_IDS.INTELLIGENCE_CALENDAR_SYNC),
    onEvent: (event) => {
      if (event.type === 'error') {
        lastError = event.error || 'Unknown error';
      }
    },
    options: {
      sessionType: 'automation',
      persistMode: { kind: 'none' },
      sessionId: 'automation-calendar-sync',
      resetConversation: true,
      modelOverride: auxiliaryOverrides.modelOverride,
      thinkingModelOverride: auxiliaryOverrides.thinkingModelOverride,
      workingProfileOverrideId: auxiliaryOverrides.workingProfileOverrideId,
    },
  });

  if (lastError) {
    return { success: false, error: lastError };
  }

  return { success: true };
};

export const syncCalendarCache = async (): Promise<CalendarSyncResult> => {
  if (!deps) {
    log.warn('Calendar sync service not initialized');
    return { success: false, error: 'Service not initialized' };
  }

  const settings = deps.getSettings();
  if (!settings.coreDirectory) {
    log.warn('No core directory configured, skipping calendar sync');
    return { success: false, error: 'No workspace configured' };
  }

  log.info('Starting calendar sync via headless agent turn');

  let lastResult: CalendarSyncResult = { success: false, error: 'No attempts made' };

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
    try {
      lastResult = await runSyncAttempt(attempt);

      if (lastResult.success) {
        log.info({ attempt }, 'Calendar sync completed successfully');
        return lastResult;
      }

      // Check if error is retryable (validation errors are worth retrying)
      if (!isRetryableError(lastResult.error)) {
        log.warn({ error: lastResult.error, attempt }, 'Calendar sync failed with non-retryable error');
        break;
      }

      if (attempt < MAX_SYNC_ATTEMPTS) {
        log.info({ error: lastResult.error, attempt, nextAttemptIn: RETRY_DELAY_MS }, 'Calendar sync failed, will retry');
        await delay(RETRY_DELAY_MS);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      lastResult = { success: false, error: message };
      log.error({ err: error, attempt }, 'Calendar sync attempt threw exception');

      if (attempt < MAX_SYNC_ATTEMPTS) {
        await delay(RETRY_DELAY_MS);
      }
    }
  }

  // All retries exhausted
  log.warn({ error: lastResult.error }, 'Calendar sync failed after all retries');
  recordSyncError(lastResult.error || 'Unknown error');
  return lastResult;
};

/**
 * Manually trigger a calendar sync.
 * Used by the calendar:trigger-sync IPC handler.
 */
export const triggerCalendarSync = syncCalendarCache;
