/**
 * StoreFactory — platform-agnostic persistent store creation.
 *
 * Replaces direct `import Store from 'electron-store'` + `new Store(...)`.
 * Electron impl wraps electron-store; cloud impl uses JSON files on disk.
 *
 * All stores MUST use lazy initialization via `getStore()` pattern to avoid
 * calling createStore() before setStoreFactory() runs at bootstrap.
 *
 * Includes a global write gate: when isUserDataReadOnly() is true (set by
 * ensureVersionCompatibility.ts), all write operations (set, delete, clear,
 * store=) become no-ops. This protects against older app versions corrupting
 * data written by newer versions.
 *
 * @see docs/plans/partway/260219_global_store_version_gate.md
 */

import type { KeyValueStore } from './store';
import { isUserDataReadOnly } from './userDataWriteGate';
import { withSingleSyncRetryOnEmfile } from './utils/emfileRetry';

export interface StoreFactoryOptions<T extends Record<string, unknown>> {
  name: string;
  defaults?: T;
  schema?: Record<string, unknown>;
  [key: string]: unknown;
}

export type StoreFactory = <T extends Record<string, unknown>>(
  options: StoreFactoryOptions<T>,
) => KeyValueStore<T>;

let _factory: StoreFactory | undefined;

export function setStoreFactory(factory: StoreFactory): void {
  _factory = factory;
}

const WRITE_METHODS = new Set(['set', 'delete', 'clear']);

/**
 * Wrap a KeyValueStore with a Proxy that blocks write operations
 * when the global userData read-only flag is active.
 */
function gateStoreWrites<T extends Record<string, unknown>>(
  store: KeyValueStore<T>,
  storeName: string,
): KeyValueStore<T> {
  return new Proxy(store, {
    get(target, prop, _receiver) {
      // `electron-store`/`conf` reaches synchronous fs paths for `.store`
      // reads and `get()` on some stores. graceful-fs cannot patch sync fs,
      // so give transient EMFILE/ENFILE one chance to clear centrally.
      if (prop === 'store') {
        return withSingleSyncRetryOnEmfile(() => Reflect.get(target, prop, target));
      }

      const value = Reflect.get(target, prop, target);

      if (prop === 'get' && typeof value === 'function') {
        return (...args: unknown[]) =>
          withSingleSyncRetryOnEmfile(() =>
            (value as (...a: unknown[]) => unknown).apply(target, args)
          );
      }

      // Intercept write methods: set(), delete(), clear()
      if (typeof prop === 'string' && WRITE_METHODS.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) => {
          if (isUserDataReadOnly()) {
             
            console.warn(`[version-gate] Blocked ${prop}() on store "${storeName}" — read-only mode`);
            return;
          }
          return withSingleSyncRetryOnEmfile(() =>
            (value as (...a: unknown[]) => unknown).apply(target, args)
          );
        };
      }

      return typeof value === 'function' ? (value as Function).bind(target) : value;
    },

    set(target, prop, value) {
      // Intercept store= assignment (the .store setter writes to disk)
      if (prop === 'store' && isUserDataReadOnly()) {
         
        console.warn(`[version-gate] Blocked store= on store "${storeName}" — read-only mode`);
        return true;
      }
      if (prop === 'store') {
        return withSingleSyncRetryOnEmfile(() => Reflect.set(target, prop, value));
      }
      return Reflect.set(target, prop, value);
    },
  }) as KeyValueStore<T>;
}

export function createStore<T extends Record<string, unknown>>(
  options: StoreFactoryOptions<T>,
): KeyValueStore<T> {
  if (!_factory) {
    throw new Error(
      'StoreFactory not initialized. Call setStoreFactory() before creating stores.',
    );
  }
  const store = _factory(options);
  return gateStoreWrites(store, options.name);
}
