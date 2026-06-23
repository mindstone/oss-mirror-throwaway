/**
 * F1 (cross-surface) — cloud store-shim load-corruption guard.
 *
 * The cloud surface wires `CloudStore` (this shim) as the global store factory
 * (`cloud-service/src/bootstrap.ts` → `setStoreFactory`). Historically the shim
 * constructor CAUGHT every read/parse failure and seeded defaults, so the shared
 * desktop guard (`safeCreateStore` / `loadStoreSafely`) never saw a load failure
 * on cloud → `loadFailed:false` → a later write persisted defaults OVER the
 * corrupt-but-real file. That is live, silent data loss on cloud for every core
 * store (contributionStore, safetyPromptStore, communityShareStore, inbox, …).
 *
 * The fix makes the shim match conf/electron-store `clearInvalidConfig:false`
 * semantics: ENOENT → fresh init (defaults), but a present-but-unreadable file
 * (corrupt JSON / non-ENOENT IO error) THROWS from the constructor, so the shared
 * guard engages on cloud by construction — preserve the raw file + back it up +
 * latch read-only + ephemeral defaults + block writes.
 *
 * Tests use ONLY temp dirs (REBEL_USER_DATA → mkdtemp); real userData is never
 * touched. Red→green: revert the shim throw (swallow → defaults) and the
 * "constructor THROWS" + "file preserved" assertions fail.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('electronStoreShim — load-corruption guard (F1, cross-surface)', () => {
  const originalUserData = process.env.REBEL_USER_DATA;
  let userDataDir = '';

  beforeEach(() => {
    vi.resetModules();
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-cloud-store-corrupt-'));
    process.env.REBEL_USER_DATA = userDataDir;
  });

  afterEach(() => {
    vi.resetModules();
    if (originalUserData === undefined) {
      delete process.env.REBEL_USER_DATA;
    } else {
      process.env.REBEL_USER_DATA = originalUserData;
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup */
    }
  });

  // ── Raw shim contract ───────────────────────────────────────────────────

  it('ABSENT file: constructor fresh-inits with defaults (legitimate first run)', async () => {
    const { Store } = await import('../electronStoreShim');
    const store = new Store<{ version: number; value: string }>({
      name: 'never-written',
      defaults: { version: 1, value: 'default' },
    });
    expect(store.store).toEqual({ version: 1, value: 'default' });
  });

  it('HEALTHY file: constructor loads the on-disk data (untouched)', async () => {
    const { Store } = await import('../electronStoreShim');
    const filePath = path.join(userDataDir, 'healthy.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, value: 'REAL' }));

    const store = new Store<{ version: number; value: string }>({
      name: 'healthy',
      defaults: { version: 1, value: 'default' },
    });
    expect(store.get('value')).toBe('REAL');
  });

  it('CORRUPT JSON: constructor THROWS (does not swallow → no defaults seeded)', async () => {
    const { Store, CloudStoreLoadError } = await import('../electronStoreShim');
    const filePath = path.join(userDataDir, 'corrupt.json');
    const corruptBytes = Buffer.from('{ this is not valid json ', 'utf8');
    fs.writeFileSync(filePath, corruptBytes);
    const before = fs.readFileSync(filePath);

    expect(
      () =>
        new Store<{ version: number; value: string }>({
          name: 'corrupt',
          defaults: { version: 1, value: 'default' },
        }),
    ).toThrow(CloudStoreLoadError);

    // File preserved byte-for-byte: the throw means the constructor never wrote.
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });

  it('NON-ENOENT IO error (file is a directory): constructor THROWS, not swallow', async () => {
    const { Store, CloudStoreLoadError } = await import('../electronStoreShim');
    // A directory at the store path makes readFileSync throw EISDIR (non-ENOENT).
    fs.mkdirSync(path.join(userDataDir, 'isdir.json'));

    expect(
      () =>
        new Store<{ version: number }>({
          name: 'isdir',
          defaults: { version: 1 },
        }),
    ).toThrow(CloudStoreLoadError);
  });

  it('reload() on a now-corrupt file keeps in-memory data (no crash, no wipe)', async () => {
    const { Store } = await import('../electronStoreShim');
    const filePath = path.join(userDataDir, 'goes-bad.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, value: 'REAL' }));

    const store = new Store<{ version: number; value: string }>({
      name: 'goes-bad',
      defaults: { version: 1, value: 'default' },
    });
    expect(store.get('value')).toBe('REAL');

    // Corrupt the file post-construction, then reload.
    const corrupt = Buffer.from('}}} not json', 'utf8');
    fs.writeFileSync(filePath, corrupt);
    expect(() => store.reload()).not.toThrow();
    // In-memory snapshot retained; corrupt file untouched.
    expect(store.get('value')).toBe('REAL');
    expect(fs.readFileSync(filePath).equals(corrupt)).toBe(true);
  });

  // ── End-to-end: core store on the cloud factory + shared guard ───────────

  it('END-TO-END: a core store via safeCreateStore on the cloud factory → corrupt file preserved, read-only, write blocked', async () => {
    // Wire the cloud shim as the global store factory (mirrors cloud bootstrap).
    const { Store } = await import('../electronStoreShim');
    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory((opts) => new Store(opts as { name?: string }) as never);

    const { setPlatformConfig } = await import('@core/platform');
    setPlatformConfig({
      userDataPath: userDataDir,
      appPath: userDataDir,
      tempPath: os.tmpdir(),
      logsPath: path.join(userDataDir, 'logs'),
      homePath: userDataDir,
      documentsPath: userDataDir,
      desktopPath: userDataDir,
      appDataPath: userDataDir,
      version: '0.0.0-test',
      isPackaged: false,
      platform: process.platform,
      totalMemoryBytes: 0,
      arch: process.arch,
      surface: 'cloud',
      isOss: false,
      getAppMetrics: () => [],
    } as never);

    const { setErrorReporter } = await import('@core/errorReporter');
    const capture = vi.fn();
    setErrorReporter({
      captureException: capture,
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    } as never);

    const { safeCreateStore, __resetLoadFailureDedupForTests } = await import(
      '@core/utils/loadStoreSafely'
    );
    __resetLoadFailureDedupForTests();

    interface Shape extends Record<string, unknown> {
      version: number;
      value: string;
    }
    const defaults: Shape = { version: 1, value: 'default' };

    // Seed real data on disk, then corrupt the backing file.
    const filePath = path.join(userDataDir, 'core-shaped.json');
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, value: 'REAL-USER-DATA' }));
    const corruptBytes = Buffer.from('{ corrupt ', 'utf8');
    fs.writeFileSync(filePath, corruptBytes);
    const before = fs.readFileSync(filePath);

    const created = safeCreateStore<Shape>({ name: 'core-shaped', defaults }, defaults);

    // Guard engaged on cloud: load failed → ephemeral read-only store + defaults.
    expect(created.loadFailed).toBe(true);
    expect(created.store.get('value')).toBe('default');

    // The real corrupt file is preserved untouched...
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);

    // ...and a write through the ephemeral store does NOT persist over it.
    created.store.set('value', 'SHOULD-NOT-PERSIST');
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);

    // Failure was observable (raw backup + Sentry capture fired once).
    expect(capture).toHaveBeenCalledTimes(1);
    const backups = fs
      .readdirSync(path.join(userDataDir, 'backups'))
      .filter((f) => f.includes('core-shaped') && f.endsWith('.corrupt.bak'));
    expect(backups.length).toBe(1);
    expect(fs.readFileSync(path.join(userDataDir, 'backups', backups[0])).equals(before)).toBe(true);
  });

  it('END-TO-END: absent file via the cloud factory → fresh writable store (not read-only)', async () => {
    const { Store } = await import('../electronStoreShim');
    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory((opts) => new Store(opts as { name?: string }) as never);

    const { setPlatformConfig } = await import('@core/platform');
    setPlatformConfig({
      userDataPath: userDataDir,
      appPath: userDataDir,
      tempPath: os.tmpdir(),
      logsPath: path.join(userDataDir, 'logs'),
      homePath: userDataDir,
      documentsPath: userDataDir,
      desktopPath: userDataDir,
      appDataPath: userDataDir,
      version: '0.0.0-test',
      isPackaged: false,
      platform: process.platform,
      totalMemoryBytes: 0,
      arch: process.arch,
      surface: 'cloud',
      isOss: false,
      getAppMetrics: () => [],
    } as never);

    const { setErrorReporter } = await import('@core/errorReporter');
    setErrorReporter({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    } as never);

    const { safeCreateStore, __resetLoadFailureDedupForTests } = await import(
      '@core/utils/loadStoreSafely'
    );
    __resetLoadFailureDedupForTests();

    interface Shape extends Record<string, unknown> {
      version: number;
      value: string;
    }
    const defaults: Shape = { version: 1, value: 'default' };

    const created = safeCreateStore<Shape>({ name: 'fresh', defaults }, defaults);
    expect(created.loadFailed).toBe(false);

    // A real writable store: a write persists to disk.
    created.store.set('value', 'WRITTEN');
    const onDisk = JSON.parse(fs.readFileSync(path.join(userDataDir, 'fresh.json'), 'utf-8'));
    expect(onDisk.value).toBe('WRITTEN');
  });
});
