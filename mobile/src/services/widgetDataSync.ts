// mobile/src/services/widgetDataSync.ts
//
// Syncs inbox action items to the iOS widget via App Groups shared UserDefaults.
// This is a Zustand store subscriber — NOT a React hook — so it runs at app boot
// independently of component lifecycle.

import { Platform } from 'react-native';
import {
  useInboxStore,
  classifyInboxTier,
  groupByTemporal,
  sortInboxItems,
  createLogger,
} from '@rebel/cloud-client';
import type { InboxItem } from '@rebel/cloud-client';

const log = createLogger('widgetDataSync');

/** Maximum action items the widget can display */
const MAX_WIDGET_ITEMS = 3;

/** App Group identifier shared between the main app and the widget extension */
const APP_GROUP_SUITE = 'group.com.mindstone.rebel.mobile';

/** Shape of action items written to shared UserDefaults (matches widget.swift ActionItem) */
interface WidgetActionItem {
  id: string;
  title: string;
  urgent: boolean;
}

function isWidgetActionItem(value: unknown): value is WidgetActionItem {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.title === 'string' &&
    typeof candidate.urgent === 'boolean'
  );
}

/**
 * Derive the top action items for the widget from the inbox store.
 * Uses the same filtering as `useTodayCards`: non-archived, 'act' tier, 'due-today' temporal group.
 * Exported for reuse by widgetBackgroundRefresh.ts.
 */
export function deriveWidgetActionItems(items: InboxItem[]): WidgetActionItem[] {
  const activeAct = items.filter(
    (item) => !item.archived && classifyInboxTier(item) === 'act',
  );
  const grouped = groupByTemporal(activeAct);
  const dueToday = grouped.get('due-today') ?? [];
  const sorted = sortInboxItems(dueToday);

  return sorted.slice(0, MAX_WIDGET_ITEMS).map((item) => ({
    id: item.id,
    title: item.title,
    urgent: item.urgent ?? false,
  }));
}

/**
 * Get the ExtensionStorage instance. Returns null on non-iOS platforms.
 */
function getExtensionStorage(): InstanceType<typeof import('@bacons/apple-targets').ExtensionStorage> | null {
  try {
    const { ExtensionStorage } = require('@bacons/apple-targets') as typeof import('@bacons/apple-targets');
    return new ExtensionStorage(APP_GROUP_SUITE);
  } catch {
    return null;
  }
}

/**
 * Reload the action widget timeline.
 */
function reloadActionWidget(): void {
  try {
    const { ExtensionStorage } = require('@bacons/apple-targets') as typeof import('@bacons/apple-targets');
    ExtensionStorage.reloadWidget('RebelActionWidget');
  } catch {
    // Non-critical
  }
}

/**
 * Write action items to App Groups shared UserDefaults and reload the widget timeline.
 * Uses ExtensionStorage from @bacons/apple-targets which wraps:
 * - UserDefaults(suiteName:) for data sharing
 * - WidgetCenter.shared.reloadTimelines(ofKind:) for timeline refresh
 * Exported for reuse by widgetBackgroundRefresh.ts.
 */
export function writeToAppGroupDefaults(items: WidgetActionItem[]): void {
  try {
    const storage = getExtensionStorage();
    if (!storage) return;

    storage.set('actionItems', items as unknown as Record<string, string | number>[]);
    storage.set('lastUpdated', String(Date.now()));
    reloadActionWidget();
  } catch (err) {
    log.warn('Failed to write widget data', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Update the widget's recording state. Called by useMeetingRecording on start/stop.
 * When isRecording=true, the widget shows a full takeover recording UI with a stop button.
 * When isRecording=false, it returns to the normal action items + buttons layout.
 */
export function setWidgetRecordingState(isRecording: boolean, meetingTitle?: string): void {
  if (Platform.OS !== 'ios') return;

  try {
    const storage = getExtensionStorage();
    if (!storage) return;

    if (isRecording) {
      storage.set('recordingStartedAt', String(Date.now()));
      storage.set('recordingTitle', meetingTitle ?? '');
      storage.set('isRecording', 'true');
    } else {
      storage.set('isRecording', 'false');
      storage.set('recordingStartedAt', '');
      storage.set('recordingTitle', '');
    }

    reloadActionWidget();
    log.debug('Widget recording state updated', { isRecording, meetingTitle });
  } catch (err) {
    log.warn('Failed to update widget recording state', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Reads current widget `isRecording` flag from App Group defaults.
 * Returns `null` if storage unavailable (non-iOS or module error).
 */
export function getWidgetRecordingState(): boolean | null {
  if (Platform.OS !== 'ios') return null;

  try {
    const storage = getExtensionStorage();
    if (!storage) return null;
    return storage.get('isRecording') === 'true';
  } catch {
    return null;
  }
}

/**
 * Reads current widget action items count from App Group defaults.
 * Returns `null` if storage unavailable or read/parse fails —
 * callers must treat null as "unknown, preserve" (do NOT use `?? 0`).
 */
export function getCurrentWidgetActionItemsCount(): number | null {
  if (Platform.OS !== 'ios') return null;

  try {
    const storage = getExtensionStorage();
    if (!storage) return null;

    const raw = storage.get('actionItems');
    if (typeof raw !== 'string') return null;

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every(isWidgetActionItem)) return null;

    return parsed.length;
  } catch {
    return null;
  }
}

/**
 * Clear all widget data from App Groups UserDefaults and reload widgets.
 * Call on unpair/401 to prevent stale account data from being displayed.
 */
export function clearWidgetData(): void {
  if (Platform.OS !== 'ios') return;

  try {
    const storage = getExtensionStorage();
    if (!storage) return;

    storage.set('actionItems', [] as unknown as Record<string, string | number>[]);
    storage.set('lastUpdated', '');
    storage.set('isRecording', 'false');
    storage.set('recordingStartedAt', '');
    storage.set('recordingTitle', '');
    reloadActionWidget();
    log.info('Widget data cleared');
  } catch (err) {
    log.warn('Failed to clear widget data', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Initialise widget data sync. Call once at app startup.
 *
 * Subscribes to inbox store changes and writes action items to shared UserDefaults
 * whenever the inbox changes. Returns an unsubscribe function for cleanup.
 *
 * Only activates on iOS — Android has no widget extension to sync with.
 */
export function initWidgetDataSync(): (() => void) | undefined {
  if (Platform.OS !== 'ios') {
    return undefined;
  }

  // Seed last-written state from current snapshot so the first subscriber
  // callback only writes when the derived widget items actually change.
  let lastWrittenJson = JSON.stringify(deriveWidgetActionItems(useInboxStore.getState().items));

  // Subscribe to future inbox changes — only write when derived items actually change
  const unsubscribe = useInboxStore.subscribe((state) => {
    const widgetItems = deriveWidgetActionItems(state.items);
    const json = JSON.stringify(widgetItems);
    if (json === lastWrittenJson) return; // No meaningful change
    lastWrittenJson = json;
    writeToAppGroupDefaults(widgetItems);
  });

  log.info('Widget data sync initialised');
  return unsubscribe;
}
