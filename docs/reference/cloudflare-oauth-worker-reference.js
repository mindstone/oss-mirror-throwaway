/**
 * Cloudflare Worker: OAuth Callback Redirector
 * 
 * Deployed at: rebel-auth.mindstone.com
 * Worker name: lively-lab
 * 
 * To edit in Cloudflare dashboard:
 *   Compute & AI -> Workers and Pages -> lively-lab -> Edit Code
 * 
 * Handles OAuth callbacks for integrations that don't support localhost redirects.
 * Redirects authorization codes to mindstone:// deep links for the desktop app.
 * 
 * Supported callbacks:
 * - /slack/callback → mindstone://slack/callback
 * - /microsoft/callback → mindstone://microsoft/callback
 * - /salesforce/callback → mindstone://salesforce/callback
 * - /plaud/callback → mindstone://plaud/callback
 * - /github/callback → mindstone://github/callback
 * - /digitalocean/callback → mindstone://digitalocean/callback
 * - /openrouter/callback → mindstone://openrouter/callback
 *
 * Special routes:
 * - /openrouter/start → serves HTML redirect page to set Referer header
 *   (OpenRouter requires Referer for app attribution, returns 409 without it)
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Handle CORS preflight for all routes
    // Some OAuth providers (like Plaud) use XHR-based redirects with custom headers
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          // Must include x-authorization-provider - Plaud's axios client sends this header
          'Access-Control-Allow-Headers': 'Content-Type, x-authorization-provider',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (url.pathname.startsWith('/slack/callback')) {
      return createRedirectPage('mindstone://slack/callback' + url.search, 'Slack');
    }

    if (url.pathname.startsWith('/microsoft/callback')) {
      return createRedirectPage('mindstone://microsoft/callback' + url.search, 'Microsoft');
    }

    if (url.pathname.startsWith('/salesforce/callback')) {
      return createRedirectPage('mindstone://salesforce/callback' + url.search, 'Salesforce');
    }

    if (url.pathname.startsWith('/plaud/callback')) {
      return createRedirectPage('mindstone://plaud/callback' + url.search, 'Plaud');
    }

    if (url.pathname.startsWith('/github/callback')) {
      return createRedirectPage('mindstone://github/callback' + url.search, 'GitHub');
    }

    if (url.pathname.startsWith('/digitalocean/callback')) {
      return createRedirectPage('mindstone://digitalocean/callback' + url.search, 'DigitalOcean');
    }

    if (url.pathname.startsWith('/openrouter/callback')) {
      return createRedirectPage('mindstone://openrouter/callback' + url.search, 'OpenRouter');
    }

    // OpenRouter requires a Referer header for app attribution (returns 409 without one).
    // This /start route serves a redirect page so the browser sends Referer from
    // rebel-auth.mindstone.com when navigating to the OpenRouter auth URL.
    if (url.pathname.startsWith('/openrouter/start')) {
      return createOpenRouterStartPage(url);
    }

    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  }
}

// Rebel-style quips for the redirect page
const QUIPS = [
  "Establishing secure connection...",
  "Convincing the servers you're trustworthy...",
  "Negotiating with the cloud...",
  "Translating corporate speak...",
  "Bypassing bureaucracy...",
  "Making introductions...",
  "Exchanging secret handshakes...",
  "Calibrating the flux capacitor...",
];

function createRedirectPage(deepLink, providerName) {
  const quip = QUIPS[Math.floor(Math.random() * QUIPS.length)];
  
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${providerName} Connected - Rebel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0a0a0f 0%, #1a1a2e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e0e0e0;
      overflow: hidden;
    }
    .orb {
      position: fixed;
      border-radius: 50%;
      filter: blur(120px);
      z-index: 0;
      pointer-events: none;
      animation: float 8s ease-in-out infinite;
    }
    .orb-1 {
      top: -80px;
      left: 0;
      width: 600px;
      height: 400px;
      background: rgba(99, 102, 241, 0.15);
    }
    .orb-2 {
      top: 25%;
      right: 0;
      width: 500px;
      height: 350px;
      background: rgba(168, 85, 247, 0.12);
      animation-delay: -4s;
    }
    .orb-3 {
      bottom: 0;
      left: 33%;
      width: 400px;
      height: 300px;
      background: rgba(59, 130, 246, 0.1);
      animation-delay: -2s;
    }
    @keyframes float {
      0%, 100% { transform: translateY(0) scale(1); }
      50% { transform: translateY(-20px) scale(1.02); }
    }
    .container { 
      position: relative;
      z-index: 1;
      max-width: 480px; 
      padding: 48px; 
      text-align: center;
      background: linear-gradient(145deg, rgba(255,255,255,0.03) 0%, rgba(255,255,255,0.01) 100%);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 1.5rem;
      box-shadow: 0 25px 50px -12px rgba(0,0,0,0.5);
    }
    .rebel-icon {
      width: 80px; height: 80px; margin-bottom: 24px;
      background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
      border-radius: 20px; display: inline-flex;
      align-items: center; justify-content: center;
      font-size: 40px; font-weight: bold; color: white;
      box-shadow: 0 8px 32px rgba(139, 92, 246, 0.3);
    }
    h1 { 
      font-size: 28px; 
      font-weight: 600; 
      margin-bottom: 8px; 
      color: #ffffff; 
    }
    .provider {
      font-size: 14px;
      color: #22c55e;
      background: rgba(34, 197, 94, 0.1);
      border: 1px solid rgba(34, 197, 94, 0.3);
      border-radius: 6px;
      padding: 4px 12px;
      display: inline-block;
      margin-bottom: 20px;
      font-weight: 500;
    }
    .quip { 
      font-size: 16px; 
      color: #a0a0a0; 
      margin-bottom: 24px; 
      line-height: 1.5;
      min-height: 24px;
    }
    .countdown {
      font-family: 'SF Mono', Monaco, Consolas, monospace;
      font-size: 13px;
      color: #666;
      margin-bottom: 24px;
    }
    .countdown span {
      color: #8b5cf6;
      font-weight: 600;
    }
    a {
      display: inline-block;
      padding: 14px 28px;
      background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
      color: #fff;
      text-decoration: none;
      border-radius: 12px;
      font-weight: 600;
      font-size: 15px;
      transition: all 0.2s;
      box-shadow: 0 4px 16px rgba(139, 92, 246, 0.3);
    }
    a:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(139, 92, 246, 0.4);
    }
    .hint {
      margin-top: 20px;
      font-size: 13px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="orb orb-1"></div>
  <div class="orb orb-2"></div>
  <div class="orb orb-3"></div>
  <div class="container">
    <div class="rebel-icon">R</div>
    <h1>Connection Established</h1>
    <div class="provider">${providerName}</div>
    <p class="quip">${quip}</p>
    <p class="countdown">Returning to Rebel in <span id="countdown">3</span>s...</p>
    <a href="${deepLink}">Open Rebel Now</a>
    <p class="hint">You can close this tab after returning to the app.</p>
  </div>
  <script>
    let seconds = 3;
    const countdownEl = document.getElementById('countdown');
    const interval = setInterval(() => {
      seconds--;
      if (countdownEl) countdownEl.textContent = seconds;
      if (seconds <= 0) {
        clearInterval(interval);
        window.location.href = "${deepLink}";
      }
    }, 1000);
    // Also try immediate redirect for faster response
    setTimeout(() => { window.location.href = "${deepLink}"; }, 100);
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 
      'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': '*',
    }
  });
}

/**
 * OpenRouter start page: serves a redirect to the OpenRouter auth URL so that
 * the browser sends a Referer header from rebel-auth.mindstone.com.
 * OpenRouter uses Referer for app attribution and returns a 409 without one.
 *
 * The Electron app passes the full OpenRouter auth URL as ?redirect=<encoded>.
 * This keeps all OAuth logic in the app; the Worker is a dumb Referer proxy.
 */
function createOpenRouterStartPage(url) {
  const redirectTo = url.searchParams.get('redirect');
  if (!redirectTo) {
    return new Response('Missing redirect parameter', { status: 400 });
  }

  // Validate and sanitize the redirect URL to prevent open redirect and XSS.
  // Re-serialize from the parsed URL to strip any injected content.
  let sanitizedUrl;
  try {
    const target = new URL(redirectTo);
    if (target.hostname !== 'openrouter.ai' || target.protocol !== 'https:') {
      return new Response('Invalid redirect target', { status: 400 });
    }
    sanitizedUrl = target.toString();
  } catch {
    return new Response('Invalid redirect URL', { status: 400 });
  }

  // HTML-escape the URL for safe interpolation into attributes
  const escaped = sanitizedUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta http-equiv="refresh" content="0;url=${escaped}">
<title>Redirecting to OpenRouter…</title>
</head>
<body style="font-family:system-ui;text-align:center;padding:40px;background:#0a0a0f;color:#e0e0e0">
<p>Redirecting to OpenRouter&hellip;</p>
<p><a href="${escaped}" style="color:#8b5cf6">Click here if not redirected.</a></p>
</body></html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
