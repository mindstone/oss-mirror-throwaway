/**
 * Bridge port discovery.
 *
 * The Rebel desktop app binds the App Bridge on 52320, falling back to the
 * next port in APP_BRIDGE_PORT_FALLBACKS when `EADDRINUSE` hits (e.g. dev +
 * prod Rebel on the same machine, R30/D26). The extension doesn't know which
 * port won the race, so we probe each candidate for a couple seconds, keep
 * the first one that answers an `/intent/health` identity check, and cache
 * the result for 60s before re-probing.
 *
 * Non-goals:
 *   - Secret-free identity: the health endpoint returns a predictable JSON
 *     payload; anyone on localhost can fingerprint it. That's acceptable —
 *     real authentication lives in the WS token exchange (Stage 3).
 *   - Hostname flexibility: we only ever talk to 127.0.0.1. An attacker on a
 *     rogue DNS lookup cannot redirect us.
 *
 * @see docs/plans/260418_rebel_app_bridge_and_browser_extension.md (Stage 6a §port-discovery)
 */

export const CANDIDATE_PORTS: readonly number[] = [
  52320, 52321, 52322, 52323, 52324, 52325,
] as const;

export const DEFAULT_PROBE_TIMEOUT_MS = 800;
export const DEFAULT_CACHE_TTL_MS = 60_000;
export const HEALTH_PATH = '/intent/health';
/** Shape the server returns when the bridge is live (a subset is enough). */
export const HEALTH_IDENTITY = 'rebel-app-bridge';

export interface HealthBody {
  ok: boolean;
  service?: string;
  version?: string;
  [key: string]: unknown;
}

export interface DiscoveredPort {
  port: number;
  origin: string;
  version?: string;
  cachedAt: number;
}

export interface PortDiscoveryOptions {
  /** Override fetch (tests). Must mimic `window.fetch`. */
  fetchImpl?: typeof fetch;
  /** Per-probe timeout. Defaults to 800ms. */
  probeTimeoutMs?: number;
  /** How long to cache a successful discovery. Defaults to 60s. */
  cacheTtlMs?: number;
  /** Override candidates (tests). */
  candidates?: readonly number[];
  /** Clock for cache expiry (tests). */
  now?: () => number;
}

export interface PortDiscovery {
  /** Return the cached port if fresh, else probe candidates in order. */
  getPort(): Promise<DiscoveredPort | null>;
  /** Force a re-probe regardless of cache state. */
  refresh(): Promise<DiscoveredPort | null>;
  /** Drop any cached discovery (e.g. on 401/failed handshake). */
  invalidate(): void;
  /** Expose the last cached entry without probing (for diagnostics/tests). */
  peekCache(): DiscoveredPort | null;
}

/**
 * Probe a single port — returns the port payload on a successful `/intent/health`
 * identity match, `null` on any failure. Never throws.
 */
export async function probePort(
  port: number,
  opts: {
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<DiscoveredPort | null> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}${HEALTH_PATH}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      signal: controller.signal,
      // `no-store` avoids SW HTTP cache masking a port reuse across restarts.
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as HealthBody | null;
    if (!body) return null;
    if (body.service !== HEALTH_IDENTITY) return null;
    if (body.ok !== true) return null;
    const result: DiscoveredPort = {
      port,
      origin,
      cachedAt: Date.now(),
    };
    if (typeof body.version === 'string') {
      result.version = body.version;
    }
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a discovery helper with a TTL cache.
 *
 * Implementation notes:
 *   - Probes run sequentially (not in parallel) so we don't light up 6 ports
 *     when port 52320 is usually correct. Cost is tiny and logs stay clean.
 *   - A probe failing with a specific port in the cache invalidates *only*
 *     that entry; the next caller re-probes from scratch.
 */
export function createPortDiscovery(
  options: PortDiscoveryOptions = {},
): PortDiscovery {
  const candidates = options.candidates ?? CANDIDATE_PORTS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl;

  let cache: DiscoveredPort | null = null;

  const probeAll = async (): Promise<DiscoveredPort | null> => {
    for (const port of candidates) {
      const probeOpts = fetchImpl
        ? { fetchImpl, timeoutMs: probeTimeoutMs }
        : { timeoutMs: probeTimeoutMs };
      const result = await probePort(port, probeOpts);
      if (result) {
        cache = { ...result, cachedAt: now() };
        return cache;
      }
    }
    cache = null;
    return null;
  };

  return {
    async getPort() {
      if (cache && now() - cache.cachedAt < cacheTtlMs) {
        return cache;
      }
      return probeAll();
    },
    async refresh() {
      cache = null;
      return probeAll();
    },
    invalidate() {
      cache = null;
    },
    peekCache() {
      return cache;
    },
  };
}
