// ---------------------------------------------------------------------------
// urlSchemePolicy
// ---------------------------------------------------------------------------
// Renamed from `imageUrlGuard` on 2026-04-23 (docs/plans/260423_i10_outstanding
// _work_STAGED_PLAN.md Stage 4 / R3). The module started as an image-URL guard
// but `createGuardedUrlTransform` also houses the anchor scheme preservation
// knob (`preserveSchemes`), so the broader name is more accurate.
//
// Symbol names were ALSO renamed on 2026-04-23 (docs/plans/260423_r1_hardening
// _i2_i3_i6.md Stage 1 / I2) after the R1 XSS fix (`8f63997ae`) extended the
// guard to `<a href>` attributes as well as `<img src>` — the old `Image`-
// scoped names became factually misleading. Consumers continue to import from
// `@rebel/shared` (barrel). No back-compat aliases.
// ---------------------------------------------------------------------------

/**
 * Schemes hardcoded as blocked in markdown `<img src>` AND `<a href>`
 * attributes (anchor coverage added 2026-04-23 in R1 fix `8f63997ae`).
 *
 * Blocked because:
 * - `javascript:` — XSS vector.
 * - `blob:` — can bypass origin checks.
 * - `file:` — exposes local filesystem paths.
 *
 * These schemes are never safe in user-authored markdown. The list is
 * intentionally not configurable — extending it should only add new blocks.
 */
export const BLOCKED_URL_SCHEMES = ['javascript:', 'blob:', 'file:'] as const;

/**
 * A blocked URL scheme recognized by `findBlockedUrlScheme`.
 */
export type BlockedUrlScheme = (typeof BLOCKED_URL_SCHEMES)[number];

type MarkdownUrlSurface = 'default' | 'message-main';

export type MarkdownUrlClassification =
  | {
      category: 'empty';
      isSafe: true;
      normalizedUrl: '';
      trimmedUrl: '';
    }
  | {
      category: 'relative' | 'hash';
      isSafe: true;
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'protocol-relative';
      isSafe: boolean;
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'windows-drive';
      isSafe: false;
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'http' | 'https';
      isSafe: true;
      scheme: 'http:' | 'https:';
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'default-safe-scheme';
      isSafe: true;
      scheme: 'mailto:' | 'irc:' | 'ircs:' | 'xmpp:';
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'library' | 'workspace' | 'rebel';
      isSafe: boolean;
      scheme: 'library:' | 'workspace:' | 'rebel:';
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'file';
      isSafe: boolean;
      scheme: 'file:';
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'data-image';
      isSafe: false;
      scheme: 'data:';
      subtype: string;
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'blocked-dangerous';
      isSafe: false;
      scheme: 'javascript:' | 'blob:';
      normalizedUrl: string;
      trimmedUrl: string;
    }
  | {
      category: 'unknown-scheme';
      isSafe: false;
      scheme: string;
      normalizedUrl: string;
      trimmedUrl: string;
    };

export interface ClassifyMarkdownUrlContext {
  /**
   * MessageMarkdown main anchors intentionally route `file://` and Rebel's
   * internal schemes through the click dispatcher. The default surface keeps
   * `file:` blocked for SafeMarkdown/SafeWebMarkdown anchors and all images.
   */
  surface?: MarkdownUrlSurface;
}

const DEFAULT_SAFE_SCHEMES = ['mailto:', 'irc:', 'ircs:', 'xmpp:'] as const;
const INTERNAL_ROUTE_SCHEMES = ['library:', 'workspace:', 'rebel:'] as const;

const hasProtocolBeforePathBoundary = (value: string): boolean => {
  const colon = value.indexOf(':');
  const questionMark = value.indexOf('?');
  const numberSign = value.indexOf('#');
  const slash = value.indexOf('/');

  return (
    colon !== -1 &&
    (slash === -1 || colon < slash) &&
    (questionMark === -1 || colon < questionMark) &&
    (numberSign === -1 || colon < numberSign)
  );
};

const isMessageMainSurface = (context?: ClassifyMarkdownUrlContext): boolean =>
  context?.surface === 'message-main';

/**
 * Classifies a markdown URL by scheme-safety category.
 *
 * This is deliberately about scheme safety only. It does not decide renderer
 * routing for library files, spaces, conversations, tutorials, or file chips;
 * those remain in MessageMarkdown and `markdownLinkHandler`.
 *
 * Matching uses the same trim + lowercase normalization as
 * `findBlockedUrlScheme`, while callers that need exact output preservation
 * still choose whether to return the original value or a trimmed value.
 */
export function classifyMarkdownUrl(
  url: string | null | undefined,
  context?: ClassifyMarkdownUrlContext,
): MarkdownUrlClassification {
  const trimmedUrl = url?.trim() ?? '';
  const normalizedUrl = trimmedUrl.toLowerCase();

  if (!trimmedUrl) {
    return {
      category: 'empty',
      isSafe: true,
      normalizedUrl: '',
      trimmedUrl: '',
    };
  }

  if (trimmedUrl.startsWith('#')) {
    return { category: 'hash', isSafe: true, normalizedUrl, trimmedUrl };
  }

  if (trimmedUrl.startsWith('//')) {
    return {
      category: 'protocol-relative',
      isSafe: !isMessageMainSurface(context),
      normalizedUrl,
      trimmedUrl,
    };
  }

  if (/^[A-Za-z]:/.test(trimmedUrl)) {
    return {
      category: 'windows-drive',
      isSafe: false,
      normalizedUrl,
      trimmedUrl,
    };
  }

  if (!hasProtocolBeforePathBoundary(trimmedUrl)) {
    return { category: 'relative', isSafe: true, normalizedUrl, trimmedUrl };
  }

  if (normalizedUrl.startsWith('http:')) {
    return {
      category: 'http',
      isSafe: true,
      scheme: 'http:',
      normalizedUrl,
      trimmedUrl,
    };
  }

  if (normalizedUrl.startsWith('https:')) {
    return {
      category: 'https',
      isSafe: true,
      scheme: 'https:',
      normalizedUrl,
      trimmedUrl,
    };
  }

  for (const scheme of DEFAULT_SAFE_SCHEMES) {
    if (normalizedUrl.startsWith(scheme)) {
      return {
        category: 'default-safe-scheme',
        isSafe: true,
        scheme,
        normalizedUrl,
        trimmedUrl,
      };
    }
  }

  for (const scheme of INTERNAL_ROUTE_SCHEMES) {
    if (normalizedUrl.startsWith(scheme)) {
      return {
        category: scheme.slice(0, -1) as 'library' | 'workspace' | 'rebel',
        isSafe: isMessageMainSurface(context),
        scheme,
        normalizedUrl,
        trimmedUrl,
      };
    }
  }

  if (normalizedUrl.startsWith('file:')) {
    return {
      category: 'file',
      isSafe: isMessageMainSurface(context),
      scheme: 'file:',
      normalizedUrl,
      trimmedUrl,
    };
  }

  const dataImageMatch = /^data:image\/([^;,]+)(?:[;,]|$)/i.exec(trimmedUrl);
  if (dataImageMatch) {
    return {
      category: 'data-image',
      isSafe: false,
      scheme: 'data:',
      subtype: dataImageMatch[1]?.toLowerCase() ?? '',
      normalizedUrl,
      trimmedUrl,
    };
  }

  if (normalizedUrl.startsWith('javascript:')) {
    return {
      category: 'blocked-dangerous',
      isSafe: false,
      scheme: 'javascript:',
      normalizedUrl,
      trimmedUrl,
    };
  }

  if (normalizedUrl.startsWith('blob:')) {
    return {
      category: 'blocked-dangerous',
      isSafe: false,
      scheme: 'blob:',
      normalizedUrl,
      trimmedUrl,
    };
  }

  return {
    category: 'unknown-scheme',
    isSafe: false,
    scheme: normalizedUrl.slice(0, normalizedUrl.indexOf(':') + 1),
    normalizedUrl,
    trimmedUrl,
  };
}

/**
 * Returns the blocked scheme if `url` starts with one, or `null` otherwise.
 *
 * Matching is case-insensitive and runs after trimming leading/trailing
 * whitespace so values like `'  JAVASCRIPT:...'` are still blocked.
 *
 * Used to gate both `<img src>` (image scheme) and `<a href>` (anchor
 * scheme) in the SafeMarkdown / SafeWebMarkdown render paths.
 */
export function findBlockedUrlScheme(
  url: string | null | undefined,
): BlockedUrlScheme | null {
  const classification = classifyMarkdownUrl(url);
  if (classification.category === 'blocked-dangerous') {
    return classification.scheme;
  }
  if (classification.category === 'file') {
    return classification.scheme;
  }

  return null;
}

/**
 * Redacts a URL for safe logging by removing query parameters and truncating
 * to 256 characters.
 *
 * This keeps OAuth/session tokens in query strings out of logs while still
 * preserving enough source context for debugging. Used for both image `src`
 * and anchor `href` redaction.
 */
export function redactUrlForLogging(url: string | null | undefined): string {
  if (!url) return '';

  const withoutQuery = url.split('?')[0] ?? '';
  return withoutQuery.slice(0, 256);
}

/**
 * Builds a react-markdown `urlTransform` that preserves blocked URL schemes
 * long enough for the `img` and `a` renderer guards to fire (log + neutralise),
 * with an optional allow-list of custom schemes that should also be passed
 * through to downstream anchor/click handlers.
 *
 * Without this, react-markdown's default `urlTransform` blanks dangerous
 * schemes (javascript:/blob:/file:/vbscript:/etc) to `''` BEFORE the component
 * `img` / `a` renderers run, so `findBlockedUrlScheme(url)` in the renderer
 * never sees the original scheme and the guard + structured warning never
 * fires — the user gets a silent `<img src="">` / `<a>` instead of the
 * intended hidden placeholder + console.warn.
 *
 * Semantics (checked in order):
 * 1. DANGEROUS PASSTHROUGH — if `url` starts with a scheme in
 *    `BLOCKED_URL_SCHEMES`, return it unchanged so the guard can log and
 *    replace it with a neutralised element. This always wins, even if a
 *    caller mistakenly added the same scheme to `preserveSchemes`.
 * 2. PRESERVE PASSTHROUGH (optional) — if `preserveSchemes` contains a
 *    scheme that matches `url` (case-insensitive, leading-whitespace-
 *    tolerant), return the url with leading whitespace trimmed so
 *    downstream `startsWith(scheme)` click-handler checks match.
 * 3. FALLBACK — delegate to `fallback` (the default react-markdown
 *    transform or any caller-supplied one) for normal scheme filtering.
 *
 * Used by SafeMarkdown and SafeWebMarkdown. MessageMarkdown has its own
 * more permissive transform (preserves library:// / rebel:// / file:// for
 * handler routing too) and calls `findBlockedUrlScheme` separately.
 *
 * @param fallback - react-markdown's default urlTransform or a custom one.
 * @param preserveSchemes - Optional list of scheme prefixes (e.g.
 *   `['rebel://']`) to pass through so downstream click handlers can route
 *   them. Matched case-insensitively with leading-whitespace tolerance;
 *   preserved value has leading whitespace trimmed. Omitting this argument
 *   is bitwise-equivalent to the pre-extension single-argument API.
 *
 * @see BLOCKED_URL_SCHEMES
 * @see findBlockedUrlScheme
 */
export function createGuardedUrlTransform(
  fallback: (url: string) => string,
  preserveSchemes?: readonly string[],
): (url: string) => string {
  const lowerPreserveSchemes =
    preserveSchemes && preserveSchemes.length > 0
      ? preserveSchemes.map((scheme) => scheme.toLowerCase())
      : undefined;

  return (url: string) => {
    const classification = classifyMarkdownUrl(url);
    if (
      classification.category === 'blocked-dangerous' ||
      classification.category === 'file'
    ) {
      return url;
    }
    if (lowerPreserveSchemes) {
      const trimmed = url.trimStart();
      const lower = trimmed.toLowerCase();
      for (const scheme of lowerPreserveSchemes) {
        if (lower.startsWith(scheme)) return trimmed;
      }
    }
    return fallback(url);
  };
}
