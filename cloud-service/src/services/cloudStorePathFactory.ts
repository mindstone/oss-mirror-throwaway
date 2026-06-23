/**
 * Cloud store-PATH factory (corrupt-safe).
 *
 * Several cloud-service stores (Slack workspace / BYOK creds / OAuth-state /
 * pending-inbound / recent-senders) use a `StoreFactory` ONLY to obtain the
 * backing file's on-disk `.path`, then perform their OWN `fs` reads/writes (with
 * their own corruption handling). They never read `.store` / `.get` / `.set`.
 *
 * Historically the production default was `(opts) => createStore(opts)`, which
 * eagerly CONSTRUCTS the store just to read `.path`. That was harmless while the
 * cloud shim swallowed read failures — but the F1 fix makes the shim THROW on a
 * corrupt-but-real backing file (matching conf `clearInvalidConfig:false`). An
 * eager construct-for-path would then throw at store-wiring time and crash the
 * cloud SERVER on boot over a single corrupt file — a worse failure than the
 * store's own read-side handling (which already degrades gracefully).
 *
 * This factory resolves the path DETERMINISTICALLY without constructing the store
 * (so a corrupt file can never crash path resolution), using the same
 * `resolveConfStorePath` derivation the shared load-guard uses — guaranteeing the
 * path matches what the shim/conf would write. It returns a minimal object with
 * the resolved `.path`; the data methods throw if anyone ever calls them, so a
 * future misuse (treating this as a real data store) fails loudly rather than
 * silently no-op'ing.
 *
 * @see src/core/utils/loadStoreSafely.ts (resolveConfStorePath)
 * @see cloud-service/src/electronStoreShim.ts (F1: throws on corrupt construct)
 */

import type { KeyValueStore } from '@core/store';
import { resolveConfStorePath } from '@core/utils/loadStoreSafely';
import type { StoreFactory, StoreFactoryOptions } from '@core/storeFactory';

const misuse = (method: string): never => {
  throw new Error(
    `cloudStorePathOnlyFactory: '${method}' called on a path-only store handle. ` +
      'This factory resolves only the on-disk path (the consumer does its own fs IO); ' +
      'it does not back a data store. Use createStore()/safeCreateStore() for real reads/writes.',
  );
};

/**
 * A `StoreFactory` that returns a handle exposing the resolved on-disk `.path`
 * WITHOUT constructing (and therefore without ever reading/parsing) the backing
 * file. Safe to call at module/route wiring time even when the file is corrupt.
 */
export const cloudStorePathOnlyFactory: StoreFactory = <T extends Record<string, unknown>>(
  options: StoreFactoryOptions<T>,
): KeyValueStore<T> => {
  // Resolve from the store name exactly as conf/the shim would; never null on
  // cloud (REBEL_USER_DATA / platform userDataPath is always set), but fall back
  // to a relative path so a misconfigured boot still yields a usable string
  // rather than crashing here.
  const resolvedPath = resolveConfStorePath(options.name) ?? `${options.name}.json`;
  return {
    get: ((..._args: unknown[]) => misuse('get')) as KeyValueStore<T>['get'],
    set: ((..._args: unknown[]) => misuse('set')) as KeyValueStore<T>['set'],
    has: (() => misuse('has')) as KeyValueStore<T>['has'],
    delete: (() => misuse('delete')) as KeyValueStore<T>['delete'],
    clear: (() => misuse('clear')) as KeyValueStore<T>['clear'],
    get store(): T {
      return misuse('store');
    },
    set store(_value: T) {
      misuse('store=');
    },
    path: resolvedPath,
  } as KeyValueStore<T>;
};
