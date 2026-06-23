/**
 * Prefixes that all identify "this URL is a workspace-relative file reference":
 *   - `rebel://library/` — canonical form (Stage H of cross-surface-links plan)
 *   - `library://`       — legacy form (pre-Stage H content, third-party pastes)
 *   - `workspace://`     — older legacy form (pre-251219 unified navigation)
 *
 * The renderer, mobile file viewer, and cloud file viewer all call
 * `getLibraryProtocol` / `extractLibraryPath` to recognise a library link and
 * extract the path. Keeping all three forms readable means:
 *   - New content uses the canonical `rebel://library/` emitted by
 *     `formatLibraryUrl` — recipients on any surface see the same URL.
 *   - Existing content (old markdown, saved documents, external pastes) keeps
 *     working without migration.
 */
export const getLibraryProtocol = (
  url: string | null | undefined,
): 'rebel://library/' | 'library://' | 'workspace://' | null => {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (lower.startsWith('rebel://library/')) return 'rebel://library/';
  if (lower.startsWith('library://')) return 'library://';
  if (lower.startsWith('workspace://')) return 'workspace://';
  return null;
};

/**
 * Strip only wrapping punctuation that was added by markdown/autolinkers around
 * the URL, without clobbering characters that are legitimately part of the path.
 *
 * Rule per bracket pair ( [], (), {}, <> ):
 *   - Remove trailing closers only while there are more closers than openers
 *     in the string so far.
 *   - Stop as soon as the counts balance — the remaining closer belongs to the
 *     path itself (e.g. `notes(v2)`, `file(copy).md`, `foo]bar`).
 *
 * This preserves `library://notes(v2)` while still stripping the outer `)` from
 * `library://notes(v2))` (which is how markdown-it produces URLs when the link
 * was wrapped in parens, e.g. `(see [x](library://notes(v2)))` → the raw URL
 * token ends with an extra `)`).
 */
const stripUnbalancedClosers = (raw: string): string => {
  const pairs: Array<[open: string, close: string]> = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['<', '>'],
  ];

  let s = raw;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (!s.endsWith(close)) continue;
      let opens = 0;
      let closes = 0;
      for (const ch of s) {
        if (ch === open) opens++;
        else if (ch === close) closes++;
      }
      if (closes > opens) {
        s = s.slice(0, -1);
        changed = true;
        break; // restart loop — another closer may now be unbalanced
      }
    }
  }
  return s;
};

export const extractLibraryPath = (url: string): string | null => {
  const protocol = getLibraryProtocol(url);
  if (!protocol) return null;

  const pathPart = url.substring(protocol.length);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    decoded = pathPart;
  }

  return stripUnbalancedClosers(decoded);
};

export const stripQueryAndFragmentFromPath = (path: string): string => {
  const hashIndex = path.indexOf('#');
  const queryIndex = path.indexOf('?');
  const separatorIndex =
    hashIndex >= 0 && queryIndex >= 0
      ? Math.min(hashIndex, queryIndex)
      : hashIndex >= 0
        ? hashIndex
        : queryIndex;

  return separatorIndex >= 0 ? path.slice(0, separatorIndex) : path;
};

export const isLibraryUrl = (url: string | null | undefined): boolean => {
  return getLibraryProtocol(url) !== null;
};

export const parseFileUrl = (url: string): { path: string; isUnc: boolean } | null => {
  if (!url.toLowerCase().startsWith('file://')) {
    return null;
  }

  const safeDecode = (raw: string): string => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  };

  try {
    const parsedUrl = new URL(url);
    let path = safeDecode(parsedUrl.pathname);

    if (/^\/[A-Za-z]:/.test(path)) {
      path = path.substring(1);
    }

    const isUnc = Boolean(parsedUrl.hostname && parsedUrl.hostname !== 'localhost');
    if (isUnc) {
      path = `\\\\${parsedUrl.hostname}${path.replace(/\//g, '\\')}`;
    }

    return { path, isUnc };
  } catch {
    const rawPath = url.substring('file://'.length).replace(/^\/([A-Za-z]:)/, '$1');
    const path = safeDecode(rawPath);
    return { path, isUnc: path.startsWith('\\') };
  }
};
