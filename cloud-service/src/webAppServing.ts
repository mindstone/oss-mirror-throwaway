/**
 * Static file serving for the web companion SPA.
 *
 * Serves built SPA assets from a configurable directory (default: `data/web-app`).
 * Runs BEFORE auth — the SPA handles authentication client-side via URL fragment tokens.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './httpUtils';

const WEB_APP_DIR = process.env.REBEL_WEB_APP_DIR
  || path.join(process.cwd(), 'data', 'web-app');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const CSP_HEADER =
  "script-src 'self'; style-src 'self' 'unsafe-inline'; default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data:;";

let cachedIndexHtml: string | null = null;

export interface WebAppOgData {
  title: string;
  description: string;
}

/**
 * Detect whether a filename contains a content hash (e.g. `main.a1b2c3d4.js`).
 * Hashed assets are immutable and can be aggressively cached.
 */
function isHashedAsset(filename: string): boolean {
  // Match: name-HASH.ext or name.HASH.ext where hash is 8+ alphanumeric chars
  return /[-\.][a-zA-Z0-9_-]{8,}\.\w+$/.test(filename);
}

function getSafeNormalisedPath(rawUrl: string | undefined): string | null {
  const urlPath = (rawUrl || '').split('?')[0].split('#')[0];
  const relativePath = urlPath.startsWith('/app')
    ? urlPath.slice(4) || '/'
    : '/';

  if (relativePath.includes('\0')) {
    return null;
  }

  const normalised = path.normalize(relativePath).replace(/\\/g, '/');
  if (normalised.includes('..')) {
    return null;
  }

  return normalised;
}

function getCachedWebAppIndexHtml(): string | null {
  if (cachedIndexHtml !== null) {
    return cachedIndexHtml;
  }

  const indexPath = path.join(WEB_APP_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8');
  return cachedIndexHtml;
}

function injectOgTags(indexHtml: string, ogData: WebAppOgData): string {
  const ogMetaTags = [
    `<meta property="og:title" content="${ogData.title}" />`,
    `<meta property="og:description" content="${ogData.description}" />`,
    '<meta property="og:site_name" content="Rebel by Mindstone" />',
    '<meta property="og:type" content="article" />',
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${ogData.title}" />`,
    `<meta name="twitter:description" content="${ogData.description}" />`,
  ].join('\n    ');

  const htmlWithTitle = indexHtml.includes('<title>')
    ? indexHtml.replace(/<title>[\s\S]*?<\/title>/i, `<title>${ogData.title}</title>`)
    : indexHtml;

  if (htmlWithTitle.includes('</head>')) {
    return htmlWithTitle.replace('</head>', `    ${ogMetaTags}\n  </head>`);
  }

  return `${htmlWithTitle}\n${ogMetaTags}`;
}

function writeHtmlResponse(req: http.IncomingMessage, res: http.ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CSP_HEADER,
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  res.end(html);
}

/**
 * Serve the web companion SPA.
 * Handles the request and sends a response — caller should `return` after calling.
 */
export function serveWebApp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  // Only serve GET requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Check if web-app directory exists
  if (!fs.existsSync(WEB_APP_DIR)) {
    log({ level: 'warn', msg: 'Web app directory not found', dir: WEB_APP_DIR });
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Web companion not installed');
    return;
  }

  const normalised = getSafeNormalisedPath(req.url);
  if (!normalised) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  // Map to filesystem
  let filePath = path.join(WEB_APP_DIR, normalised === '/' ? 'index.html' : normalised);
  let ext = path.extname(filePath).toLowerCase();

  // SPA fallback: if file doesn't exist, serve index.html
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(WEB_APP_DIR, 'index.html');
    ext = '.html';
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';
  const cacheControl = isHashedAsset(path.basename(filePath))
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': cacheControl,
    'Content-Security-Policy': CSP_HEADER,
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }

  fs.createReadStream(filePath).pipe(res);
}

/**
 * Serve index.html with dynamic Open Graph metadata injected.
 * Used for /app/shared/:shareId so social crawlers get branded previews.
 */
export function serveWebAppWithOgTags(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ogData: WebAppOgData,
): void {
  // Only serve GET requests
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Check if web-app directory exists
  if (!fs.existsSync(WEB_APP_DIR)) {
    log({ level: 'warn', msg: 'Web app directory not found', dir: WEB_APP_DIR });
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Web companion not installed');
    return;
  }

  // Preserve traversal protection contract
  const normalised = getSafeNormalisedPath(req.url);
  if (!normalised) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad Request');
    return;
  }

  const indexHtml = getCachedWebAppIndexHtml();
  if (!indexHtml) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const htmlWithOgTags = injectOgTags(indexHtml, ogData);
  writeHtmlResponse(req, res, htmlWithOgTags);
}
