import type { McpAppUiMeta } from '@shared/types';

/** Pure HTML attribute escape. Used by MCP App and plugin iframe CSP meta injection. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sanitizes a connector-supplied domain for MCP App dynamic CSP construction.
 * Only URL-like source entries, CSP keywords, and data/blob schemes are allowed.
 */
export function sanitizeCspDomain(domain: string): string | null {
  // Strip whitespace
  const trimmed = domain.trim();
  if (!trimmed) return null;

  // Block CSP injection characters: semicolons, quotes, newlines
  if (/[;\r\n'"]/g.test(trimmed)) {
    return null;
  }

  // Only allow valid domain patterns:
  // - https://example.com
  // - *.example.com
  // - 'self', 'none' (CSP keywords)
  // - data:, blob: (CSP schemes)
  const validPattern = /^('self'|'none'|data:|blob:|https?:\/\/[\w\-.*]+(?::\d+)?(?:\/[\w\-./?%&=]*)?)$/i;
  if (!validPattern.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Build an MCP App Content-Security-Policy string from a connector's CSP config
 * plus user-trusted preview domains. Used by McpAppView before blob rendering.
 */
export function buildCSPString(csp?: McpAppUiMeta['csp'], trustedDomains?: string[]): string {
  // Merge MCP App resourceDomains with user-trusted preview domains
  const allResourceDomains = [...(csp?.resourceDomains || []), ...(trustedDomains || [])];

  // Sanitize all domain arrays
  const sanitizedConnect = (csp?.connectDomains || [])
    .map(sanitizeCspDomain)
    .filter((d): d is string => d !== null);
  const sanitizedResource = allResourceDomains
    .map(sanitizeCspDomain)
    .filter((d): d is string => d !== null);
  const sanitizedFrame = (csp?.frameDomains || [])
    .map(sanitizeCspDomain)
    .filter((d): d is string => d !== null);

  const connectSrc = sanitizedConnect.length > 0
    ? sanitizedConnect.join(' ')
    : "'none'";

  const resourceSrc = sanitizedResource.length > 0
    ? sanitizedResource.join(' ')
    : '';

  const frameSrc = sanitizedFrame.length > 0
    ? sanitizedFrame.join(' ')
    : "'none'";

  const directives = [
    "default-src 'none'",
    `script-src 'unsafe-inline' blob: data: ${resourceSrc}`.trim(),
    `style-src 'unsafe-inline' ${resourceSrc}`.trim(),
    `connect-src ${connectSrc}`,
    `img-src data: blob: ${resourceSrc}`.trim(),
    `font-src data: ${resourceSrc}`.trim(),
    `media-src blob: ${resourceSrc}`.trim(),
    `frame-src ${frameSrc}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "worker-src 'none'",
  ];

  return directives.join('; ');
}

/** Strict CSP directives for plugin iframes (no network, no nested frames, inline scripts only). */
export const STRICT_CSP: string[] = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "connect-src 'none'",
  "img-src data: blob:",
  "font-src data:",
  "media-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
  "worker-src 'none'",
];

/**
 * Options for injecting a CSP <meta> tag into sandboxed iframe HTML payloads.
 *
 * `mode` intentionally preserves the existing fallback divergence:
 * - `mcp-app` keeps McpAppView's `<head>...</head>${html}` fallback.
 * - `plugin` keeps PluginIframeView's full-document wrapper fallback.
 */
export interface CspMetaInjectionOptions {
  mode: 'mcp-app' | 'plugin';
  cspString: string;
  /** Optional additional <head> inserts such as MCP host-context and error-capture scripts. */
  additionalHeadInserts?: string;
}

/**
 * Inject a CSP <meta> tag into sandboxed iframe HTML.
 *
 * McpAppView uses this with additional host-context/error-capture scripts; PluginIframeView
 * uses it with only the strict plugin CSP. Fallback insertion order is consumer-specific.
 */
export function injectCspMeta(html: string, options: CspMetaInjectionOptions): string {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(options.cspString)}">`;
  const injections = `${cspMeta}${options.additionalHeadInserts ?? ''}`;

  const headRegex = /<head([^>]*)>/i;
  if (headRegex.test(html)) {
    return html.replace(headRegex, `<head$1>${injections}`);
  }

  const doctypeRegex = /<!DOCTYPE[^>]*>/i;
  if (doctypeRegex.test(html)) {
    return html.replace(doctypeRegex, (match) => `${match}<head>${injections}</head>`);
  }

  if (options.mode === 'plugin') {
    const withHtmlTag = html.replace(/<html([^>]*)>/i, `<html$1><head>${injections}</head>`);
    if (withHtmlTag !== html) return withHtmlTag;

    return `<!DOCTYPE html><html><head>${injections}</head><body>${html}</body></html>`;
  }

  return `<head>${injections}</head>${html}`;
}

function isAllowedSandboxOrigin(eventOrigin: string, allowedOrigins: ReadonlyArray<'null' | string>): boolean {
  return allowedOrigins.some((allowedOrigin) => {
    if (eventOrigin === allowedOrigin) {
      return true;
    }

    // Preserve McpAppView's existing custom-protocol behavior:
    // sandboxed protocol iframe origins have historically been accepted by prefix.
    return allowedOrigin !== 'null'
      && allowedOrigin.endsWith(':')
      && eventOrigin.startsWith(allowedOrigin);
  });
}

/**
 * Check whether a postMessage event came from an allowed sandboxed frame.
 *
 * PluginIframeView uses this for a single null-origin iframe. McpAppView uses this for
 * inline/fullscreen iframes and accepts both null-origin blobs and rebel-preview protocol URLs.
 */
export function isMessageFromAllowedSandboxFrame(
  event: MessageEvent,
  allowedWindows: ReadonlyArray<Window | null>,
  allowedOrigins: ReadonlyArray<'null' | string>,
): boolean {
  const sourceMatches = allowedWindows.some((allowedWindow) => (
    allowedWindow !== null && event.source === allowedWindow
  ));

  return sourceMatches && isAllowedSandboxOrigin(event.origin, allowedOrigins);
}
