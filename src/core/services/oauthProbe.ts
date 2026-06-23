import { createScopedLogger } from '@core/logger';

const log = createScopedLogger({ component: 'oauthProbe' });

export interface OAuthProbeResult {
  /**
   * Classification decision:
   * - 'oauth'   — server responded 401 (or 403 with WWW-Authenticate indicating
   *              OAuth/Bearer). Strong signal the server requires authentication.
   * - 'open'    — server accepted an unauthenticated `initialize` (HTTP 200/202).
   *              No OAuth needed.
   * - 'unknown' — ambiguous: probe timed out, network error, or unexpected
   *              status. Caller decides whether to set `oauth: true` speculatively.
   */
  classification: 'oauth' | 'open' | 'unknown';
  statusCode?: number;
  error?: string;
}

/**
 * Short timeout so the probe never meaningfully stalls the add-server flow.
 * If a real MCP server can't respond within this window it is highly likely
 * some other connectivity problem will surface downstream anyway.
 */
export const PROBE_TIMEOUT_MS = 5_000;

const AUTH_INDICATOR_REGEX = /bearer|oauth|openid/i;

/**
 * Probe a custom MCP HTTP/SSE URL to classify whether it requires OAuth.
 *
 * Uses the MCP JSON-RPC `initialize` method — the first request any MCP HTTP
 * server handles. A 401 (or 403 with a WWW-Authenticate header indicating
 * Bearer/OAuth) is strong evidence the server requires authentication. A 200
 * (or 202) means the server accepted the unauthenticated request, so no OAuth
 * is needed.
 *
 * Deliberately fails closed: on timeout, network error, or unexpected status
 * the probe returns `'unknown'`. Callers MUST NOT set `oauth: true` speculatively
 * from an `'unknown'` result — doing so would trigger browser OAuth popups for
 * typo'd URLs and unresponsive endpoints. Only an explicit `'oauth'` classification
 * should flip the flag.
 *
 * This is intentionally a very small, library-free probe — no MCP SDK client,
 * no DCR, no streaming. We only need to distinguish "needs auth" from "open"
 * at add-time. The full MCP + OAuth handshake happens later via Super-MCP.
 *
 * Platform-agnostic: uses only the global `fetch`, so it lives in `src/core/`
 * and can be reused from desktop, cloud, and mobile surfaces.
 */
export async function probeMcpUrlForOAuth(url: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<OAuthProbeResult> {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    return { classification: 'unknown', error: 'Non-HTTP URL; probe skipped.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'rebel-oauth-probe',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'rebel-oauth-probe', version: '1.0.0' },
        },
      }),
      signal: controller.signal,
      redirect: 'follow',
    });

    const statusCode = response.status;

    if (statusCode === 401) {
      log.info({ url, statusCode }, 'OAuth probe: 401 — server requires authentication');
      return { classification: 'oauth', statusCode };
    }

    if (statusCode === 403) {
      const wwwAuth = response.headers.get('www-authenticate') || '';
      if (AUTH_INDICATOR_REGEX.test(wwwAuth)) {
        log.info({ url, statusCode, wwwAuth }, 'OAuth probe: 403 with OAuth/Bearer WWW-Authenticate');
        return { classification: 'oauth', statusCode };
      }
      log.info({ url, statusCode }, 'OAuth probe: 403 without OAuth indicator — ambiguous');
      return { classification: 'unknown', statusCode };
    }

    if (statusCode === 200 || statusCode === 202) {
      log.info({ url, statusCode }, 'OAuth probe: server accepted unauthenticated initialize');
      return { classification: 'open', statusCode };
    }

    log.info({ url, statusCode }, 'OAuth probe: ambiguous status');
    return { classification: 'unknown', statusCode };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.info({ url, err: message }, 'OAuth probe: network error or timeout');
    return { classification: 'unknown', error: message };
  } finally {
    clearTimeout(timer);
  }
}
