import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { AppSettings } from '@shared/types';
import { DEFAULT_DIAGNOSTICS_SETTINGS } from '@shared/types';

const tagFsExhaustionMock = vi.fn();

let persistedStore: Record<string, unknown> | null = null;
let seedStore: Record<string, unknown> = {};
let readErrorCodesQueue: Array<string | null> = [];
let writeErrorCodesQueue: Array<string | null> = [];

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const makeFsError = (code: string): NodeJS.ErrnoException => {
  const err = new Error(`${code}: too many open files`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
};

 
vi.mock('@core/utils/gracefulFsObservability', () => ({
  tagFsExhaustion: tagFsExhaustionMock,
}));

 
vi.mock('electron-store', () => ({
  default: class MockStore {
    constructor(opts?: { defaults?: Record<string, unknown> }) {
      if (persistedStore === null) {
        persistedStore = {
          ...deepClone(opts?.defaults ?? {}),
          ...deepClone(seedStore),
        };
      }
    }

    get store(): Record<string, unknown> {
      const code = readErrorCodesQueue.shift();
      if (code) {
        throw makeFsError(code);
      }
      return deepClone(persistedStore ?? {});
    }

    set store(val: Record<string, unknown>) {
      const code = writeErrorCodesQueue.shift();
      if (code) {
        throw makeFsError(code);
      }
      persistedStore = deepClone(val);
    }

    get(key: string): unknown {
      return deepClone((persistedStore ?? {})[key]);
    }

    set(key: string, val: unknown): void {
      const code = writeErrorCodesQueue.shift();
      if (code) {
        throw makeFsError(code);
      }
      persistedStore = { ...(persistedStore ?? {}), [key]: deepClone(val) };
    }

    delete(key: string): void {
      const code = writeErrorCodesQueue.shift();
      if (code) {
        throw makeFsError(code);
      }
      const next = { ...(persistedStore ?? {}) };
      delete next[key];
      persistedStore = next;
    }

    clear(): void {
      const code = writeErrorCodesQueue.shift();
      if (code) {
        throw makeFsError(code);
      }
      persistedStore = {};
    }
  },
}));

interface ErrorInjection {
  readErrors?: Array<string | null>;
  writeErrors?: Array<string | null>;
}

const loadSettingsStore = async (
  seed: Partial<AppSettings> = {},
  injection: ErrorInjection = {}
) => {
  vi.resetModules();
  tagFsExhaustionMock.mockClear();
  persistedStore = null;
  seedStore = deepClone(seed as Record<string, unknown>);
  readErrorCodesQueue = [...(injection.readErrors ?? [])];
  writeErrorCodesQueue = [...(injection.writeErrors ?? [])];
  return import('../settingsStore');
};

describe('settingsStore diagnostics snapshot (REBEL-56Q)', () => {
  beforeEach(() => {
    vi.resetModules();
    tagFsExhaustionMock.mockClear();
    persistedStore = null;
    seedStore = {};
    readErrorCodesQueue = [];
    writeErrorCodesQueue = [];
  });

  it('returns DEFAULT_DIAGNOSTICS_SETTINGS when cold-boot snapshot priming hits EMFILE', async () => {
    const { getDiagnosticsSnapshot } = await loadSettingsStore(
      {
        codexRepairSchemaVersion: 2,
        modelsNamespaceSchemaVersion: 2,
      } as Partial<AppSettings>,
      { readErrors: [null, null, 'EMFILE', 'EMFILE'] },
    );

    expect(getDiagnosticsSnapshot()).toEqual(DEFAULT_DIAGNOSTICS_SETTINGS);
  });

  it('refreshes diagnostics snapshot after settings writes', async () => {
    const { settingsStore, getDiagnosticsSnapshot } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      modelsNamespaceSchemaVersion: 2,
    } as Partial<AppSettings>);

    const nextDiagnostics = {
      ...DEFAULT_DIAGNOSTICS_SETTINGS,
      debugBreadcrumbsUntil: Date.now() + 60_000,
    };

    (settingsStore as unknown as { set: (key: string, value: unknown) => void }).set(
      'diagnostics',
      nextDiagnostics,
    );

    expect(getDiagnosticsSnapshot()).toEqual(nextDiagnostics);
  });

  it('keeps previous snapshot and tags EMFILE when refresh hits EMFILE', async () => {
    const { settingsStore, getDiagnosticsSnapshot } = await loadSettingsStore({
      codexRepairSchemaVersion: 2,
      modelsNamespaceSchemaVersion: 2,
    } as Partial<AppSettings>);

    const previousDiagnostics = {
      ...DEFAULT_DIAGNOSTICS_SETTINGS,
      debugBreadcrumbsUntil: Date.now() + 30_000,
    };
    settingsStore.store = {
      ...settingsStore.store,
      diagnostics: previousDiagnostics,
    } as AppSettings;
    expect(getDiagnosticsSnapshot()).toEqual(previousDiagnostics);

    const nextSettings = {
      ...settingsStore.store,
      diagnostics: {
        ...previousDiagnostics,
        debugBreadcrumbsUntil: Date.now() + 90_000,
      },
    } as AppSettings;

    readErrorCodesQueue = ['EMFILE', 'EMFILE'];
    tagFsExhaustionMock.mockClear();

    settingsStore.store = nextSettings;

    expect(getDiagnosticsSnapshot()).toEqual(previousDiagnostics);
    expect(tagFsExhaustionMock).toHaveBeenCalledWith(
      expect.any(Error),
      'diagnostics_snapshot_refresh',
    );
  });
});

describe('renderer log relay EMFILE guards (REBEL-56Q Layer A wiring)', () => {
  it('wraps log:event handler in EMFILE-aware try/catch', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(source).toContain("ipcMain.on('log:event'");
    expect(source).toContain("if (isTooManyOpenFilesError(error))");
    expect(source).toContain("tagFsExhaustion(error, 'log_event_handler')");
  });

  it('wraps console-message relay in EMFILE-aware try/catch', () => {
    // The console-message relay moved to the extracted main window factory
    // (Stage 3 of the index.ts startup refactor — see
    // docs/plans/260623_refactor-index-startup-extract/PLAN.md). The relay now
    // registers on the post-load `loadedWin` local rather than the `mainWindow`
    // global; the EMFILE-guard behaviour is preserved verbatim.
    const source = readFileSync(new URL('../startup/mainWindowFactory.ts', import.meta.url), 'utf8');

    expect(source).toContain("loadedWin.webContents.on('console-message'");
    expect(source).toContain("tagFsExhaustion(error, 'console_message_relay')");
    expect(source).toContain('maybeSurfaceFdExhaustionWarning()');
  });
});
