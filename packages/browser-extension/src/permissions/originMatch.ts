/**
 * Origin / match-pattern helpers for the Rebel browser extension.
 *
 * Pure functions — NO `chrome.*` API calls. All boundary logic (running
 * `chrome.permissions.contains`, attempting `executeScript` fallbacks, etc.)
 * lives in `serviceWorker.ts`; this module only understands URLs and emits
 * structured results.
 *
 * See docs/plans/260424_browser_extension_bundling_and_permissions_fix.md
 * §Key Decisions 7 (computeMatchPattern) + §Brand voice (displayOriginForUser).
 */

export interface MatchPatternOk {
  ok: true;
  /** `scheme://host[:port]` (lowercased host, explicit port only if non-standard). */
  origin: string;
  /** Full match pattern for `chrome.permissions.contains/request`. */
  matchPattern: string;
}

export type MatchPatternFailure =
  | 'unsupported-scheme'
  | 'opaque'
  | 'pending'
  | 'invalid';

export interface MatchPatternErr {
  ok: false;
  reason: MatchPatternFailure;
}

export type MatchPatternResult = MatchPatternOk | MatchPatternErr;

const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Compute the Chrome match pattern for a tab URL.
 *
 * Handles:
 *  - HTTP(S) only (anything else → `unsupported-scheme`).
 *  - IPv6 hosts: correctly brackets in the match pattern.
 *  - Non-standard ports: included in the pattern when non-default
 *    (443 for https, 80 for http are defaults — omitted).
 *  - `tab.pendingUrl`-shaped URLs: refuses with `pending` so the caller
 *    re-queries once the navigation commits.
 *  - Opaque / null origins (`data:`, `blob:`, `javascript:`): `opaque`
 *    or `unsupported-scheme` depending on shape.
 *  - `new URL()` throws: `invalid`.
 *
 * The match pattern is internal only — it's passed to `chrome.permissions.*`
 * APIs; never shown to the user. `displayOriginForUser()` produces the
 * user-facing label.
 */
export function computeMatchPattern(
  tabUrl: string | undefined,
): MatchPatternResult {
  if (typeof tabUrl !== 'string' || tabUrl.length === 0) {
    return { ok: false, reason: 'invalid' };
  }

  let parsed: URL;
  try {
    parsed = new URL(tabUrl);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  const protocol = parsed.protocol.toLowerCase();

  // about:blank / about:srcdoc — chrome only exposes these as the temporary
  // `pendingUrl` during navigation. We refuse and expect the caller to
  // re-query after `webNavigation.onCommitted`.
  if (protocol === 'about:') {
    if (parsed.href === 'about:blank' || parsed.href === 'about:srcdoc') {
      return { ok: false, reason: 'pending' };
    }
    return { ok: false, reason: 'unsupported-scheme' };
  }

  // data: / blob: / javascript: / filesystem: produce opaque origins (host is
  // empty, `origin` is the literal string `"null"`).
  if (
    protocol === 'data:' ||
    protocol === 'blob:' ||
    protocol === 'javascript:' ||
    protocol === 'filesystem:'
  ) {
    return { ok: false, reason: 'opaque' };
  }

  if (!SUPPORTED_PROTOCOLS.has(protocol)) {
    // chrome:, chrome-extension:, moz-extension:, file:, edge:, …
    return { ok: false, reason: 'unsupported-scheme' };
  }

  // After protocol/scheme filtering we should always have a non-empty host.
  // Defensive check anyway — something like `https:` alone would slip past.
  const host = parsed.hostname.toLowerCase();
  if (host.length === 0) {
    return { ok: false, reason: 'opaque' };
  }

  // Match WHATWG: hostname of an IPv6 URL may already contain brackets
  // (some engines preserve them) or may be bracketless. Chrome match
  // patterns require brackets around the IPv6 literal; normalise here.
  const hostForPattern = isIpv6Hostname(host)
    ? host.startsWith('[') && host.endsWith(']')
      ? host
      : `[${host}]`
    : host;

  const scheme = protocol === 'https:' ? 'https' : 'http';
  const isDefaultPort =
    parsed.port === '' ||
    (protocol === 'https:' && parsed.port === '443') ||
    (protocol === 'http:' && parsed.port === '80');

  const hostWithPort = isDefaultPort ? hostForPattern : `${hostForPattern}:${parsed.port}`;
  const origin = `${scheme}://${hostWithPort}`;
  const matchPattern = `${origin}/*`;

  return { ok: true, origin, matchPattern };
}

/**
 * Heuristic: IPv6 literal hosts in WHATWG URLs have no brackets but DO
 * contain at least two colons (the colon-separated groups). Also covers
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`).
 */
function isIpv6Hostname(host: string): boolean {
  if (host.includes('[') || host.includes(']')) {
    // Belt-and-braces — if the bracketed form somehow shows up, treat it as
    // IPv6 directly.
    return true;
  }
  return host.includes(':');
}

/**
 * Produce the user-facing origin label — never the `/*` match pattern, never
 * the raw match-pattern form.
 *
 *   `https://portal.pitchbook.com`        → `portal.pitchbook.com`
 *   `https://portal.pitchbook.com/*`      → `portal.pitchbook.com`
 *   `http://localhost:3000`               → `localhost:3000 (http)`
 *   `http://localhost:3000/*`             → `localhost:3000 (http)`
 *   `https://[2001:db8::1]:8443`          → `[2001:db8::1]:8443`
 *
 * HTTP gets an explicit `(http)` suffix so non-technical users aren't left
 * wondering whether the site is secure. HTTPS is the unmarked default.
 */
export function displayOriginForUser(origin: string): string {
  if (typeof origin !== 'string' || origin.length === 0) {
    return origin ?? '';
  }

  const stripped = origin.replace(/\/\*$/, '');

  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return stripped;
  }

  const protocol = parsed.protocol.toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const hostForDisplay = isIpv6Hostname(host)
    ? host.startsWith('[') && host.endsWith(']')
      ? host
      : `[${host}]`
    : host;
  const hostWithPort =
    parsed.port.length > 0 ? `${hostForDisplay}:${parsed.port}` : hostForDisplay;

  if (protocol === 'https:') {
    return hostWithPort;
  }
  if (protocol === 'http:') {
    return `${hostWithPort} (http)`;
  }
  return stripped;
}
