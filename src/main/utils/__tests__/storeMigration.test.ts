import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VersionedData, StoreMigrationConfig, MigrationFn } from '../storeMigration';

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn()
};

const mockFs = {
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn()
};

const mockApp = {
  getPath: vi.fn().mockReturnValue('/mock/userData')
};

// Controllable platform-config seam: the backup directory is derived from
// getPlatformConfig().userDataPath. Tests drive it to the happy path (resolves a
// userData path) or the uninitialized path (throws) to exercise the no-cwd-litter
// fallback. Default behavior is set in beforeEach.
const mockGetPlatformConfig = vi.fn();

const mockCaptureException = vi.fn();

vi.mock('electron', () => ({
  app: mockApp
}));

vi.mock('@core/errorReporter', () => ({
  getErrorReporter: () => ({
    captureException: mockCaptureException,
    captureMessage: vi.fn(),
    addBreadcrumb: vi.fn(),
  }),
  setErrorReporter: vi.fn(),
}));

vi.mock('node:fs', () => ({
  default: mockFs
}));

vi.mock('@core/logger', () => ({
  logger: mockLogger
}));

vi.mock('@core/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@core/platform')>();
  return { ...actual, getPlatformConfig: mockGetPlatformConfig };
});

interface TestStoreData extends VersionedData {
  version: number;
  name: string;
  count?: number;
  items?: string[];
}

const createTestConfig = (
  overrides: Partial<StoreMigrationConfig<TestStoreData>> = {}
): StoreMigrationConfig<TestStoreData> => ({
  storeName: 'test-store',
  currentVersion: 3,
  migrations: {
    1: (data) => ({
      ...data,
      version: 2,
      count: data.count ?? 0
    }),
    2: (data) => ({
      ...data,
      version: 3,
      items: data.items ?? []
    })
  },
  createDefault: () => ({
    version: 3,
    name: 'default',
    count: 0,
    items: []
  }),
  ...overrides
});

describe('storeMigration', () => {
  let migrateStore: typeof import('../storeMigration').migrateStore;
  let validateMigrationCoverage: typeof import('../storeMigration').validateMigrationCoverage;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Default: platform config resolves a userData path (production happy path).
    mockGetPlatformConfig.mockReturnValue({ userDataPath: '/mock/userData' });
    const mod = await import('../storeMigration');
    migrateStore = mod.migrateStore;
    validateMigrationCoverage = mod.validateMigrationCoverage;
  });

  describe('migrateStore', () => {
    describe('fresh data (no existing store)', () => {
      it('returns fresh defaults when stored is null', () => {
        const config = createTestConfig();
        const result = migrateStore(null, config);

        expect(result.status).toBe('fresh');
        expect(result.data.version).toBe(3);
        expect(result.data.name).toBe('default');
        expect(result.fromVersion).toBeNull();
        expect(result.toVersion).toBe(3);
        expect(result.shouldPersist).toBe(true);
        expect(result.backupPath).toBeNull();
      });

      it('returns fresh defaults when stored is undefined', () => {
        const config = createTestConfig();
        const result = migrateStore(undefined, config);

        expect(result.status).toBe('fresh');
        expect(result.shouldPersist).toBe(true);
      });
    });

    describe('corrupted data', () => {
      it('empty {} → seeds defaults AND persists (fresh-init path, not read-only)', () => {
        const config = createTestConfig();
        const result = migrateStore({}, config);

        expect(result.status).toBe('corrupted');
        expect(result.data.version).toBe(3);
        // An empty object is what a brand-new store looks like before its first
        // write — there is no real data to protect, so initialization must
        // proceed (shouldPersist: true, NOT read-only).
        expect(result.shouldPersist).toBe(true);
      });

      it('NON-EMPTY version-less data → does NOT persist defaults (preserve real data, read-only)', () => {
        const config = createTestConfig();
        const result = migrateStore({ items: [1, 2, 3], name: 'real-but-unversioned' }, config);

        expect(result.status).toBe('corrupted');
        expect(result.data.version).toBe(3);
        // Present-but-unversioned data could be REAL data whose version field was
        // lost. Overwriting it with defaults is the data-reset class — so keep
        // defaults in memory only, back up the raw data, and DON'T persist.
        expect(result.shouldPersist).toBe(false);
        expect(result.backupPath).not.toBeNull();
        expect(mockFs.writeFileSync).toHaveBeenCalled();
        expect(mockCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: expect.objectContaining({ operation: 'migrateStore.corrupted', storeName: 'test-store' }),
          }),
        );
      });

      it('treats data with non-numeric version as corrupted', () => {
        const config = createTestConfig();
        const result = migrateStore({ version: 'invalid', name: 'bad' }, config);

        expect(result.status).toBe('corrupted');
        expect(result.data.version).toBe(3);
      });

      it('treats data with NaN version as corrupted', () => {
        const config = createTestConfig();
        const result = migrateStore({ version: NaN, name: 'bad' }, config);

        expect(result.status).toBe('corrupted');
      });

      it('treats data with Infinity version as corrupted', () => {
        const config = createTestConfig();
        const result = migrateStore({ version: Infinity, name: 'bad' }, config);

        expect(result.status).toBe('corrupted');
      });
    });

    describe('current version (no migration needed)', () => {
      it('returns data as-is when version matches current', () => {
        const config = createTestConfig();
        const stored: TestStoreData = {
          version: 3,
          name: 'existing',
          count: 42,
          items: ['a', 'b']
        };

        const result = migrateStore(stored, config);

        expect(result.status).toBe('current');
        expect(result.data).toEqual(stored);
        expect(result.fromVersion).toBe(3);
        expect(result.toVersion).toBe(3);
        expect(result.shouldPersist).toBe(false);
        expect(result.backupPath).toBeNull();
        expect(mockFs.writeFileSync).not.toHaveBeenCalled();
      });
    });

    describe('future version (newer app version)', () => {
      it('returns data as-is and does NOT persist for future versions', () => {
        const config = createTestConfig();
        const stored: TestStoreData = {
          version: 5,
          name: 'future-data',
          count: 100,
          items: ['future']
        };

        const result = migrateStore(stored, config);

        expect(result.status).toBe('future_version');
        expect(result.data).toEqual(stored);
        expect(result.fromVersion).toBe(5);
        expect(result.toVersion).toBe(5);
        expect(result.shouldPersist).toBe(false);
        expect(result.backupPath).toBeNull();
        expect(mockFs.writeFileSync).not.toHaveBeenCalled();
      });

      it('logs warning for future version', () => {
        const config = createTestConfig();
        migrateStore({ version: 10, name: 'way-future' }, config);

        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            storeName: 'test-store',
            storedVersion: 10,
            currentVersion: 3
          }),
          expect.any(String)
        );
      });
    });

    describe('migration from older versions', () => {
      it('migrates from v1 to v3 through all steps', () => {
        const config = createTestConfig();
        const stored: TestStoreData = {
          version: 1,
          name: 'old-data'
        };

        const result = migrateStore(stored, config);

        expect(result.status).toBe('migrated');
        expect(result.data.version).toBe(3);
        expect(result.data.name).toBe('old-data');
        expect(result.data.count).toBe(0);
        expect(result.data.items).toEqual([]);
        expect(result.fromVersion).toBe(1);
        expect(result.toVersion).toBe(3);
        expect(result.shouldPersist).toBe(true);
      });

      it('migrates from v2 to v3 (single step)', () => {
        const config = createTestConfig();
        const stored: TestStoreData = {
          version: 2,
          name: 'v2-data',
          count: 5
        };

        const result = migrateStore(stored, config);

        expect(result.status).toBe('migrated');
        expect(result.data.version).toBe(3);
        expect(result.data.count).toBe(5);
        expect(result.data.items).toEqual([]);
      });

      it('creates backup before migration', () => {
        const config = createTestConfig();
        const stored: TestStoreData = { version: 1, name: 'backup-me' };

        const result = migrateStore(stored, config);

        expect(mockFs.mkdirSync).toHaveBeenCalledWith(
          expect.stringContaining('backups'),
          expect.any(Object)
        );
        expect(mockFs.writeFileSync).toHaveBeenCalledWith(
          expect.stringMatching(/test-store-v1-.*\.json$/),
          expect.any(String),
          'utf8'
        );
        expect(result.backupPath).toMatch(/test-store-v1-.*\.json$/);
      });

      it('scrubs app-settings secrets from migration backups', () => {
        const config = createTestConfig({
          storeName: 'app-settings',
        });
        const stored = {
          version: 1,
          name: 'settings',
          providerKeys: { openai: 'fake-secret-provider' },
          claude: { apiKey: 'fake-ant-secret' },
          customProviders: [{ id: 'cohere', apiKey: 'cohere-secret' }],
        } as unknown as TestStoreData;

        migrateStore(stored, config);

        const backupJson = mockFs.writeFileSync.mock.calls.at(-1)?.[1] as string;
        expect(backupJson).not.toContain('fake-secret-provider');
        expect(backupJson).not.toContain('fake-ant-secret');
        expect(backupJson).not.toContain('cohere-secret');
        // SSOT name-pattern scrub: `providerKeys` matches `^providerKeys$` so
        // the whole map is blanked; per-field secret keys (claude.apiKey,
        // customProviders[].apiKey) are blanked individually.
        expect(JSON.parse(backupJson)).toMatchObject({
          providerKeys: '',
          claude: { apiKey: '' },
          customProviders: [{ apiKey: '' }],
        });
      });

      it('preserves existing data during migration', () => {
        const config = createTestConfig();
        const stored: TestStoreData = {
          version: 1,
          name: 'preserve-me',
          count: 999
        };

        const result = migrateStore(stored, config);

        expect(result.data.name).toBe('preserve-me');
        expect(result.data.count).toBe(999);
      });
    });

    describe('backup directory resolution (never litters process.cwd())', () => {
      // Regression guard: storeMigration used to fall back to
      // `path.join(process.cwd(), 'backups')` when platform config was not yet
      // initialized, which littered whatever dir the process started in (the repo
      // root, under the packaged-app boot smoke / dev / CLI). The backup is now
      // resolved to a non-cwd location: an absolute REBEL_USER_DATA override if
      // set (co-located + harness-cleanable), else os.tmpdir(). Never cwd.
      const tmpBackups = path.join(os.tmpdir(), 'rebel-store-backups');
      const withEnv = (value: string | undefined, fn: () => void): void => {
        const prev = process.env.REBEL_USER_DATA;
        if (value === undefined) delete process.env.REBEL_USER_DATA;
        else process.env.REBEL_USER_DATA = value;
        try {
          fn();
        } finally {
          if (prev === undefined) delete process.env.REBEL_USER_DATA;
          else process.env.REBEL_USER_DATA = prev;
        }
      };
      const lastWrittenPath = (): string =>
        mockFs.writeFileSync.mock.calls.at(-1)?.[0] as string;

      it('falls back to os.tmpdir() (never cwd) when platform config is uninitialized and REBEL_USER_DATA is unset', () => {
        mockGetPlatformConfig.mockImplementation(() => {
          throw new Error('PlatformConfig not initialized');
        });
        withEnv(undefined, () => {
          const config = createTestConfig();
          const result = migrateStore({ version: 1, name: 'old' }, config);

          // Migration completes AND the backup is preserved — just never in cwd.
          expect(result.status).toBe('migrated');
          expect(result.data.version).toBe(3);
          expect(mockFs.mkdirSync).toHaveBeenCalledWith(tmpBackups, expect.any(Object));
          expect(lastWrittenPath().startsWith(tmpBackups)).toBe(true);
          expect(lastWrittenPath()).not.toContain(process.cwd());
          expect(result.backupPath).not.toBeNull();
        });
      });

      it('ignores a RELATIVE REBEL_USER_DATA and uses os.tmpdir() (never cwd-relative)', () => {
        mockGetPlatformConfig.mockImplementation(() => {
          throw new Error('PlatformConfig not initialized');
        });
        // A relative override would make path.join(override, 'backups') resolve
        // against cwd — exactly the litter we are eliminating. Only absolute
        // overrides are honored; otherwise we fall through to tmpdir.
        withEnv('relative/data/dir', () => {
          const config = createTestConfig();
          const result = migrateStore({ version: 1, name: 'old' }, config);

          expect(result.status).toBe('migrated');
          expect(mockFs.mkdirSync).toHaveBeenCalledWith(tmpBackups, expect.any(Object));
          expect(lastWrittenPath().startsWith(tmpBackups)).toBe(true);
          expect(lastWrittenPath()).not.toContain(process.cwd());
        });
      });

      it('writes the backup under an ABSOLUTE REBEL_USER_DATA (not cwd, not tmpdir) when platform config is uninitialized', () => {
        mockGetPlatformConfig.mockImplementation(() => {
          throw new Error('PlatformConfig not initialized');
        });
        withEnv('/override/userData', () => {
          const config = createTestConfig();
          const result = migrateStore({ version: 1, name: 'old' }, config);

          expect(result.status).toBe('migrated');
          const expectedDir = path.join('/override/userData', 'backups');
          expect(mockFs.mkdirSync).toHaveBeenCalledWith(expectedDir, expect.any(Object));
          expect(lastWrittenPath().startsWith(expectedDir)).toBe(true);
          expect(lastWrittenPath()).not.toContain(process.cwd());
          expect(result.backupPath).not.toBeNull();
        });
      });
    });

    describe('migration error handling', () => {
      it('falls back to defaults when migration step is missing', () => {
        const config = createTestConfig({
          migrations: {
            1: (data) => ({ ...data, version: 2 })
            // Missing migration for v2 -> v3
          }
        });
        const stored: TestStoreData = { version: 1, name: 'test' };

        const result = migrateStore(stored, config);

        expect(result.status).toBe('corrupted');
        expect(result.data.version).toBe(3);
        expect(result.data.name).toBe('default');
        // Migration failure must be non-destructive: keep defaults in memory but
        // never persist them over the real (un-migratable) on-disk data.
        expect(result.shouldPersist).toBe(false);
        expect(mockLogger.error).toHaveBeenCalledWith(
          expect.objectContaining({ storeName: 'test-store' }),
          expect.stringContaining('Missing migration from v2 to v3')
        );
      });

      it('falls back to defaults when migration throws', () => {
        const config = createTestConfig({
          migrations: {
            1: () => {
              throw new Error('Migration exploded');
            },
            2: (data) => ({ ...data, version: 3 })
          }
        });
        const stored: TestStoreData = { version: 1, name: 'boom' };

        const result = migrateStore(stored, config);

        expect(result.status).toBe('corrupted');
        expect(result.data.version).toBe(3);
        expect(result.data.name).toBe('default');
        expect(result.backupPath).not.toBeNull();
        // DATA-SAFETY CONTRACT (core of this change): a throwing migration must
        // return shouldPersist:false so the caller never writes defaults over
        // the user's real store. (Red before the fix: this was `true`.)
        expect(result.shouldPersist).toBe(false);
        // The failure is observable, not silent.
        expect(mockCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: expect.objectContaining({ operation: 'migrateStore.corrupted', storeName: 'test-store' }),
            extra: expect.objectContaining({ fromVersion: 1 }),
          }),
        );
      });

      it('reporting failure inside the corrupted branch does not break the load (best-effort)', () => {
        mockCaptureException.mockImplementationOnce(() => {
          throw new Error('reporter transport down');
        });
        const config = createTestConfig({
          migrations: {
            1: () => {
              throw new Error('Migration exploded');
            },
            2: (data) => ({ ...data, version: 3 }),
          },
        });
        const stored: TestStoreData = { version: 1, name: 'boom' };

        // Must NOT throw even though the reporter throws.
        const result = migrateStore(stored, config);

        expect(result.status).toBe('corrupted');
        expect(result.shouldPersist).toBe(false);
      });

      it('auto-corrects version if migration forgets to update it', () => {
        const config = createTestConfig({
          currentVersion: 2,
          migrations: {
            1: (data) => ({ ...data }) // Forgot to update version
          }
        });
        const stored: TestStoreData = { version: 1, name: 'test' };

        const result = migrateStore(stored, config);

        expect(result.data.version).toBe(2);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ expected: 2, actual: 1 }),
          expect.stringContaining('did not update version')
        );
      });

      // #4 — wrong-version-return observability. A migration that forgets to set
      // the target version is coerced (non-destructive, data still usable) but
      // must be OBSERVABLE so the silent coercion can't mask a buggy migration
      // forever. Keep coercion; add a deduped captureException.
      it('reports wrong-version-return observably while staying non-destructive (data usable)', () => {
        const config = createTestConfig({
          currentVersion: 2,
          migrations: {
            1: (data) => ({ ...data, name: 'transformed' }) // Forgot to bump version
          }
        });
        const stored: TestStoreData = { version: 1, name: 'test' };

        const result = migrateStore(stored, config);

        // Non-destructive: data is coerced to the right version and still usable.
        expect(result.status).toBe('migrated');
        expect(result.data.version).toBe(2);
        expect(result.data.name).toBe('transformed');
        expect(result.shouldPersist).toBe(true);
        // Observable, not silent.
        expect(mockCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: expect.objectContaining({
              operation: 'migrateStore.wrongVersionReturn',
              storeName: 'test-store',
            }),
            extra: expect.objectContaining({ expectedVersion: 2, actualVersion: 1 }),
          }),
        );
      });

      it('dedupes the wrong-version-return report per (store, step) within a process', () => {
        const config = createTestConfig({
          currentVersion: 2,
          migrations: {
            1: (data) => ({ ...data }) // Forgot to bump version, every load
          }
        });

        migrateStore({ version: 1, name: 'a' }, config);
        migrateStore({ version: 1, name: 'b' }, config);

        const wrongVersionCalls = mockCaptureException.mock.calls.filter(
          (call) =>
            (call[1] as { tags?: { operation?: string } })?.tags?.operation ===
            'migrateStore.wrongVersionReturn',
        );
        expect(wrongVersionCalls).toHaveLength(1);
      });
    });

    // F2 — backup-fail-closed. When the pre-migration backup cannot be written
    // (createBackup → null), an old-version migration must NOT proceed-and-persist:
    // without a backup there is no recovery net, so a buggy migration could
    // overwrite the only durable copy. Fail closed: in-memory defaults,
    // shouldPersist:false, corrupted (read-only), observable.
    describe('backup-fail-closed (F2)', () => {
      it('refuses to migrate-and-persist when the pre-migration backup write fails', () => {
        // Make the backup write fail so createBackup() returns null. The dir
        // mkdir is allowed; only the backup file write throws. Restore the
        // default no-op afterward so the throwing impl can't leak to later tests
        // (vi.clearAllMocks() resets call history but NOT mockImplementation).
        mockFs.writeFileSync.mockImplementationOnce(() => {
          throw new Error('EACCES: backup dir unwritable');
        });
        const config = createTestConfig();
        const stored: TestStoreData = { version: 1, name: 'real-user-data', count: 7 };

        const result = migrateStore(stored, config);

        // Fail closed: in-memory defaults, do NOT persist, read-only/corrupted.
        expect(result.status).toBe('corrupted');
        expect(result.shouldPersist).toBe(false);
        expect(result.backupPath).toBeNull();
        expect(result.data.name).toBe('default'); // in-memory defaults this session
        // Observable — the degrade is reported, not silent.
        expect(mockCaptureException).toHaveBeenCalledWith(
          expect.any(Error),
          expect.objectContaining({
            tags: expect.objectContaining({
              operation: 'migrateStore.corrupted',
              storeName: 'test-store',
            }),
            extra: expect.objectContaining({ fromVersion: 1 }),
          }),
        );
      });

      it('migrates and persists normally when the backup succeeds (success path unchanged)', () => {
        // Default mockFs.writeFileSync is a no-op (success) → createBackup returns a path.
        const config = createTestConfig();
        const stored: TestStoreData = { version: 1, name: 'real-user-data' };

        const result = migrateStore(stored, config);

        expect(result.status).toBe('migrated');
        expect(result.shouldPersist).toBe(true);
        expect(result.backupPath).not.toBeNull();
      });
    });

    // #3 — clone before migrate. A migration that mutates a nested field in
    // place and THEN throws must not corrupt the caller's in-memory object.
    // runMigrations operates on a structuredClone of the input, so the caller's
    // object is byte-for-byte unchanged on throw.
    describe('clone-before-migrate (#3)', () => {
      it('does NOT mutate the caller object when a migration mutates a nested field then throws', () => {
        const config = createTestConfig({
          migrations: {
            1: (data) => {
              // Mutate a nested field IN PLACE, then throw.
              (data.items as string[]).push('mutated');
              data.name = 'mutated-name';
              throw new Error('migration exploded after mutating');
            },
            2: (data) => ({ ...data, version: 3 }),
          },
        });
        const stored: TestStoreData = {
          version: 1,
          name: 'original-name',
          items: ['original'],
        };

        const result = migrateStore(stored, config);

        // Non-destructive result: defaults in memory, not persisted.
        expect(result.status).toBe('corrupted');
        expect(result.shouldPersist).toBe(false);
        // The caller's ORIGINAL object is untouched (clone works).
        expect(stored.name).toBe('original-name');
        expect(stored.items).toEqual(['original']);
      });

      it('does NOT mutate the caller object during a successful in-place migration', () => {
        const config = createTestConfig({
          currentVersion: 2,
          migrations: {
            1: (data) => {
              (data.items as string[]).push('added-by-migration');
              data.version = 2;
              return data;
            },
          },
        });
        const stored: TestStoreData = {
          version: 1,
          name: 'keep',
          items: ['original'],
        };

        const result = migrateStore(stored, config);

        // Migration result reflects the mutation...
        expect(result.status).toBe('migrated');
        expect(result.data.items).toEqual(['original', 'added-by-migration']);
        // ...but the caller's original object is unchanged (operated on a clone).
        expect(stored.version).toBe(1);
        expect(stored.items).toEqual(['original']);
      });
    });
  });

  describe('validateMigrationCoverage', () => {
    it('returns valid when all migrations exist', () => {
      const migrations: Record<number, MigrationFn<VersionedData>> = {
        1: (d) => ({ ...d, version: 2 }),
        2: (d) => ({ ...d, version: 3 }),
        3: (d) => ({ ...d, version: 4 })
      };

      const result = validateMigrationCoverage(migrations, 1, 4);

      expect(result.valid).toBe(true);
      expect(result.missingVersions).toEqual([]);
    });

    it('detects missing migrations', () => {
      const migrations: Record<number, MigrationFn<VersionedData>> = {
        1: (d) => ({ ...d, version: 2 })
        // Missing 2 and 3
      };

      const result = validateMigrationCoverage(migrations, 1, 4);

      expect(result.valid).toBe(false);
      expect(result.missingVersions).toEqual([2, 3]);
    });

    it('returns valid for empty range', () => {
      const result = validateMigrationCoverage({}, 3, 3);

      expect(result.valid).toBe(true);
      expect(result.missingVersions).toEqual([]);
    });
  });
});
