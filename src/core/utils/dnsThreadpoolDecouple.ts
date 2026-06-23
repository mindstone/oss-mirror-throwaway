/**
 * DNS resolver selection for all outbound HTTP.
 *
 * ## Default
 * Desktop defaults to Node's OS resolver (`dns.lookup` / getaddrinfo). That
 * honors OS-scoped and VPN split-DNS rules by construction, which fixes the
 * REBEL-6B6 class where c-ares bypassed the user's VPN resolver configuration.
 *
 * ## c-ares opt-in
 * The c-ares/cacheable-lookup path remains as an instant rollback and for cloud:
 * set `REBEL_HTTP_RESOLVER=cares` or `REBEL_DNS_DECOUPLE=1` to install an undici
 * dispatcher whose `connect.lookup` resolves via c-ares off the libuv threadpool
 * with `dns.lookup` fallback. It was added for threadpool-starvation protection,
 * but it can bypass VPN scoped DNS, so it is no longer the desktop default.
 *
 * Cloud intentionally opts into c-ares via deploy env (`cloud-service/fly.toml`)
 * because there is no user VPN on that surface and the OS-resolver/cache impact
 * in `node:22-slim` is spike-unproven.
 *
 * The MCP client constructs its OWN undici `Agent` (mcpClient.ts), not covered
 * by the global dispatcher, and reads the same `isCaresDnsEnabled()` selector.
 *
 * SSRF is net-neutral: `ssrfProtection.ts` still validates via `dns.resolve4/6`
 * BEFORE fetch; this only selects the connect-time resolver and does not bypass
 * any pre-fetch validation.
 *
 * Node-only (uses `node:dns`, `undici`, `cacheable-lookup`). Do not import from
 * the renderer or any browser surface.
 *
 * @see docs/plans/260617_meeting-bot-dns-starvation/PLAN.md
 */
import * as dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import CacheableLookup from 'cacheable-lookup';
// eslint-disable-next-line no-restricted-syntax -- dns-decouple-justified: canonical resolver-choice module; undici symbols are only used when the c-ares selector opts in
import { Agent, setGlobalDispatcher } from 'undici';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'dnsThreadpoolDecouple' });

let sharedCacheableLookup: CacheableLookup | undefined;
let globalDecoupleInstalled = false;
let decoupledLookup: LookupFunction | undefined;

// Boot-time selector for outbound HTTP DNS. Default is the OS resolver; c-ares
// is opt-in for rollback/cloud. Legacy kill-switch values still force OS and
// win over any opt-in. Read at module load — must precede any settings load.
const isOsResolverForced =
  process.env.REBEL_HTTP_RESOLVER === 'system' || process.env.REBEL_DNS_DECOUPLE === '0';
const isCaresOptIn =
  process.env.REBEL_HTTP_RESOLVER === 'cares' || process.env.REBEL_DNS_DECOUPLE === '1';
const CARES_DNS_ENABLED = !isOsResolverForced && isCaresOptIn;

export function isCaresDnsEnabled(): boolean {
  return CARES_DNS_ENABLED;
}

/**
 * Lazily construct the ONE shared `CacheableLookup` instance.
 *
 * Default options are intentional: `fallbackDuration` stays at its 3600s default
 * so c-ares failures (ENOTFOUND/ENODATA for /etc/hosts, `.local`/mDNS, VPN
 * split-horizon names) transparently fall back to `dns.lookup`. Do NOT pass
 * `fallbackDuration: 0`.
 */
export function getSharedCacheableLookup(): CacheableLookup {
  if (!sharedCacheableLookup) {
    // maxTtl bounds cached entries to 60s (never serve very stale DNS); the lib's
    // sub-second errorTtl default means failures aren't cached; fallbackDuration
    // stays at its 3600s default so the dns.lookup fallback (for /etc/hosts,
    // .local/mDNS, VPN split-horizon) remains ON.
    sharedCacheableLookup = new CacheableLookup({ maxTtl: 60 });
  }
  return sharedCacheableLookup;
}

/**
 * The callback-form lookup (matching `dns.lookup`'s signature) that undici's
 * `connect.lookup` expects. Resolves off the libuv threadpool via c-ares, with
 * `dns.lookup` fallback for names c-ares can't resolve.
 */
/**
 * Wrap a cacheable-lookup with a hard fall-through to `dns.lookup` on ANY c-ares
 * error. cacheable-lookup only auto-falls-back on ENODATA/ENOTFOUND (empty
 * answers); `SERVFAIL`, c-ares timeouts, and malformed answers would otherwise
 * propagate and fail the connect. Falling back to getaddrinfo on those keeps the
 * resolver "never worse than today" — the fallback re-enters the threadpool, but
 * only on the rare c-ares-failure path, not the hot path. Exported for testing.
 */
export function createLookupWithFallback(
  cacheable: Pick<CacheableLookup, 'lookup'>,
  dnsLookup: typeof dns.lookup = dns.lookup,
): LookupFunction {
  type Cb = (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void;
  const clLookup = cacheable.lookup as unknown as (h: string, o: dns.LookupOptions, cb: Cb) => void;
  const sysLookup = dnsLookup as unknown as (h: string, o: dns.LookupOptions, cb: Cb) => void;
  const lookup = (hostname: string, options: dns.LookupOptions | Cb, callback?: Cb): void => {
    const cb = (typeof options === 'function' ? options : callback) as Cb;
    const opts = (typeof options === 'function' ? {} : options) as dns.LookupOptions;
    clLookup(hostname, opts, (err, ...rest) => {
      if (err) {
        // c-ares SERVFAIL / timeout / malformed → getaddrinfo fallback (never worse).
        sysLookup(hostname, opts, cb);
        return;
      }
      cb(null, ...rest);
    });
  };
  return lookup as unknown as LookupFunction;
}

/**
 * The callback-form lookup undici's `connect.lookup` expects. Resolves off the
 * libuv threadpool via c-ares, with a hard `dns.lookup` fallback on any c-ares
 * error (see {@link createLookupWithFallback}). Memoized so the global dispatcher
 * and the MCP Agent share one stable lookup reference.
 */
export function getDecoupledLookup(): LookupFunction {
  if (!decoupledLookup) {
    decoupledLookup = createLookupWithFallback(getSharedCacheableLookup(), dns.lookup);
  }
  return decoupledLookup;
}

/**
 * Install the global undici resolver choice. In OS-resolver mode this logs and
 * leaves the default dispatcher in place; in c-ares mode it installs a dispatcher
 * whose connect-time resolver is decoupled from the libuv threadpool. Idempotent
 * — calling twice is a no-op. Covers `globalThis.fetch` (and therefore the
 * Anthropic SDK). The MCP client's own undici Agent reads the same selector.
 *
 * Must be called at boot, after graceful-fs / system certs and before any
 * outbound HTTP.
 */
export function installGlobalUndiciDnsDecouple(): void {
  if (globalDecoupleInstalled) {
    return;
  }
  globalDecoupleInstalled = true;
  if (!CARES_DNS_ENABLED) {
    log.info(
      'Outbound HTTP DNS using OS resolver (getaddrinfo/dns.lookup); c-ares opt-in via REBEL_HTTP_RESOLVER=cares or REBEL_DNS_DECOUPLE=1',
    );
    return;
  }
  try {
    // eslint-disable-next-line no-restricted-syntax -- dns-decouple-justified: canonical installer; the dispatcher below uses the shared getDecoupledLookup()
    setGlobalDispatcher(
      // eslint-disable-next-line no-restricted-syntax -- dns-decouple-justified: canonical c-ares opt-in Agent constructed with connect.lookup = getDecoupledLookup()
      new Agent({
        // autoSelectFamily enables undici's happy-eyeballs across IPv4/IPv6. c-ares
        // (unlike getaddrinfo) does not fall back across families on its own, so
        // without this an IPv6-only / mixed network could fail to connect.
        connect: { lookup: getDecoupledLookup(), autoSelectFamily: true },
      }),
    );
    log.info(
      'Decoupled DNS dispatcher installed: using c-ares/cacheable-lookup for outbound HTTP (dns.lookup fallback retained, autoSelectFamily on)',
    );
  } catch (err) {
    // Fail open: a broken resolver must never take down ALL outbound HTTP. Leave
    // the default dispatcher (getaddrinfo) in place — the threadpool-starvation
    // risk returns, but the app stays usable. Reset the flag so a later call may retry.
    globalDecoupleInstalled = false;
    log.error({ err }, 'Failed to install decoupled DNS dispatcher; left default resolver in place');
  }
}
