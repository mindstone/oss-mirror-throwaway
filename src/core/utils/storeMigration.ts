/**
 * Store Migration Framework
 *
 * Provides safe, forward-only migrations for electron-store data with:
 * - Future-version protection (never modify data from newer app versions)
 * - Automatic backups before destructive operations
 * - Explicit migration registry with clear version progression
 * - Graceful handling of corrupted or missing data
 *
 * @see docs/plans/260330_strengthen_de_electronification.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getPlatformConfig } from '@core/platform';
import { logger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { scrubAppSettingsSecretsForBackup } from '@core/utils/appSettingsSecretScrub';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

export interface VersionedData {
  version: number;
  [key: string]: unknown;
}

export type MigrationFn<T extends VersionedData> = (data: T) => T;

export interface StoreMigrationConfig<T extends VersionedData> {
  storeName: string;
  currentVersion: number;
  migrations: Record<number, MigrationFn<T>>;
  createDefault: () => T;
  validate?: (data: unknown) => data is T;
}

export type MigrationResultStatus =
  | 'fresh'
  | 'current'
  | 'migrated'
  | 'future_version'
  | 'corrupted';

export interface MigrationResult<T extends VersionedData> {
  data: T;
  status: MigrationResultStatus;
  fromVersion: number | null;
  toVersion: number;
  backupPath: string | null;
  shouldPersist: boolean;
}

/**
 * Whether a migration result MUST put the consuming store into read-only mode.
 *
 * Read-only when:
 * - `future_version` — data from a newer app version; modifying it could corrupt
 *   forward-compat data (always `shouldPersist: false`).
 * - `corrupted` AND `shouldPersist === false` — a real, versioned store whose
 *   MIGRATION THREW. We run on in-memory defaults this session, but the real
 *   (un-migrated) file is preserved on disk (`shouldPersist: false`), so any
 *   later write must be blocked or it would clobber that real data with empty
 *   defaults — the data-reset class this guard exists to prevent.
 *
 * NOT read-only:
 * - `corrupted` AND `shouldPersist === true` — the FRESH/empty-shape path
 *   (version-less `{}` on first run). There is no real on-disk data to protect;
 *   the store must initialize and accept writes normally. (See `migrateStore`
 *   Case 2.)
 * - `fresh` / `current` / `migrated` — normal writable states.
 *
 * Callers should derive their read-only flag from this helper (passing the
 * migration result) rather than re-deriving the predicate, so the policy lives
 * in one place. It accepts the whole result because the corrupted decision
 * depends on `shouldPersist`, not status alone.
 */
export const shouldEnterReadOnlyMode = <T extends VersionedData>(
  result: Pick<MigrationResult<T>, 'status' | 'shouldPersist'>,
): boolean =>
  result.status === 'future_version' ||
  (result.status === 'corrupted' && result.shouldPersist === false);

/**
 * Resolve the directory for pre-migration store backups. Primary: the resolved
 * user-data path. Fallback (platform config not yet initialized — very early
 * boot, degraded path, dev scripts, tests): an explicit ABSOLUTE `REBEL_USER_DATA`
 * override, else a stable OS temp dir.
 *
 * We deliberately never fall back to `process.cwd()`: a backup written there
 * litters whatever directory the process happened to start in (historically the
 * repo root, under the packaged-app boot smoke / dev / CLI). Preferring an
 * absolute `REBEL_USER_DATA` co-locates the backup with the data it protects and
 * lets test/CLI harnesses point it at an isolated, auto-cleaned profile (so the
 * boot smoke's per-run temp profile sweeps it up instead of leaving it in the
 * shared tmpdir); a relative override is ignored so it can't quietly reintroduce
 * a cwd-relative write. Otherwise we use `os.tmpdir()` (always writable,
 * self-cleaning) so the pre-migration backup is still preserved for recovery
 * rather than lost. This makes the cwd-litter class unrepresentable rather than
 * merely contained by each caller anchoring its cwd.
 */
export const getBackupDirectory = (): string => {
  try {
    return path.join(getPlatformConfig().userDataPath, 'backups');
  } catch {
    const override = process.env.REBEL_USER_DATA;
    if (override && path.isAbsolute(override)) return path.join(override, 'backups');
    return path.join(os.tmpdir(), 'rebel-store-backups');
  }
};

const ensureBackupDirectory = (): string => {
  const backupDir = getBackupDirectory();
  try {
    fs.mkdirSync(backupDir, { recursive: true });
  } catch (error) {
    logger.warn({ err: error, backupDir }, 'Failed to create backup directory');
  }
  return backupDir;
};

/**
 * Back up the RAW on-disk bytes of a store file before any recovery action that
 * might overwrite it. Distinct from {@link createBackup} (which serializes a
 * parsed/in-memory object): this preserves the exact unparseable/corrupt bytes
 * so the original can be recovered or forensically inspected even when JSON
 * parsing, schema validation, or decryption failed. Reuses the same backup-dir
 * resolution as the migration framework so all recovery artifacts co-locate.
 *
 * Best-effort and never throws: the caller is already on a degraded path, so a
 * backup-write failure must not escalate. Returns the backup path on success,
 * else `null`.
 */
export const backupRawStoreBytes = (
  storeName: string,
  rawBytes: Buffer,
): string | null => {
  try {
    const backupDir = ensureBackupDirectory();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `${storeName}-rawload-${timestamp}.corrupt.bak`;
    const backupPath = path.join(backupDir, fileName);
    fs.writeFileSync(backupPath, rawBytes);
    logger.info({ storeName, backupPath, byteLength: rawBytes.length }, 'Backed up raw store bytes after load failure');
    return backupPath;
  } catch (error) {
    logger.error({ err: error, storeName }, 'Failed to back up raw store bytes after load failure');
    return null;
  }
};

const createBackup = <T extends VersionedData>(
  storeName: string,
  data: T
): string | null => {
  try {
    const backupDir = ensureBackupDirectory();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const version = typeof data.version === 'number' ? data.version : 'unknown';
    const fileName = `${storeName}-v${version}-${timestamp}.json`;
    const backupPath = path.join(backupDir, fileName);

    const backupData = storeName === 'app-settings'
      ? scrubAppSettingsSecretsForBackup(data)
      : data;
    fs.writeFileSync(backupPath, JSON.stringify(backupData, null, 2), 'utf8');
    logger.info({ storeName, backupPath, version }, 'Created store backup before migration');
    return backupPath;
  } catch (error) {
    logger.error({ err: error, storeName }, 'Failed to create store backup');
    return null;
  }
};

/**
 * Report a corrupted-migration event to the error reporter, best-effort.
 *
 * A corrupted migration is non-destructive by construction (the live store is
 * NOT overwritten — see {@link migrateStore} Case 2 / Case 5 catch), so this is
 * the ONLY observability surface that surfaces "user is silently running on
 * in-memory defaults this session". Reporting must never break the load: a
 * reporter that throws is swallowed via {@link ignoreBestEffortCleanup} so a
 * degraded telemetry transport can't turn a recoverable corrupted-store load
 * into a hard failure.
 */
const reportCorruptedMigration = (
  storeName: string,
  error: unknown,
  fromVersion: number | null,
): void => {
  try {
    getErrorReporter().captureException(error, {
      level: 'error',
      tags: { operation: 'migrateStore.corrupted', storeName },
      extra: { fromVersion },
    });
  } catch (reportError) {
    ignoreBestEffortCleanup(reportError, {
      operation: 'migrateStore.reportCorrupted',
      reason: 'Corrupted-migration reporting is best-effort observability; a reporter failure must never turn a recoverable (non-destructive) corrupted load into a hard crash.',
    });
  }
};

/**
 * Dedup set for the wrong-version-return observability (#4). A migration step
 * that forgets to set the target version will fire on every load for every
 * affected user; we coerce + report ONCE per (store, step) per process so the
 * signal is visible without flooding telemetry. Keyed by store + version edge
 * because that uniquely identifies the buggy migration function.
 */
const reportedWrongVersionEdges = new Set<string>();

/**
 * Report (deduped, best-effort) a migration that returned the wrong version
 * number. This is NON-destructive — the caller still coerces the version and
 * the migrated data remains usable (per review guidance, do NOT fail closed
 * here). But a migration that forgot to transform would otherwise be masked
 * forever by the silent coercion, so surface it as an error-level signal.
 */
const reportWrongMigrationVersion = (
  storeName: string,
  expectedVersion: number,
  actualVersion: number,
): void => {
  const dedupKey = `${storeName}:${expectedVersion}`;
  if (reportedWrongVersionEdges.has(dedupKey)) return;
  reportedWrongVersionEdges.add(dedupKey);

  try {
    // Static message (dynamic detail lives in tags/extra) so Sentry groups all
    // wrong-version-return events together and the no-dynamic-capture-message
    // lint rule is satisfied.
    const wrongVersionError = new Error(
      'Store migration returned the wrong version number; coercing. The migration ' +
      'function likely forgot to set the version (and may have forgotten to transform ' +
      'the data too) — investigate the migration registered for the prior version.'
    );
    getErrorReporter().captureException(wrongVersionError, {
      level: 'error',
      tags: { operation: 'migrateStore.wrongVersionReturn', storeName },
      extra: { expectedVersion, actualVersion },
    });
  } catch (reportError) {
    ignoreBestEffortCleanup(reportError, {
      operation: 'migrateStore.reportWrongVersion',
      reason: 'Wrong-version-return reporting is best-effort observability; a reporter failure must never turn a recoverable (coerced, non-destructive) migration into a hard crash.',
    });
  }
};

const isValidVersionedData = (data: unknown): data is VersionedData => {
  return (
    data !== null &&
    typeof data === 'object' &&
    'version' in data &&
    typeof (data as VersionedData).version === 'number' &&
    Number.isFinite((data as VersionedData).version)
  );
};

const runMigrations = <T extends VersionedData>(
  data: T,
  fromVersion: number,
  toVersion: number,
  migrations: Record<number, MigrationFn<T>>,
  storeName: string
): T => {
  // #3 — deep-clone the input before running any migration step.
  //
  // Registered migrations frequently mutate nested objects in place (then
  // return the same reference). If a migration mutates and THEN throws, the
  // caller's original in-memory object is left half-migrated/corrupted even
  // though `migrateStore` falls back to defaults — a silent foot-gun. Operating
  // on a structured clone guarantees the caller's object is never touched: on
  // throw, the original is byte-for-byte unchanged. No current migration relies
  // on reference identity with the input (they all build/return data, never
  // compare `=== input`), so cloning is behaviour-preserving for the happy path.
  let current: T = structuredClone(data);

  for (let v = fromVersion; v < toVersion; v++) {
    const migrateFn = migrations[v];
    if (!migrateFn) {
      const error = new Error(
        `Missing migration from v${v} to v${v + 1} for store "${storeName}". ` +
        `Add a migration function for version ${v} in the migrations registry.`
      );
      logger.error({ storeName, fromVersion: v, toVersion: v + 1 }, error.message);
      throw error;
    }

    logger.debug({ storeName, from: v, to: v + 1 }, 'Running store migration step');

    try {
      current = migrateFn(current);
      if (current.version !== v + 1) {
        logger.warn(
          { storeName, expected: v + 1, actual: current.version },
          'Migration did not update version number correctly'
        );
        // #4 — observable (deduped) so a migration that silently forgot to
        // transform/version can't hide behind this non-destructive coercion.
        reportWrongMigrationVersion(storeName, v + 1, current.version);
        current = { ...current, version: v + 1 };
      }
    } catch (error) {
      logger.error(
        { err: error, storeName, fromVersion: v },
        'Migration step failed'
      );
      throw error;
    }
  }

  return current;
};

/**
 * Migrate store data safely with version handling.
 *
 * Behavior by version comparison:
 * - No data or invalid: Return fresh defaults (status: 'fresh' or 'corrupted')
 * - stored.version === currentVersion: Return as-is (status: 'current')
 * - stored.version < currentVersion: Run migrations, backup first (status: 'migrated')
 * - stored.version > currentVersion: Return as-is, DO NOT MODIFY (status: 'future_version')
 */
export const migrateStore = <T extends VersionedData>(
  stored: unknown,
  config: StoreMigrationConfig<T>
): MigrationResult<T> => {
  const { storeName, currentVersion, migrations, createDefault, validate } = config;

  // Case 1: No data at all
  if (stored === null || stored === undefined) {
    logger.debug({ storeName }, 'No existing store data, creating fresh defaults');
    return {
      data: createDefault(),
      status: 'fresh',
      fromVersion: null,
      toVersion: currentVersion,
      backupPath: null,
      shouldPersist: true
    };
  }

  // Case 2: Data exists but is not properly versioned.
  //
  // Two sub-cases, distinguished to avoid both false positives and data loss:
  //
  //  (2a) An EMPTY object `{}` — the FRESH/EMPTY-shape path. This is what a
  //       brand-new electron-store looks like before its first write (and what
  //       several stores' first run looks like), so we seed defaults and PERSIST
  //       (`shouldPersist: true`). There is no real data to protect.
  //
  //  (2b) A NON-EMPTY version-less object (or other malformed-but-present data)
  //       — this could be REAL data whose `version` field was lost/corrupted, or
  //       data from a pre-versioning era. Overwriting it with defaults would be
  //       the data-reset class. So we use defaults IN MEMORY for this session but
  //       do NOT persist (`shouldPersist: false`) and back the raw data up;
  //       callers treat `corrupted` + `shouldPersist:false` as read-only, so the
  //       on-disk data + backup are preserved for recovery.
  //
  // (The migration-THROW path over already-versioned data is Case 5's catch.)
  if (!isValidVersionedData(stored)) {
    const isEmptyFreshShape =
      typeof stored === 'object' &&
      stored !== null &&
      !Array.isArray(stored) &&
      Object.keys(stored as Record<string, unknown>).length === 0;

    logger.warn(
      { storeName, dataType: typeof stored, isEmptyFreshShape },
      isEmptyFreshShape
        ? 'Store data is empty, seeding fresh defaults'
        : 'Store data is present but not properly versioned, preserving on-disk data and degrading to read-only'
    );

    // Attempt backup of the raw data for recovery (cheap; helps both sub-cases).
    const backupPath = createBackup(storeName, stored as T);

    if (isEmptyFreshShape) {
      return {
        data: createDefault(),
        status: 'corrupted',
        fromVersion: null,
        toVersion: currentVersion,
        backupPath,
        shouldPersist: true
      };
    }

    // Non-empty version-less data: preserve it. Observable so the degrade
    // (running on in-memory defaults) can't hide.
    reportCorruptedMigration(
      storeName,
      new Error(`Store "${storeName}" has present-but-unversioned data; preserving on disk and degrading to read-only`),
      null,
    );

    return {
      data: createDefault(),
      status: 'corrupted',
      fromVersion: null,
      toVersion: currentVersion,
      backupPath,
      shouldPersist: false
    };
  }

  const storedVersion = stored.version;

  // Case 3: Future version - DO NOT MODIFY
  if (storedVersion > currentVersion) {
    logger.warn(
      {
        storeName,
        storedVersion,
        currentVersion,
        warning: 'Data created by newer app version - refusing to modify'
      },
      'Future version detected in store data'
    );

    // Return the data as-is but DO NOT persist (avoid overwriting with potentially incompatible changes)
    return {
      data: stored as T,
      status: 'future_version',
      fromVersion: storedVersion,
      toVersion: storedVersion,
      backupPath: null,
      shouldPersist: false
    };
  }

  // Case 4: Current version - no migration needed
  if (storedVersion === currentVersion) {
    logger.debug({ storeName, version: currentVersion }, 'Store data is current version');

    // Optional validation
    if (validate && !validate(stored)) {
      logger.warn({ storeName }, 'Store data failed validation, using as-is');
    }

    return {
      data: stored as T,
      status: 'current',
      fromVersion: storedVersion,
      toVersion: currentVersion,
      backupPath: null,
      shouldPersist: false
    };
  }

  // Case 5: Old version - run migrations
  logger.info(
    { storeName, fromVersion: storedVersion, toVersion: currentVersion },
    'Migrating store data to current version'
  );

  // Create backup before migration
  const backupPath = createBackup(storeName, stored as T);

  // F2 — fail closed when the pre-migration backup could not be written.
  //
  // `createBackup` returns null when the backup write failed (disk full,
  // permissions, unwritable backup dir, …). A migration is potentially
  // destructive: it rewrites the user's only durable copy. Without a backup we
  // have NO recovery net, so a buggy migration could silently overwrite real
  // data with no way back. Refuse to migrate-and-persist: run on in-memory
  // defaults this session, keep the real on-disk file untouched
  // (`shouldPersist: false`), and surface the degrade. `corrupted` +
  // `shouldPersist: false` makes `shouldEnterReadOnlyMode` trip, so consumers
  // block writes and the real data survives until the backup path is healthy.
  //
  // Applies to ALL stores, including any derived/cache store: no consumer of
  // `migrateStore` is a pure rebuildable cache that wants a destructive reset
  // here (they all gate persistence on `shouldPersist` + read-only), and there
  // is no clean per-store opt-out signal — so fail-closed for all is the safe
  // default. Erring toward preserving data is strictly safer than erring toward
  // overwriting it.
  if (backupPath === null) {
    const backupError = new Error(
      `Store "${storeName}" migration aborted: pre-migration backup could not be written. ` +
      `Running on in-memory defaults this session and preserving the real on-disk data (read-only).`
    );
    logger.error(
      { storeName, fromVersion: storedVersion, toVersion: currentVersion },
      'Pre-migration backup failed; refusing to migrate-and-persist (fail closed, real data preserved on disk)'
    );
    reportCorruptedMigration(storeName, backupError, storedVersion);

    return {
      data: createDefault(),
      status: 'corrupted',
      fromVersion: storedVersion,
      toVersion: currentVersion,
      backupPath: null,
      shouldPersist: false
    };
  }

  try {
    const migrated = runMigrations(
      stored as T,
      storedVersion,
      currentVersion,
      migrations,
      storeName
    );

    logger.info(
      { storeName, fromVersion: storedVersion, toVersion: currentVersion, backupPath },
      'Store migration completed successfully'
    );

    return {
      data: migrated,
      status: 'migrated',
      fromVersion: storedVersion,
      toVersion: currentVersion,
      backupPath,
      shouldPersist: true
    };
  } catch (error) {
    logger.error(
      { err: error, storeName, fromVersion: storedVersion, toVersion: currentVersion },
      'Store migration failed, falling back to in-memory defaults (real data preserved on disk)'
    );

    // Non-destructive by construction: a migration that throws (e.g. one
    // malformed persisted item aborting the whole batch) returns defaults for
    // IN-MEMORY use this session but MUST NOT persist them — that would reset
    // the user's real store to empty defaults over their data (the
    // session-index-collapse class). `shouldPersist: false` + callers treating
    // `corrupted` like `future_version` (read-only) keep the on-disk file AND
    // the pre-migration backup intact for recovery. Observable so the degrade
    // surfaces instead of failing silently.
    reportCorruptedMigration(storeName, error, storedVersion);

    return {
      data: createDefault(),
      status: 'corrupted',
      fromVersion: storedVersion,
      toVersion: currentVersion,
      backupPath,
      shouldPersist: false
    };
  }
};

/**
 * Helper to create a type-safe migration registry.
 * Ensures migrations are defined for consecutive versions.
 */
export const createMigrationRegistry = <T extends VersionedData>(
  migrations: Record<number, MigrationFn<T>>
): Record<number, MigrationFn<T>> => {
  return migrations;
};

/**
 * Utility to check if migrations cover all versions from a base to target.
 * Useful for validation in tests.
 */
export const validateMigrationCoverage = (
  migrations: Record<number, MigrationFn<VersionedData>>,
  fromVersion: number,
  toVersion: number
): { valid: boolean; missingVersions: number[] } => {
  const missingVersions: number[] = [];

  for (let v = fromVersion; v < toVersion; v++) {
    if (!migrations[v]) {
      missingVersions.push(v);
    }
  }

  return {
    valid: missingVersions.length === 0,
    missingVersions
  };
};
