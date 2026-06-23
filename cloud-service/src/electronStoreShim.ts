/**
 * electron-store Shim
 *
 * Provides a conf-like implementation that matches the electron-store API
 * used by shared code. Uses a simple JSON file for persistence.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

// Note: this shim is also imported via tsconfig-paths alias (`electron-store`)
// from non-cloud callers like the eval harness, where the cloud-service ESM
// package boundary breaks named-export resolution from `@core/logger` under
// tsx. Use console.error in the single error path below; it works under every
// loader and the path already throws (no silent-failure risk).

const dataPath = process.env.REBEL_USER_DATA || '/data';
const CLOUD_STORE_DIR_MODE = 0o700;
const CLOUD_STORE_FILE_MODE = 0o600;

/** All live Store instances, so we can reload them after archive extraction. */
const _allStores: Store[] = [];

/** Reload every Store instance from disk (call after archive extraction). */
export function reloadAllStores(): void {
  for (const store of _allStores) {
    store.reload();
  }
}

export class CloudStorePersistError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(filePath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cloud settings persist failed for ${filePath}: ${reason}`);
    this.name = 'CloudStorePersistError';
    this.path = filePath;
    this.reason = reason;
    this.cause = cause;
  }
}

/**
 * Raised by the CloudStore constructor when the backing file EXISTS but cannot
 * be read or parsed (corrupt JSON, schema/parse violation, transient non-ENOENT
 * IO error). Mirrors conf/electron-store's `clearInvalidConfig:false` semantics:
 * the store's read MUST throw on a present-but-unreadable file so the shared
 * load-corruption guard (`safeCreateStore` / `loadStoreSafely`) engages on the
 * cloud surface exactly as it does on desktop — preserving the real file,
 * backing it up, and latching read-only — instead of silently re-seeding
 * defaults over real user data (the cloud-wipe class this fixes).
 *
 * ENOENT (file absent) is NOT this error: an absent file is a legitimate fresh
 * init and the constructor seeds defaults as before.
 */
export class CloudStoreLoadError extends Error {
  readonly path: string;
  readonly reason: string;

  constructor(filePath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Cloud settings load failed for ${filePath}: ${reason}`);
    this.name = 'CloudStoreLoadError';
    this.path = filePath;
    this.reason = reason;
    this.cause = cause;
  }
}

/** True when an error is a Node ENOENT (file/dir absent). */
const isEnoent = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'ENOENT';

class Store<T extends Record<string, unknown> = Record<string, unknown>> {
  private _data: T;
  private _filePath: string;
  private _defaults: T;

  constructor(opts: { name?: string; defaults?: T } = {}) {
    this._defaults = (opts.defaults || {}) as T;
    const name = opts.name || 'config';
    this._filePath = path.join(dataPath, `${name}.json`);

    this._data = this._readFromDisk();
    _allStores.push(this);
  }

  /**
   * Read + parse the backing file, matching conf's `clearInvalidConfig:false`
   * semantics:
   *  - file ABSENT (ENOENT)                 → return fresh defaults (legit init).
   *  - file present, parses cleanly         → defaults merged with on-disk data.
   *  - file present but unreadable/corrupt  → THROW CloudStoreLoadError so the
   *    (non-ENOENT IO error / bad JSON)         shared guard catches it, preserves
   *                                             the real file, backs it up, and
   *                                             latches read-only — never wiping.
   */
  private _readFromDisk(): T {
    let raw: string;
    try {
      raw = fs.readFileSync(this._filePath, 'utf-8');
    } catch (error) {
      if (isEnoent(error)) {
        // Legitimate first run: no backing file yet.
        return { ...this._defaults };
      }
      // Present-but-unreadable (EACCES/EBUSY/EISDIR/partial write/etc.): the file
      // exists and holds real data we must not clobber. Throw so the shared guard
      // preserves it and latches read-only.
      throw new CloudStoreLoadError(this._filePath, error);
    }
    try {
      return { ...this._defaults, ...JSON.parse(raw) };
    } catch (error) {
      // Corrupt JSON over a real file — same preserve-and-latch contract.
      throw new CloudStoreLoadError(this._filePath, error);
    }
  }

  /** Re-read the JSON file from disk into memory. */
  reload(): void {
    try {
      this._data = this._readFromDisk();
    } catch (error) {
      // reload() is invoked post-construction (e.g. after archive extraction),
      // when this Store instance already holds a valid in-memory snapshot. A
      // corrupt/unreadable file here must NOT crash the live process or wipe the
      // disk: keep the current in-memory data and surface the failure for
      // observability. (Construction-time corruption is the case the shared guard
      // handles via the throw above; this branch covers a file that went bad
      // AFTER a healthy load.)
      console.error('[cloud-electron-store-shim] Cloud settings reload failed; keeping in-memory data', {
        path: this._filePath,
        err: error,
      });
      ignoreBestEffortCleanup(error, {
        operation: 'cloudElectronStoreShim.reload',
        reason:
          'reload() on a now-corrupt file must keep the valid in-memory snapshot rather than crash the live process or wipe disk; the failure is already logged above and the on-disk file is preserved untouched.',
      });
    }
  }

  get store(): T {
    return this._data;
  }

  set store(value: T) {
    this._persist(value);
    this._data = value;
  }

  get(key: string, defaultValue?: unknown): unknown {
    const val = (this._data as Record<string, unknown>)[key];
    return val !== undefined ? val : defaultValue;
  }

  set(keyOrObj: string | Record<string, unknown>, value?: unknown): void {
    const next = { ...this._data } as Record<string, unknown>;
    if (typeof keyOrObj === 'string') {
      next[keyOrObj] = value;
    } else {
      Object.assign(next, keyOrObj);
    }
    this._persist(next as T);
    this._data = next as T;
  }

  has(key: string): boolean {
    return key in this._data;
  }

  delete(key: string): void {
    const next = { ...this._data } as Record<string, unknown>;
    delete next[key];
    this._persist(next as T);
    this._data = next as T;
  }

  clear(): void {
    const next = { ...this._defaults };
    this._persist(next);
    this._data = next;
  }

  get size(): number {
    return Object.keys(this._data).length;
  }

  get path(): string {
    return this._filePath;
  }

  private _persist(data: T): void {
    const directoryPath = path.dirname(this._filePath);
    const tempPath = `${this._filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(directoryPath, { recursive: true, mode: CLOUD_STORE_DIR_MODE });
      if (process.platform !== 'win32') {
        fs.chmodSync(directoryPath, CLOUD_STORE_DIR_MODE);
      }
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), {
        encoding: 'utf-8',
        mode: CLOUD_STORE_FILE_MODE,
      });
      if (process.platform !== 'win32') {
        fs.chmodSync(tempPath, CLOUD_STORE_FILE_MODE);
      }
      fs.renameSync(tempPath, this._filePath);
      if (process.platform !== 'win32') {
        fs.chmodSync(this._filePath, CLOUD_STORE_FILE_MODE);
      }
    } catch (err) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best-effort cleanup for failed atomic writes.
      }
      const persistError = new CloudStorePersistError(this._filePath, err);
      console.error('[cloud-electron-store-shim] Cloud settings persist failed', {
        path: this._filePath,
        err: persistError,
      });
      throw persistError;
    }
  }
}

export default Store;
export { Store };
