/**
 * CSP variants for the rebel-html:// protocol handler.
 *
 * Two-tier model:
 *
 *  - **Strict (default)** — passive remote resources allowed (img/style/font
 *    from any https), scripts from a small allowlist of major CDNs only,
 *    no fetch/XHR, no remote forms. Suitable for the modal "agent-built
 *    HTML report" case (Chart.js, Tailwind, D3 from CDNs).
 *
 *  - **Trusted** — user has explicitly opted in for this specific file +
 *    content hash. Allows any HTTPS scripts (incl. inline), fetch/XHR, and
 *    remote form posts. Iframe sandbox stays `allow-scripts` (no
 *    `allow-same-origin`) — that hard escape gate is never relaxed.
 *
 * Both variants block: nested frames (`frame-src 'none'`), `<object>`,
 * `<base>` hijacks, and Web Workers/service workers.
 *
 * The actual sandbox attribute is set by the renderer iframe (in
 * DocumentRenderers.tsx). This module owns CSP only.
 *
 * @see docs/plans/260525_html_preview_trust_tiers.md
 * @see src/core/services/htmlPreviewTrustService.ts
 */

/**
 * Major JS/CSS CDN origins permitted to serve scripts in strict mode.
 *
 * NOTE on threat model: jsdelivr, unpkg, cdnjs et al. will serve any package
 * anyone publishes to npm, so this allowlist filters lazy attackers but does
 * not stop motivated ones (`npm publish evil@1.0.0` then reference it). The
 * real exfil/escape gates remain `connect-src 'none'` and the iframe sandbox
 * without `allow-same-origin`.
 */
export const MAJOR_SCRIPT_CDNS: readonly string[] = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://cdn.tailwindcss.com',
  'https://esm.sh',
  'https://cdn.skypack.dev',
  'https://code.jquery.com',
  'https://d3js.org',
  'https://cdn.plot.ly',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com',
];

const SHARED_HARD_BLOCKS = [
  "object-src 'none'",
  "base-uri 'none'",
  "worker-src 'none'",
  "frame-src 'none'",
] as const;

/** Build the CSP header value for a rebel-html:// HTML response. */
export function getRebelHtmlCsp(opts: { trusted: boolean }): string {
  const cdnList = MAJOR_SCRIPT_CDNS.join(' ');

  if (opts.trusted) {
    return [
      "default-src 'none'",
      "img-src 'self' rebel-html: data: https:",
      "style-src 'unsafe-inline' rebel-html: https:",
      "font-src rebel-html: data: https:",
      "script-src 'self' rebel-html: 'unsafe-inline' https:",
      "connect-src https:",
      "form-action https:",
      ...SHARED_HARD_BLOCKS,
    ].join('; ');
  }

  return [
    "default-src 'none'",
    "img-src 'self' rebel-html: data: https:",
    "style-src 'unsafe-inline' rebel-html: https:",
    "font-src rebel-html: data: https:",
    `script-src rebel-html: ${cdnList}`,
    "connect-src 'none'",
    "form-action 'none'",
    ...SHARED_HARD_BLOCKS,
  ].join('; ');
}
