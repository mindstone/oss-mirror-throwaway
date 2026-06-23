import {
  ProviderId,
  ProbeResult,
  ProbeErrorCode,
  ProviderReachabilitySnapshot,
} from '@shared/diagnostics/providerReachabilitySnapshot';
import { getSettings, onSettingsChange } from '../settingsStore';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 30_000;
const CLOUD_FALLBACK_URL = 'https://rebel.mindstone.com';

const PROVIDER_URLS: Record<ProviderId, () => string> = {
  anthropic: () => 'https://api.anthropic.com/',
  openai: () => 'https://api.openai.com/v1/models',
  google: () => 'https://generativelanguage.googleapis.com/',
  openrouter: () => 'https://openrouter.ai/',
  codex: () => 'https://chatgpt.com/',
  'rebel-cloud': () => {
    try {
      const url = getSettings().cloudInstance?.cloudUrl || CLOUD_FALLBACK_URL;
      return url.replace(/\/+$/, '') + '/api/ping';
    } catch {
      return CLOUD_FALLBACK_URL + '/api/ping';
    }
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let snapshot: ProviderReachabilitySnapshot = {
  snapshotPresent: false,
  lastRefreshAt: null,
  providers: {},
};

function resetSnapshot(): void {
  snapshot = {
    snapshotPresent: false,
    lastRefreshAt: null,
    providers: {},
  };
}

function cloneSnapshot(): ProviderReachabilitySnapshot {
  const now = Date.now();
  const providers = Object.fromEntries(
    Object.entries(snapshot.providers ?? {}).map(([provider, result]) => [
      provider,
      {
        ...result,
        stale: result.stale || now > result.expiresAt,
      },
    ]),
  ) as ProviderReachabilitySnapshot['providers'];

  return {
    snapshotPresent: snapshot.snapshotPresent,
    lastRefreshAt: snapshot.lastRefreshAt,
    providers,
  };
}

function writeProbeResult(provider: ProviderId, result: ProbeResult): ProbeResult {
  snapshot.providers = {
    ...(snapshot.providers ?? {}),
    [provider]: { ...result },
  };
  snapshot.snapshotPresent = true;
  snapshot.lastRefreshAt = Date.now();
  return { ...result };
}

// Clear cache when settings change (e.g., active provider changes or cloud instance URL changes).
//
// The settings listener is bound lazily via ensureSettingsListener() on first use of the public
// entry points — deliberately NOT eagerly at module load. An eager bind here runs before the
// SettingsStoreAdapter boundary is initialised in bundles whose module-init ordering imports this
// file pre-bootstrap (e.g. the OSS desktop build), where onSettingsChange() throws
// "SettingsStoreAdapter not initialized" and prints an alarming-but-benign stack trace at boot.
// Deferring to first use is fully equivalent: the cache only holds data after a probe, and every
// production path that probes or reads the cache (getProviderReachabilitySnapshot /
// refreshProviderReachabilityCache) calls ensureSettingsListener() before touching the snapshot.
let unlistenSettings: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Logic
// ---------------------------------------------------------------------------

function classifyReachabilityError(err: unknown): ProbeResult['errorCode'] {
  if (err && typeof err === 'object' && 'name' in err && (err as Error).name === 'AbortError') {
    return 'timeout';
  }

  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  
  if (
    message.includes('unable to get local issuer certificate') ||
    message.includes('unable to verify the first certificate') ||
    message.includes('self signed certificate') ||
    message.includes('certificate verify failed') ||
    message.includes('err_tls') ||
    message.includes('certificate has expired')
  ) {
    return 'tls';
  }

  if (message.includes('timed out') || message.includes('etimedout')) {
    return 'timeout';
  }

  if (
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('enetunreach') ||
    message.includes('ehostunreach') ||
    message.includes('socket hang up')
  ) {
    return 'dns';
  }

  return 'unknown';
}

/**
 * Performs a HEAD-only request to the provider's known reachability URL.
 * Never sends a body or reads/sends API keys.
 * Returns structured status + error code + latency.
 */
export async function probeProviderReachability(provider: ProviderId): Promise<ProbeResult> {
  // Attempt to bind the settings-change invalidator before writing the cache.
  // probeProviderReachability is the only cache-writing path besides the snapshot/refresh getters
  // (which already bind on entry), so this keeps cache invalidation wired up the same way the
  // removed eager module-load bind did — without the boot-time stack trace. If the adapter is
  // still uninitialised at first use, ensureSettingsListener() logs and continues (graceful
  // degradation already present on the getter/refresh paths); in practice first use is post-boot.
  ensureSettingsListener();
  const url = PROVIDER_URLS[provider]();
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  const now = Date.now();

  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    
    clearTimeout(timeout);
    const latencyMs = Date.now() - startTime;

    if (response.ok || response.status === 404 || response.status === 401 || response.status === 403) {
      // 404/401/403 indicate we reached the server and it responded via HTTP
      return writeProbeResult(provider, {
        status: 'reachable',
        latencyMs,
        checkedAt: now,
        cachedAt: now,
        expiresAt: now + CACHE_TTL_MS,
        stale: false,
      });
    }

    // Server responded but with 5xx or weird 4xx that might imply a gateway error
    const is5xx = response.status >= 500 && response.status < 600;
    return writeProbeResult(provider, {
      status: 'unreachable',
      latencyMs,
      errorCode: is5xx ? 'http_5xx' : 'http_4xx',
      checkedAt: now,
      cachedAt: now,
      expiresAt: now + CACHE_TTL_MS,
      stale: false,
    });
  } catch (err) {
    clearTimeout(timeout);
    const latencyMs = Date.now() - startTime;
    const errorCode = classifyReachabilityError(err);
    
    return writeProbeResult(provider, {
      status: 'unreachable',
      latencyMs,
      errorCode,
      checkedAt: now,
      cachedAt: now,
      expiresAt: now + CACHE_TTL_MS,
      stale: false,
    });
  }
}

/**
 * Ensures we are listening to settings changes for cache invalidation.
 */
function ensureSettingsListener() {
  if (!unlistenSettings) {
    try {
      unlistenSettings = onSettingsChange(() => {
        // Invalidate the cache by resetting the snapshot
        resetSnapshot();
      });
    } catch (err) {
      // Still not ready
      console.warn('[providerReachabilitySnapshot] Could not bind onSettingsChange on demand.', err);
    }
  }
}

/**
 * Gets the current provider reachability snapshot without performing network I/O.
 *
 * Callers that want to refresh stale data must explicitly call
 * refreshProviderReachabilityCache() or probeProviderReachability().
 */
export function getProviderReachabilitySnapshot(): ProviderReachabilitySnapshot {
  ensureSettingsListener();
  return cloneSnapshot();
}

/**
 * Explicitly refreshes the provider reachability cache.
 *
 * The refresh is TTL-aware by default: existing entries are reused until their
 * 30s TTL expires. Pass force=true for a direct user action that should
 * re-check providers immediately.
 */
export async function refreshProviderReachabilityCache(
  providersToProbe?: ProviderId[],
  options?: { force?: boolean },
): Promise<ProviderReachabilitySnapshot> {
  ensureSettingsListener();

  const now = Date.now();
  const toProbe = providersToProbe || (Object.keys(PROVIDER_URLS) as ProviderId[]);

  const promises: Promise<void>[] = [];

  // Ensure providers object exists
  if (!snapshot.providers) {
    snapshot.providers = {};
  }

  for (const provider of toProbe) {
    const existing = snapshot.providers[provider];

    if (options?.force || !existing || now > existing.expiresAt) {
      // Need to refresh
      const probePromise = probeProviderReachability(provider).then(() => undefined);
      promises.push(probePromise);

      // Mark existing as stale if present while we wait
      if (existing) {
        existing.stale = true;
      }
    }
  }

  await Promise.all(promises);
  return cloneSnapshot();
}

// ---------------------------------------------------------------------------
// All-providers-unreachable verdict (support-facing diagnostics only)
// ---------------------------------------------------------------------------

/** Verdict produced by {@link detectAllProvidersUnreachable}. */
export type ReachabilityVerdict =
  /** Every provider with fresh, definite evidence was unreachable. */
  | 'all_unreachable'
  /** Some fresh providers reachable, some unreachable. */
  | 'partially_unreachable'
  /** At least one fresh provider reachable; none unreachable. */
  | 'none_unreachable'
  /** No fresh, definite evidence (empty / all-stale / unknown-status snapshot). */
  | 'inconclusive';

export interface ReachabilityAssessment {
  verdict: ReachabilityVerdict;
  /** Providers whose probe data was fresh + definite, and thus drove the verdict. */
  consideredProviders: ProviderId[];
  /** The subset of considered providers that were unreachable. */
  unreachableProviders: ProviderId[];
  /** Error code per unreachable provider, for support triage. */
  errorCodes: Partial<Record<ProviderId, ProbeErrorCode>>;
  /** Snapshot's last refresh time (so a verdict from stale-ish data is interpretable). */
  lastRefreshAt: number | null;
}

/**
 * Pure verdict over a reachability snapshot: "is everything unreachable right now?"
 *
 * Only FRESH (non-stale) probes with a DEFINITE status (`reachable`/`unreachable`)
 * count as evidence. Stale, missing, or `unknown`-status entries are NOT treated as
 * unreachable — they make the verdict `inconclusive`. This keeps diagnostics honest
 * during the exact degraded states they exist to explain: a stale or empty snapshot
 * must never read as a confident "all providers down" (plan critique F7).
 *
 * Support-facing only: drives NO user-facing copy and NO retry/routing decision.
 * Pure (no I/O, no mutation) → unit-testable in isolation.
 */
export function detectAllProvidersUnreachable(
  snapshot: ProviderReachabilitySnapshot,
): ReachabilityAssessment {
  const entries = Object.entries(snapshot.providers ?? {}) as Array<[ProviderId, ProbeResult]>;
  const fresh = entries.filter(
    ([, r]) => r && !r.stale && (r.status === 'reachable' || r.status === 'unreachable'),
  );
  const unreachable = fresh.filter(([, r]) => r.status === 'unreachable');
  const reachable = fresh.filter(([, r]) => r.status === 'reachable');

  const errorCodes: Partial<Record<ProviderId, ProbeErrorCode>> = {};
  for (const [provider, r] of unreachable) {
    if (r.errorCode) errorCodes[provider] = r.errorCode;
  }

  let verdict: ReachabilityVerdict;
  if (!snapshot.snapshotPresent || fresh.length === 0) {
    verdict = 'inconclusive';
  } else if (unreachable.length > 0 && reachable.length === 0) {
    verdict = 'all_unreachable';
  } else if (unreachable.length > 0) {
    verdict = 'partially_unreachable';
  } else {
    verdict = 'none_unreachable';
  }

  return {
    verdict,
    consideredProviders: fresh.map(([p]) => p),
    unreachableProviders: unreachable.map(([p]) => p),
    errorCodes,
    lastRefreshAt: snapshot.lastRefreshAt,
  };
}
