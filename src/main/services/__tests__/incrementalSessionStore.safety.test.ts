/**
 * Safety hardening tests for IncrementalSessionStore.
 *
 * Tests forward-version read-only mode, soft-delete, upsert-only saves,
 * UNION index semantics, eviction, and version marker.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { initTestPlatformConfig } from '@core/__tests__/testHelpers';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { AgentSession } from '@shared/types';

// ---------- shared stubs ----------

const stubLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

vi.mock('@core/logger', () => ({
  createScopedLogger: () => stubLogger,
  logger: stubLogger,
}));

// ---------- test helpers ----------

let testDir: string;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    title: 'Test Session',
    createdAt: 1000,
    updatedAt: 2000,
    messages: [],
    eventsByTurn: {},
    activeTurnId: null,
    isBusy: false,
    lastError: null,
    resolvedAt: null,
    ...overrides,
  };
}

function writeIndex(sessionsDir: string, version: number, sessions: Array<{ id: string; updatedAt?: number; doneAt?: number | null; [k: string]: unknown }>): void {
  const index = {
    version,
    lastUpdated: Date.now(),
    sessions: sessions.map(s => ({
      id: s.id,
      title: 'Test',
      createdAt: 1000,
      updatedAt: s.updatedAt ?? 2000,
      resolvedAt: null,
      doneAt: s.doneAt ?? null,
      starredAt: null,
      deletedAt: null,
      origin: 'manual',
      isCorrupted: false,
      privateMode: false,
      interruptedTurnId: null,
        preview: '',
      firstMessagePreview: '',
      messageCount: 0,
      hasDraft: false,
      draftPreview: null,
      draftUpdatedAt: null,
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, turnCount: 0 },
      activeTurnId: null,
      isBusy: false,
      lastError: null,
      fingerprint: `${s.updatedAt ?? 2000}:0:0:${JSON.stringify(['Test', 0, 0, 0, null, '', 0, '', '', 0, 'manual', 0, 0, 0])}`,
    })),
  };
  fs.writeFileSync(path.join(sessionsDir, 'index.json'), JSON.stringify(index), 'utf8');
}

function writeSessionFile(sessionsDir: string, session: AgentSession): void {
  fs.writeFileSync(
    path.join(sessionsDir, `${session.id}.json`),
    JSON.stringify(session),
    'utf8'
  );
}

// ---------- tests ----------

describe('IncrementalSessionStore safety hardening', () => {
  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-safety-'));
    vi.resetModules();
    await initTestPlatformConfig({ userDataPath: testDir });
    // Reset the read-only mode between tests
    Object.values(stubLogger).forEach((fn) => (fn as ReturnType<typeof vi.fn>).mockClear());
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to get a fresh IncrementalSessionStore instance with mocked userData path.
   */
  async function getStore() {
    // Mock electron
    vi.doMock('electron', () => ({
      app: {
        getPath: () => testDir,
        getVersion: () => '1.0.0-test',
      },
    }));

    // Mock inboxStore (has side effects)
    vi.doMock('../inboxStore', () => ({
      markSessionTurnsAsCompleted: (s: AgentSession) => ({
        ...s,
        activeTurnId: null,
        isBusy: false,
      }),
    }));

    const mod = await import('../incrementalSessionStore');
    // We need a fresh instance each time — the module caches a singleton
    // Access class directly and construct
    const store = new mod.IncrementalSessionStore();
    return { store, INDEX_VERSION: mod.INDEX_VERSION };
  }

  // =================================================================
  // Stage 1: Forward-Version Read-Only Mode
  // =================================================================

  describe('Stage 1: Forward-Version Read-Only Mode', () => {
    it('enters read-only mode when index version is newer', async () => {
      const { store, INDEX_VERSION } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Write index with a future version
      writeIndex(sessionsDir, INDEX_VERSION + 1, [{ id: 'sess-1' }]);
      writeSessionFile(sessionsDir, makeSession({ id: 'sess-1' }));

      const sessions = store.loadSync();
      expect(sessions.length).toBe(1);
      expect(store.isReadOnly()).toBe(true);
    });

    it('does NOT enter read-only mode when index version matches', async () => {
      const { store, INDEX_VERSION } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      writeIndex(sessionsDir, INDEX_VERSION, [{ id: 'sess-1' }]);
      writeSessionFile(sessionsDir, makeSession({ id: 'sess-1' }));

      store.loadSync();
      expect(store.isReadOnly()).toBe(false);
    });

    it('blocks save() in read-only mode', async () => {
      const { store } = await getStore();
      store.setReadOnlyMode(true);

      await store.save([makeSession()]);
      // No files should be written
      expect(fs.existsSync(path.join(testDir, 'sessions'))).toBe(false);
    });

    it('blocks saveSync() in read-only mode', async () => {
      const { store } = await getStore();
      store.setReadOnlyMode(true);

      store.saveSync([makeSession()]);
      expect(fs.existsSync(path.join(testDir, 'sessions'))).toBe(false);
    });

    it('blocks upsertSession() in read-only mode', async () => {
      const { store } = await getStore();
      store.setReadOnlyMode(true);

      await store.upsertSession(makeSession());
      expect(fs.existsSync(path.join(testDir, 'sessions'))).toBe(false);
    });

    it('blocks upsertSessionsSync() in read-only mode', async () => {
      const { store } = await getStore();
      store.setReadOnlyMode(true);

      store.upsertSessionsSync([makeSession()]);
      expect(fs.existsSync(path.join(testDir, 'sessions'))).toBe(false);
    });

    it('blocks deleteSession() in read-only mode', async () => {
      const { store } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const session = makeSession({ id: 'sess-keep' });
      writeSessionFile(sessionsDir, session);
      store.setReadOnlyMode(true);

      await store.deleteSession('sess-keep', { intent: 'user-delete' });
      // File should still exist
      expect(fs.existsSync(path.join(sessionsDir, 'sess-keep.json'))).toBe(true);
    });
  });

  // =================================================================
  // Stage 2: Soft-Delete Instead of Hard Delete
  // =================================================================

  describe('Stage 2: Soft-Delete', () => {
    it('moves deleted session file to sessions-deleted/', async () => {
      const { store, INDEX_VERSION } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const session = makeSession({ id: 'sess-del' });
      writeSessionFile(sessionsDir, session);
      writeIndex(sessionsDir, INDEX_VERSION, [{ id: 'sess-del' }]);

      store.loadSync();
      await store.deleteSession('sess-del', { intent: 'user-delete' });

      // Original file should be gone
      expect(fs.existsSync(path.join(sessionsDir, 'sess-del.json'))).toBe(false);
      // Should exist in sessions-deleted/
      const deletedDir = path.join(testDir, 'sessions-deleted');
      expect(fs.existsSync(deletedDir)).toBe(true);
      const deletedFiles = fs.readdirSync(deletedDir);
      expect(deletedFiles.some(f => f.startsWith('sess-del_'))).toBe(true);
    });

    it('sessions-deleted/ is NOT scanned by rebuildIndexFromFiles', async () => {
      const { store } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      const deletedDir = path.join(testDir, 'sessions-deleted');
      fs.mkdirSync(sessionsDir, { recursive: true });
      fs.mkdirSync(deletedDir, { recursive: true });

      // Put a session file in sessions/ and one in sessions-deleted/
      const liveSession = makeSession({ id: 'sess-live' });
      writeSessionFile(sessionsDir, liveSession);
      fs.writeFileSync(
        path.join(deletedDir, 'sess-deleted_12345.json'),
        JSON.stringify(makeSession({ id: 'sess-deleted' })),
        'utf8'
      );

      // loadSync with no index => triggers rebuild from files
      const sessions = store.loadSync();
      expect(sessions.map(s => s.id)).toContain('sess-live');
      expect(sessions.map(s => s.id)).not.toContain('sess-deleted');
    });
  });

  // =================================================================
  // Stage 3: Upsert-Only Saves + UNION Index
  // =================================================================

  describe('Stage 3: Upsert-Only Saves + UNION Index', () => {
    it('save() with fewer sessions does NOT delete existing session files', async () => {
      const { store, INDEX_VERSION } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const session1 = makeSession({ id: 'sess-1', updatedAt: 1000 });
      const session2 = makeSession({ id: 'sess-2', updatedAt: 2000 });
      writeSessionFile(sessionsDir, session1);
      writeSessionFile(sessionsDir, session2);
      writeIndex(sessionsDir, INDEX_VERSION, [{ id: 'sess-1' }, { id: 'sess-2' }]);

      store.loadSync();

      // Save with only session1 — session2 should NOT be deleted
      await store.save([{ ...session1, updatedAt: 3000 }]);
      await store.waitForPendingWrites();

      // Both files should still exist
      expect(fs.existsSync(path.join(sessionsDir, 'sess-1.json'))).toBe(true);
      expect(fs.existsSync(path.join(sessionsDir, 'sess-2.json'))).toBe(true);
    });

    it('index retains entries for sessions NOT in the latest save batch', async () => {
      const { store, INDEX_VERSION } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const session1 = makeSession({ id: 'sess-1', updatedAt: 1000 });
      const session2 = makeSession({ id: 'sess-2', updatedAt: 2000 });
      writeSessionFile(sessionsDir, session1);
      writeSessionFile(sessionsDir, session2);
      writeIndex(sessionsDir, INDEX_VERSION, [
        { id: 'sess-1', updatedAt: 1000 },
        { id: 'sess-2', updatedAt: 2000 },
      ]);

      store.loadSync();

      // Save only session1 with updated data
      await store.save([{ ...session1, updatedAt: 5000, title: 'Updated' }]);
      await store.waitForPendingWrites();

      // Read back the index
      const indexContent = fs.readFileSync(path.join(sessionsDir, 'index.json'), 'utf8');
      const index = JSON.parse(indexContent);
      const ids = index.sessions.map((s: { id: string }) => s.id);
      expect(ids).toContain('sess-1');
      expect(ids).toContain('sess-2');
    });

    it('fingerprint cache retains entries for sessions not in the latest batch', async () => {
      const { store, INDEX_VERSION } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const session1 = makeSession({ id: 'sess-1', updatedAt: 1000 });
      const session2 = makeSession({ id: 'sess-2', updatedAt: 2000 });
      writeSessionFile(sessionsDir, session1);
      writeSessionFile(sessionsDir, session2);
      writeIndex(sessionsDir, INDEX_VERSION, [
        { id: 'sess-1', updatedAt: 1000 },
        { id: 'sess-2', updatedAt: 2000 },
      ]);

      store.loadSync();

      // Save only session1
      await store.save([{ ...session1, updatedAt: 5000 }]);
      await store.waitForPendingWrites();

      // Now save only session2 — it should not detect session1 as "changed"
      // since the fingerprint cache should still have session1's entry
      const session2Updated = { ...session2, updatedAt: 6000 };
      await store.save([session2Updated]);
      await store.waitForPendingWrites();

      // listSessions should show both
      const summaries = store.listSessions();
      const ids = summaries.map(s => s.id);
      expect(ids).toContain('sess-1');
      expect(ids).toContain('sess-2');
    });
  });

  // =================================================================
  // Stage 5: Anomaly Detection
  // =================================================================

  describe('Stage 5: Anomaly Detection', () => {
    it('logs error when save batch is <5% of known sessions', async () => {
      const { store, INDEX_VERSION } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Create 20 sessions in the index (MIN_KNOWN_FOR_CHECK = 10)
      const sessions = Array.from({ length: 20 }, (_, i) =>
        makeSession({ id: `sess-${i}`, updatedAt: 1000 + i })
      );
      for (const s of sessions) writeSessionFile(sessionsDir, s);
      writeIndex(sessionsDir, INDEX_VERSION,
        sessions.map(s => ({ id: s.id, updatedAt: s.updatedAt }))
      );

      store.loadSync();
      stubLogger.error.mockClear();

      // Save with 0 sessions (<5% of 20)
      await store.save([]);
      await store.waitForPendingWrites();

      // Should have logged an ANOMALY error
      const anomalyCall = stubLogger.error.mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('ANOMALY')
      );
      expect(anomalyCall).toBeDefined();
    });

    it('does NOT log error for normal partial saves (>5%)', async () => {
      const { store, INDEX_VERSION } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const sessions = Array.from({ length: 20 }, (_, i) =>
        makeSession({ id: `sess-${i}`, updatedAt: 1000 + i })
      );
      for (const s of sessions) writeSessionFile(sessionsDir, s);
      writeIndex(sessionsDir, INDEX_VERSION,
        sessions.map(s => ({ id: s.id, updatedAt: s.updatedAt }))
      );

      store.loadSync();
      stubLogger.error.mockClear();

      // Save with 5 sessions (25% of 20) — should NOT trigger anomaly
      await store.save(sessions.slice(0, 5));
      await store.waitForPendingWrites();

      const anomalyCall = stubLogger.error.mock.calls.find(
        (call: unknown[]) => typeof call[1] === 'string' && call[1].includes('ANOMALY')
      );
      expect(anomalyCall).toBeUndefined();
    });
  });

  // =================================================================
  // Stage 4: Eviction
  // =================================================================

  describe('Stage 4: Eviction', () => {
    it('evicts oldest Done sessions when over cap', async () => {
      vi.doMock('@core/constants', async (importOriginal) => ({
        ...(await importOriginal()),
        MAX_PERSISTED_SESSIONS: 3,
      }));

      const { store } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      // Create 4 Done sessions (doneAt set) — only Done sessions are eviction-eligible;
      // the oldest should be evicted.
      const sessions = [
        makeSession({ id: 'old', updatedAt: 1000, doneAt: 1000 }),
        makeSession({ id: 'mid', updatedAt: 2000, doneAt: 2000 }),
        makeSession({ id: 'new', updatedAt: 3000, doneAt: 3000 }),
        makeSession({ id: 'newest', updatedAt: 4000, doneAt: 4000 }),
      ];

      for (const s of sessions) {
        writeSessionFile(sessionsDir, s);
      }

      // Save all 4 — eviction should kick in
      store.saveSync(sessions);

      // Read the index — should have 3 sessions
      const indexContent = fs.readFileSync(path.join(sessionsDir, 'index.json'), 'utf8');
      const index = JSON.parse(indexContent);
      expect(index.sessions.length).toBe(3);
      const ids = index.sessions.map((s: { id: string }) => s.id);
      expect(ids).not.toContain('old');
      expect(ids).toContain('mid');
      expect(ids).toContain('new');
      expect(ids).toContain('newest');

      // The evicted file should be in sessions-deleted/
      const deletedDir = path.join(testDir, 'sessions-deleted');
      if (fs.existsSync(deletedDir)) {
        const deletedFiles = fs.readdirSync(deletedDir);
        expect(deletedFiles.some(f => f.startsWith('old_'))).toBe(true);
      }
    });

    it('never evicts Active sessions even if over cap', async () => {
      vi.doMock('@core/constants', async (importOriginal) => ({
        ...(await importOriginal()),
        MAX_PERSISTED_SESSIONS: 2,
      }));

      const { store } = await getStore();
      const sessionsDir = path.join(testDir, 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });

      const sessions = [
        makeSession({ id: 'active-old', updatedAt: 1000, doneAt: null }),
        makeSession({ id: 'active-mid', updatedAt: 2000, doneAt: null }),
        makeSession({ id: 'done', updatedAt: 3000, doneAt: 3000 }),
      ];

      for (const s of sessions) {
        writeSessionFile(sessionsDir, s);
      }

      store.saveSync(sessions);

      // The Done session should be evicted; Active ones should stay.
      const indexContent = fs.readFileSync(path.join(sessionsDir, 'index.json'), 'utf8');
      const index = JSON.parse(indexContent);
      const ids = index.sessions.map((s: { id: string }) => s.id);
      expect(ids).toContain('active-old');
      expect(ids).toContain('active-mid');
      expect(ids).not.toContain('done');
    });
  });

  // =================================================================
  // Stage 6: Version Marker
  // =================================================================

  describe('Stage 6: Version Marker', () => {
    it('creates version marker on fresh install', async () => {
      await initTestPlatformConfig({ userDataPath: testDir, version: '1.0.0-test' });
      vi.doMock('electron', () => ({
        app: {
          getPath: () => testDir,
          getVersion: () => '1.0.0-test',
        },
      }));

      const { checkAndUpdateVersionMarker } = await import('../versionMarker');
      const result = checkAndUpdateVersionMarker(5);

      expect(result.isOlderVersion).toBe(false);
      const markerPath = path.join(testDir, 'version-marker.json');
      expect(fs.existsSync(markerPath)).toBe(true);

      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      expect(marker.indexVersion).toBe(5);
      expect(marker.appVersion).toBe('1.0.0-test');
    });

    it('returns isOlderVersion=true when marker has higher indexVersion', async () => {
      await initTestPlatformConfig({ userDataPath: testDir, version: '1.0.0-test' });
      // Write a marker from a "newer" version
      const markerPath = path.join(testDir, 'version-marker.json');
      fs.writeFileSync(markerPath, JSON.stringify({
        appVersion: '2.0.0',
        indexVersion: 10,
        lastWrittenAt: Date.now(),
      }));

      vi.doMock('electron', () => ({
        app: {
          getPath: () => testDir,
          getVersion: () => '1.0.0-test',
        },
      }));

      const { checkAndUpdateVersionMarker } = await import('../versionMarker');
      const result = checkAndUpdateVersionMarker(5);

      expect(result.isOlderVersion).toBe(true);
      // Marker should NOT be overwritten
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      expect(marker.indexVersion).toBe(10);
    });

    it('returns isOlderVersion=false and updates marker when current version is equal', async () => {
      await initTestPlatformConfig({ userDataPath: testDir, version: '1.0.0-new' });
      const markerPath = path.join(testDir, 'version-marker.json');
      fs.writeFileSync(markerPath, JSON.stringify({
        appVersion: '1.0.0-old',
        indexVersion: 5,
        lastWrittenAt: 1000,
      }));

      vi.doMock('electron', () => ({
        app: {
          getPath: () => testDir,
          getVersion: () => '1.0.0-new',
        },
      }));

      const { checkAndUpdateVersionMarker } = await import('../versionMarker');
      const result = checkAndUpdateVersionMarker(5);

      expect(result.isOlderVersion).toBe(false);
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      expect(marker.appVersion).toBe('1.0.0-new');
      expect(marker.lastWrittenAt).toBeGreaterThan(1000);
    });
  });
});
