/**
 * Plugin External Fetch Service
 *
 * Executes mediated HTTP requests on behalf of plugins to allowlisted
 * external domains. GET-only for MVP.
 *
 * Security layers:
 * 1. Domain validation against plugin manifest `externalDomains`
 * 2. Private/local IP blocking (SSRF prevention)
 * 3. DNS rebinding protection (resolved IP check)
 * 4. Rate limiting (30 requests/min per plugin)
 * 5. Response size cap (1MB)
 * 6. Request timeout (30s)
 * 7. Redirect disabled (`redirect: 'manual'`)
 * 8. GET-only enforcement
 *
 * @see docs/plans/260327_plugin_wave5_infrastructure.md — Stage B6
 */

import { createScopedLogger } from '@core/logger';
import { resolveAndValidateHost, buildPinnedDispatcher, _clearDnsCacheForTesting as _clearSsrfDnsCacheForTesting } from '@core/utils/ssrfProtection';
import { fireAndForget } from '@shared/utils/fireAndForget';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

const log = createScopedLogger({ service: 'pluginExternalFetch' });

// ── Constants ──────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_048_576; // 1MB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_CALLS = 30;

// ── Types ──────────────────────────────────────────────────────────────

export interface PluginFetchRequest {
  url: string;
  method: 'GET';
  headers?: Record<string, string>;
  pluginId: string;
  allowedDomains: string[];
}

export interface PluginFetchResponse {
  ok: boolean;
  status: number;
  data: unknown;
  error?: string;
}

// ── Rate Limiter ───────────────────────────────────────────────────────

const fetchTimestamps = new Map<string, number[]>();

/**
 * Check whether a plugin is allowed to make another external fetch.
 * Does NOT record the call — call `recordFetchCall()` after success.
 */
export function checkFetchRateLimit(pluginId: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let timestamps = fetchTimestamps.get(pluginId);
  if (!timestamps) {
    return { allowed: true };
  }

  timestamps = timestamps.filter((ts) => ts > windowStart);
  fetchTimestamps.set(pluginId, timestamps);

  if (timestamps.length < RATE_LIMIT_MAX_CALLS) {
    return { allowed: true };
  }

  const oldestInWindow = timestamps[0];
  const retryAfterMs = oldestInWindow + RATE_LIMIT_WINDOW_MS - now;
  return { allowed: false, retryAfterMs: Math.max(retryAfterMs, 0) };
}

/**
 * Record a successful external fetch call for a plugin.
 */
export function recordFetchCall(pluginId: string): void {
  const now = Date.now();
  let timestamps = fetchTimestamps.get(pluginId);
  if (!timestamps) {
    timestamps = [];
    fetchTimestamps.set(pluginId, timestamps);
  }
  timestamps.push(now);
}

/** Reset rate limit state (for testing). */
export function _resetFetchRateLimiterForTesting(): void {
  fetchTimestamps.clear();
}

// ── Domain Validation ──────────────────────────────────────────────────

/**
 * Check if a hostname matches a list of allowed domain patterns.
 *
 * - Exact match: `api.linear.app` matches `api.linear.app` only
 * - Wildcard: `*.github.com` matches `api.github.com`, `raw.github.com`,
 *   but NOT `github.com` itself
 * - Port must match if specified in the allowed domain
 */
export function isDomainAllowed(hostname: string, port: string | null, allowedDomains: string[]): boolean {
  const hostLower = hostname.toLowerCase();

  for (const pattern of allowedDomains) {
    const patternLower = pattern.toLowerCase().trim();
    if (!patternLower) continue;

    // Check if pattern includes a port
    const colonIdx = patternLower.lastIndexOf(':');
    let patternHost: string;
    let patternPort: string | null = null;

    if (colonIdx > 0 && !patternLower.endsWith(']')) {
      // Has port (and not an IPv6 bracket)
      patternHost = patternLower.slice(0, colonIdx);
      patternPort = patternLower.slice(colonIdx + 1);
    } else {
      patternHost = patternLower;
    }

    // If pattern has a port, request port must match
    if (patternPort !== null) {
      if (port !== patternPort) continue;
    }

    // Exact match
    if (patternHost === hostLower) {
      return true;
    }

    // Wildcard match: *.domain.com
    if (patternHost.startsWith('*.')) {
      const suffix = patternHost.slice(1); // ".domain.com"
      if (hostLower.endsWith(suffix) && hostLower.length > suffix.length) {
        // Ensure the character before the suffix is the start or a dot
        // e.g. "api.github.com" matches "*.github.com"
        // but "notgithub.com" does NOT match "*.github.com"
        const prefix = hostLower.slice(0, hostLower.length - suffix.length);
        if (!prefix.includes('.')) {
          // Only match one subdomain level for safety
          return true;
        }
      }
    }
  }

  return false;
}

// ── SSRF Protection (imported from @core/utils/ssrfProtection) ─────────
// isPrivateIp, resolveAndValidateHost imported at top of file.
// Re-export isPrivateIp for existing test consumers.
export { isPrivateIp } from '@core/utils/ssrfProtection';

/** @deprecated Use `_clearDnsCacheForTesting` from `@core/utils/ssrfProtection` directly. */
export function _clearDnsCacheForTesting(): void {
  _clearSsrfDnsCacheForTesting();
}

// ── Fetch Execution ────────────────────────────────────────────────────

/**
 * Read response body with a size limit. Returns the raw text.
 * Throws if the response exceeds MAX_RESPONSE_BYTES.
 */
async function readResponseWithLimit(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_BYTES) {
    // Cancel the unread body so the per-request pinned dispatcher's graceful
    // close (in the caller's finally) can release its socket rather than
    // hanging on an undrained body.
    try {
      await response.body?.cancel();
    } catch (cancelErr) {
      ignoreBestEffortCleanup(cancelErr, {
        operation: 'pluginExternalFetch.cancelOversizeBody',
        reason: 'Body rejected on oversize content-length; cancel frees the pinned dispatcher socket.',
      });
    }
    throw new Error(`Response too large: ${contentLength} bytes exceeds ${MAX_RESPONSE_BYTES} byte limit.`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        fireAndForget(reader.cancel(), 'pluginExternalFetchService.line192');
        throw new Error(`Response too large: exceeded ${MAX_RESPONSE_BYTES} byte limit.`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode();
}

/**
 * Parse response body based on Content-Type.
 * JSON → parsed object, otherwise → raw text string.
 */
function parseResponseData(bodyText: string, contentType: string | null): unknown {
  if (!contentType) return bodyText;

  const ct = contentType.toLowerCase();
  if (ct.includes('application/json') || ct.includes('+json')) {
    try {
      return JSON.parse(bodyText);
    } catch {
      return bodyText;
    }
  }

  return bodyText;
}

/**
 * Execute a mediated external fetch request on behalf of a plugin.
 *
 * Validates domain, blocks private IPs, enforces rate limits,
 * applies timeout and response size limits, and disables redirects.
 */
export async function executePluginFetch(request: PluginFetchRequest): Promise<PluginFetchResponse> {
  const { url, method, headers, pluginId, allowedDomains } = request;

  // 1. Enforce GET-only
  if (method !== 'GET') {
    return { ok: false, status: 0, data: null, error: 'Only GET requests are allowed.' };
  }

  // 2. Parse URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, status: 0, data: null, error: `Invalid URL: "${url}"` };
  }

  // 3. Only allow http/https
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return { ok: false, status: 0, data: null, error: `Unsupported protocol: ${parsedUrl.protocol}` };
  }

  // 4. Validate domain against allowedDomains
  const port = parsedUrl.port || null;
  if (!isDomainAllowed(parsedUrl.hostname, port, allowedDomains)) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: `Domain "${parsedUrl.hostname}" is not in the allowed domains list for this plugin.`,
    };
  }

  // 5. Rate limit check
  const rateCheck = checkFetchRateLimit(pluginId);
  if (!rateCheck.allowed) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: `Rate limit exceeded. Try again in ${Math.ceil((rateCheck.retryAfterMs ?? 0) / 1000)}s.`,
    };
  }

  // 6. DNS resolution + private IP blocking (returns pinned IP for TOCTOU mitigation)
  let resolvedIp: string;
  try {
    resolvedIp = await resolveAndValidateHost(parsedUrl.hostname);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : 'DNS validation failed.',
    };
  }

  // 7. Record rate limit call before executing
  recordFetchCall(pluginId);

  // 8. Pin the connection to the already-validated IP to close the DNS-rebinding
  //    TOCTOU: the SSRF check resolved+validated `resolvedIp`, and we connect to
  //    *that same IP* so the validated IP and the connect IP cannot diverge. The
  //    URL hostname is left UNCHANGED for BOTH http and https, so undici derives
  //    the correct `Host` header (and, for https, the TLS SNI servername) from
  //    the real hostname while the socket targets the validated IP. This replaces
  //    the previous http-only hostname-rewrite (which left https only partially
  //    mitigated by the 5s DNS cache).
  const fetchUrl = new URL(parsedUrl.toString());
  const fetchHeaders: Record<string, string> = { ...headers };

  // Strip cookies to prevent jar sharing
  delete fetchHeaders['cookie'];
  delete fetchHeaders['Cookie'];

  const pinnedDispatcher = buildPinnedDispatcher(resolvedIp);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(fetchUrl.toString(), {
      method: 'GET',
      headers: fetchHeaders,
      signal: controller.signal,
      redirect: 'manual', // Disable redirects
      // Pin connect to the validated IP. `dispatcher` is an undici-specific
      // fetch option not present in the lib DOM `fetch` types.
      dispatcher: pinnedDispatcher,
    } as RequestInit & { dispatcher: typeof pinnedDispatcher });

    // 9. Check for redirect responses
    if (response.status >= 300 && response.status < 400) {
      // We won't read this body — cancel it so the per-request pinned dispatcher
      // (graceful-closed in finally) can release its socket. A graceful close
      // stays pending until the body is drained or cancelled.
      try {
        await response.body?.cancel();
      } catch (cancelErr) {
        ignoreBestEffortCleanup(cancelErr, {
          operation: 'pluginExternalFetch.cancelRedirectBody',
          reason: 'Body discarded on disabled-redirect 3xx; cancel frees the pinned dispatcher socket.',
        });
      }
      return {
        ok: false,
        status: response.status,
        data: null,
        error: `Redirects are disabled for security. The server returned ${response.status}.`,
      };
    }

    // 10. Read and parse response body with size limit
    const bodyText = await readResponseWithLimit(response);
    const contentType = response.headers.get('content-type');
    const data = parseResponseData(bodyText, contentType);

    log.debug(
      { pluginId, url: parsedUrl.hostname, status: response.status },
      'Plugin external fetch completed',
    );

    return {
      ok: response.ok,
      status: response.status,
      data,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, status: 0, data: null, error: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.` };
    }

    log.error({ err: error, pluginId, url: parsedUrl.hostname }, 'Plugin external fetch failed');
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : 'Fetch failed.',
    };
  } finally {
    clearTimeout(timeout);
    // Close the per-request pinned dispatcher. The response body is fully read
    // inside the try above before we reach here, so a graceful close is safe;
    // we don't await it and swallow errors so it can't mask the real result.
    void pinnedDispatcher.close().catch((err) => {
      log.debug({ err, pluginId }, 'pinned plugin-fetch dispatcher close failed (non-fatal)');
    });
  }
}
