/**
 * F2 — communityShareStore corrupt-construct guard (REAL-FS integration spike).
 *
 * communityShareStore persists REAL user data (optedOut, eligibility, previews).
 * It was constructed via a bare `createStore()`, so a corrupt backing file would
 * throw at construct time and (now that the cloud shim throws too) crash init.
 * Routing it through `safeCreateStore` makes a corrupt construct PRESERVE the raw
 * file, back it up, and latch the store read-only — instead of wiping.
 *
 * This wires a REAL conf store (`clearInvalidConfig:false`, so `.store` throws on
 * corrupt data) as the factory against a temp-dir file — never real userData.
 *
 * Red→green: revert communityShareStore to the bare `createStore()` and the
 * "construct does not throw / file preserved / read-only" assertions fail.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Conf from 'conf';

const ConfCtor: typeof Conf =
  typeof Conf === 'function' ? Conf : (Conf as unknown as { default: typeof Conf }).default;

let tmpDir: string;

const setupModule = async () => {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-communityshare-corrupt-'));
  process.env.REBEL_USER_DATA = tmpDir;

  const { setPlatformConfig } = await import('@core/platform');
  setPlatformConfig({
    userDataPath: tmpDir,
    appPath: tmpDir,
    tempPath: os.tmpdir(),
    logsPath: path.join(tmpDir, 'logs'),
    homePath: tmpDir,
    documentsPath: tmpDir,
    desktopPath: tmpDir,
    appDataPath: tmpDir,
    version: '0.0.0-test',
    isPackaged: false,
    platform: process.platform,
    totalMemoryBytes: 0,
    arch: process.arch,
    surface: 'desktop',
    isOss: false,
    getAppMetrics: () => [],
  } as never);

  // Real conf store as the factory: throws at construct on corrupt files.
  const { setStoreFactory } = await import('@core/storeFactory');
  setStoreFactory(
    (opts) =>
      new ConfCtor({
        cwd: tmpDir,
        configName: opts.name,
        clearInvalidConfig: false,
        defaults: opts.defaults,
      }) as never,
  );

  const { setErrorReporter } = await import('@core/errorReporter');
  setErrorReporter({
    captureException: vi.fn(),
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  } as never);

  const { __resetLoadFailureDedupForTests } = await import('@core/utils/loadStoreSafely');
  __resetLoadFailureDedupForTests();

  return await import('../communityShareStore');
};

afterEach(() => {
  delete process.env.REBEL_USER_DATA;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

describe('communityShareStore — corrupt-construct guard (F2)', () => {
  it('CORRUPT file: first touch does NOT throw, preserves the raw file, and latches read-only', async () => {
    // setupModule() creates the temp dir + wires the factory but does NOT
    // touch the store (lazy getStore()). Seed the corrupt file afterwards, so
    // it's present at the first store construction (the first writer below).
    const store = await setupModule();
    const filePath = path.join(tmpDir, 'community-share.json');
    const corruptBytes = Buffer.from('{ not valid json', 'utf8');
    fs.writeFileSync(filePath, corruptBytes);
    const before = fs.readFileSync(filePath);

    // A writer first-touches the store; the guard must engage without throwing.
    expect(() => store.setOptedOut(true)).not.toThrow();

    // The corrupt file is preserved byte-for-byte (no wipe, no defaults written).
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);

    // Read-only latch: a subsequent write is also a no-op on disk.
    expect(() => store.markSessionEvaluated('sess-1')).not.toThrow();
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });

  it('ABSENT file: fresh init works and writes persist', async () => {
    const store = await setupModule();
    store.setOptedOut(true);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tmpDir, 'community-share.json'), 'utf-8'),
    );
    expect(onDisk.optedOut).toBe(true);
  });

  it('HEALTHY file: existing data is read, not clobbered', async () => {
    // setupModule() wires the factory + temp dir; we then seed a healthy file and
    // re-import so the store reads it at first construct (below).
    await setupModule();
    const filePath = path.join(tmpDir, 'community-share.json');
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        optedOut: true,
        evaluatedSessionIds: ['kept'],
        eligibleSessions: {},
        previews: {},
        dailyCount: 0,
        dailyCountDate: '',
      }),
    );

    // Re-import so the store reads the just-written file at first construct.
    vi.resetModules();
    const { setPlatformConfig } = await import('@core/platform');
    setPlatformConfig({
      userDataPath: tmpDir,
      appPath: tmpDir,
      tempPath: os.tmpdir(),
      logsPath: path.join(tmpDir, 'logs'),
      homePath: tmpDir,
      documentsPath: tmpDir,
      desktopPath: tmpDir,
      appDataPath: tmpDir,
      version: '0.0.0-test',
      isPackaged: false,
      platform: process.platform,
      totalMemoryBytes: 0,
      arch: process.arch,
      surface: 'desktop',
      isOss: false,
      getAppMetrics: () => [],
    } as never);
    const { setStoreFactory } = await import('@core/storeFactory');
    setStoreFactory(
      (opts) =>
        new ConfCtor({
          cwd: tmpDir,
          configName: opts.name,
          clearInvalidConfig: false,
          defaults: opts.defaults,
        }) as never,
    );
    const { setErrorReporter } = await import('@core/errorReporter');
    setErrorReporter({
      captureException: vi.fn(),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    } as never);
    const fresh = await import('../communityShareStore');

    expect(fresh.isOptedOut()).toBe(true);
    expect(fresh.isSessionEvaluated('kept')).toBe(true);
  });
});
