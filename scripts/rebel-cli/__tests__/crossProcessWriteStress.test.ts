import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession } from '../../../src/shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const helperPath = path.join(__dirname, 'fixtures', 'writeSessionChild.ts');
let testDir: string;

describe('standalone CLI cross-process write contention', () => {
  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cli-write-stress-'));
    vi.resetModules();
    await initTestPlatformConfig({ userDataPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('preserves all markers and keeps index.json consistent', async () => {
    const sessionId = 'shared-session';
    const markers = ['alpha', 'bravo', 'charlie'];

    await Promise.all(markers.map((marker) => runChild(marker, sessionId).done));

    const { IncrementalSessionStore } = await import('../../../src/core/services/incrementalSessionStore');
    const store = new IncrementalSessionStore();
    const session = await store.getSession(sessionId);
    expect(session?.messages.map((message) => message.text).sort()).toEqual(markers);

    const indexPath = path.join(testDir, 'sessions', 'index.json');
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
      sessions: Array<{ id: string; messageCount: number }>;
    };
    expect(index.sessions.find((entry) => entry.id === sessionId)?.messageCount).toBe(3);
  });

  it('preserves GUI lazy upsert and standalone writer index entries under lock contention', async () => {
    const standalone = runChild('standalone-gui-race', 'standalone-gui-session', { holdIndexLockMs: 75 });
    await standalone.waitForIndexLock;

    const { upsertSessionsWithLocks } = await import('../../../src/core/services/lockedSessionPersistence');
    const { IncrementalSessionStore } = await import('../../../src/core/services/incrementalSessionStore');
    const { createSessionLockManager, defaultIsProcessAlive } = await import('../../../src/core/utils/sessionFileLock');
    const store = new IncrementalSessionStore();
    const lockManager = createSessionLockManager({
      locksDirectory: path.join(testDir, 'sessions-locks'),
      isProcessAlive: defaultIsProcessAlive,
      now: Date.now,
    });

    await upsertSessionsWithLocks({
      sessions: [makeSession('gui-lazy-session', 'gui-lazy-upsert')],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 2_000,
    });
    await standalone.done;

    await expectIndexContains(['gui-lazy-session', 'standalone-gui-session']);
  });

  it('preserves sync GUI save and standalone writer index entries under lock contention', async () => {
    const standalone = runChild('standalone-sync-race', 'standalone-sync-session', { holdIndexLockMs: 75 });
    await standalone.waitForIndexLock;

    const { upsertSessionsWithLocksSync } = await import('../../../src/core/services/lockedSessionPersistence');
    const { IncrementalSessionStore } = await import('../../../src/core/services/incrementalSessionStore');
    const { createSessionLockManager, defaultIsProcessAlive } = await import('../../../src/core/utils/sessionFileLock');
    const store = new IncrementalSessionStore();
    const lockManager = createSessionLockManager({
      locksDirectory: path.join(testDir, 'sessions-locks'),
      isProcessAlive: defaultIsProcessAlive,
      now: Date.now,
    });

    upsertSessionsWithLocksSync({
      sessions: [makeSession('gui-sync-session', 'gui-sync-save')],
      store,
      lockManager,
      ownerKind: 'desktop',
      maxRetryMs: 2_000,
    });
    await standalone.done;

    await expectIndexContains(['gui-sync-session', 'standalone-sync-session']);
  });
});

function runChild(
  marker: string,
  sessionId: string,
  options: { holdIndexLockMs?: number } = {},
): { done: Promise<void>; waitForIndexLock: Promise<void> } {
  let resolveIndexLock: (() => void) | undefined;
  const waitForIndexLock = new Promise<void>((resolve) => {
    resolveIndexLock = resolve;
  });
  const done = new Promise<void>((resolve, reject) => {
    const child = fork(helperPath, {
      cwd: projectRoot,
      env: {
        ...process.env,
        REBEL_USER_DATA: testDir,
        REBEL_TEST_SESSION_ID: sessionId,
        REBEL_TEST_MARKER: marker,
        REBEL_TEST_HOLD_INDEX_LOCK_MS: String(options.holdIndexLockMs ?? 0),
        TS_NODE_PROJECT: path.join(projectRoot, 'tsconfig.node.json'),
      },
      execArgv: ['--require', 'tsconfig-paths/register', '--import', 'tsx'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('message', (message) => {
      if (typeof message === 'object' && message !== null && (message as { type?: string }).type === 'index-lock-acquired') {
        resolveIndexLock?.();
      }
    });
    child.on('exit', (code) => {
      resolveIndexLock?.();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`child ${marker} exited ${code}: ${stderr}`));
      }
    });
  });
  return { done, waitForIndexLock };
}

function makeSession(id: string, marker: string): AgentSession {
  const now = Date.now();
  return {
    id,
    title: `Session ${marker}`,
    createdAt: now,
    updatedAt: now,
    messages: [{
      id: `message-${marker}`,
      turnId: `turn-${marker}`,
      role: 'user',
      text: marker,
      createdAt: now,
    }],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
  };
}

async function expectIndexContains(sessionIds: string[]): Promise<void> {
  const indexPath = path.join(testDir, 'sessions', 'index.json');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
    sessions: Array<{ id: string }>;
  };
  for (const sessionId of sessionIds) {
    expect(index.sessions.some((entry) => entry.id === sessionId)).toBe(true);
  }
}
