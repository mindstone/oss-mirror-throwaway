/**
 * Tutorial Player Server
 *
 * Lightweight localhost HTTP server that serves a wrapper HTML page for YouTube embeds.
 * 
 * **Background:**
 * YouTube iframes require a valid HTTP Referer header to function properly.
 * In production, Electron loads the app from `file://` protocol via `mainWindow.loadFile()`.
 * The `file://` protocol cannot send valid HTTP Referer headers - this is a fundamental
 * browser security limitation that causes YouTube's "Error 153: Video playback error".
 *
 * **Solution:**
 * Instead of embedding YouTube directly in the `file://` page, we serve a small wrapper
 * page from `http://127.0.0.1:<port>` which CAN send proper Referer headers.
 * The TutorialsModal loads this wrapper in an iframe, and the wrapper embeds YouTube.
 *
 * **Security considerations:**
 * - Server only listens on 127.0.0.1 (localhost only, not accessible from network)
 * - Uses a per-session random token to prevent unauthorized access
 * - Only serves the single tutorial-player endpoint, no file system access
 * - Validates videoId parameter to prevent injection attacks
 */

import http from 'node:http';
import crypto from 'node:crypto';
import { createScopedLogger } from '@core/logger';
import { attachBenignSocketErrorGuard } from '@core/utils/socketErrorGuard';

const log = createScopedLogger({ service: 'tutorialPlayerServer' });

const DEFAULT_PORT = 18770;

// Server state
let server: http.Server | null = null;
let currentPort: number = DEFAULT_PORT;
let authToken: string | null = null;

/**
 * Get the URL for embedding a YouTube video via the tutorial player server.
 * Returns null if the server is not running.
 */
export function getTutorialPlayerUrl(youtubeId: string): string | null {
  if (!server || !authToken) return null;
  
  // Validate YouTube ID format (11 alphanumeric characters plus hyphens/underscores)
  if (!/^[a-zA-Z0-9_-]{11}$/.test(youtubeId)) {
    log.warn({ youtubeId }, 'Invalid YouTube ID format');
    return null;
  }
  
  return `http://127.0.0.1:${currentPort}/tutorial-player?videoId=${youtubeId}&token=${authToken}`;
}

/**
 * Generate the HTML wrapper page for YouTube embeds.
 * @param youtubeId - Validated 11-character YouTube video ID
 * @param autoplay - Whether the video should autoplay (default: false)
 */
function generatePlayerHtml(youtubeId: string, autoplay: boolean = false): string {
  // Double-validate the YouTube ID to prevent XSS
  const safeId = youtubeId.replace(/[^a-zA-Z0-9_-]/g, '');
  
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tutorial Player</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
    iframe {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      border: none;
    }
  </style>
</head>
<body>
  <iframe
    id="player"
    src="https://www.youtube-nocookie.com/embed/${safeId}?autoplay=${autoplay ? 1 : 0}&modestbranding=1&rel=0&enablejsapi=1&origin=http://127.0.0.1:${currentPort}"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
    allowfullscreen
  ></iframe>
  <script>
    // Forward YouTube player state messages to parent window
    window.addEventListener('message', function(event) {
      // Only forward messages from YouTube's known origins (strict check)
      var isYouTube = event.origin === 'https://www.youtube.com' ||
                      event.origin === 'https://www.youtube-nocookie.com';
      if (isYouTube) {
        // Re-post to parent (file:// has null origin, so we use '*')
        window.parent.postMessage(event.data, '*');
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Handle incoming HTTP requests.
 */
function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${currentPort}`);
  
  // Only handle GET requests to /tutorial-player
  if (req.method !== 'GET' || url.pathname !== '/tutorial-player') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }
  
  // Validate auth token
  const token = url.searchParams.get('token');
  if (token !== authToken) {
    log.warn('Invalid auth token');
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  
  // Validate video ID
  const videoId = url.searchParams.get('videoId');
  if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    log.warn({ videoId }, 'Invalid video ID');
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Invalid video ID');
    return;
  }
  
  // Read autoplay preference (default: no autoplay for chat embeds)
  const autoplay = url.searchParams.get('autoplay') === '1';
  
  // Serve the player HTML
  const html = generatePlayerHtml(videoId, autoplay);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    // Security headers
    'X-Content-Type-Options': 'nosniff',
    // NOTE: X-Frame-Options is intentionally NOT set because this page MUST be
    // embeddable in the Electron app's file:// context. The auth token provides
    // access control instead.
    // Use 'origin' referrer policy to avoid leaking the auth token to YouTube
    'Referrer-Policy': 'origin',
  });
  res.end(html);
}

/**
 * Find an available port, trying the default first.
 */
async function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const testServer = http.createServer();
    
    testServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Try next port
        testServer.close();
        resolve(findAvailablePort(startPort + 1));
      } else {
        reject(err);
      }
    });
    
    testServer.listen(startPort, '127.0.0.1', () => {
      const address = testServer.address();
      const port = typeof address === 'object' && address ? address.port : startPort;
      testServer.close(() => resolve(port));
    });
  });
}

/**
 * Start the tutorial player server.
 * Returns the port number it's running on.
 */
export async function startTutorialPlayerServer(): Promise<number> {
  if (server) {
    log.info({ port: currentPort }, 'Tutorial player server already running');
    return currentPort;
  }
  
  // Generate auth token
  authToken = crypto.randomBytes(32).toString('base64url');
  
  // Find available port
  currentPort = await findAvailablePort(DEFAULT_PORT);
  
  return new Promise((resolve, reject) => {
    server = http.createServer(handleRequest);
    attachBenignSocketErrorGuard(server); // REBEL-5J5: swallow benign per-connection socket errors

    server.on('error', (err: NodeJS.ErrnoException) => {
      log.error({ error: err.message }, 'Tutorial player server error');
      server = null;
      authToken = null;
      reject(err);
    });
    
    server.listen(currentPort, '127.0.0.1', () => {
      log.info({ port: currentPort }, 'Tutorial player server started');
      resolve(currentPort);
    });
  });
}

/**
 * Stop the tutorial player server.
 */
export async function stopTutorialPlayerServer(): Promise<void> {
  const s = server;
  if (!s) return;
  
  return new Promise((resolve) => {
    s.close(() => {
      log.info('Tutorial player server stopped');
      server = null;
      authToken = null;
      resolve();
    });
  });
}
