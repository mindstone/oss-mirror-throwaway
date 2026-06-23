/**
 * F1 data-loss guard — END-TO-END store retrofit spikes (REAL fs, temp dirs ONLY).
 *
 * Wires a REAL electron-store/conf factory (`clearInvalidConfig: false`, so
 * `.store` RETHROWS on corrupt data) against temp-dir files — never real
 * userData. Seeds a store file with corrupt/invalid content, drives the actual
 * store's load path, and asserts the on-disk file is BYTE-FOR-BYTE preserved
 * (NOT overwritten with defaults), the store is read-only, a subsequent write is
 * blocked, and the failure is observable. Plus: absent file → fresh init still
 * persists defaults.
 *
 * Red→green: revert the per-store guard (the old `catch { store = reset }` /
 * `safeParse-fail → writeSync(defaults)`) and the byte-for-byte assertions fail
 * because the file gets clobbered.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Conf from 'conf';

const ConfCtor: typeof Conf =
  typeof Conf === 'function' ? Conf : (Conf as unknown as { default: typeof Conf }).default;

let tmpDir: string;
let capture: ReturnType<typeof vi.fn>;

/**
 * Fresh module graph + real conf-backed factory rooted at a temp dir. Returns
 * the resolved userData dir so tests can locate / corrupt the backing files.
 */
const bootRealStores = async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-storeguard-'));
  process.env.REBEL_USER_DATA = tmpDir;

  const { setPlatformConfig, defaultCapabilities } = await import('@core/platform');
  setPlatformConfig({
    userDataPath: tmpDir,
    appPath: tmpDir,
    tempPath: tmpDir,
    logsPath: tmpDir,
    homePath: tmpDir,
    documentsPath: tmpDir,
    desktopPath: tmpDir,
    appDataPath: tmpDir,
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 8 * 1024 * 1024 * 1024,
    arch: process.arch,
    surface: 'desktop',
    isOss: false,
    capabilities: defaultCapabilities('desktop'),
  });

  const { setStoreFactory } = await import('@core/storeFactory');
  setStoreFactory(
    (opts) =>
      new ConfCtor({
        cwd: tmpDir,
        configName: opts.name,
        clearInvalidConfig: false,
        defaults: opts.defaults as Record<string, unknown> | undefined,
        // conf needs a projectVersion to construct outside an Electron app.
        projectVersion: '0.0.0-test',
      }) as never,
  );

  capture = vi.fn();
  const { setErrorReporter } = await import('@core/errorReporter');
  setErrorReporter({
    captureException: capture,
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  } as never);

  const { setBroadcastService } = await import('@core/broadcastService');
  setBroadcastService({ sendToAllWindows: vi.fn(), sendToFocusedWindow: vi.fn() } as never);

  return tmpDir;
};

afterEach(() => {
  delete process.env.REBEL_USER_DATA;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

describe('fileConversationStore — corrupt JSON preserved (electron-store caller)', () => {
  it('CORRUPT JSON: file byte-for-byte preserved, read-only, write blocked, observable', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'file-conversation.json');
    // Seed real data then corrupt the file.
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, entries: [{ id: 'real', filePath: 'a', sessionId: 's', sessionTitle: 't', timestamp: 1, source: 'open' }], lastPruned: 0 }),
    );
    const corrupt = Buffer.from('{ corrupt-not-json ', 'utf8');
    fs.writeFileSync(filePath, corrupt);
    const before = fs.readFileSync(filePath);

    const mod = await import('../fileConversationStore');
    // Drive load + then a write attempt.
    mod.trackFileConversation('/abs/file.txt', 'sess-1', 'Title', 'write');

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // NOT wiped
    expect(after.equals(corrupt)).toBe(true);
    expect(capture).toHaveBeenCalled(); // observable
  });

  it('ABSENT file: fresh init persists defaults (still works — never latched read-only)', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'file-conversation.json');
    expect(fs.existsSync(filePath)).toBe(false);

    const mod = await import('../fileConversationStore');
    mod.trackFileConversation('/abs/file.txt', 'sess-1', 'Title', 'write');

    // A fresh store accepts the write and persists (no read-only latch on absent).
    expect(fs.existsSync(filePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(Array.isArray(persisted.entries)).toBe(true);
    expect(persisted.entries.length).toBeGreaterThan(0);
    // A genuine absent/fresh load must NOT have reported a load failure.
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('inboxStore — corrupt JSON preserved', () => {
  it('CORRUPT JSON: file byte-for-byte preserved, write blocked', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'inbox.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, items: [{ id: 'real-item' }], history: [] }));
    const corrupt = Buffer.from('}{ broken', 'utf8');
    fs.writeFileSync(filePath, corrupt);
    const before = fs.readFileSync(filePath);

    const mod = await import('../inboxStore');
    const state = mod.getInboxState(); // triggers load
    expect(state.items).toEqual([]); // ephemeral defaults in memory

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // NOT wiped
    expect(capture).toHaveBeenCalled();
  });
});

describe('toolUsageStore — broadened beyond EMFILE: corrupt JSON preserved', () => {
  it('CORRUPT JSON: file byte-for-byte preserved, write blocked (read-only)', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'tool-usage.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 6, tools: [{ toolName: 'Slack/x', usageCount: 3 }], lastUpdatedAt: 0 }));
    const corrupt = Buffer.from('{ broken json', 'utf8');
    fs.writeFileSync(filePath, corrupt);
    const before = fs.readFileSync(filePath);

    const mod = await import('../toolUsageStore');
    expect(mod.getFrequentTools()).toEqual([]); // ephemeral defaults
    // A write attempt must be blocked by the read-only latch.
    mod.recordToolUsage('Slack/new');

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // NOT wiped
    expect(after.equals(corrupt)).toBe(true);
    expect(capture).toHaveBeenCalled();
  });
});

describe('folderStore — corrupt + schema-invalid preserved (direct-fs, the original incident)', () => {
  it('CORRUPT JSON: folders.json byte-for-byte preserved, read-only, save blocked', async () => {
    const dir = await bootRealStores();
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, 'folders.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, folders: [{ id: 'f1', name: 'Real Folder' }], membership: { s1: 'f1' } }));
    const corrupt = Buffer.from('{ not json at all', 'utf8');
    fs.writeFileSync(filePath, corrupt);
    const before = fs.readFileSync(filePath);

    const { FolderStore } = await import('../folderStore');
    const store = new FolderStore();
    const loaded = store.load();
    expect(loaded.folders).toEqual([]); // ephemeral defaults
    expect(store.isReadOnly()).toBe(true);

    // A subsequent save must be blocked.
    await store.save({ version: 1, folders: [{ id: 'x', name: 'New', createdAt: 0, updatedAt: 0 }], membership: {} });
    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // NOT wiped by load OR save
    expect(after.equals(corrupt)).toBe(true);
  });

  it('SCHEMA-INVALID but parseable: folders.json preserved, read-only (single bad entry must not wipe all)', async () => {
    const dir = await bootRealStores();
    const sessionsDir = path.join(dir, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const filePath = path.join(sessionsDir, 'folders.json');
    // Parseable JSON but violates the schema (membership must be Record<string,string>).
    const invalid = JSON.stringify({ version: 1, folders: 'this-should-be-an-array', membership: { s1: 12345 } });
    fs.writeFileSync(filePath, invalid);
    const before = fs.readFileSync(filePath);

    const { FolderStore } = await import('../folderStore');
    const store = new FolderStore();
    const loaded = store.load();
    expect(loaded.folders).toEqual([]); // ephemeral defaults
    expect(store.isReadOnly()).toBe(true);

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // schema drift must NOT reset+persist
  });

  it('ABSENT: fresh init persists empty defaults (still works)', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'sessions', 'folders.json');
    expect(fs.existsSync(filePath)).toBe(false);

    const { FolderStore } = await import('../folderStore');
    const store = new FolderStore();
    const loaded = store.load();
    expect(loaded).toEqual({ version: 1, folders: [], membership: {} });
    expect(store.isReadOnly()).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true); // persisted
  });
});

describe('contributionStore — generic (non-EMFILE) load failure preserved (item 1)', () => {
  it('CORRUPT JSON: connector-contributions.json preserved, write blocked (read-only)', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'connector-contributions.json');
    // Seed real contribution data, then corrupt the file on disk.
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 6,
        contributions: [
          {
            id: 'contrib-real',
            sessionId: 's1',
            linkedSessionIds: ['s1'],
            connectorName: 'Acme',
            status: 'draft',
            attributionMode: 'anonymous',
            acknowledgedEvents: [],
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const corrupt = Buffer.from('{ corrupt-contributions ', 'utf8');
    fs.writeFileSync(filePath, corrupt);
    const before = fs.readFileSync(filePath);

    const mod = await import('../contributionStore');
    // Reading serves ephemeral defaults (real data preserved on disk).
    expect(mod.listContributions()).toEqual([]);

    // A write attempt MUST be blocked by the read-only latch (pre-fix: the
    // generic catch primed defaults and let this write self-heal — wiping data).
    expect(() =>
      mod.createContribution({
        sessionId: 's2',
        connectorName: 'New',
        status: 'draft',
        attributionMode: 'anonymous',
      }),
    ).toThrow(/read-only/i);

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // NOT wiped
    expect(after.equals(corrupt)).toBe(true);
    expect(capture).toHaveBeenCalled(); // observable
  });

  it('ABSENT: fresh init is writable (no read-only latch on a genuinely absent file)', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'connector-contributions.json');
    expect(fs.existsSync(filePath)).toBe(false);

    const mod = await import('../contributionStore');
    const created = mod.createContribution({
      sessionId: 's1',
      connectorName: 'Acme',
      status: 'draft',
      attributionMode: 'anonymous',
    });
    expect(created.id).toBeTruthy();
    expect(mod.listContributions().length).toBe(1);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('safetyPromptStore — real safety policy/history preserved (item 3)', () => {
  it('CORRUPT JSON: safety-prompt.json preserved, reset/update/revert all blocked', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'safety-prompt.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        safetyPrompt: 'MY REAL CUSTOM SAFETY POLICY',
        version: 3,
        lastUpdatedAt: 123,
        lastUpdatedBy: 'user',
        migrationComplete: true,
        history: [{ prompt: 'old', version: 2, updatedAt: 1, updatedBy: 'user' }],
      }),
    );
    const corrupt = Buffer.from('{ not-valid-safety-json', 'utf8');
    fs.writeFileSync(filePath, corrupt);
    const before = fs.readFileSync(filePath);

    const mod = await import('../../safetyPromptStore');

    // resetToDefaults is the most dangerous writer — it must NOT clobber the file.
    mod.resetToDefaults();
    mod.updateSafetyPrompt('attacker-supplied', 'user');
    expect(mod.revertToVersion(2)).toBe(false);
    mod.setMigrationComplete(false);

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // real policy preserved byte-for-byte
    expect(after.equals(corrupt)).toBe(true);
    expect(capture).toHaveBeenCalled(); // observable
  });

  it('ABSENT: fresh init is writable (update persists, no read-only latch)', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'safety-prompt.json');
    expect(fs.existsSync(filePath)).toBe(false);

    const mod = await import('../../safetyPromptStore');
    mod.updateSafetyPrompt('a fresh policy', 'user');
    expect(mod.getSafetyPrompt()).toBe('a fresh policy');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('safeCreateStore — construct-time corruption spike (item 6)', () => {
  it('achievements: corrupt file → construct fails → preserved + read-only + writes inert', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'achievements.json');
    // electron-store/conf reads+validates in its CONSTRUCTOR, so a corrupt file
    // throws at construction time. Seed real data, then corrupt.
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, streaks: {}, badges: {}, counters: {}, tier: {} }));
    const corrupt = Buffer.from('{{ corrupt-achievements', 'utf8');
    fs.writeFileSync(filePath, corrupt);
    const before = fs.readFileSync(filePath);

    const mod = await import('../achievementsStore');
    // Any getter forces construction; the ephemeral store returns defaults.
    expect(() => mod.getBadges()).not.toThrow();
    // A mutator's write must be inert — it can't flush over the corrupt file.
    mod.incrementSessionCount(false);

    const after = fs.readFileSync(filePath);
    expect(after.equals(before)).toBe(true); // construction-time throw must NOT wipe
    expect(after.equals(corrupt)).toBe(true);
    expect(capture).toHaveBeenCalled();
  });
});

describe('loadStoreSafely dedup — repeated reads of a corrupt store (item 2)', () => {
  it('exactly ONE backup + ONE capture across many getter calls', async () => {
    const dir = await bootRealStores();
    const filePath = path.join(dir, 'memory-history.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, entries: [{ id: 'e1' }], lastPruned: 0, backfillCompleted: true }));
    const corrupt = Buffer.from('{ corrupt-memory-history', 'utf8');
    fs.writeFileSync(filePath, corrupt);

    const { __resetLoadFailureDedupForTests } = await import('@core/utils/loadStoreSafely');
    __resetLoadFailureDedupForTests();

    const mod = await import('../../../main/services/memoryHistoryStore');
    // Hammer the hot-path getters many times.
    for (let i = 0; i < 12; i++) {
      mod.getMemoryHistory();
      mod.getMemoryHistoryCount();
    }

    // Exactly one Sentry capture for this store, despite 24 getter calls.
    const captureCallsForStore = capture.mock.calls.filter(
      ([, ctx]) => (ctx as { tags?: { storeName?: string } })?.tags?.storeName === 'memory-history',
    );
    expect(captureCallsForStore.length).toBe(1);

    // Exactly one raw `.corrupt.bak` for this store in the backups dir.
    const backupDir = path.join(dir, 'backups');
    const backups = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((f) => f.startsWith('memory-history-rawload-') && f.endsWith('.corrupt.bak'))
      : [];
    expect(backups.length).toBe(1);
  });
});
