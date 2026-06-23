/**
 * GET /app/open?u=<rebel://...>  — Cross-surface deep-link launcher.
 *
 * Serves a small public HTML page that:
 *   1. Validates the `u` query param as a `rebel://` URL whose host is on
 *      the `KNOWN_REBEL_HOSTS` allow-list (prevents open-redirect abuse).
 *   2. Attempts to hand the URL off to the OS (opens Rebel if installed).
 *   3. After a short timeout, redirects to the install/web CTA at
 *      `https://getrebel.mindstone.com` so recipients without Rebel still
 *      land somewhere useful.
 *
 * No auth required — this is the public counterpart to the desktop
 * "Copy web link" action (see `@core/navigation/generateShareLink`).
 *
 * See docs/plans/260416_centralize_cross_surface_links.md — Stage F.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { parseNavigationUrl } from '@shared/navigation/urlParser';

const FALLBACK_URL = 'https://getrebel.mindstone.com';

/**
 * Hosts accepted as the first path segment of a rebel:// URL. Mirrors
 * `KNOWN_REBEL_HOSTS` in `packages/shared/src/utils/markdownLinkHandler.ts`;
 * kept local so this route has zero runtime deps on the @rebel/shared package
 * bundling story (cloud-service bundles differently from the renderer).
 */
const KNOWN_REBEL_HOSTS = new Set([
  'conversation',
  'sessions',
  'library',
  'workspace',
  'space',
  'settings',
  'tasks',
  'insights',
  'automations',
  'usecases',
  'team',
  'plugin',
  'action',
  'focus',
  'feedback',
  'media',
]);

function isValidRebelUrl(raw: string): boolean {
  if (!raw.startsWith('rebel://')) return false;
  // URL() accepts `rebel://host/path` fine because the scheme uses the
  // "special scheme"-compatible authority component. Empty host (the legacy
  // three-slash action form, e.g. `rebel:///start-voice`) is allowed too —
  // parseNavigationUrl maps it to a canonical action target.
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'rebel:') return false;
  // Require either a known host or the legacy empty-host action form.
  if (parsed.hostname && !KNOWN_REBEL_HOSTS.has(parsed.hostname)) {
    return false;
  }
  // Ensure the parser can make sense of it (covers path/query validation).
  if (!parseNavigationUrl(raw)) return false;
  return true;
}

/**
 * HTML-escape a string for safe embedding in an HTML attribute or text node.
 * Prevents the `u` param (already rebel-scheme validated) from breaking out
 * of the meta-refresh / anchor context if a malformed URL slips through.
 */
function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safely embed a string as a JavaScript string literal inside an HTML
 * <script> block. `JSON.stringify` covers most escaping but NOT the
 * `</script>` substring (which would close the script tag prematurely) or
 * line separators (which can break JS parsing). Replace those explicitly.
 */
function jsStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/<\/(script)/gi, '<\\/$1')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderLauncherPage(rebelUrl: string): string {
  const safeUrl = htmlEscape(rebelUrl);
  const safeFallback = htmlEscape(FALLBACK_URL);
  // Strategy:
  //   - Immediately set `window.location = rebelUrl` via JS to attempt the
  //     OS protocol handoff. Browsers that recognise the scheme open the app.
  //   - After 1.2s (enough for iOS/macOS/Windows to accept the handoff or
  //     show the "open this link" prompt), fall back to getrebel.mindstone.com.
  //   - Provide visible links for users who block JS or prefer manual action.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Opening Rebel…</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    padding: 48px 24px;
    max-width: 440px;
    margin: 0 auto;
    line-height: 1.5;
    text-align: center;
  }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
  p { color: #555; margin: 8px 0; }
  @media (prefers-color-scheme: dark) { p { color: #aaa; } }
  .cta {
    display: inline-block;
    margin-top: 24px;
    padding: 10px 20px;
    background: #2563eb;
    color: #fff;
    text-decoration: none;
    border-radius: 8px;
    font-weight: 500;
  }
  .cta:hover { background: #1d4ed8; }
  code {
    font-family: ui-monospace, SFMono-Regular, monospace;
    font-size: 12px;
    word-break: break-all;
  }
</style>
</head>
<body>
<h1>Opening Rebel…</h1>
<p>If Rebel is installed on this device, it should open in a moment.</p>
<p><a class="cta" href="${safeFallback}">Get Rebel</a></p>
<p style="margin-top:24px;font-size:12px;color:#999;">
  Direct link: <code>${safeUrl}</code>
</p>
<script>
(function () {
  var target = ${jsStringLiteral(rebelUrl)};
  var fallback = ${jsStringLiteral(FALLBACK_URL)};
  try {
    window.location.href = target;
  } catch (e) { /* ignore — we'll fall back below */ }
  setTimeout(function () {
    // Only navigate away if the page is still visible — if Rebel opened,
    // the browser tab is usually either closed or in the background.
    if (!document.hidden) {
      window.location.replace(fallback);
    }
  }, 1200);
})();
</script>
</body>
</html>`;
}

export async function handleAppOpen(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '', 'http://localhost');
  const rebelUrl = url.searchParams.get('u');

  if (!rebelUrl || !isValidRebelUrl(rebelUrl)) {
    // Bad / missing param — redirect to the fallback landing page rather
    // than returning a 4xx so external sharers don't see an error screen.
    res.writeHead(302, { Location: FALLBACK_URL });
    res.end();
    return;
  }

  const html = renderLauncherPage(rebelUrl);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    // Short cache so refreshes keep working; long enough to avoid hammering
    // the cloud service when the launcher bounces a user through a redirect.
    'Cache-Control': 'public, max-age=60',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}
