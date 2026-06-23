import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { AgentSession } from '../../../../src/shared/types';

const require = createRequire(import.meta.url);
const { setPlatformConfig } = require('../../../../src/core/platform') as typeof import('../../../../src/core/platform');

const userDataPath = process.env.REBEL_USER_DATA;
const sessionId = process.env.REBEL_TEST_SESSION_ID;
const marker = process.env.REBEL_TEST_MARKER;

if (!userDataPath || !sessionId || !marker) {
  throw new Error('Missing REBEL_USER_DATA, REBEL_TEST_SESSION_ID, or REBEL_TEST_MARKER');
}
const userData = userDataPath;
const targetSessionId = sessionId;
const markerText = marker;

setPlatformConfig({
  userDataPath: userData,
  appPath: process.cwd(),
  tempPath: os.tmpdir(),
  logsPath: path.join(userData, 'logs'),
  homePath: os.homedir(),
  documentsPath: path.join(os.homedir(), 'Documents'),
  desktopPath: path.join(os.homedir(), 'Desktop'),
  appDataPath: userData,
  version: 'test',
  isPackaged: false,
  platform: process.platform,
  totalMemoryBytes: os.totalmem(),
  arch: process.arch,
  surface: 'cli',
  isOss: false,
  getAppMetrics: () => [],
});

async function main(): Promise<void> {
  const { IncrementalSessionStore } = require('../../../../src/core/services/incrementalSessionStore') as typeof import('../../../../src/core/services/incrementalSessionStore');
  const { createSessionLockManager, defaultIsProcessAlive } = require('../../../../src/core/utils/sessionFileLock') as typeof import('../../../../src/core/utils/sessionFileLock');

  const store = new IncrementalSessionStore();
  const lockManager = createSessionLockManager({
    locksDirectory: path.join(userData, 'sessions-locks'),
    isProcessAlive: defaultIsProcessAlive,
    now: Date.now,
  });

  const lockOptions = {
    pid: process.pid,
    startedAt: Date.now(),
    ownerKind: 'cli' as const,
    maxRetryMs: 5_000,
  };

  const sessionLock = await lockManager.acquirePerSession(targetSessionId, lockOptions);
  try {
    const indexLock = await lockManager.acquireGlobalIndex(lockOptions);
    try {
      const existing = await store.getSession(targetSessionId);
      const now = Date.now();
      const session: AgentSession = existing
        ? {
            ...existing,
            updatedAt: now,
            messages: [
              ...existing.messages,
              {
                id: `message-${markerText}`,
                turnId: `turn-${markerText}`,
                role: 'user',
                text: markerText,
                createdAt: now,
              },
            ],
          }
        : {
            id: targetSessionId,
            title: 'Stress Session',
            createdAt: now,
            updatedAt: now,
            messages: [{
              id: `message-${markerText}`,
              turnId: `turn-${markerText}`,
              role: 'user',
              text: markerText,
              createdAt: now,
            }],
            eventsByTurn: {},
            activeTurnId: null,
            isBusy: false,
            lastError: null,
            resolvedAt: null,
          };
      process.send?.({ type: 'index-lock-acquired', marker: markerText });
      await delay(Number(process.env.REBEL_TEST_HOLD_INDEX_LOCK_MS ?? 0));
      store.upsertSessionsSyncWithReload([session]);
    } finally {
      await indexLock.release();
    }
  } finally {
    await sessionLock.release();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
