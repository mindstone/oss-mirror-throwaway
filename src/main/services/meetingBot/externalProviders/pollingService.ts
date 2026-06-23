/**
 * External Provider Polling Service
 *
 * Polls external transcript providers (Fireflies, Fathom) and imports new transcripts.
 * Runs separately from the main meeting bot service to keep concerns separated.
 */

import { createScopedLogger } from '@core/logger';
import { getSettings } from '@core/services/settingsStore';
import type { ExternalProvider, ProviderAdapter, ExternalTranscript } from './types';
import { createFathomAdapter } from './fathomAdapter';
import { createFirefliesAdapter } from './firefliesAdapter';
import {
  isAlreadyImported,
  markAsImported,
  getLastSyncTime,
  setLastSyncTime,
  cleanupOldRecords,
} from './importTrackingStore';
import { saveExternalTranscript, type ExternalTranscriptData } from '../transcriptStorage';
import { createBatteryThrottledInterval } from '../../visibilityAwareScheduler';
import { fireAndForget } from '@shared/utils/fireAndForget';

const log = createScopedLogger({ service: 'external-provider-polling' });

/** Polling interval for external providers (30 minutes) */
const POLL_INTERVAL_MS = 30 * 60 * 1000;

/** Battery polling interval for external providers (60 minutes) */
const BATTERY_POLL_INTERVAL_MS = 60 * 60 * 1000;

/** Initial delay before first poll (1 minute) */
const INITIAL_POLL_DELAY_MS = 60 * 1000;

/** Default lookback period for first sync (7 days) */
const DEFAULT_LOOKBACK_DAYS = 7;

/** In-progress flag to prevent concurrent syncs */
let syncInProgress = false;

/** Track whether we've logged the "no provider" info message this session */
let hasLoggedNoProvider = false;

/** Cleanup function for the battery-throttled polling interval */
let cleanupPollingInterval: (() => void) | null = null;

/**
 * Get the currently configured provider and its adapter.
 * Returns null if no external provider is configured.
 */
function getConfiguredProvider(): { provider: ExternalProvider; adapter: ProviderAdapter } | null {
  const settings = getSettings();
  const meetingBot = settings.meetingBot ?? {};

  // Check for Fireflies
  if (meetingBot.firefliesApiKey) {
    return {
      provider: 'fireflies',
      adapter: createFirefliesAdapter(meetingBot.firefliesApiKey),
    };
  }

  // Check for Fathom
  if (meetingBot.fathomApiKey) {
    return {
      provider: 'fathom',
      adapter: createFathomAdapter(meetingBot.fathomApiKey),
    };
  }

  return null;
}

/**
 * Convert ExternalTranscript to ExternalTranscriptData for storage.
 */
function convertToStorageData(transcript: ExternalTranscript): ExternalTranscriptData {
  return {
    externalId: transcript.externalId,
    provider: transcript.provider,
    meetingTitle: transcript.title,
    meetingUrl: transcript.meetingUrl,
    participants: transcript.participants,
    duration: transcript.duration,
    startTime: transcript.startTime,
    rawTranscript: transcript.transcript,
    summary: transcript.summary,
    actionItems: transcript.actionItems,
    calendarId: transcript.calendarId,
  };
}

/**
 * Sync transcripts from a specific provider.
 */
async function syncProvider(
  provider: ExternalProvider,
  adapter: ProviderAdapter
): Promise<{ imported: number; skipped: number; errors: number }> {
  const result = { imported: 0, skipped: 0, errors: 0 };

  // Determine sync start time
  let since = getLastSyncTime(provider);
  if (!since) {
    // First sync - look back DEFAULT_LOOKBACK_DAYS
    since = new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    log.info({ provider, since: since.toISOString() }, 'First sync, looking back');
  }

  // Fetch transcripts with pagination
  let cursor: string | undefined;
  let hasMore = true;
  let fetchFailed = false;

  while (hasMore) {
    log.debug({ provider, cursor }, 'Fetching transcripts page');

    const fetchResult = await adapter.fetchTranscripts(since, cursor);

    if (!fetchResult.success) {
      log.error({ provider, error: fetchResult.error }, 'Failed to fetch transcripts');
      result.errors++;
      fetchFailed = true;
      break;
    }

    // Process each transcript
    for (const transcript of fetchResult.transcripts) {
      // Skip if already imported
      if (isAlreadyImported(provider, transcript.externalId)) {
        result.skipped++;
        continue;
      }

      // Save transcript
      const storageData = convertToStorageData(transcript);
      const saveResult = await saveExternalTranscript(storageData);

      if (saveResult.success) {
        // saveExternalTranscript() now owns emit/defer behaviour via the meeting-source kernel.
        if (saveResult.filePath && !saveResult.staged) {
          // Mark as imported only for non-staged transcripts (staged transcripts
          // will be re-fetched on next poll if staging resets or app restarts)
          markAsImported({
            externalId: transcript.externalId,
            provider,
            importedAt: new Date().toISOString(),
            savedPath: saveResult.filePath,
            title: transcript.title,
          });
        } else if (saveResult.staged) {
          // Don't mark as imported — will be re-fetched on next poll if staging resets.
          log.info({ provider, externalId: transcript.externalId }, 'Transcript staged for review, event deferred until approval');
        }

        if (saveResult.alreadyExists) {
          result.skipped++;
          log.debug({ provider, externalId: transcript.externalId }, 'Transcript already exists in space');
        } else {
          result.imported++;
          log.info({ provider, externalId: transcript.externalId, path: saveResult.filePath }, 'Imported transcript');
        }
      } else {
        result.errors++;
        log.warn({ provider, externalId: transcript.externalId, error: saveResult.error }, 'Failed to save transcript');
      }
    }

    // Check for more pages
    if (fetchResult.nextCursor) {
      cursor = fetchResult.nextCursor;
    } else {
      hasMore = false;
    }
  }

  // Only advance last sync time if fetch succeeded (avoid skipping transcripts on API failure)
  if (!fetchFailed) {
    setLastSyncTime(provider, new Date());
  } else {
    log.warn({ provider }, 'Not advancing last sync time due to fetch failure');
  }

  return result;
}

/**
 * Run a sync for configured external providers.
 */
export async function syncExternalProviders(): Promise<{
  success: boolean;
  provider?: ExternalProvider;
  imported: number;
  skipped: number;
  errors: number;
  error?: string;
}> {
  if (syncInProgress) {
    log.debug('Sync already in progress, skipping');
    return { success: false, imported: 0, skipped: 0, errors: 0, error: 'Sync already in progress' };
  }

  const configured = getConfiguredProvider();
  if (!configured) {
    if (!hasLoggedNoProvider) {
      log.info('No external provider configured — configure a Fireflies or Fathom API key in Settings > Meetings to enable transcript imports');
      hasLoggedNoProvider = true;
    } else {
      log.debug('No external provider configured');
    }
    return { success: true, imported: 0, skipped: 0, errors: 0 };
  }

  syncInProgress = true;
  log.info({ provider: configured.provider }, 'Starting external provider sync');

  try {
    const result = await syncProvider(configured.provider, configured.adapter);

    log.info(
      { provider: configured.provider, ...result },
      'External provider sync complete'
    );

    return {
      success: true,
      provider: configured.provider,
      ...result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error, provider: configured.provider }, 'External provider sync failed');
    return {
      success: false,
      provider: configured.provider,
      imported: 0,
      skipped: 0,
      errors: 1,
      error: message,
    };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Test connection to a specific provider.
 */
export async function testProviderConnection(
  provider: ExternalProvider,
  apiKey: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  const adapter = provider === 'fireflies'
    ? createFirefliesAdapter(apiKey)
    : createFathomAdapter(apiKey);

  const result = await adapter.testConnection();
  return {
    success: result.success,
    message: result.message,
    error: result.error,
  };
}

/**
 * Start polling for external provider transcripts.
 */
export function startExternalProviderPolling(): void {
  if (cleanupPollingInterval) {
    log.debug('External provider polling already running');
    return;
  }

  hasLoggedNoProvider = false; // Reset so fresh startups re-log the info message

  log.info(
    { normalIntervalMs: POLL_INTERVAL_MS, batteryIntervalMs: BATTERY_POLL_INTERVAL_MS },
    'Starting external provider polling'
  );

  // Clean up old records
  cleanupOldRecords();

  // Initial sync after delay (intentional load shaping - don't run immediately at startup)
  setTimeout(() => {
    fireAndForget(syncExternalProviders(), 'meetingBot.externalProviders.pollingService.line285');
  }, INITIAL_POLL_DELAY_MS);

  // Regular polling with battery awareness
  cleanupPollingInterval = createBatteryThrottledInterval(
    () => void syncExternalProviders(),
    POLL_INTERVAL_MS,
    BATTERY_POLL_INTERVAL_MS
  );
}

/**
 * Stop polling for external provider transcripts.
 */
export function stopExternalProviderPolling(): void {
  if (cleanupPollingInterval) {
    cleanupPollingInterval();
    cleanupPollingInterval = null;
    log.info('Stopped external provider polling');
  }
}

/**
 * Check if external provider polling is active.
 */
export function isExternalProviderPollingActive(): boolean {
  return cleanupPollingInterval !== null;
}

/**
 * Trigger a manual sync (for "Sync Now" button).
 */
export async function triggerManualSync(): Promise<{
  success: boolean;
  provider?: ExternalProvider;
  imported: number;
  message?: string;
  error?: string;
}> {
  const result = await syncExternalProviders();

  if (!result.success) {
    return {
      success: false,
      error: result.error,
      imported: 0,
    };
  }

  if (!result.provider) {
    return {
      success: true,
      imported: 0,
      message: 'No external provider configured',
    };
  }

  return {
    success: true,
    provider: result.provider,
    imported: result.imported,
    message: result.imported > 0
      ? `Imported ${result.imported} transcript${result.imported === 1 ? '' : 's'}`
      : 'No new transcripts found',
  };
}
