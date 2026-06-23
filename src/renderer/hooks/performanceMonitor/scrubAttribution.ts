/**
 * PII-scrubbed attribution for long-task PerformanceEntry objects.
 *
 * Stage 3 of `docs/plans/260423_secondary_process_cpu_observability.md`.
 *
 * The prod-capable renderer perf monitor ships long-task metadata to main
 * via `log:event` so it can appear in field reports. Raw long-task
 * `attribution[].containerSrc` / `containerName` routinely contains user
 * content: URLs with query strings, document titles, session IDs, etc.
 *
 * This module emits a two-field shape with:
 *   - `category`: an enum `'script' | 'layout' | 'paint' | 'unknown'`
 *     (no free-form strings).
 *   - `labelPath`: at most the URL path segment (no query, hash, userinfo),
 *     and `null` if any UUID-like, long-hex, email, or base64-like token is
 *     detected.
 */

export type LongTaskCategory = 'script' | 'layout' | 'paint' | 'unknown';

export interface ScrubbedAttribution {
  category: LongTaskCategory;
  labelPath: string | null;
}

interface TaskAttribution {
  containerType?: string;
  containerSrc?: string;
  containerName?: string;
  containerId?: string;
}

// UUID (v1-v5 canonical 8-4-4-4-12 hex, case-insensitive)
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Long hex run (>= 16 chars) — hashes, session IDs, etc.
const LONG_HEX_RE = /[0-9a-f]{16,}/i;
// Email — user@domain
const EMAIL_RE = /[\w+.-]+@[\w.-]+\.[a-z]{2,}/i;
// Long base64-ish token (>= 20 chars from the base64 alphabet, not all
// lowercase letters — a plain English word like "representative" should not
// trigger). Requires at least one digit, uppercase, `+`, `/`, or `=`.
const LONG_BASE64_RE = /[A-Za-z0-9+/=]{20,}/;

/**
 * Map `containerType` (from the LongTask API) to our high-level category.
 * Falls back to `entry.entryType` for non-window attribution.
 */
function deriveCategory(entry: PerformanceEntry, containerType?: string): LongTaskCategory {
  const rawType = (entry as unknown as { entryType?: string }).entryType;
  if (rawType === 'paint' || rawType === 'largest-contentful-paint' || rawType === 'first-input') {
    return 'paint';
  }
  if (rawType === 'layout-shift') {
    return 'layout';
  }

  if (!containerType) {
    // No attribution → assume the main JS context (the typical longtask
    // source in a pure-renderer app).
    return rawType === 'longtask' ? 'script' : 'unknown';
  }

  const ct = containerType.toLowerCase();
  if (ct === 'window' || ct === 'iframe' || ct === 'embed' || ct === 'object') {
    return 'script';
  }
  return 'unknown';
}

/**
 * Check whether a candidate string contains any PII-risk token. Returns
 * `true` when the string must be dropped entirely.
 */
function containsRiskyToken(s: string): boolean {
  if (UUID_RE.test(s)) return true;
  if (EMAIL_RE.test(s)) return true;
  if (LONG_HEX_RE.test(s)) return true;
  // Only flag base64 if there's a digit or uppercase letter — guards
  // against scanning a 20+ char path segment of all-lowercase words.
  if (LONG_BASE64_RE.test(s) && /[A-Z0-9+/=]/.test(s)) return true;
  return false;
}

/**
 * Strip query string, fragment, and userinfo from a URL-like string.
 * Keeps only the path portion. Never returns empty string — `null` instead.
 */
function extractPathOnly(candidate: string): string | null {
  if (!candidate) return null;

  // Remove fragment.
  let s = candidate.split('#')[0] ?? '';
  // Remove query.
  s = s.split('?')[0] ?? '';

  // If it looks absolute (scheme://), parse out the path. Otherwise use as-is
  // (relative path / file name).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      // `URL.pathname` excludes userinfo / host / query / fragment already.
      const pathname = url.pathname || '/';
      return pathname;
    } catch {
      // Malformed URL — conservatively drop.
      return null;
    }
  }

  // `user:pass@host/path` guard for non-scheme inputs.
  if (s.includes('@') && !s.includes(' ')) {
    const afterAt = s.split('@').pop() ?? '';
    s = afterAt.startsWith('/') ? afterAt : '/' + afterAt.split('/').slice(1).join('/');
  }

  // Collapse leading `//host/path` to `/path`.
  if (s.startsWith('//')) {
    const parts = s.slice(2).split('/');
    s = '/' + parts.slice(1).join('/');
  }

  return s || null;
}

/**
 * PII-scrub a PerformanceEntry's attribution into an enum category +
 * sanitized path. Never includes user content, URLs with query strings,
 * fragments, userinfo, document titles, or session IDs.
 *
 * Exported for unit testing.
 */
export function scrubAttribution(entry: PerformanceEntry): ScrubbedAttribution {
  const attribution = (entry as unknown as { attribution?: TaskAttribution[] }).attribution;

  const first = Array.isArray(attribution) ? attribution[0] : undefined;
  const containerType = first?.containerType;
  const category = deriveCategory(entry, containerType);

  if (!first) {
    return { category, labelPath: null };
  }

  // Prefer containerSrc (URL-like) → fall back to containerName (may be a
  // free-form title). containerName is more likely to carry user content
  // (document title), so we apply stricter scrubbing to it.
  const rawSrc = first.containerSrc?.trim();
  if (rawSrc) {
    if (containsRiskyToken(rawSrc)) {
      return { category, labelPath: null };
    }
    const path = extractPathOnly(rawSrc);
    if (!path) {
      return { category, labelPath: null };
    }
    if (containsRiskyToken(path)) {
      return { category, labelPath: null };
    }
    // Document titles ("My Secret Document.docx") occasionally appear as
    // containerSrc; whitespace never appears in legitimate URL paths. Drop.
    if (/\s/.test(path)) {
      return { category, labelPath: null };
    }
    // Cap length so a pathological input can't bloat the log line.
    if (path.length > 256) {
      return { category, labelPath: null };
    }
    return { category, labelPath: path };
  }

  const rawName = first.containerName?.trim();
  if (rawName) {
    // containerName is free-form; it can be a window/frame name ("main") or
    // a document title. Drop anything with whitespace or risky tokens.
    if (/\s/.test(rawName) || containsRiskyToken(rawName)) {
      return { category, labelPath: null };
    }
    // Limit to a bounded length so we never bloat the log line with an
    // unexpectedly long identifier.
    if (rawName.length > 64) {
      return { category, labelPath: null };
    }
    return { category, labelPath: rawName };
  }

  return { category, labelPath: null };
}

/**
 * Legacy helper preserved for the dev-mode hook. Formats a long-task
 * attribution into a human-readable label — intentionally bypasses the
 * prod-grade scrub (dev-only, console-logged, not emitted to main).
 *
 * Exported here so the Stage-3 unified hook can re-export it and existing
 * tests (`formatLongTaskAttribution.test.ts`) continue to pass.
 */
export function formatLongTaskAttribution(entry: PerformanceEntry): string | null {
  const attribution = (entry as unknown as { attribution?: TaskAttribution[] }).attribution;
  if (!Array.isArray(attribution) || attribution.length === 0) return null;

  const first = attribution[0];
  if (!first) return null;

  const type = first.containerType || 'unknown';
  const label = first.containerName || first.containerSrc || '';
  return label ? `${type}(${label})` : type;
}
