/**
 * WebFetch — built-in tool for reading web page content.
 *
 * Fetches a URL, extracts readable content via Readability, and converts
 * to Markdown via Turndown. Includes SSRF protection (per-hop IP validation),
 * rate limiting, and Content-Type checking.
 *
 * Uses linkedom (pure-JS, bundles cleanly with esbuild) instead of jsdom.
 * Readability URL resolution requires: (1) setting documentURI via
 * Object.defineProperty, and (2) injecting <base href> if the source
 * HTML doesn't already have one. This preserves hash-only links (#section)
 * and correctly resolves relative URLs.
 *
 * @see docs/plans/260411_restore_web_and_search_builtin_tools.md
 */

import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
// Use the browser ESM build of turndown — it has zero Node.js dependencies.
// The default CJS build eagerly requires @mixmark-io/domino at module load
// time for server-side HTML parsing, which crashes in packaged Electron
// because Vite bundles turndown inline but leaves the domino require() as
// a bare runtime call with no node_modules to resolve against.
// The browser build expects a DOM node input (no DOMParser fallback needed).
// @ts-expect-error — turndown ships no types for the browser subpath
import TurndownService from 'turndown/lib/turndown.browser.es.js';
import { createScopedLogger } from '@core/logger';
import { followRedirectsSafely } from '@core/utils/ssrfProtection';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';
import type { BuiltinToolContext, ToolExecutionResult } from '../types';
import type { ToolDefinition } from '../modelTypes';

const log = createScopedLogger({ service: 'webFetchTool' });

// ── Constants ──────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_RAW_TEXT_CHARS = 50_000;       // 50 KB of text
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RATE_LIMIT = 10;
const USER_AGENT = 'Rebel/1.0 (https://mindstone.com)';

const RATE_LIMIT_MESSAGE =
  "I've reached my page-reading limit for this task (10 pages per task). " +
  'Try again in a new conversation, or set up a dedicated web reading tool in Settings > Connectors.';

// ── Tool Definition ────────────────────────────────────────────────────

export const WEB_FETCH_TOOL_DEFINITION: ToolDefinition = {
  name: 'WebFetch',
  description:
    'Fetch and read a web page. Returns the page content as Markdown. ' +
    'Use this when you need to read a URL the user shared or look up information on a specific page.',
  input_schema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch.',
      },
      timeout: {
        type: 'integer',
        minimum: 1000,
        description: 'Request timeout in milliseconds (default 15000).',
      },
      raw: {
        type: 'boolean',
        description: 'If true, return raw stripped text instead of Readability-parsed Markdown.',
      },
    },
    required: ['url'],
  },
};

// ── Helpers ────────────────────────────────────────────────────────────

/** Strip HTML tags and collapse whitespace for raw text fallback. */
function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Check if a Content-Type header indicates readable text content. */
function isReadableContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes('text/html') || ct.includes('text/plain') || ct.includes('application/xhtml');
}

/** Describe a non-readable content type in user-friendly terms. */
function describeContentType(contentType: string): string {
  const ct = contentType.toLowerCase();
  if (ct.includes('application/pdf')) return 'a PDF document';
  if (ct.includes('image/')) return 'an image';
  if (ct.includes('audio/')) return 'an audio file';
  if (ct.includes('video/')) return 'a video file';
  if (ct.includes('application/zip') || ct.includes('application/gzip')) return 'a compressed archive';
  if (ct.includes('application/json')) return 'a JSON file';
  if (ct.includes('application/xml') || ct.includes('text/xml')) return 'an XML document';
  return `a file of type "${contentType}"`;
}

/**
 * Read a response body as a stream, accumulating bytes up to the size limit.
 * Returns the body text if within limits, or throws on exceeding.
 */
async function readBodyWithLimit(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // No body stream — fall back to text()
    return response.text();
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Request aborted');
      }

      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Response too large (exceeded ${Math.round(maxBytes / 1024 / 1024)}MB limit). This page is too big to read.`);
      }

      chunks.push(decoder.decode(value, { stream: true }));
    }
    // Flush remaining bytes
    chunks.push(decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }

  return chunks.join('');
}

// ── Executor ───────────────────────────────────────────────────────────

export async function executeWebFetch(
  input: unknown,
  context: BuiltinToolContext,
): Promise<ToolExecutionResult> {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { output: 'WebFetch requires a valid input object.', isError: true };
  }
  const params = input as Record<string, unknown>;
  const startTime = Date.now();

  // ── Validate input ─────────────────────────────────────────────────
  const url = params.url;
  if (typeof url !== 'string' || url.trim().length === 0) {
    return { output: 'WebFetch requires a valid URL.', isError: true };
  }

  const timeout = typeof params.timeout === 'number' && params.timeout > 0
    ? params.timeout
    : DEFAULT_TIMEOUT_MS;
  const raw = params.raw === true;

  // ── Rate limit check ───────────────────────────────────────────────
  if (context.rateLimitState) {
    const current = context.rateLimitState.get('WebFetch') ?? 0;
    if (current >= MAX_RATE_LIMIT) {
      return { output: RATE_LIMIT_MESSAGE, isError: true };
    }
    context.rateLimitState.set('WebFetch', current + 1);
  }

  // Extract hostname for logging (never log full URL or query params)
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { output: 'The URL provided is not valid. Please check the URL and try again.', isError: true };
  }

  try {
    // ── Fetch with SSRF protection ─────────────────────────────────
    const response = await followRedirectsSafely(url, {
      maxHops: 5,
      signal: context.signal,
      timeout,
      headers: { 'User-Agent': USER_AGENT },
    });

    const finalUrl = response.url || url;
    const statusCode = response.status;
    const contentType = response.headers.get('content-type') ?? '';

    // ── Check Content-Type ─────────────────────────────────────────
    if (!isReadableContentType(contentType) && contentType.length > 0) {
      const description = describeContentType(contentType);
      // We won't read this body — cancel it so the per-request pinned
      // dispatcher (owned by followRedirectsSafely, already graceful-closing)
      // can release its socket. A graceful close stays pending until the body
      // is drained or cancelled.
      try {
        await response.body?.cancel();
      } catch (cancelErr) {
        ignoreBestEffortCleanup(cancelErr, {
          operation: 'webFetch.cancelNonReadableBody',
          reason: 'Body discarded on non-readable content type; cancel frees the pinned dispatcher socket.',
        });
      }
      log.info(
        { hostname, statusCode, contentType, durationMs: Date.now() - startTime },
        'WebFetch: non-readable content type',
      );
      return {
        output: `This URL returned ${description}. I can only read HTML and plain text pages.`,
        isError: false,
      };
    }

    // ── Read body with size limit ──────────────────────────────────
    const html = await readBodyWithLimit(response, MAX_BODY_BYTES, context.signal);
    const bytesRead = new TextEncoder().encode(html).byteLength;

    log.info(
      { hostname, statusCode, contentType, bytesRead, durationMs: Date.now() - startTime },
      'WebFetch: page fetched',
    );

    // ── Raw mode: strip HTML and return text ───────────────────────
    if (raw) {
      const text = stripHtml(html);
      const truncated = text.length > MAX_RAW_TEXT_CHARS
        ? text.slice(0, MAX_RAW_TEXT_CHARS) + '\n\n[Content truncated — showing first 50KB of text]'
        : text;
      return { output: truncated, isError: false };
    }

    // ── Parse with Readability + Turndown ──────────────────────────
    const { document: doc } = parseHTML(html);

    // linkedom doesn't set documentURI/baseURI from a URL option like jsdom.
    // Readability needs documentURI === baseURI to preserve hash-only links
    // (#section) and uses baseURI to resolve relative URLs.
    Object.defineProperty(doc, 'documentURI', { value: finalUrl, writable: false });

    // Ensure <base href> exists and is absolute. linkedom's baseURI getter
    // returns the raw attribute value (unlike jsdom/browsers which resolve it),
    // so relative/protocol-relative bases must be resolved against the page URL.
    const existingBase = doc.querySelector('base[href]');
    if (existingBase) {
      const rawHref = existingBase.getAttribute('href') ?? '';
      try {
        const resolved = new URL(rawHref, finalUrl);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
          existingBase.setAttribute('href', resolved.href);
        } else {
          existingBase.setAttribute('href', finalUrl);
        }
      } catch {
        existingBase.setAttribute('href', finalUrl);
      }
    } else if (doc.documentElement) {
      let head = doc.querySelector('head');
      if (!head) {
        head = doc.createElement('head');
        doc.documentElement.insertBefore(head, doc.documentElement.firstChild);
      }
      const base = doc.createElement('base');
      base.setAttribute('href', finalUrl);
      head.insertBefore(base, head.firstChild);
    }

    // linkedom doesn't auto-wrap plain text in <html>, so documentElement
    // may be null. Readability requires it — skip to raw text fallback.
    const article = doc.documentElement ? new Readability(doc).parse() : null;

    if (article && article.content) {
      const turndown = new TurndownService();
      // Parse the HTML article content into a DOM node via linkedom so
      // turndown's browser build can traverse it directly (it has no
      // built-in HTML parser — that's the CJS build's domino path).
      // Wrap in <html><body> to ensure linkedom places content inside body.
      const { document: articleDoc } = parseHTML(
        `<html><body>${article.content}</body></html>`,
      );
      let markdown = turndown.turndown(articleDoc.body);

      // Prepend title if available
      if (article.title) {
        markdown = `# ${article.title}\n\n${markdown}`;
      }

      // Truncate if extremely long
      if (markdown.length > MAX_RAW_TEXT_CHARS) {
        markdown = markdown.slice(0, MAX_RAW_TEXT_CHARS) + '\n\n[Content truncated — showing first 50KB]';
      }

      return { output: markdown, isError: false };
    }

    // ── Readability returned null — fall back to raw text ──────────
    log.info({ hostname }, 'WebFetch: Readability returned null, falling back to raw text');
    const fallbackText = stripHtml(html);
    const truncatedFallback = fallbackText.length > MAX_RAW_TEXT_CHARS
      ? fallbackText.slice(0, MAX_RAW_TEXT_CHARS) + '\n\n[Content truncated — showing first 50KB of text]'
      : fallbackText;

    return { output: truncatedFallback, isError: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;

    log.warn({ hostname, durationMs, error: message }, 'WebFetch: request failed');

    // ── User-friendly error messages ─────────────────────────────
    if (message.includes('aborted') || message.includes('abort')) {
      return { output: 'The page request was cancelled.', isError: true };
    }
    if (message.includes('timed out') || message.includes('timeout')) {
      return { output: `The page took too long to load (timed out after ${Math.round(timeout / 1000)} seconds). The site may be slow or unavailable.`, isError: true };
    }
    if (message.includes('Blocked:') || message.includes('private') || message.includes('local')) {
      return { output: 'This URL points to a private or local network address and cannot be accessed for security reasons.', isError: true };
    }
    if (message.includes('Response too large')) {
      return { output: message, isError: true };
    }
    if (message.includes('Too many redirects')) {
      return { output: 'This URL has too many redirects. The page may be misconfigured.', isError: true };
    }

    return {
      output: `Could not read this page: ${message}`,
      isError: true,
    };
  }
}
