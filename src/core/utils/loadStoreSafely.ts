/**
 * Shared load-corruption guard (F1).
 *
 * The problem this exists to prevent
 * ---------------------------------
 * Rebel's electron-store/conf stores are configured `clearInvalidConfig: false`.
 * With that setting, the `.store` getter does NOT silently reset on a bad file —
 * it RETHROWS on corrupt JSON (SyntaxError), schema violation, decrypt failure,
 * or any transient IO error (EACCES / EBUSY / partial write). The ONE exception
 * is `ENOENT`, which conf swallows and returns an empty object for (legitimate
 * first run).
 *
 * Historically each store wrapped its load in a broad outer
 * `catch { getStore().store = createDefault() }`. On ANY thrown load error that
 * catch overwrote the user's real, intact-but-momentarily-unreadable data with
 * empty defaults — with no backup, never reaching the (hardened) migrateStore
 * framework. A transient permission blip or a single corrupt byte became
 * permanent, silent data loss.
 *
 * The invariant
 * -------------
 * A load failure on EXISTING data must NEVER overwrite it with defaults.
 * On load failure we distinguish:
 *  - truly ABSENT  (ENOENT / no file)        → legitimate fresh init; persisting
 *                                               defaults is fine.
 *  - FAILED-EXISTING (file present but
 *    unreadable/unparseable/etc.)             → PRESERVE the raw file untouched,
 *                                               back up its raw bytes if we can,
 *                                               return ephemeral in-memory
 *                                               defaults for session continuity,
 *                                               and BLOCK all writes (read-only
 *                                               latch) until a clean reload.
 *
 * This module provides the classification + raw-byte backup. The CALLER is
 * responsible for honoring the returned outcome (persist-vs-not, read-only
 * latch) — see {@link LoadStoreOutcome}.
 *
 * Recovery policy (by design): a load-failed / construct-failed store is
 * READ-ONLY-UNTIL-RESTART. There is NO same-session auto-recovery — once a store
 * latches read-only, callers keep it read-only for the life of the process even
 * if the underlying file later becomes readable. This is intentional, not an
 * oversight: re-attempting the failing load on every getter would (a) re-throw
 * repeatedly on the hot path, and (b) risk a half-recovered state racing in-flight
 * reads. The clean recovery path is an app restart, which re-runs init from a
 * (now hopefully healthy) file. The per-process dedup below (see
 * {@link markLoadFailureHandled}) also assumes this: it fires the raw backup +
 * Sentry capture AT MOST ONCE per store per process precisely because the
 * degraded state is sticky for the session. Callers that genuinely can re-attempt
 * a clean load (e.g. transient EMFILE, handled separately) must call
 * {@link clearLoadFailureDedup} on success so a LATER genuine corruption is
 * reported again.
 */

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '@core/logger';
import { getErrorReporter } from '@core/errorReporter';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import { createStore, type StoreFactoryOptions } from '@core/storeFactory';
import type { KeyValueStore } from '@core/store';
import { getDataPath } from './dataPaths';
import { backupRawStoreBytes } from './storeMigration';

/**
 * The subset of {@link StoreFactoryOptions} that influences a conf/electron-store
 * file's ON-DISK PATH. conf resolves the backing file as
 * `<cwd ?? userData>/<configName ?? name>.<fileExtension ?? 'json'>`. A store
 * created with any of these overrides would, under the naive `<userData>/<name>.json`
 * derivation, classify+back up the WRONG file — misreading a present-but-corrupt
 * file as ENOENT/absent and (the wipe class) re-seeding defaults over real data.
 * So path resolution must derive from the SAME options the store was created with.
 */
export interface ConfStorePathParts {
  /** Store `name` — also the `configName` default. */
  name: string;
  /** Overrides the default `userData` directory. */
  cwd?: string;
  /** Overrides the default file basename (defaults to `name`). */
  configName?: string;
  /** Overrides the default `.json` extension (leading dot optional in conf). */
  fileExtension?: string;
}

/**
 * Narrow arbitrary {@link StoreFactoryOptions} (whose index signature admits any
 * key) down to the path-affecting parts, ignoring anything that isn't a string.
 * Defensive: a non-string `cwd`/`configName`/`fileExtension` is treated as absent
 * so a malformed option can't produce a bogus path (which would then misclassify).
 */
const pickConfPathParts = (
  options: Pick<StoreFactoryOptions<Record<string, unknown>>, 'name'> & Record<string, unknown>,
): ConfStorePathParts => {
  const asString = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 ? value : undefined;
  return {
    name: options.name,
    cwd: asString(options.cwd),
    configName: asString(options.configName),
    fileExtension: asString(options.fileExtension),
  };
};

/**
 * Deterministically resolve an electron-store/conf store's on-disk path WITHOUT
 * constructing the store. conf writes
 * `<cwd ?? userData>/<configName ?? name>.<fileExtension ?? 'json'>`. We need this
 * because conf throws at CONSTRUCTION time when the backing file is already
 * corrupt (it eagerly reads/validates in its constructor), so the guarded thunk
 * that constructs the store can't hand us a `.path` on failure — we derive it
 * from the SAME options instead.
 *
 * Accepts either a bare store name (the common case — `<userData>/<name>.json`)
 * or the full {@link ConfStorePathParts} so a store created with a custom
 * `cwd`/`configName`/`fileExtension` resolves to its REAL file rather than the
 * default-derived one (which would misclassify a present-but-corrupt file as
 * absent and re-seed defaults — the wipe class this guard exists to prevent).
 *
 * Returns `null` if userData can't be resolved (very early boot / uninitialised
 * platform) AND no explicit `cwd` was given, in which case the guard fails SAFE
 * (read-only, never absent). An explicit `cwd` does not need userData, so it
 * resolves even pre-boot.
 */
export const resolveConfStorePath = (
  store: string | ConfStorePathParts,
): string | null => {
  const parts: ConfStorePathParts = typeof store === 'string' ? { name: store } : store;
  const basename = parts.configName ?? parts.name;
  // conf accepts the extension with or without a leading dot; normalise to one.
  const ext = parts.fileExtension
    ? `.${parts.fileExtension.replace(/^\./, '')}`
    : '.json';
  const fileName = `${basename}${ext}`;
  try {
    const dir = parts.cwd ?? getDataPath();
    return path.join(dir, fileName);
  } catch (error) {
    // userData not resolvable yet (very early boot / uninitialised platform) and
    // no explicit cwd. Returning null makes the guard fail SAFE (read-only,
    // never absent) — the path is best-effort classification metadata, not a
    // hard requirement.
    ignoreBestEffortCleanup(error, {
      operation: 'loadStoreSafely.resolveConfStorePath',
      reason: 'Store path resolution is best-effort; an unresolved userData path must degrade to fail-safe classification, not crash the load.',
    });
    return null;
  }
};

/**
 * Outcome of a guarded store load.
 *
 * - `loaded`       — the load thunk succeeded; `data` is the loaded value.
 * - `absent`       — the load threw, and the on-disk file does not exist
 *                    (ENOENT). This is a legitimate first run: the caller MAY
 *                    persist defaults. `data` is fresh defaults.
 * - `load-failed`  — the load threw and the on-disk file DOES exist (or we
 *                    couldn't even determine that — fail safe). The real file is
 *                    preserved untouched; `data` is ephemeral in-memory defaults
 *                    for this session ONLY. The caller MUST enter read-only mode
 *                    and MUST NOT persist `data`. `backupPath` is the raw-byte
 *                    backup, or `null` if the backup itself failed.
 */
export type LoadStoreOutcome<T> =
  | { outcome: 'loaded'; data: T }
  | { outcome: 'absent'; data: T }
  | { outcome: 'load-failed'; data: T; backupPath: string | null };

/**
 * Whether a load outcome must put the consuming store into read-only mode and
 * be blocked from persisting. Mirrors `shouldEnterReadOnlyMode` from the
 * migration framework so callers derive the policy in one place.
 */
export const isLoadFailedReadOnly = <T>(result: LoadStoreOutcome<T>): boolean =>
  result.outcome === 'load-failed';

const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ENOENT';

/**
 * Per-process dedup for load-failure SIDE EFFECTS (raw `.corrupt.bak` write +
 * Sentry capture). Keyed by `storeName`.
 *
 * Why: stores like inbox / memory-history call the guarded load on EVERY getter
 * (UI refresh, pollers). Without dedup, a single corrupt `inbox.json` would spew
 * a fresh raw backup + a fresh Sentry event on every poll — flooding the backup
 * dir and telemetry while telling us nothing new. The CLASSIFICATION itself is
 * always recomputed (cheap, deterministic, and the caller still latches
 * read-only every time); only the noisy, append-only side effects are deduped.
 *
 * Cleared via {@link clearLoadFailureDedup} when a store reports a successful
 * reload, so a genuinely new corruption LATER in the same process is reported
 * again. (With the read-only-until-restart policy most stores never clear it,
 * which is correct — the degrade is sticky for the session.)
 */
const handledLoadFailures = new Set<string>();

/**
 * Returns `true` the FIRST time a given store's load failure is seen this
 * process (and records it); `false` on subsequent calls until cleared. The
 * caller uses this to gate the one-shot raw backup + Sentry capture.
 */
const markLoadFailureHandled = (storeName: string): boolean => {
  if (handledLoadFailures.has(storeName)) return false;
  handledLoadFailures.add(storeName);
  return true;
};

/**
 * Clear the load-failure dedup for a store after a confirmed successful reload,
 * so a later genuine corruption is reported afresh. No-op if not present.
 */
export const clearLoadFailureDedup = (storeName: string): void => {
  handledLoadFailures.delete(storeName);
};

/**
 * Test-only: reset the per-process load-failure dedup set so each case starts
 * from a clean slate (the set is module-global and otherwise persists across
 * tests in the same worker).
 * @internal
 */
export const __resetLoadFailureDedupForTests = (): void => {
  handledLoadFailures.clear();
};

/**
 * Report (best-effort) that a store load failed on EXISTING data and we are
 * running on ephemeral in-memory defaults this session. This is the only
 * observability surface for the degrade, so reporting must never break the
 * (already degraded) load.
 */
const reportLoadFailure = (
  storeName: string,
  error: unknown,
  backupPath: string | null,
): void => {
  try {
    getErrorReporter().captureException(error, {
      level: 'error',
      tags: { operation: 'loadStoreSafely.loadFailed', storeName },
      extra: { backupPath },
    });
  } catch (reportError) {
    ignoreBestEffortCleanup(reportError, {
      operation: 'loadStoreSafely.reportLoadFailure',
      reason:
        'Load-failure reporting is best-effort observability; a reporter failure must never turn a recoverable (non-destructive, read-only) load failure into a hard crash.',
    });
  }
};

/**
 * Classification of an already-caught load failure, for callers that own their
 * own try/catch (e.g. they distinguish transient FD-exhaustion from corruption
 * before deciding). Reads the raw bytes to classify ENOENT-vs-exists and backs
 * up the bytes when the file exists. Never throws.
 *
 * - `absent`      → ENOENT: legitimate fresh init; caller may persist defaults.
 * - `load-failed` → file exists (or undeterminable — fail safe): caller MUST
 *                   preserve the file, latch read-only, and NOT persist.
 *                   `backupPath` is the raw-byte backup or `null`.
 */
export const classifyLoadFailure = (
  storeName: string,
  storeFilePath: string | null,
  error: unknown,
):
  | { outcome: 'absent' }
  | { outcome: 'load-failed'; backupPath: string | null } => {
  let rawBytes: Buffer | null = null;

  if (storeFilePath) {
    try {
      rawBytes = fs.readFileSync(storeFilePath);
    } catch (readError) {
      if (isEnoent(readError)) {
        logger.info(
          { storeName, err: error },
          'Store load failed but file is absent (ENOENT) — treating as fresh init',
        );
        return { outcome: 'absent' };
      }
      logger.warn(
        { storeName, err: readError },
        'Store load failed and raw-byte read also failed (non-ENOENT) — preserving data, entering read-only',
      );
    }
  } else {
    logger.warn(
      { storeName },
      'Store load failed and no file path available to classify — failing safe (read-only, preserve data)',
    );
  }

  // Dedup the NOISY side effects (raw backup write + Sentry capture) to at most
  // once per store per process. Stores that call the guarded load on every
  // getter (pollers, UI refresh) would otherwise spew a fresh `.corrupt.bak`
  // and a fresh Sentry event on each poll. The classification (load-failed) is
  // still returned every time so the caller re-latches read-only on every read.
  const firstOccurrence = markLoadFailureHandled(storeName);
  if (!firstOccurrence) {
    return { outcome: 'load-failed', backupPath: null };
  }

  const backupPath = rawBytes ? backupRawStoreBytes(storeName, rawBytes) : null;
  logger.error(
    { storeName, backupPath, err: error },
    'Store load failed on existing data — preserving on-disk file, running on in-memory defaults (read-only this session)',
  );
  reportLoadFailure(storeName, error, backupPath);
  return { outcome: 'load-failed', backupPath };
};

/**
 * Minimal in-memory KeyValueStore used as an ephemeral, no-op-on-write fallback
 * when the real (conf-backed) store cannot be CONSTRUCTED because its backing
 * file is corrupt (conf reads+validates in its constructor and throws). The
 * caller has already latched read-only, so writes are blocked upstream; this
 * fallback exists purely so getters return defaults instead of dereferencing a
 * null store and crashing. It never touches disk — the real corrupt file is
 * preserved untouched.
 */
const createEphemeralReadOnlyStore = <T extends Record<string, unknown>>(
  storeFilePath: string | null,
  defaults: T,
): KeyValueStore<T> => {
  const data: T = structuredClone(defaults);
  const noop = (): void => {
    /* read-only fallback: writes are intentionally inert (data preserved on disk) */
  };
  return {
    get: ((key: string) => (data as Record<string, unknown>)[key]) as KeyValueStore<T>['get'],
    set: noop as KeyValueStore<T>['set'],
    has: (key: string) => key in (data as Record<string, unknown>),
    delete: noop,
    clear: noop,
    get store() {
      return data;
    },
    set store(_value: T) {
      /* inert: never persist over the preserved corrupt file */
    },
    path: storeFilePath ?? '',
  } as KeyValueStore<T>;
};

/**
 * Construct an electron-store/conf-backed store SAFELY. conf throws at
 * construction time when the backing file is already corrupt, so a bare
 * `createStore()` at module/singleton init can crash the whole subsystem and
 * (in callers that catch + reset) wipe real data. This wraps construction:
 *  - success → `{ store, loadFailed: false }` (normal).
 *  - construct throws → classify (ENOENT vs existing). For `absent` we retry once
 *    after the conf constructor self-heals the directory (it creates a usable
 *    fresh store), so the caller gets a real writable store. For existing data we
 *    preserve+back up the raw bytes, report, and return an EPHEMERAL read-only
 *    in-memory store with `loadFailed: true` so the caller latches read-only.
 *
 * Never throws.
 */
export const safeCreateStore = <T extends Record<string, unknown>>(
  options: StoreFactoryOptions<T>,
  defaults: T,
): { store: KeyValueStore<T>; loadFailed: boolean } => {
  try {
    return { store: createStore<T>(options), loadFailed: false };
  } catch (error) {
    // Resolve from the FULL options the store was created with — a custom
    // cwd/configName/fileExtension would otherwise make us classify+back up the
    // wrong file (misread as absent → wipe the real one).
    const filePath = resolveConfStorePath(pickConfPathParts(options));
    const classified = classifyLoadFailure(options.name, filePath, error);
    if (classified.outcome === 'absent') {
      // Truly absent file that still failed to construct (rare). Retry once —
      // conf's constructor creates the directory and a fresh store on a clean
      // path. If it still throws, fall through to the ephemeral fallback.
      try {
        return { store: createStore<T>(options), loadFailed: false };
      } catch (retryError) {
        logger.error(
          { storeName: options.name, err: retryError },
          'Store construction failed twice on an absent file — using ephemeral read-only fallback',
        );
      }
    }
    return {
      store: createEphemeralReadOnlyStore<T>(filePath, defaults),
      loadFailed: true,
    };
  }
};

/**
 * Load a store value safely, enforcing the never-overwrite-existing-data
 * invariant on failure.
 *
 * @param storeName    Stable identifier (also used to name the raw-byte backup).
 * @param storeFilePath The store's on-disk path (e.g. `KeyValueStore.path`).
 *                      Used to classify ENOENT-vs-exists and to read the raw
 *                      bytes for backup. Pass `null` only if a store genuinely
 *                      cannot expose its path — we then fail SAFE (treat as
 *                      load-failed/read-only, never absent), preserving data.
 * @param load         Thunk that performs the actual load (e.g. read `.store`
 *                      then `migrateStore`). May throw.
 * @param createDefault Factory for ephemeral in-memory defaults used on failure.
 */
export const loadStoreSafely = <T>(
  storeName: string,
  storeFilePath: string | null,
  load: () => T,
  createDefault: () => T,
): LoadStoreOutcome<T> => {
  try {
    return { outcome: 'loaded', data: load() };
  } catch (error) {
    const classified = classifyLoadFailure(storeName, storeFilePath, error);
    if (classified.outcome === 'absent') {
      return { outcome: 'absent', data: createDefault() };
    }
    return { outcome: 'load-failed', data: createDefault(), backupPath: classified.backupPath };
  }
};
