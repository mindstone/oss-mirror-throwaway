/**
 * SSRF (Server-Side Request Forgery) Protection Utilities
 *
 * Shared infrastructure for validating URLs and IP addresses to prevent
 * SSRF attacks. Used by both pluginExternalFetchService (plugin fetch)
 * and the WebFetch builtin tool.
 *
 * Security layers:
 * 1. Private/local IP blocking (IPv4 + IPv6)
 * 2. DNS resolution with rebinding protection (5s cache)
 * 3. Safe redirect following with per-hop IP validation
 * 4. Scheme allowlisting (http/https only)
 *
 * @see src/main/services/pluginExternalFetchService.ts — consumer (plugin fetch)
 * @see docs/plans/260411_restore_web_and_search_builtin_tools.md — planning doc
 */

import dns from 'node:dns/promises';
// `LookupOptions` lives in the callback `node:dns` namespace, not `node:dns/promises`.
import type { LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
// eslint-disable-next-line no-restricted-syntax -- dns-decouple-justified: Agent is used only by buildPinnedDispatcher, whose connect.lookup is a constant-returning pinned lookup (off the libuv threadpool by construction); it never uses Node's default getaddrinfo, so it satisfies the decouple rule's intent. SSRF connect-to-validated-IP fix (260617).
import { Agent } from 'undici';
import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ service: 'ssrfProtection' });

// ── Private IP Detection ───────────────────────────────────────────────

/**
 * IPv4 private/reserved ranges to block (SSRF prevention).
 *
 * Each entry is a { prefix, mask } pair for unsigned 32-bit comparison.
 * To check: `(ipNum & mask) === prefix` (both sides unsigned via `>>> 0`).
 */
export const PRIVATE_IPV4_RANGES: Array<{ prefix: number; mask: number }> = [
  { prefix: 0x7F000000, mask: 0xFF000000 },   // 127.0.0.0/8  — loopback
  { prefix: 0x0A000000, mask: 0xFF000000 },   // 10.0.0.0/8   — private
  { prefix: 0xAC100000, mask: 0xFFF00000 },   // 172.16.0.0/12 — private
  { prefix: 0xC0A80000, mask: 0xFFFF0000 },   // 192.168.0.0/16 — private
  { prefix: 0xA9FE0000, mask: 0xFFFF0000 },   // 169.254.0.0/16 — link-local
  { prefix: 0x00000000, mask: 0xFF000000 },   // 0.0.0.0/8    — "this" network
  { prefix: 0x64400000, mask: 0xFFC00000 },   // 100.64.0.0/10 — carrier-grade NAT (RFC 6598)
  { prefix: 0xC6120000, mask: 0xFFFE0000 },   // 198.18.0.0/15 — benchmarking (RFC 2544)
];

/**
 * Convert a dotted-decimal IPv4 address to an unsigned 32-bit number.
 * Returns null if the string is not a valid IPv4 address.
 */
export function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    const num = parseInt(part, 10);
    if (isNaN(num) || num < 0 || num > 255) return null;
    result = (result << 8) | num;
  }
  return result >>> 0; // unsigned 32-bit
}

/**
 * Check if an IPv4 address (as unsigned 32-bit number) falls in any private range.
 *
 * JavaScript bitwise operators produce signed 32-bit results, so we use `>>> 0`
 * on both sides of the comparison to ensure unsigned comparison.
 */
export function isPrivateIpv4(ipNum: number): boolean {
  for (const range of PRIVATE_IPV4_RANGES) {
    if (((ipNum & range.mask) >>> 0) === (range.prefix >>> 0)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if an IP address is private/reserved and should be blocked.
 * Handles both IPv4 and IPv6, including IPv4-mapped IPv6 addresses.
 */
export function isPrivateIp(ip: string): boolean {
  // Check localhost hostnames
  const lower = ip.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) {
    return true;
  }

  // IPv6 checks
  if (ip.includes(':')) {
    const normalized = ip.toLowerCase();
    // Loopback
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
    // Unique local (fc00::/7)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    // Link-local (fe80::/10)
    if (normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
        normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
    // Unspecified
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
    // IPv4-mapped IPv6 — dotted-decimal form (::ffff:x.x.x.x)
    const v4MappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (v4MappedDotted) {
      return isPrivateIp(v4MappedDotted[1]);
    }
    // IPv4-mapped IPv6 — hex form (::ffff:HHHH:HHHH)
    const v4MappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4MappedHex) {
      const high = parseInt(v4MappedHex[1], 16);
      const low = parseInt(v4MappedHex[2], 16);
      const dotted = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      return isPrivateIp(dotted);
    }
    return false;
  }

  // IPv4 checks
  const ipNum = ipv4ToNumber(ip);
  if (ipNum === null) return false;

  return isPrivateIpv4(ipNum);
}

// ── DNS Resolution + Rebinding Protection ──────────────────────────────

/**
 * Simple DNS result cache to mitigate TOCTOU rebinding.
 * Entries expire after 5 seconds — subsequent fetches to the same hostname
 * within that window reuse the validated IP without re-resolving.
 */
const DNS_CACHE_TTL_MS = 5_000;

interface DnsCacheEntry {
  ip: string;
  expiresAt: number;
}

const dnsResultCache = new Map<string, DnsCacheEntry>();

/** Clear DNS cache (for testing). */
export function _clearDnsCacheForTesting(): void {
  dnsResultCache.clear();
}

function getCachedDnsResult(hostname: string): string | null {
  const entry = dnsResultCache.get(hostname);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    dnsResultCache.delete(hostname);
    return null;
  }
  return entry.ip;
}

function cacheDnsResult(hostname: string, ip: string): void {
  dnsResultCache.set(hostname, { ip, expiresAt: Date.now() + DNS_CACHE_TTL_MS });
}

/**
 * Resolve a hostname and verify the resolved IP is not private.
 * Returns the first validated public IP address for use in the fetch call.
 * Caches the result for 5 seconds to mitigate DNS rebinding TOCTOU.
 */
export async function resolveAndValidateHost(hostname: string): Promise<string> {
  // Direct IP address check (no DNS needed)
  if (isPrivateIp(hostname)) {
    throw new Error(`Blocked: "${hostname}" resolves to a private/local network address.`);
  }

  // Hostname-level blocks
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.local')) {
    throw new Error(`Blocked: "${hostname}" is a local hostname.`);
  }

  // Check DNS cache first
  const cachedIp = getCachedDnsResult(hostname);
  if (cachedIp) {
    return cachedIp;
  }

  try {
    // Resolve both IPv4 and IPv6
    const [ipv4Results, ipv6Results] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ]);

    const resolvedIps: string[] = [];
    if (ipv4Results.status === 'fulfilled') resolvedIps.push(...ipv4Results.value);
    if (ipv6Results.status === 'fulfilled') resolvedIps.push(...ipv6Results.value);

    if (resolvedIps.length === 0) {
      throw new Error(`DNS resolution failed: no addresses found for "${hostname}".`);
    }

    // DNS rebinding protection: all resolved IPs must be public
    for (const resolvedIp of resolvedIps) {
      if (isPrivateIp(resolvedIp)) {
        throw new Error(
          `Blocked: "${hostname}" resolved to private IP ${resolvedIp}. This may indicate DNS rebinding.`,
        );
      }
    }

    // Cache the first resolved IP for subsequent rapid requests
    const pinnedIp = resolvedIps[0];
    cacheDnsResult(hostname, pinnedIp);
    return pinnedIp;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Blocked:')) {
      throw error;
    }
    if (error instanceof Error && error.message.startsWith('DNS resolution failed:')) {
      throw error;
    }
    throw new Error(`DNS resolution failed for "${hostname}": ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// ── Connect-to-validated-IP (close DNS-rebinding TOCTOU) ───────────────

/**
 * Build a `lookup` (matching `dns.lookup`'s callback contract) that ALWAYS
 * returns the single already-validated IP — never re-resolving DNS. This is the
 * core of the rebinding fix: the SSRF check resolves+validates the IP, and the
 * connect uses *that same IP*, so the check IP and the connect IP cannot diverge.
 *
 * Node's `net.connect`/`tls.connect` invoke a custom lookup with
 * `options = { hints, all: true }`; when `all` is set the callback MUST return
 * an array of `{ address, family }`, NOT positional `(err, address, family)`
 * (positional yields `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined`).
 * We handle both shapes for safety.
 *
 * Because it returns a constant synchronously, this lookup never touches the
 * libuv threadpool — it is strictly off the DNS-starvation path (see
 * dnsThreadpoolDecouple.ts), which is why pinning here does not re-introduce the
 * threadpool-bound `dns.lookup` the global decoupled dispatcher exists to avoid.
 */
export function createPinnedLookup(validatedIp: string): LookupFunction {
  const family = validatedIp.includes(':') ? 6 : 4;
  type Cb = (err: NodeJS.ErrnoException | null, ...rest: unknown[]) => void;
  const lookup = (
    _hostname: string,
    options: LookupOptions | Cb,
    callback?: Cb,
  ): void => {
    const cb = (typeof options === 'function' ? options : callback) as Cb;
    const opts = (typeof options === 'function' ? {} : options) as LookupOptions;
    if (opts && opts.all) {
      cb(null, [{ address: validatedIp, family }]);
    } else {
      cb(null, validatedIp, family);
    }
  };
  return lookup as unknown as LookupFunction;
}

/**
 * Build a per-request undici dispatcher whose connect-time DNS resolution is
 * pinned to the already-validated IP. The URL hostname is left UNCHANGED, so
 * undici derives the TLS SNI servername and the `Host` header from the real
 * hostname (correct cert validation + virtual-host routing) while the socket
 * connects to the validated IP.
 *
 * The caller MUST `close()` the returned Agent after the request (in a
 * `finally`) — a per-request dispatcher otherwise leaks sockets/file handles.
 *
 * `autoSelectFamily` is intentionally left at its default: the lookup returns a
 * single family-tagged address, so there is nothing to happy-eyeballs across,
 * and enabling it would not change behaviour.
 */
export function buildPinnedDispatcher(validatedIp: string): Agent {
  // eslint-disable-next-line no-restricted-syntax -- dns-decouple-justified: connect.lookup is a constant-returning pinned lookup (createPinnedLookup) that never calls dns.lookup/getaddrinfo, so it is off the libuv threadpool by construction — it satisfies the decouple rule's intent without getDecoupledLookup(). This is the SSRF connect-to-validated-IP fix (260617).
  return new Agent({ connect: { lookup: createPinnedLookup(validatedIp) } });
}

/**
 * Gracefully close a per-request pinned dispatcher without awaiting it.
 *
 * `Agent.close()` resolves only after all in-flight requests (including a body
 * stream the caller hasn't read yet) complete, so firing it for a returned
 * response does not truncate the body. We deliberately do NOT await — the
 * caller reads the body after we return — and we swallow/log errors so a close
 * failure can never surface as an unhandled rejection or mask the real result.
 */
function closePinnedDispatcher(dispatcher: Agent): void {
  void dispatcher.close().catch((err) => {
    log.debug({ err }, 'pinned SSRF dispatcher close failed (non-fatal)');
  });
}

/**
 * Cancel a discarded response body (best-effort) and then ALWAYS close the
 * dispatcher. Cancelling first lets the dispatcher's graceful close resolve
 * promptly; awaiting the cancel inside a guard ensures a rejected `cancel()`
 * (rare) can never skip the dispatcher close and leak the socket.
 */
async function cancelBodyAndCloseDispatcher(response: Response, dispatcher: Agent): Promise<void> {
  try {
    await response.body?.cancel();
  } catch (err) {
    log.debug({ err }, 'pinned SSRF response body cancel failed (non-fatal)');
  } finally {
    closePinnedDispatcher(dispatcher);
  }
}

// ── Safe Redirect Following ────────────────────────────────────────────

/**
 * Follow HTTP redirects safely with per-hop SSRF validation.
 *
 * Unlike `fetch({ redirect: 'follow' })`, this function validates each
 * redirect destination's resolved IP against private ranges before
 * following. This prevents SSRF via redirect chains that point to
 * internal IPs (e.g., https://evil.com → http://169.254.169.254/metadata).
 *
 * @param url - The initial URL to fetch
 * @param options.maxHops - Maximum number of redirects to follow (default 5)
 * @param options.signal - AbortSignal for cancellation
 * @param options.timeout - Request timeout in ms (default 15000)
 * @param options.headers - Additional headers to send with each request
 * @returns The final (non-redirect) Response
 * @throws On private IP, non-HTTP scheme, max hops exceeded, timeout, or abort
 */
export async function followRedirectsSafely(
  url: string,
  options: {
    maxHops?: number;
    signal?: AbortSignal;
    timeout?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const { maxHops = 5, signal, timeout = 15_000, headers } = options;

  let currentUrl = url;

  // Validate initial URL scheme
  const initialParsed = new URL(currentUrl);
  if (initialParsed.protocol !== 'http:' && initialParsed.protocol !== 'https:') {
    throw new Error(`Blocked: unsupported URL scheme "${initialParsed.protocol}". Only http: and https: are allowed.`);
  }

  for (let hop = 0; ; hop++) {
    const parsed = new URL(currentUrl);

    // Validate scheme on every hop (redirects could change scheme)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Blocked: redirect to unsupported scheme "${parsed.protocol}". Only http: and https: are allowed.`);
    }

    // Resolve and validate hostname IP — blocks private IPs. The returned IP is
    // the one we pin the connection to (below), so the validated IP and the
    // connect IP cannot diverge (closes the DNS-rebinding TOCTOU).
    const validatedIp = await resolveAndValidateHost(parsed.hostname);

    // Build timeout signal, composed with caller's signal
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => timeoutController.abort(), timeout);

    // Compose signals: abort if either the caller's signal or our timeout fires
    let composedSignal: AbortSignal;
    if (signal) {
      // If caller already aborted, throw immediately
      if (signal.aborted) {
        clearTimeout(timeoutId);
        throw new Error('Request aborted');
      }
      // Use AbortSignal.any if available (Node 20+), otherwise listen manually
      if ('any' in AbortSignal) {
        composedSignal = AbortSignal.any([signal, timeoutController.signal]);
      } else {
        // Fallback: forward caller abort to our controller
        const onAbort = () => timeoutController.abort();
        signal.addEventListener('abort', onAbort, { once: true });
        composedSignal = timeoutController.signal;
      }
    } else {
      composedSignal = timeoutController.signal;
    }

    // Build a per-hop dispatcher pinned to the validated IP, immediately before
    // the fetch so no earlier throw (e.g. an already-aborted signal) can leak it.
    // Rebuilt every hop so each redirect target is independently validated and
    // pinned. Closed on every exit path below to avoid leaking sockets.
    const pinnedDispatcher = buildPinnedDispatcher(validatedIp);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        headers: headers ?? {},
        signal: composedSignal,
        redirect: 'manual',
        // Pin the connection to the validated IP. `dispatcher` is an
        // undici-specific fetch option not in the lib DOM `fetch` types.
        dispatcher: pinnedDispatcher,
      } as RequestInit & { dispatcher: Agent });
    } catch (error) {
      clearTimeout(timeoutId);
      // This hop's request failed — the dispatcher has no pending body to
      // stream, so close it now (graceful close resolves once idle).
      closePinnedDispatcher(pinnedDispatcher);
      if (error instanceof Error && error.name === 'AbortError') {
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }
        throw new Error(`Request timed out after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    // Non-redirect response — return it. We hand the response to the caller,
    // who reads the body later, so we schedule a *graceful* dispatcher close
    // (resolves only after the in-flight body stream completes — verified that
    // closing before the caller reads the body does not truncate it).
    if (response.status < 300 || response.status >= 400) {
      closePinnedDispatcher(pinnedDispatcher);
      return response;
    }

    // From here on it's a redirect we will not return: its body is cancelled
    // and this hop's pinned dispatcher is no longer needed.

    // 3xx redirect — check hop limit before following
    if (hop >= maxHops) {
      await cancelBodyAndCloseDispatcher(response, pinnedDispatcher);
      throw new Error(`Too many redirects (max ${maxHops}). Last URL: ${currentUrl}`);
    }

    const location = response.headers.get('location');
    if (!location) {
      // 3xx without Location header — return as-is. Caller may read the body,
      // so close the dispatcher gracefully (after the in-flight stream).
      closePinnedDispatcher(pinnedDispatcher);
      return response;
    }

    // Cancel the redirect response body to free resources, then close this
    // hop's dispatcher — the next hop builds its own pinned dispatcher.
    await cancelBodyAndCloseDispatcher(response, pinnedDispatcher);

    // Resolve relative URLs via URL constructor
    const nextUrl = new URL(location, currentUrl).toString();

    log.debug(
      { from: currentUrl, to: nextUrl, status: response.status, hop },
      'Following redirect',
    );

    currentUrl = nextUrl;
  }
}
