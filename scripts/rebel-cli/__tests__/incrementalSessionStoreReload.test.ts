import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import type { AgentSession } from '@shared/types';

let testDir: string;

const makeSession = (id: string, marker: string): AgentSession => ({
  id,
  title: marker,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [{
    id: `message-${marker}`,
    turnId: `turn-${marker}`,
    role: 'user',
    text: marker,
    createdAt: Date.now(),
  }],
  eventsByTurn: {},
  activeTurnId: null,
  isBusy: false,
  lastError: null,
  resolvedAt: null,
});

describe('IncrementalSessionStore reload-on-lock variant', () => {
  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cli-index-reload-'));
    vi.resetModules();
    await initTestPlatformConfig({ userDataPath: testDir });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('re-reads index.json before merging so another process entry is preserved', async () => {
    const { IncrementalSessionStore } = await import('../../../src/core/services/incrementalSessionStore');
    const writerOne = new IncrementalSessionStore();
    const writerTwo = new IncrementalSessionStore();

    writerOne.upsertSessionsSync([makeSession('session-a', 'A')]);
    expect(writerTwo.loadSync()).toHaveLength(1);
    writerOne.upsertSessionsSync([makeSession('session-b', 'B')]);

    writerTwo.upsertSessionsSyncWithReload([makeSession('session-c', 'C')]);

    const finalStore = new IncrementalSessionStore();
    const finalSessions = finalStore.loadSync();
    expect(finalSessions.map((session) => session.id).sort()).toEqual([
      'session-a',
      'session-b',
      'session-c',
    ]);
  });
});
