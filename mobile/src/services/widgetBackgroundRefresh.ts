// mobile/src/services/widgetBackgroundRefresh.ts
//
// iOS background refresh for the widget. Periodically wakes the app via
// BGAppRefreshTask, fetches fresh inbox data from the cloud, derives action
// items, and writes them to App Groups UserDefaults so the widget stays
// reasonably current without the user opening the app.
//
// Key design decisions (see docs/plans/260414_widget_background_refresh.md):
//  - Does NOT use fetchInbox() — it swallows errors (returns void), can't
//    report BackgroundFetchResult, and its 15s timeout + 2 retries exceeds
//    iOS's 30s background budget.
//  - Uses direct fetch with 10s timeout, single attempt, no retry.
//  - Only writes to UserDefaults on success — never overwrites good data with
//    empty/failed results.
//  - TaskManager.defineTask() is at module top level (expo-task-manager
//    requirement — must execute before any component renders).

import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import { Platform } from 'react-native';
import { useAuthStore, createLogger } from '@rebel/cloud-client';
import type { InboxState } from '@rebel/cloud-client';
import {
  deriveWidgetActionItems,
  getCurrentWidgetActionItemsCount,
  writeToAppGroupDefaults,
} from './widgetDataSync';

const log = createLogger('widgetBackgroundRefresh');

/** Task name registered with expo-task-manager. */
export const WIDGET_REFRESH_TASK = 'widget-inbox-refresh';

/** Timeout for the background fetch request. Well within iOS's ~30s budget. */
const BACKGROUND_FETCH_TIMEOUT_MS = 10_000;

/** Minimum interval between background fetches (seconds). iOS may increase this. */
const MINIMUM_INTERVAL_S = 15 * 60; // 15 minutes

// ---------------------------------------------------------------------------
// Task definition — MUST be at module top level (expo-task-manager requirement)
// ---------------------------------------------------------------------------

TaskManager.defineTask(WIDGET_REFRESH_TASK, async () => {
  log.info('Background refresh task started');

  try {
    // Step 1: Defensively load credentials — in background wake, JS context
    // may not retain cloud client configuration.
    await useAuthStore.getState().loadCredentials();
    const { isPaired, cloudUrl, token } = useAuthStore.getState();

    if (!isPaired || !cloudUrl || !token) {
      log.info('Not paired — skipping background refresh', { isPaired });
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    log.debug('Credentials loaded, fetching inbox');

    // Step 2: Direct fetch with tight timeout — avoids cloudClient's
    // 15s timeout + 2 retries that would exceed iOS's 30s budget.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BACKGROUND_FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${cloudUrl}/api/ipc/inbox%3Aload`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ params: [] }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      log.warn('Background inbox fetch failed', { status: response.status });
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }

    // Step 3: Parse response and derive widget items
    const inboxState = await response.json();
    if (!inboxState || !Array.isArray((inboxState as Partial<InboxState>).items)) {
      log.warn('Background inbox fetch: unexpected response shape', { shape: typeof inboxState });
      return BackgroundFetch.BackgroundFetchResult.Failed;
    }

    const widgetItems = deriveWidgetActionItems((inboxState as InboxState).items);

    log.debug('Derived widget items from background fetch', { itemCount: widgetItems.length });

    if (widgetItems.length === 0) {
      const currentCount = getCurrentWidgetActionItemsCount();
      if (currentCount === null) {
        log.warn('Background refresh: current widget state unreadable, preserving');
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }
      if (currentCount > 0) {
        log.info(
          'Background refresh: empty result vs non-empty snapshot, preserving snapshot',
          { currentCount },
        );
        return BackgroundFetch.BackgroundFetchResult.NoData;
      }
    }

    // Step 4: Write to App Groups UserDefaults (only on success).
    // Re-check paired state before writing — unpair may have occurred during fetch.
    if (!useAuthStore.getState().isPaired) {
      log.info('Unpaired during background fetch — skipping write');
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }
    writeToAppGroupDefaults(widgetItems);

    log.info('Background refresh completed — NewData', { itemCount: widgetItems.length });
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (err) {
    log.warn(
      'Background refresh task failed',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ---------------------------------------------------------------------------
// Registration / unregistration
// ---------------------------------------------------------------------------

/**
 * Register the widget background refresh task with iOS.
 *
 * Call when the user is paired. Idempotent — safe to call multiple times.
 * No-op on non-iOS platforms.
 */
export async function registerWidgetBackgroundRefresh(): Promise<void> {
  if (Platform.OS !== 'ios') return;

  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (status === BackgroundFetch.BackgroundFetchStatus.Denied) {
      log.warn('Background fetch denied by system — cannot register', { status });
      return;
    }
    if (status === BackgroundFetch.BackgroundFetchStatus.Restricted) {
      log.warn('Background fetch restricted — cannot register', { status });
      return;
    }

    // Idempotence: check if already registered
    const isRegistered = await TaskManager.isTaskRegisteredAsync(WIDGET_REFRESH_TASK);
    if (isRegistered) {
      log.debug('Widget background refresh task already registered');
      return;
    }

    await BackgroundFetch.registerTaskAsync(WIDGET_REFRESH_TASK, {
      minimumInterval: MINIMUM_INTERVAL_S,
      stopOnTerminate: false,
      startOnBoot: false,
    });

    log.info('Widget background refresh registered', { minimumInterval: MINIMUM_INTERVAL_S });
  } catch (err) {
    log.warn(
      'Failed to register widget background refresh',
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}

/**
 * Unregister the widget background refresh task.
 *
 * Call on unpair to stop background refreshes. No-op if not registered or
 * not on iOS.
 */
export async function unregisterWidgetBackgroundRefresh(): Promise<void> {
  if (Platform.OS !== 'ios') return;

  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(WIDGET_REFRESH_TASK);
    if (!isRegistered) {
      log.debug('Widget background refresh task not registered — nothing to unregister');
      return;
    }

    await BackgroundFetch.unregisterTaskAsync(WIDGET_REFRESH_TASK);
    log.info('Widget background refresh unregistered');
  } catch (err) {
    log.warn(
      'Failed to unregister widget background refresh',
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
}
