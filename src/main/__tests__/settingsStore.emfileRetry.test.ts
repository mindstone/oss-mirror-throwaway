/**
 * Tests for Stage 1.5 EMFILE retry wrap on settingsStore.
 *
 * Verifies that withSingleSyncRetryOnEmfile is correctly applied to the
 * three sync fs sites in settingsStore that graceful-fs cannot patch:
 *   1. getCachedSettings() cache-miss read of `_rawSettingsStore.store`.
 *   2. bootstrapCodexRepairMigration() — both the read of
 *      `_rawSettingsStore.store` and the conditional write back.
 *   3. Proxy `set` handler for `prop === 'store'` (belt-and-braces).
 *
 * REBEL-1C8 crash site. See docs/plans/260428_graceful_fs_emfile_fix.md
 * Stage 1.5 for the rationale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings } from '@shared/types';

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};
let storeReadCount = 0;
let storeWriteCount = 0;
let readErrorCodesQueue: string[] = [];
let writeErrorCodesQueue: string[] = [];

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const makeFsError = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code}: too many open files`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

 
vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown>; name?: string }) {
      if (persistedStore === null) {
        persistedStore = {
          ...deepClone(opts?.defaults ?? {}),
          ...deepClone(seedStore),
        };
      }
    }

    get store(): Record<string, unknown> {
      storeReadCount++;
      const code = readErrorCodesQueue.shift();
      if (code) {
        throw makeFsError(code);
      }
      return deepClone(persistedStore ?? {});
    }

    set store(val: Record<string, unknown>) {
      storeWriteCount++;
      const code = writeErrorCodesQueue.shift();
      if (code) {
        throw makeFsError(code);
      }
      persistedStore = deepClone(val);
    }

    get(key: string): unknown {
      return (persistedStore ?? {})[key];
    }

    set(key: string, val: unknown): void {
      persistedStore = { ...(persistedStore ?? {}), [key]: deepClone(val) };
    }

    delete(key: string): void {
      const next = { ...(persistedStore ?? {}) };
      delete next[key];
      persistedStore = next;
    }

    clear(): void {
      persistedStore = {};
    }
  },
}));

interface ErrorInjection {
  readErrors?: string[];
  writeErrors?: string[];
}

const loadSettingsStore = async (
  seed: Partial<AppSettings> = {},
  injection: ErrorInjection = {}
) => {
  vi.resetModules();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  storeReadCount = 0;
  storeWriteCount = 0;
  readErrorCodesQueue = [...(injection.readErrors ?? [])];
  writeErrorCodesQueue = [...(injection.writeErrors ?? [])];
  const mod = await import('../settingsStore');
  // The one-shot bootstrap migrations + diagnostics-snapshot prime used to run at
  // module-load time; they are now DEFERRED to first settings access (the OSS
  // boot-crash fix). Trigger that first access here so this helper reproduces the
  // old import-time boot exactly: any injected read/write error queue is consumed
  // at this trigger (matching the `bootstrap migration path retries on EMFILE`
  // test), and tests that reset the read/write counters AFTER loadSettingsStore
  // measure only post-boot runtime I/O.
  mod.getSettings();
  return mod;
};

describe('settingsStore Stage 1.5 — withSingleSyncRetryOnEmfile wrap', () => {
  beforeEach(() => {
    persistedStore = null;
    seedStore = {};
    storeReadCount = 0;
    storeWriteCount = 0;
    readErrorCodesQueue = [];
    writeErrorCodesQueue = [];
    vi.resetModules();
  });

  it('bootstrap priming keeps getSettings() in-memory even when disk reads would EMFILE', async () => {
    const { getSettings } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      modelsNamespaceSchemaVersion: 2,
    } as Partial<AppSettings>);

    storeReadCount = 0;
    readErrorCodesQueue = ['EMFILE', 'EMFILE'];

    const settings = getSettings();

    expect(settings).toBeTruthy();
    expect(storeReadCount).toBe(0);
    expect(readErrorCodesQueue).toEqual(['EMFILE', 'EMFILE']);
  });

  it('store= write retries once on EMFILE and then succeeds', async () => {
    const { settingsStore } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      modelsNamespaceSchemaVersion: 2,
    } as Partial<AppSettings>);

    storeWriteCount = 0;
    writeErrorCodesQueue = ['EMFILE'];
    const next = { ...settingsStore.store, theme: 'light' } as AppSettings;

    settingsStore.store = next;

    expect(storeWriteCount).toBe(2);
    expect(writeErrorCodesQueue).toHaveLength(0);
    expect((persistedStore ?? {}).theme).toBe('light');
  });

  it('store= write does NOT retry on non-EMFILE errors', async () => {
    const { settingsStore } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      modelsNamespaceSchemaVersion: 2,
    } as Partial<AppSettings>);

    storeWriteCount = 0;
    writeErrorCodesQueue = ['EACCES', 'EACCES'];
    const next = { ...settingsStore.store, theme: 'light' } as AppSettings;

    let caught: NodeJS.ErrnoException | undefined;
    try {
      settingsStore.store = next;
    } catch (e) {
      caught = e as NodeJS.ErrnoException;
    }

    expect(caught?.code).toBe('EACCES');
    expect(storeWriteCount).toBe(1);
    expect(writeErrorCodesQueue).toEqual(['EACCES']);
  });

  it('bootstrap migration path retries on EMFILE during initial read', async () => {
    // No `codexRepairSchemaVersion` → migration stamps the schema version (1 write).
    // Inject EMFILE on the very first store read (during bootstrap).
    await loadSettingsStore({} as Partial<AppSettings>, {
      readErrors: ['EMFILE'],
    });

    // Bootstrap performs five migrations plus diagnostics snapshot priming:
    //   * Codex repair: 1 EMFILE read + 1 success read = 2 reads, 1 write (stamp).
    //   * OR provider heal: 1 read, 1 write (stamp).
    //   * Models namespace: 1 read, 1 write (claude→models migration since
    //     DEFAULT_SETTINGS.claude is defined and models is undefined).
    //   * OR profileSource migration: 1 read, 1 write (version stamp with no eligible
    //     legacy OR profiles in defaults).
    //   * BTS auto-profile reroute migration: 1 read, 1 write (version stamp on first
    //     boot with no auto-profile references found — 260521 BTS Haiku-fallback A3).
    //   * diagnostics snapshot boot prime: 1 read.
    expect(storeReadCount).toBe(7);
    expect(storeWriteCount).toBe(5);
    expect(readErrorCodesQueue).toHaveLength(0);

    // Sanity: persistedStore now carries the stamped schema version
    expect((persistedStore ?? {}).codexRepairSchemaVersion).toBe(2);
  });
});
