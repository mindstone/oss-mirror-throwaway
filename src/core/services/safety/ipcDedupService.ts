/**
 * IPC request/response dedup cache.
 *
 * Stage C of `docs/plans/260417_approval_consolidation_closeout.md` closes
 * the server-side double-fire gap left by cloud-client's `fetchWithRetry`
 * (see `cloud-client/src/cloudClient.ts`): when a POST's first attempt
 * successfully mutated server state but its response was lost on the way
 * back (TCP reset, timeout), `fetchWithRetry` naturally re-dispatches the
 * identical payload. Without server-side dedup, the second attempt runs
 * the mutation a second time.
 *
 * The store's `isIdempotentSuccess` handling already suppresses the
 * user-visible row duplication for the 4 staging channels, but the
 * handler still pays the full cost of the second run. This service is
 * the defense-in-depth layer: when the client attaches a per-action
 * UUID as `clientDedupKey`, the server records the first response and
 * replays it for any retry arriving within the TTL.
 *
 * Design goals:
 *   1. **Per-process, in-memory.** No persistence — a restart drops the
 *      cache, which is safe (the user simply retries and the original
 *      handler runs again).
 *   2. **Short TTL.** 30 seconds by default. Long enough to cover the
 *      longest reasonable retry window (default backoff `1s × 1.5 ^ N`
 *      with 2 retries tops out around 6 s); short enough that two
 *      intentional user actions with the same key (e.g. the UI was
 *      buggy) don't get silently collapsed for minutes.
 *   3. **Bounded memory.** Capped at 500 entries with lazy-purge + FIFO
 *      eviction. Under attacker-induced churn the map never grows past
 *      the cap, sacrificing dedup guarantees for the oldest entries.
 *   4. **Zero Electron imports.** Lives in `src/core/` so both the
 *      Electron main process and the cloud service wire their own
 *      per-process instance (`src/main/index.ts` and
 *      `cloud-service/src/bootstrap.ts`).
 *   5. **Fail open on empty key.** If no `clientDedupKey` is present,
 *      the service returns `undefined` from `peek` and is a no-op on
 *      `record` — the handler runs as if dedup was never attached.
 *
 * Threat model — what this defends against:
 *   - `fetchWithRetry` re-dispatching a lost-response retry that would
 *     mutate server state twice.
 *
 * Out of scope:
 *   - Cross-process / cross-machine dedup. Each desktop + cloud process
 *     keeps its own cache. Acceptable because each client's retries
 *     hit the same server process (or the same desktop instance).
 *   - Persistence. A restart during a 30-second window is rare enough
 *     that the degraded-behaviour surface (second attempt re-runs) is
 *     the right trade-off versus adding a disk/IDB layer.
 *   - Error caching nuance. We cache whatever the wrapped handler
 *     returned synchronously, including `{ status: 'error', ... }`.
 *     Handlers that THREW do not get cached (see `withDedup` in
 *     `memoryHandlers.ts`). Same input + same failure mode within TTL
 *     = same response back — this is correct, not a bug.
 */

/** Default TTL (milliseconds). Exported for tests + planning-doc readers. */
export const DEFAULT_DEDUP_TTL_MS = 30_000;

/** Default cap on cached entries before FIFO eviction kicks in. */
export const DEFAULT_DEDUP_CAP = 500;

export interface IpcDedupService {
  /**
   * Return the cached response for `(channel, key)` if still within TTL,
   * else `undefined`. An `undefined` or empty `key` always returns
   * `undefined` (no-op for callers that choose not to pass a dedup key).
   *
   * Distinction: `undefined` = "nothing cached" vs. any other value =
   * "this is the cached response (replay it)". Callers MUST branch on
   * `peek(...) !== undefined` rather than truthy/falsy — handler
   * responses like `{ status: 'success' }` are truthy but so is
   * `undefined` when coerced.
   */
  peek(channel: string, key: string): unknown;

  /**
   * Record the response for `(channel, key)`. No-op when `key` is
   * missing or empty. Evicts expired entries and FIFO-evicts the oldest
   * entry if the cap is reached.
   */
  record(channel: string, key: string, response: unknown): void;
}

export interface CreateIpcDedupServiceOptions {
  /** Override TTL (ms). Defaults to {@link DEFAULT_DEDUP_TTL_MS}. */
  ttlMs?: number;
  /** Override cap. Defaults to {@link DEFAULT_DEDUP_CAP}. */
  cap?: number;
  /** Override clock for deterministic tests. Defaults to {@link Date.now}. */
  now?: () => number;
}

interface CacheEntry {
  response: unknown;
  recordedAt: number;
}

function compositeKey(channel: string, key: string): string {
  // The `channel` axis isolates keys per IPC endpoint so two different
  // handlers that happen to reuse the same client-generated UUID (which
  // shouldn't happen, but defensively) get independent cache slots.
  return `${channel}:${key}`;
}

/**
 * Create a single {@link IpcDedupService} instance. Call once per process
 * at startup. The returned service captures its cache in closure — do
 * NOT instantiate multiple services for the same process and expect
 * entries to flow between them (that's a design feature, not a bug).
 */
export function createIpcDedupService(
  options: CreateIpcDedupServiceOptions = {},
): IpcDedupService {
  const ttlMs = options.ttlMs ?? DEFAULT_DEDUP_TTL_MS;
  const cap = options.cap ?? DEFAULT_DEDUP_CAP;
  const now = options.now ?? Date.now;

  // Map iteration is insertion-ordered in all modern JS engines, so
  // `keys().next()` yields the oldest entry for FIFO eviction — no
  // separate queue required.
  const cache = new Map<string, CacheEntry>();

  function isExpired(entry: CacheEntry, currentMs: number): boolean {
    return currentMs - entry.recordedAt >= ttlMs;
  }

  function purgeExpired(currentMs: number): void {
    for (const [k, entry] of cache) {
      if (isExpired(entry, currentMs)) {
        cache.delete(k);
      }
    }
  }

  function enforceCap(currentMs: number): void {
    if (cache.size < cap) return;
    purgeExpired(currentMs);
    while (cache.size >= cap) {
      const oldest = cache.keys().next();
      if (oldest.done || typeof oldest.value !== 'string') break;
      cache.delete(oldest.value);
    }
  }

  return {
    peek(channel, key) {
      if (typeof key !== 'string' || key.length === 0) return undefined;
      const currentMs = now();
      const k = compositeKey(channel, key);
      const entry = cache.get(k);
      if (!entry) return undefined;
      if (isExpired(entry, currentMs)) {
        // Lazy-purge the stale entry on read so peek → record for the
        // same key doesn't double up.
        cache.delete(k);
        return undefined;
      }
      return entry.response;
    },

    record(channel, key, response) {
      if (typeof key !== 'string' || key.length === 0) return;
      const currentMs = now();
      // Bound memory BEFORE inserting so the cap is a hard ceiling even
      // under sustained legitimate insertion. purgeExpired runs inside
      // enforceCap so the first-line defense (expired-first eviction)
      // fires before the FIFO drop.
      enforceCap(currentMs);
      const k = compositeKey(channel, key);
      cache.set(k, { response, recordedAt: currentMs });
    },
  };
}
