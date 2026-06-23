import crypto from 'node:crypto';
import path from 'node:path';
import type { KeyValueStore } from '@core/store';
import { createStore } from '@core/storeFactory';
import { createScopedLogger } from '@core/logger';
import { toPortablePath } from '@core/utils/portablePath';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

interface DriveAwareSyncNoticeStoreShape extends Record<string, unknown> {
  driveAwareSyncNotified: Record<string, number>;
}

const STORE_NAME = 'cloud-drive-aware-sync';
const CASE_INSENSITIVE_PLATFORMS = new Set(['darwin', 'win32']);
const log = createScopedLogger({ service: 'driveAwareSyncNoticeStore' });

let noticeStore: KeyValueStore<DriveAwareSyncNoticeStoreShape> | null = null;
const fallbackNotified = new Map<string, number>();

function normalizeWorkspacePath(workspacePath: string): string {
  const portable = toPortablePath(path.resolve(workspacePath)).normalize('NFC');
  if (CASE_INSENSITIVE_PLATFORMS.has(process.platform)) {
    return portable.toLowerCase();
  }
  return portable;
}

function getNoticeStore(): KeyValueStore<DriveAwareSyncNoticeStoreShape> | null {
  if (noticeStore) return noticeStore;
  try {
    noticeStore = createStore<DriveAwareSyncNoticeStoreShape>({
      name: STORE_NAME,
      defaults: {
        driveAwareSyncNotified: {},
      },
    });
    return noticeStore;
  } catch (err) {
    ignoreBestEffortCleanup(err, {
      operation: 'driveAwareSyncNoticeStore.getNoticeStore',
      reason: 'fallback-to-memory-when-store-unavailable',
      owner: 'main.driveAwareSyncNoticeStore',
    });
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Drive-aware sync notice store unavailable; using process-memory fallback',
    );
    return null;
  }
}

export function buildDriveAwareWorkspaceFingerprint(coreDirectory: string): string {
  return crypto.createHash('sha1').update(normalizeWorkspacePath(coreDirectory)).digest('hex');
}

export function hasDriveAwareSyncNoticeBeenShown(coreDirectory: string): boolean {
  const fingerprint = buildDriveAwareWorkspaceFingerprint(coreDirectory);
  const store = getNoticeStore();
  if (!store) return fallbackNotified.has(fingerprint);
  const map = store.get('driveAwareSyncNotified', {});
  return typeof map[fingerprint] === 'number' && Number.isFinite(map[fingerprint]);
}

export function markDriveAwareSyncNoticeShown(
  coreDirectory: string,
  timestampMs: number = Date.now(),
): { workspaceFingerprint: string; timestamp: number } {
  const workspaceFingerprint = buildDriveAwareWorkspaceFingerprint(coreDirectory);
  const store = getNoticeStore();
  if (!store) {
    fallbackNotified.set(workspaceFingerprint, timestampMs);
    return { workspaceFingerprint, timestamp: timestampMs };
  }

  const current = store.get('driveAwareSyncNotified', {});
  store.set('driveAwareSyncNotified', {
    ...current,
    [workspaceFingerprint]: timestampMs,
  });

  return { workspaceFingerprint, timestamp: timestampMs };
}
