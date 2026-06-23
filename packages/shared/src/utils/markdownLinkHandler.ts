import {
  extractLibraryPath,
  getLibraryProtocol,
  parseFileUrl,
  stripQueryAndFragmentFromPath,
} from './libraryUrls';
import { getFileExtension, isImagePath } from './fileCategories';

export type HandledKind =
  | 'file'
  | 'image'
  | 'folder'
  | 'conversation'
  | 'tutorial'
  | 'rebel-nav';

export type BlockedReason =
  | 'protocol-relative'
  | 'unknown-scheme'
  | 'invalid-tutorial'
  | 'invalid-rebel-url'
  | 'empty-path'
  | 'platform-unsupported';

export type LinkDispatchResult =
  | { action: 'handled'; kind: HandledKind }
  | { action: 'open-external'; url: string }
  | { action: 'blocked'; reason: BlockedReason; url: string }
  | { action: 'ignore' };

export type LinkPolicy = {
  onOpenFile?: (path: string) => void;
  onOpenFileUrl?: (url: string) => void;
  onOpenImage?: (path: string) => void;
  onOpenFolder?: (path: string) => void;
  onOpenConversation?: (sessionId: string) => void;
  onOpenTutorial?: (tutorialPath: string) => void;
  onNavigate?: (url: string) => void;
  onBlocked?: (url: string, reason: BlockedReason) => void;
};

const REBEL_TUTORIAL_PREFIX = 'rebel://help/tutorials/';
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;
const FILE_EXTENSION_REGEX = /\.[A-Za-z0-9]+$/;
// Keep in sync with parseNavigationUrl() in src/shared/navigation/urlParser.ts.
// The canonical parser is desktop-only; mirroring its allowlist here lets the
// dispatcher reject obvious garbage before a host is even reached.
const KNOWN_REBEL_HOSTS = new Set([
  'settings',
  'sessions',
  'conversation',
  'library',
  'workspace',
  'space',
  'automations',
  'focus',
  'tasks',
  'team',
  'usecases',
  'insights',
  'media',
  'plugin',
  'feedback',
  'action',
]);
// Hosts whose canonical parser returns null without a first segment.
// 'conversation' and 'sessions' are intentionally NOT here — canonical parser
// treats empty as sessions-root navigation, so we keep that semantic.
const HOSTS_REQUIRING_FIRST_SEGMENT = new Set([
  'space',
  'insights',
  'media',
  'plugin',
  'action',
]);

const decodePath = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

function isValidRebelUrl(
  url: string,
): { valid: boolean; host?: string; firstSegment?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false };
  }

  if (parsed.protocol.toLowerCase() !== 'rebel:') {
    return { valid: false };
  }

  const host = parsed.hostname.toLowerCase();
  if (!KNOWN_REBEL_HOSTS.has(host)) {
    return { valid: false };
  }

  const path = parsed.pathname.startsWith('/')
    ? parsed.pathname.slice(1)
    : parsed.pathname;
  const segments = path.split('/').filter((segment) => segment.length > 0);
  const firstSegment = segments[0];

  if (HOSTS_REQUIRING_FIRST_SEGMENT.has(host) && !firstSegment) {
    return { valid: false };
  }

  return { valid: true, host, firstSegment };
}

export function createMarkdownLinkHandler(
  policy: LinkPolicy,
): (url: string) => LinkDispatchResult {
  const block = (url: string, reason: BlockedReason): LinkDispatchResult => {
    policy.onBlocked?.(url, reason);
    return { action: 'blocked', reason, url };
  };

  const dispatchPath = (path: string): LinkDispatchResult => {
    if (path.endsWith('/')) {
      policy.onOpenFolder?.(path);
      return { action: 'handled', kind: 'folder' };
    }

    if (isImagePath(path) && getFileExtension(path) !== 'svg') {
      policy.onOpenImage?.(path);
      return { action: 'handled', kind: 'image' };
    }

    policy.onOpenFile?.(path);
    return { action: 'handled', kind: 'file' };
  };

  return (url: string): LinkDispatchResult => {
    if (!url) {
      return { action: 'ignore' };
    }

    const lower = url.toLowerCase();

    if (lower.startsWith(REBEL_TUTORIAL_PREFIX)) {
      let filename = url.substring(REBEL_TUTORIAL_PREFIX.length);
      try {
        filename = decodeURIComponent(filename);
      } catch {
        return block(url, 'invalid-tutorial');
      }

      filename = stripQueryAndFragmentFromPath(filename);
      if (
        !filename ||
        filename.includes('/') ||
        filename.includes('\\') ||
        filename.includes('..') ||
        !/\.html?$/i.test(filename)
      ) {
        return block(url, 'invalid-tutorial');
      }

      policy.onOpenTutorial?.(`rebel-system/help-for-humans/tutorials/${filename}`);
      return { action: 'handled', kind: 'tutorial' };
    }

    if (lower.startsWith('rebel://')) {
      const { valid, host, firstSegment } = isValidRebelUrl(url);
      if (!valid) {
        return block(url, 'invalid-rebel-url');
      }

      if (host === 'conversation' || host === 'sessions') {
        // Empty first segment = sessions-root navigation (matches canonical parser).
        // Route through onNavigate so surfaces can decide what "sessions root" means
        // for their UX (desktop: sessions list; mobile: currently no-op + toast).
        if (!firstSegment) {
          policy.onNavigate?.(url);
          return { action: 'handled', kind: 'rebel-nav' };
        }

        // Malformed percent-encoding in the sessionId is unrecoverable — block
        // rather than silently dispatch a garbage id.
        let sessionId: string;
        try {
          sessionId = decodeURIComponent(firstSegment);
        } catch {
          return block(url, 'invalid-rebel-url');
        }
        policy.onOpenConversation?.(sessionId);
        return { action: 'handled', kind: 'conversation' };
      }

      // Stage H: `rebel://library/{path}` is the canonical form for
      // workspace-relative file references (replaces the legacy `library://`
      // protocol form). Route it through the same file/image/folder
      // dispatcher as the legacy form so clicks open the file in-place
      // rather than switching to the library surface via NavigationContext.
      // Empty first segment (`rebel://library/`) falls through to onNavigate
      // so the whole library surface opens — matches the original library
      // navigation semantics.
      if (host === 'library' && firstSegment) {
        const extractedPath = extractLibraryPath(url);
        const path = stripQueryAndFragmentFromPath(extractedPath ?? '');
        if (!path) {
          return block(url, 'empty-path');
        }
        return dispatchPath(path);
      }

      policy.onNavigate?.(url);
      return { action: 'handled', kind: 'rebel-nav' };
    }

    if (getLibraryProtocol(url)) {
      const extractedPath = extractLibraryPath(url);
      const path = stripQueryAndFragmentFromPath(extractedPath ?? '');
      if (!path) {
        return block(url, 'empty-path');
      }
      return dispatchPath(path);
    }

    if (parseFileUrl(url) !== null) {
      if (!policy.onOpenFileUrl) {
        return block(url, 'platform-unsupported');
      }

      policy.onOpenFileUrl(url);
      return { action: 'handled', kind: 'file' };
    }

    if (url.startsWith('//')) {
      return block(url, 'protocol-relative');
    }

    if (lower.startsWith('http://') || lower.startsWith('https://')) {
      return { action: 'open-external', url };
    }

    const strippedPath = stripQueryAndFragmentFromPath(url);
    const looksLikeFolder = strippedPath.endsWith('/');
    const looksLikeFile = FILE_EXTENSION_REGEX.test(strippedPath);
    const hasScheme = URL_SCHEME_REGEX.test(url) && !WINDOWS_DRIVE_PATH_REGEX.test(url);

    if ((looksLikeFolder || looksLikeFile) && !hasScheme) {
      return dispatchPath(decodePath(strippedPath));
    }

    if (hasScheme) {
      return block(url, 'unknown-scheme');
    }

    return { action: 'ignore' };
  };
}
