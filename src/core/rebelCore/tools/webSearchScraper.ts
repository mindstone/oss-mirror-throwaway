/**
 * DuckDuckGo HTML scraping utilities for WebSearch.
 *
 * Parses DDG's lite HTML endpoint results and detects CAPTCHA / parser drift.
 * Uses linkedom for parsing (pure-JS, bundles cleanly with esbuild).
 *
 * @see docs/plans/260411_restore_web_and_search_builtin_tools.md
 */

import { parseHTML } from 'linkedom';

// ── Types ──────────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ScrapeResult {
  results: SearchResult[];
  captchaDetected: boolean;
  /** Non-empty response but zero results parsed (and no CAPTCHA). */
  parserDrift: boolean;
  /** First 200 chars of body text when parserDrift is true (diagnostic aid). */
  driftSnippet?: string;
}

// ── Constants ──────────────────────────────────────────────────────────

/** Minimum response size (bytes) to consider "non-empty" for parser drift. */
const MIN_BODY_SIZE_FOR_DRIFT = 1024;

// ── Implementation ─────────────────────────────────────────────────────

/**
 * Detect CAPTCHA / anti-bot challenge using structural checks only
 * (no English text matching — supports non-Latin locales).
 *
 * Two detection strategies (checked most-specific-first):
 * 1. **Image-puzzle challenge**: DDG's "anomaly-modal" CAPTCHA with checkbox
 *    image tiles (added April 2026). Detected via `.anomaly-modal` class or
 *    forms posting to `anomaly.js`.
 * 2. **Hidden-input form**: `<form>` with ≥2 hidden inputs and no search input
 *    (classic token/nonce challenge pages).
 */
function detectCaptcha(doc: Document, hasResults: boolean): boolean {
  if (hasResults) return false;

  // Strategy 2: DDG anomaly-modal image-puzzle CAPTCHA
  if (doc.querySelector('.anomaly-modal') || doc.querySelector('[data-testid="anomaly-modal"]')) {
    return true;
  }
  // Also catch anomaly.js form action (fallback if class names change)
  const forms = doc.querySelectorAll('form');
  for (const form of forms) {
    const action = form.getAttribute('action') ?? '';
    if (action.includes('anomaly.js')) {
      return true;
    }
  }

  // Strategy 1: hidden-input challenge forms
  for (const form of forms) {
    const hiddenInputs = form.querySelectorAll('input[type="hidden"]');
    if (hiddenInputs.length >= 2) {
      const searchInput = form.querySelector('input[name="q"][type="text"]');
      if (!searchInput) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Parse DuckDuckGo HTML search results.
 *
 * Extracts titles, URLs, and snippets from the DDG lite HTML endpoint.
 * Detects CAPTCHA pages (structural checks only) and parser drift
 * (non-empty response with zero results and no CAPTCHA).
 */
export function scrapeDdgResults(html: string): ScrapeResult {
  const { document: doc } = parseHTML(html);

  {

    // ── Extract results ──────────────────────────────────────────────
    const resultLinks = doc.querySelectorAll('.result__a');
    const results: SearchResult[] = [];

    for (const link of resultLinks) {
      const titleText = link.textContent?.trim() ?? '';
      let href = link.getAttribute('href') ?? '';

      // DDG sometimes wraps URLs in a redirect — extract the real URL
      if (href.includes('uddg=')) {
        try {
          const parsed = new URL(href, 'https://duckduckgo.com');
          const decoded = parsed.searchParams.get('uddg');
          if (decoded) href = decoded;
        } catch {
          // Keep the original href
        }
      }

      // Find the snippet — it's a sibling `.result__snippet` element
      const resultContainer = link.closest('.result') ?? link.closest('.results_links');
      const snippetEl = resultContainer?.querySelector('.result__snippet');
      const snippet = snippetEl?.textContent?.trim() ?? '';

      if (titleText && href) {
        results.push({ title: titleText, url: href, snippet });
      }
    }

    // ── Detect CAPTCHA ───────────────────────────────────────────────
    const captchaDetected = detectCaptcha(doc, results.length > 0);

    // ── Detect parser drift ──────────────────────────────────────────
    const parserDrift =
      results.length === 0 &&
      !captchaDetected &&
      html.length > MIN_BODY_SIZE_FOR_DRIFT;

    // Capture content-free diagnostics when drift is detected.
    // IMPORTANT: DDG renders the user's query in the <title> tag (e.g. "<query> at DuckDuckGo"),
    // so we must NOT include the title text here — only its length. Same reasoning for all
    // other fields: length / count only, never text content.
    const driftSnippet = parserDrift
      ? `bodyLen=${html.length} titleLen=${(doc.querySelector('title')?.textContent ?? '').length} forms=${doc.querySelectorAll('form').length} links=${doc.querySelectorAll('a').length}`
      : undefined;

    return { results, captchaDetected, parserDrift, driftSnippet };
  }
}
