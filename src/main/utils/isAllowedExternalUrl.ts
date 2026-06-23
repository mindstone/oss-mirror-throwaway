/**
 * Shared external-URL allowlist for `shell.openExternal` call sites.
 *
 * Fail-closed: returns true ONLY for http:// and https://. Everything else
 * (ui://, javascript:, file:, data:, mailto:, empty, malformed) returns false.
 *
 * Why this exists: Electron's `setWindowOpenHandler` and the dev `will-navigate`
 * fallback historically forwarded ANY URL to `shell.openExternal`, which on
 * macOS delegates unknown schemes (e.g. MCP Apps `ui://` URIs) to the OS
 * default browser — silently escaping in-app resource URIs to the user's
 * external browser. This helper is the single source of truth so all three
 * boundary points (window-open, will-navigate, app:open-url) enforce the
 * same policy. See docs-private/investigations/260423_ui_canvas_link_opens_firefox.md.
 */
export function isAllowedExternalUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed) return false;
  // URL constructor normalises and rejects malformed input.
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Best-effort scheme extraction for observability (log context only).
 * Returns the URL protocol (e.g. `'ui:'`, `'javascript:'`) if parseable,
 * `'unparseable'` if the URL constructor rejects it, or `'non-string'`
 * if the input is not a string. Never throws.
 *
 * Intended for use alongside `isAllowedExternalUrl` in the deny-path log
 * line, so operators can grep for the specific scheme being blocked.
 */
export function safeUrlScheme(url: unknown): string {
  if (typeof url !== 'string') return 'non-string';
  try {
    return new URL(url.trim()).protocol;
  } catch {
    return 'unparseable';
  }
}
