import {
  buildCacheKeyPrefix,
  clearKeysForPrefix,
  createLogger,
  useApprovalStore,
  useAuthStore,
  useInboxStore,
  useOfflineQueueStore,
  useSessionStore,
  useStagedFilesStore,
} from '@rebel/cloud-client';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { clearMobileDiagnosticEvents } from '../storage/diagnosticEventBufferStorage';
import { useActiveRecordingStore } from '../stores/activeRecordingStore';
import { purgeFileLogs } from '../utils/fileLogSink';
import { deleteMeetingSession, listMeetingManifests } from '../utils/meetingManifest';
import { clearWidgetData } from './widgetDataSync';
import { unregisterWidgetBackgroundRefresh } from './widgetBackgroundRefresh';

const log = createLogger('accountScopedStateTeardown');

export const ACCOUNT_SCOPED_TEARDOWN_SURFACES = [
  'cloud-client/src/auth/createAuthStore.ts',
  'cloud-client/src/offlineQueue/offlineQueueStore.ts',
  'cloud-client/src/offlineQueue/OfflineQueue.ts',
  'cloud-client/src/persistence/persistenceHelpers.ts',
  'cloud-client/src/stores/approvalStore.ts',
  'cloud-client/src/stores/inboxStore.ts',
  'cloud-client/src/stores/sessionStore.ts',
  'cloud-client/src/stores/stagedFilesStore.ts',
  'mobile/src/services/widgetBackgroundRefresh.ts',
  'mobile/src/services/widgetDataSync.ts',
  'mobile/src/storage/asyncStoragePersistence.ts',
  'mobile/src/storage/diagnosticEventBufferStorage.ts',
  'mobile/src/storage/offlineQueueStorage.ts',
  'mobile/src/storage/secureTokenStorage.ts',
  'mobile/src/stores/activeRecordingStore.ts',
  'mobile/src/utils/fileLogSink.ts',
  'mobile/src/utils/meetingManifest.ts',
] as const;

type BaseWipeOptions = {
  unpair?: () => Promise<void>;
};

export type WipeAllAccountScopedStateOptions =
  | (BaseWipeOptions & {
      reason: 'unauthorized';
      clearOfflineQueue: false;
      widgetSyncUnsubscribe?: () => void;
    })
  | (BaseWipeOptions & {
      reason: 'explicitDisconnect';
      clearOfflineQueue: true;
    });

async function deleteAllMeetingSessionsBestEffort(): Promise<void> {
  try {
    const manifests = await listMeetingManifests();
    for (const manifest of manifests) {
      await deleteMeetingSession(manifest.localId).catch(() => {});
    }
  } catch {
    // Best effort: current callers do not block disconnect on meeting cleanup failures.
  }
}

function unbindOfflineQueueBestEffort(): void {
  try {
    useOfflineQueueStore.getState().bindAuthIdentity(null);
  } catch {
    // Store not initialised: nothing to unbind.
  }
}

async function clearOfflineQueueBestEffort(): Promise<void> {
  try {
    await useOfflineQueueStore.getState().clearAll();
  } catch {
    // Store may not be initialized: continue with disconnect flow.
  }
}

function resetUserDataStores(): void {
  useSessionStore.getState().resetStore();
  useInboxStore.getState().resetStore();
  useApprovalStore.getState().resetStore();
  useStagedFilesStore.getState().resetStore();
  useActiveRecordingStore.getState().clearRecording();
}

async function clearCloudCache(cloudUrl: string | null): Promise<void> {
  if (cloudUrl) {
    await clearKeysForPrefix(buildCacheKeyPrefix(cloudUrl));
  }
}

async function purgeDiagnosticStateBestEffort(): Promise<void> {
  const outcomes = await Promise.allSettled([
    purgeFileLogs(),
    clearMobileDiagnosticEvents(),
  ]);

  const operations = ['mobileDiagnosticFileLogs', 'mobileDiagnosticEventBuffer'] as const;
  outcomes.forEach((outcome, index) => {
    if (outcome.status === 'rejected') {
      ignoreBestEffortCleanup(outcome.reason, {
        operation: operations[index],
        reason: 'diagnostic cleanup must not block account teardown',
        owner: 'mobile-auth-teardown',
        severity: 'warn',
      });
    }
  });
}

function clearWidgetDataWithUnauthorizedLogging(): void {
  try {
    clearWidgetData();
  } catch (err) {
    log.warn('Failed to clear widget data during unauthorized cleanup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function unregisterWidgetBackgroundRefreshWithUnauthorizedLogging(): Promise<void> {
  try {
    await unregisterWidgetBackgroundRefresh();
  } catch (err) {
    log.warn('Failed to unregister widget background refresh during unauthorized cleanup', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runUnauthorizedTeardown(
  cloudUrl: string | null,
  opts: Extract<WipeAllAccountScopedStateOptions, { reason: 'unauthorized' }>,
): Promise<void> {
  unbindOfflineQueueBestEffort();

  opts.widgetSyncUnsubscribe?.();

  await deleteAllMeetingSessionsBestEffort();
  await clearCloudCache(cloudUrl);
  resetUserDataStores();
  await purgeDiagnosticStateBestEffort();
  await (opts.unpair ?? useAuthStore.getState().unpair)();

  clearWidgetDataWithUnauthorizedLogging();
  await unregisterWidgetBackgroundRefreshWithUnauthorizedLogging();
}

async function runExplicitDisconnectTeardown(
  cloudUrl: string | null,
  opts: Extract<WipeAllAccountScopedStateOptions, { reason: 'explicitDisconnect' }>,
): Promise<void> {
  clearWidgetData();
  void unregisterWidgetBackgroundRefresh();

  await deleteAllMeetingSessionsBestEffort();
  await clearOfflineQueueBestEffort();
  resetUserDataStores();
  await purgeDiagnosticStateBestEffort();
  await clearCloudCache(cloudUrl);
  await (opts.unpair ?? useAuthStore.getState().unpair)();
}

export async function wipeAllAccountScopedState(
  cloudUrl: string | null,
  opts: WipeAllAccountScopedStateOptions,
): Promise<void> {
  if (opts.clearOfflineQueue) {
    await runExplicitDisconnectTeardown(cloudUrl, opts);
    return;
  }

  await runUnauthorizedTeardown(cloudUrl, opts);
}
