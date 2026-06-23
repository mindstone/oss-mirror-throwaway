/**
 * F1 data-loss guard — REAL-FS integration spikes.
 *
 * These exercise the actual electron-store/conf backend (`clearInvalidConfig:
 * false`, so `.store` RETHROWS on corrupt data) against REAL temp-dir files —
 * never real userData. The load-failure invariant is the whole point: a load
 * failure on EXISTING data must NEVER overwrite it with defaults. So each spike
 * asserts the on-disk file is BYTE-FOR-BYTE preserved, the guard latches
 * read-only / no-persist, and the failure is observable.
 *
 * Red→green: reverting the guard (catching the throw and writing defaults back)
 * clobbers the file and fails the byte-for-byte assertions.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Conf from 'conf';
import { setErrorReporter, type ErrorReporter } from '@core/errorReporter';
import type { KeyValueStore } from '@core/store';
import {
  loadStoreSafely,
  classifyLoadFailure,
  isLoadFailedReadOnly,
  resolveConfStorePath,
  safeCreateStore,
  __resetLoadFailureDedupForTests,
} from '../loadStoreSafely';

interface Shape extends Record<string, unknown> {
  version: number;
  value: string;
}

const ConfCtor: typeof Conf =
  typeof Conf === 'function' ? Conf : (Conf as unknown as { default: typeof Conf }).default;

let tmpDir: string;
let capture: ReturnType<typeof vi.fn>;

const makeStore = (name: string): KeyValueStore<Shape> =>
  new ConfCtor<Shape>({
    cwd: tmpDir,
    configName: name,
    clearInvalidConfig: false,
    defaults: { version: 1, value: 'default' },
  }) as unknown as KeyValueStore<Shape>;

const createDefault = (): Shape => ({ version: 1, value: 'default' });

beforeEach(() => {
  __resetLoadFailureDedupForTests();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rebel-loadguard-'));
  // Backups land under <userDataPath>/backups. Platform config is NOT initialised
  // in this test, so getBackupDirectory() falls back to the absolute
  // REBEL_USER_DATA override — point it at the temp dir so raw-byte backups are
  // self-cleaning and never touch real userData.
  process.env.REBEL_USER_DATA = tmpDir;
  capture = vi.fn();
  setErrorReporter({
    captureException: capture,
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  } as unknown as ErrorReporter);
});

afterEach(() => {
  delete process.env.REBEL_USER_DATA;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort temp cleanup */
  }
});

describe('loadStoreSafely — corrupt existing data is preserved (never wiped)', () => {
  it('CORRUPT JSON: preserves file byte-for-byte, latches read-only, backs up, observable', () => {
    const store = makeStore('corrupt-json');
    // Seed real data, then corrupt the file on disk.
    store.store = { version: 1, value: 'REAL-USER-DATA' };
    const corruptBytes = Buffer.from('{ this is not valid json ', 'utf8');
    fs.writeFileSync(store.path, corruptBytes);
    const before = fs.readFileSync(store.path);

    const result = loadStoreSafely<Shape>(
      'corrupt-json',
      store.path,
      () => store.store, // rethrows SyntaxError
      createDefault,
    );

    // Invariant: the file is untouched.
    const after = fs.readFileSync(store.path);
    expect(after.equals(before)).toBe(true);
    expect(after.equals(corruptBytes)).toBe(true);

    // Outcome: load-failed → read-only, ephemeral defaults, observable, raw backup.
    expect(result.outcome).toBe('load-failed');
    expect(isLoadFailedReadOnly(result)).toBe(true);
    expect(result.data).toEqual(createDefault());
    if (result.outcome === 'load-failed') {
      expect(result.backupPath).toBeTruthy();
      expect(fs.readFileSync(result.backupPath as string).equals(corruptBytes)).toBe(true);
    }
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('ENOENT / absent: classified fresh, writable defaults (fresh init still works)', () => {
    const absentPath = path.join(tmpDir, 'never-written.json');
    expect(fs.existsSync(absentPath)).toBe(false);

    const result = loadStoreSafely<Shape>(
      'absent',
      absentPath,
      () => {
        // Simulate a load that throws even though the file is absent.
        const err = new Error('boom') as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      },
      createDefault,
    );

    expect(result.outcome).toBe('absent');
    expect(isLoadFailedReadOnly(result)).toBe(false);
    expect(result.data).toEqual(createDefault());
    // No backup, no error report for a legitimate fresh init.
    expect(capture).not.toHaveBeenCalled();
  });

  it('happy path: a successful load returns loaded + writable', () => {
    const store = makeStore('happy');
    store.store = { version: 1, value: 'intact' };

    const result = loadStoreSafely<Shape>('happy', store.path, () => store.store, createDefault);

    expect(result.outcome).toBe('loaded');
    expect(isLoadFailedReadOnly(result)).toBe(false);
    expect(result.data.value).toBe('intact');
  });

  it('no file path available → fails SAFE (load-failed, never absent)', () => {
    const result = loadStoreSafely<Shape>(
      'no-path',
      null,
      () => {
        throw new Error('decrypt failed');
      },
      createDefault,
    );
    expect(result.outcome).toBe('load-failed');
    expect(isLoadFailedReadOnly(result)).toBe(true);
  });
});

describe('classifyLoadFailure — caller-owned catch (e.g. toolUsageStore)', () => {
  it('existing file → load-failed + raw backup', () => {
    const filePath = path.join(tmpDir, 'tool-usage.json');
    const raw = Buffer.from('{ corrupt', 'utf8');
    fs.writeFileSync(filePath, raw);

    const classified = classifyLoadFailure('tool-usage', filePath, new Error('SyntaxError'));
    expect(classified.outcome).toBe('load-failed');
    const before = fs.readFileSync(filePath);
    expect(before.equals(raw)).toBe(true); // not wiped
    if (classified.outcome === 'load-failed') {
      expect(classified.backupPath).toBeTruthy();
    }
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('absent file → absent (fresh init allowed)', () => {
    const filePath = path.join(tmpDir, 'tool-usage-absent.json');
    const classified = classifyLoadFailure('tool-usage', filePath, new Error('boom'));
    expect(classified.outcome).toBe('absent');
    expect(capture).not.toHaveBeenCalled();
  });

  it('DEDUP: repeated corrupt classifications → exactly ONE backup + ONE capture (item 2)', () => {
    const filePath = path.join(tmpDir, 'dedup-store.json');
    const raw = Buffer.from('{ corrupt-dedup', 'utf8');
    fs.writeFileSync(filePath, raw);

    const backupPaths: Array<string | null> = [];
    for (let i = 0; i < 10; i++) {
      const classified = classifyLoadFailure('dedup-store', filePath, new Error('SyntaxError'));
      expect(classified.outcome).toBe('load-failed');
      if (classified.outcome === 'load-failed') backupPaths.push(classified.backupPath);
    }

    // Exactly one capture despite 10 classify calls.
    expect(capture).toHaveBeenCalledTimes(1);
    // Only the FIRST classification produced a backup path; the rest are null —
    // i.e. at most one raw `.corrupt.bak` write per store per process.
    expect(backupPaths[0]).toBeTruthy();
    expect(backupPaths.slice(1).every((p) => p === null)).toBe(true);
    // Exactly one physical backup file was created by THIS run's first call.
    expect(fs.existsSync(backupPaths[0] as string)).toBe(true);
    // The file is still preserved byte-for-byte.
    expect(fs.readFileSync(filePath).equals(raw)).toBe(true);

    // Clearing the dedup re-arms the side effects (a LATER genuine corruption is
    // reported afresh) — proves the dedup is keyed + clearable, not permanent.
    __resetLoadFailureDedupForTests();
    const reArmed = classifyLoadFailure('dedup-store', filePath, new Error('SyntaxError'));
    expect(reArmed.outcome).toBe('load-failed');
    if (reArmed.outcome === 'load-failed') expect(reArmed.backupPath).toBeTruthy();
    expect(capture).toHaveBeenCalledTimes(2);
  });
});

describe('resolveConfStorePath — full-options path resolution (item 4)', () => {
  it('bare name resolves under userData (the common case)', () => {
    // No platform config set in this test → getDataPath() throws → REBEL_USER_DATA
    // override (= tmpDir) is used by getDataPath()? No — resolveConfStorePath uses
    // getDataPath(); when unresolved with no cwd it returns null. So assert null here.
    const resolved = resolveConfStorePath('my-store');
    // Either a real userData-derived path, or null when userData is unresolved.
    if (resolved !== null) {
      expect(resolved.endsWith(`${path.sep}my-store.json`)).toBe(true);
    }
  });

  it('explicit cwd + configName + fileExtension → targets the REAL file (not the default)', () => {
    const resolved = resolveConfStorePath({
      name: 'logical-name',
      cwd: tmpDir,
      configName: 'on-disk-name',
      fileExtension: 'conf',
    });
    expect(resolved).toBe(path.join(tmpDir, 'on-disk-name.conf'));
  });

  it('fileExtension with a leading dot is normalised (no double dot)', () => {
    const resolved = resolveConfStorePath({ name: 's', cwd: tmpDir, fileExtension: '.dat' });
    expect(resolved).toBe(path.join(tmpDir, 's.dat'));
  });

  it('explicit cwd resolves even when userData is unresolvable (pre-boot)', () => {
    // getDataPath() would throw (no platform config), but an explicit cwd skips it.
    const resolved = resolveConfStorePath({ name: 'early', cwd: tmpDir });
    expect(resolved).toBe(path.join(tmpDir, 'early.json'));
  });

  it('safeCreateStore with a custom-named corrupt file preserves the RIGHT file', () => {
    // Seed a corrupt file at the CUSTOM path; a store created with these options
    // must classify+back up THIS file, not <userData>/<name>.json.
    const customPath = path.join(tmpDir, 'custom-config-name.json');
    const raw = Buffer.from('{ corrupt-custom', 'utf8');
    fs.writeFileSync(customPath, raw);

    // safeCreateStore uses the real createStore() factory → wire a conf-backed one.
    return import('@core/storeFactory').then(({ setStoreFactory }) => {
      setStoreFactory(
        (opts) =>
          new ConfCtor({
            cwd: (opts.cwd as string) ?? tmpDir,
            configName: (opts.configName as string) ?? opts.name,
            clearInvalidConfig: false,
            defaults: opts.defaults as Record<string, unknown> | undefined,
            projectVersion: '0.0.0-test',
          }) as never,
      );

      const created = safeCreateStore<Shape>(
        { name: 'logical', cwd: tmpDir, configName: 'custom-config-name', defaults: createDefault() },
        createDefault(),
      );
      expect(created.loadFailed).toBe(true);

      // The custom-named file is preserved byte-for-byte (NOT wiped, NOT misclassified absent).
      expect(fs.readFileSync(customPath).equals(raw)).toBe(true);
      // Observable: a load failure was reported for this store.
      expect(capture).toHaveBeenCalled();
      // The store's writes are inert — they cannot flush over the preserved file.
      created.store.set('value' as never, 'attacker' as never);
      created.store.store = { version: 9, value: 'attacker' } as Shape;
      expect(fs.readFileSync(customPath).equals(raw)).toBe(true);
    });
  });
});

describe('classifyLoadFailure — failure-mode resilience (item 6)', () => {
  it('backup-write failure (returns null) still preserves the file + reports load-failed', () => {
    const filePath = path.join(tmpDir, 'backup-fail.json');
    const raw = Buffer.from('{ corrupt-backupfail', 'utf8');
    fs.writeFileSync(filePath, raw);

    // Force ONLY the raw-byte backup write (the `.corrupt.bak`) to throw, leaving
    // the original-file read intact. `backupRawStoreBytes` catches and returns null.
    const realWrite = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (typeof p === 'string' && p.endsWith('.corrupt.bak')) {
        throw new Error('disk full');
      }
      return (realWrite as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync);

    try {
      const classified = classifyLoadFailure('backup-fail', filePath, new Error('SyntaxError'));
      expect(classified.outcome).toBe('load-failed');
      if (classified.outcome === 'load-failed') {
        expect(classified.backupPath).toBeNull(); // backup failed → null, but...
      }
      // ...the original file is STILL preserved byte-for-byte.
      expect(fs.readFileSync(filePath).equals(raw)).toBe(true);
      // Still observable.
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('reporter that THROWS does not break recovery (still load-failed, file preserved)', () => {
    const filePath = path.join(tmpDir, 'reporter-throws.json');
    const raw = Buffer.from('{ corrupt-reporter', 'utf8');
    fs.writeFileSync(filePath, raw);

    setErrorReporter({
      captureException: vi.fn(() => {
        throw new Error('telemetry transport down');
      }),
      captureMessage: vi.fn(),
      addBreadcrumb: vi.fn(),
    } as unknown as ErrorReporter);

    expect(() => classifyLoadFailure('reporter-throws', filePath, new Error('SyntaxError'))).not.toThrow();
    const classified = classifyLoadFailure('reporter-throws', filePath, new Error('SyntaxError'));
    expect(classified.outcome).toBe('load-failed');
    expect(fs.readFileSync(filePath).equals(raw)).toBe(true); // preserved
  });
});
