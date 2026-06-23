import { Children, isValidElement, memo, ReactNode, useState, useCallback, useEffect, useDeferredValue, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
// ESLINT-ALLOW-LIST NOTE: This file is on the allow-list in eslint.config.mjs
// for @typescript-eslint/no-restricted-imports (react-markdown). If you rename
// this file, update the allow-list in Stage F.
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { basename, dirname, join, isAbsolute } from 'pathe';
import { Lock, Globe, MessageSquare, ExternalLink, BookOpen, ChevronRight, Copy, Check } from 'lucide-react';
import { Tooltip } from '@renderer/components/ui/Tooltip';
import { ImageContextMenu } from './ImageContextMenu';
import { useImageContextMenu } from './useImageContextMenu';
import { LinkContextMenu, type LinkContextMenuTarget } from './LinkContextMenu';
import { remarkLibraryLinks, type RemarkLibraryLinksOptions } from './remarkLibraryLinks';
import { MediaEmbed, isEmbeddableMediaUrl } from './MediaEmbed';
import { rendererDesktopSpaceResolver } from '@renderer/contexts/desktopSpaceResolverRenderer';
import {
  createMarkdownLinkHandler,
  parseFileUrl,
  getLibraryProtocol,
  extractLibraryPath,
  parseCollapseBlock,
  isCollapseLanguage,
  convertHtmlDetailsToCollapse,
  preprocessMarkdownForRender,
  findBlockedUrlScheme,
  redactUrlForLogging,
} from '@rebel/shared';
import { classifyMarkdownUrl } from '@rebel/shared/utils/urlSchemePolicy';
import { formatLibraryUrl, parseNavigationUrl } from '@shared/navigation/urlParser';
import { resolveLink, toBestFileLink, type FileLinkKind } from '@core/navigation';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { useSettingsSafe } from '@renderer/features/settings';
import { useSpacesData } from '@renderer/hooks/useSpacesData';
import { getFilePrivacy, isImagePath, isVideoPath, getImageMimeType } from '@renderer/utils/documentUtils';
import { withRendererTimeout } from '@renderer/utils/withRendererTimeout';
import { showPathOpenFailureToast } from '@renderer/utils/pathOpenFailure';
import { captureRendererMessage } from '@renderer/src/sentry';
import { JsonDocumentView, isJsonLanguage, extractCodeText, isRenderableJsonObject } from './JsonDocumentView';
import { DocumentBlock } from './DocumentBlock';
import styles from './ToolResultImage.module.css';
import mediaStyles from './MediaEmbed.module.css';

const DOCUMENT_MIN_LENGTH = 200;
const MESSAGE_MAIN_MARKDOWN_URL_CONTEXT = { surface: 'message-main' } as const;

function isDocumentLanguage(className: string | undefined, textLength: number): boolean {
  if (textLength < DOCUMENT_MIN_LENGTH) return false;
  if (!className) return true;
  const tokens = className.toLowerCase().split(/\s+/);
  return (
    tokens.includes('language-text') ||
    tokens.includes('language-markdown') ||
    tokens.includes('language-md')
  );
}

/**
 * Cache for image data. Persists dimensions + mtimeMs to localStorage so they're
 * available across app restarts. Also caches loaded dataUrls in memory to prevent
 * flashing when virtualized list remounts components.
 *
 * Freshness contract (see docs-private/investigations/260519_stale_image_cache_after_agent_overwrite.md):
 * each cached entry stores the on-disk mtime that was observed when the data
 * URL was loaded. On `AutoLoadImage` mount with a cache hit, we paint the
 * cached data URL immediately (preserves Stage I7 anti-flash) and issue a
 * background `library:stat-file` IPC; if the on-disk mtime is newer than the
 * cached mtime, we invalidate the entry and let the subscriber-reset trigger
 * a fresh fetch. Path keys are canonicalised at the write boundary so
 * `./foo.png`, `foo.png`, and `foo\\png` map to the same entry.
 */
const IMAGE_DIMENSION_CACHE_KEY = 'rebel-image-dimensions-cache';
const imageDimensionCache = new Map<string, { width: number; height: number }>();
const imageMtimeCache = new Map<string, number>();
const imageSizeCache = new Map<string, number | null>();
const MAX_IMAGE_CACHE_ENTRIES = 50;
const MAX_IMAGE_CACHE_BYTES = 50 * 1024 * 1024;
const IMAGE_CACHE_EVICTION_WINDOW_MS = 5 * 60 * 1000;
const imageDataUrlCache = new Map<string, string>(); // In-memory only, not persisted
let imageDataUrlCacheTotalBytes = 0;
let imageDataUrlCacheEvictionsCumulative = 0;
const imageDataUrlCacheEvictionTimestamps: number[] = [];

function recordImageDataUrlCacheEviction(): void {
  imageDataUrlCacheEvictionsCumulative += 1;
  imageDataUrlCacheEvictionTimestamps.push(Date.now());
  pruneImageDataUrlCacheEvictions(Date.now());
}

function pruneImageDataUrlCacheEvictions(nowMs: number): void {
  const cutoffMs = nowMs - IMAGE_CACHE_EVICTION_WINDOW_MS;
  while (
    imageDataUrlCacheEvictionTimestamps.length > 0 &&
    imageDataUrlCacheEvictionTimestamps[0] < cutoffMs
  ) {
    imageDataUrlCacheEvictionTimestamps.shift();
  }
}
/**
 * Per-canonical-path generation token. Bumped on every cache invalidation so
 * in-flight shared promises can detect they were started under a now-stale
 * generation and refuse to persist their result or notify subscribers.
 */
const cacheGenerations = new Map<string, number>();
/**
 * Per-canonical-path count of shared promise bodies still capable of
 * completing. Pruning `cacheGenerations` is safe only when this count is
 * zero AND the cache has no entry AND no subscribers — otherwise a
 * pre-invalidation `generationAtStart = 0` could collide with the
 * post-delete default of `0` and a stale image would be written into the
 * cache by an outstanding promise.
 */
const inFlightCountByCanonical = new Map<string, number>();
/**
 * Mounted-instance reset callbacks keyed by canonical filePath. Fired on
 * invalidation so currently-rendered subscribers reset their local state and
 * re-issue a fetch — without this, currently-mounted components keep showing
 * the stale image until they unmount.
 */
const mountedImageSubscribers = new Map<string, Set<() => void>>();

/**
 * Canonicalise a workspace image path for cache-key purposes. Converts
 * backslashes to forward slashes and strips a single leading `./` segment so
 * that relative vs absolute and slash-form variants collapse to the same key.
 * Does NOT resolve absolute paths or normalise `..` segments — callers
 * already pass paths from a single rendering pass, so the goal here is
 * tolerance to common surface variations, not full path resolution.
 */
export function canonicalizeImagePath(filePath: string): string {
  if (!filePath) return filePath;
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Renderer leak diagnostic helper. Returns entry count and byte size
 * of the in-memory data URL cache. Entries are bounded by both count
 * and total byte budget.
 *
 * String `.length` returns UTF-16 code units; for ASCII/base64 content this
 * approximates byte count closely enough for diagnostic purposes.
 */
export const getImageDataUrlCacheStats = (): {
  entries: number;
  estimatedKB: number;
  totalBytes: number;
  maxBytes: number;
  evictionCount: number;
  evictionRate5m: number;
} => {
  pruneImageDataUrlCacheEvictions(Date.now());
  return {
    entries: imageDataUrlCache.size,
    estimatedKB: Math.round(imageDataUrlCacheTotalBytes / 1024),
    totalBytes: imageDataUrlCacheTotalBytes,
    maxBytes: MAX_IMAGE_CACHE_BYTES,
    evictionCount: imageDataUrlCacheEvictionsCumulative,
    evictionRate5m: imageDataUrlCacheEvictionTimestamps.length,
  };
};
type SharedImageFetchResult = {
  dataUrl: string;
  dimensions: { width: number; height: number };
  mtimeMs: number;
  size: number | null;
  /** True iff the shared promise observed a generation bump between start
   *  and completion. Subscribers must ignore stale results so an invalidated
   *  cache isn't reseeded with the pre-invalidation data. */
  stale: boolean;
};

type ReadFileBase64Response = {
  base64: string;
  mtimeMs: number;
  size: number;
};

function parseReadFileBase64Response(
  response: ReadFileBase64Response | string,
): { base64: string; mtimeMs: number; size: number | null } {
  if (typeof response === 'string') {
    // Backward-compatibility guard for stale test/mocked bridges. Production
    // now returns metadata in-band via the IPC contract.
    return { base64: response, mtimeMs: 0, size: null };
  }
  return {
    base64: response.base64,
    mtimeMs: response.mtimeMs,
    size: response.size,
  };
}

const inFlightImageRequests = new Map<string, Promise<SharedImageFetchResult>>();
const makeImageRequestKey = (filePath: string, documentPath: string | undefined) =>
  `${documentPath ?? ''}::${filePath}`;
// Decode timeout: 100× typical in-browser PNG decode (<100ms) × 100 for headroom.
// Without it, a pathological `Image` that never fires onload/onerror would pin
// the in-flight promise forever and hang every later subscriber for the same
// key. See docs/plans/260422_broken_image_followups_i6_i7.md Stage I7.
const IMAGE_DECODE_TIMEOUT_MS = 10_000;

// IPC timeout: bounds `window.libraryApi.readFileBase64` for AutoLoadImage so a
// main-side fs hang surfaces a recoverable error instead of pinning the shared
// in-flight promise forever. 15s matches the repo's cloud-fs timeout precedent
// in `src/core/utils/cloudStorageUtils.ts` and is far above a legitimate local
// 5MB PNG read (typically tens of ms). Does NOT cancel the underlying IPC —
// late settles are observed with a one-shot console.info (see late-settle
// observer in AutoLoadImage's shared promise body).
// See docs/plans/260423_i12_i14_i9_image_pipeline_hardening.md Stage I12.
const IMAGE_IPC_TIMEOUT_MS = 15_000;

/**
 * Typed error thrown by the AutoLoadImage shared-promise pipeline so failure
 * breadcrumbs can classify errors by code instead of parsing error messages
 * (which would silently break on i18n / copy tweaks). Non-image-pipeline
 * errors (e.g. ENOENT surfaced from the main handler, unexpected runtime
 * errors) reach the breadcrumbs as generic `Error` and get tagged as either
 * `code: 'workspace-escape'` (for pinned workspace-boundary strings) or
 * `code: 'unknown'` by `describeImageFailure`.
 */
export type ImagePipelineErrorCode =
  | 'workspace-escape'
  | 'ipc-timeout'
  | 'decode-timeout'
  | 'unknown';

type TimedImagePipelineErrorCode = Extract<ImagePipelineErrorCode, 'ipc-timeout' | 'decode-timeout'>;

class ImagePipelineError extends Error {
  readonly code: Exclude<ImagePipelineErrorCode, 'unknown'>;
  readonly timeoutMs: number;
  constructor(code: TimedImagePipelineErrorCode, timeoutMs: number, message: string) {
    super(message);
    this.name = 'ImagePipelineError';
    this.code = code;
    this.timeoutMs = timeoutMs;
  }
}

const IMAGE_ERROR_COPY: Record<ImagePipelineErrorCode, { title: string; helper?: string }> = {
  'workspace-escape': {
    title: "That image link points outside your workspace, so I can't show it here.",
    helper: "Ask me to save a copy in your workspace and I'll show it inline.",
  },
  'ipc-timeout': {
    title: "Couldn't reach the image. The connection timed out.",
    helper: 'Try opening the image again, or reload the conversation.',
  },
  'decode-timeout': {
    title: "Couldn't render that image. It might be unusually large or in a format I don't speak.",
    helper: 'Try opening it directly, or ask me to convert it to a standard format.',
  },
  unknown: {
    title: "Couldn't load the image.",
    helper: 'Open it directly to take a look.',
  },
};

// Desktop transcript image-pipeline only. Cloud/mobile have separate image surfaces;
// their image-failure UX is out of scope here. See planning doc § Cross-surface parity.
export const ImageError = ({ code }: { code: ImagePipelineErrorCode }) => {
  const copy = IMAGE_ERROR_COPY[code];
  return (
    <div
      style={{
        padding: '8px 12px',
        color: 'rgba(248, 113, 113, 0.9)',
        fontSize: '0.85rem',
        marginTop: '8px',
      }}
    >
      <div>{copy.title}</div>
      {copy.helper ? (
        <div style={{ marginTop: '2px' }}>{copy.helper}</div>
      ) : null}
    </div>
  );
};

const WORKSPACE_ESCAPE_ERROR_FRAGMENT = 'outside the workspace directory';

function classifyError(err: unknown): ImagePipelineErrorCode {
  if (err instanceof ImagePipelineError) {
    return err.code;
  }
  // Substring-match is safe because src/main/ipc/__tests__/libraryHandlers.errorMessageContract.test.ts pins the exact strings; future renames fail loudly together.
  // TODO(I1): switch to error-code matching once main-side error-code enrichment ships (docs/plans/260422_broken_image_followups_i6_i7.md).
  if (err instanceof Error && err.message.includes(WORKSPACE_ESCAPE_ERROR_FRAGMENT)) {
    return 'workspace-escape';
  }
  return 'unknown';
}

/**
 * Classify a shared-promise pipeline failure for breadcrumb tagging.
 * Timeout classes come from typed `ImagePipelineError`; workspace-escape is
 * detected via a pinned canonical message fragment until I1 ships typed codes.
 */
function describeImageFailure(err: unknown): { code: ImagePipelineErrorCode; timeoutMs: number | undefined } {
  const code = classifyError(err);
  const timeoutMs = err instanceof ImagePipelineError ? err.timeoutMs : undefined;
  return { code, timeoutMs };
}

/**
 * Singleton bridge from `library:changed` IPC events into the inline image
 * cache. Mounted lazily on the first `AutoLoadImage` instance so module-load
 * order in tests doesn't subscribe before mocks are wired in. When a write
 * path that does emit `library:changed` (Write/Edit, document editor,
 * cloud-sync) fires for a known image path, we invalidate that entry up
 * front — the mtime-based check on the next mount handles the remaining
 * paths that never emit (Bash, MCP, image-filtered watcher).
 */
let librarySubscriptionInstalled = false;
let unsubscribeLibraryChanged: (() => void) | null = null;
type LibraryChangedEvent = {
  timestamp?: number;
  affectsTree?: boolean;
  writerKind?: 'editor' | 'agent' | 'file-watcher' | 'cloud-sync';
  changedPath?: string;
};
type LibraryChangedSubscribe = (callback: (event: LibraryChangedEvent) => void) => () => void;
function ensureLibraryChangedSubscriptionMounted(): void {
  if (librarySubscriptionInstalled) return;
  librarySubscriptionInstalled = true;
  if (typeof window === 'undefined') return;
  const api = (window as unknown as { api?: { onLibraryChanged?: LibraryChangedSubscribe } }).api;
  if (typeof api?.onLibraryChanged !== 'function') {
    // Renderer harness hasn't wired the bridge — leave the flag set so we
    // don't re-check on every mount. Production preload always exposes it.
    return;
  }
  const unsubscribe = api.onLibraryChanged((event: LibraryChangedEvent) => {
    if (event && typeof event.changedPath === 'string' && event.changedPath.length > 0) {
      invalidateImageCacheEntry(event.changedPath);
    }
  });
  unsubscribeLibraryChanged = typeof unsubscribe === 'function' ? unsubscribe : null;
}

/** Test-only reset hook for the library:changed subscription. */
export function __resetImageLibraryChangedSubscriptionForTests(): void {
  unsubscribeLibraryChanged?.();
  unsubscribeLibraryChanged = null;
  librarySubscriptionInstalled = false;
}

function decodeImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let settled = false;
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
      // Sever the src so the browser can release the decoded bitmap. Large
      // base64 data URLs can pin non-trivial memory while an Image element
      // still references them.
      try {
        img.src = '';
      } catch {
        // Defensive — some jsdom/happy-dom versions may throw on reassignment.
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ImagePipelineError(
        'decode-timeout',
        IMAGE_DECODE_TIMEOUT_MS,
        `Image decode timed out after ${IMAGE_DECODE_TIMEOUT_MS}ms`,
      ));
    }, IMAGE_DECODE_TIMEOUT_MS);
    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      cleanup();
      resolve({ width, height });
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error('Failed to decode image'));
    };
    img.src = dataUrl;
  });
}

type StoredDimensionEntry = {
  width: number;
  height: number;
  // Optional for backward compatibility with entries saved before the freshness
  // contract shipped. Missing mtime is treated as 0 below so the next stat
  // observation overwrites the entry with the on-disk mtime. `size` is
  // captured alongside `mtimeMs` to disambiguate same-second overwrites on
  // filesystems with 1s mtime resolution.
  mtimeMs?: number;
  size?: number | null;
};

// Load dimension cache from localStorage on module init
try {
  const stored = localStorage.getItem(IMAGE_DIMENSION_CACHE_KEY);
  if (stored) {
    const parsed = JSON.parse(stored) as Record<string, StoredDimensionEntry>;
    Object.entries(parsed).forEach(([key, value]) => {
      if (!value || typeof value !== 'object') return;
      const canonical = canonicalizeImagePath(key);
      imageDimensionCache.set(canonical, { width: value.width, height: value.height });
      if (typeof value.mtimeMs === 'number') {
        imageMtimeCache.set(canonical, value.mtimeMs);
      }
      if (typeof value.size === 'number' || value.size === null) {
        imageSizeCache.set(canonical, value.size);
      }
    });
  }
} catch {
  // Ignore parse errors
}

const persistDimensionCache = (): void => {
  try {
    const obj: Record<string, StoredDimensionEntry> = {};
    imageDimensionCache.forEach((v, k) => {
      const mtimeMs = imageMtimeCache.get(k);
      const size = imageSizeCache.get(k);
      const entry: StoredDimensionEntry = { ...v };
      if (typeof mtimeMs === 'number') entry.mtimeMs = mtimeMs;
      if (size !== undefined) entry.size = size;
      obj[k] = entry;
    });
    localStorage.setItem(IMAGE_DIMENSION_CACHE_KEY, JSON.stringify(obj));
  } catch {
    // Ignore storage errors
  }
};

const estimateImageDataUrlBytes = (dataUrl: string): number => dataUrl.length;

const removeImageCacheEntry = (
  canonical: string,
  options: { countEviction?: boolean } = {},
): { hadDataUrl: boolean; hadMtime: boolean; hadSize: boolean; hadDims: boolean } => {
  const existingDataUrl = imageDataUrlCache.get(canonical);
  if (existingDataUrl !== undefined) {
    imageDataUrlCache.delete(canonical);
    imageDataUrlCacheTotalBytes = Math.max(
      0,
      imageDataUrlCacheTotalBytes - estimateImageDataUrlBytes(existingDataUrl),
    );
    if (options.countEviction) {
      recordImageDataUrlCacheEviction();
    }
  }

  const hadMtime = imageMtimeCache.delete(canonical);
  const hadSize = imageSizeCache.delete(canonical);
  const hadDims = imageDimensionCache.delete(canonical);
  pruneCacheGenerationsIfDormant(canonical);

  return {
    hadDataUrl: existingDataUrl !== undefined,
    hadMtime,
    hadSize,
    hadDims,
  };
};

const saveToCache = (
  filePath: string,
  dimensions: { width: number; height: number },
  dataUrl: string,
  mtimeMs: number,
  size: number | null,
) => {
  const canonical = canonicalizeImagePath(filePath);
  const entryBytes = estimateImageDataUrlBytes(dataUrl);
  let didChangeDimensionCache = false;

  if (imageDataUrlCache.has(canonical)) {
    const removed = removeImageCacheEntry(canonical);
    didChangeDimensionCache = didChangeDimensionCache || removed.hadDims;
  }

  if (entryBytes > MAX_IMAGE_CACHE_BYTES) {
    if (didChangeDimensionCache) {
      persistDimensionCache();
    }
    return;
  }

  while (
    imageDataUrlCache.size > 0 &&
    (
      imageDataUrlCache.size >= MAX_IMAGE_CACHE_ENTRIES ||
      imageDataUrlCacheTotalBytes + entryBytes > MAX_IMAGE_CACHE_BYTES
    )
  ) {
    const firstKey = imageDataUrlCache.keys().next().value;
    if (firstKey) {
      const removed = removeImageCacheEntry(firstKey, { countEviction: true });
      didChangeDimensionCache = didChangeDimensionCache || removed.hadDims;
    }
  }

  if (
    imageDataUrlCache.size >= MAX_IMAGE_CACHE_ENTRIES ||
    imageDataUrlCacheTotalBytes + entryBytes > MAX_IMAGE_CACHE_BYTES
  ) {
    if (didChangeDimensionCache) {
      persistDimensionCache();
    }
    return;
  }

  imageDimensionCache.set(canonical, dimensions);
  imageDataUrlCache.set(canonical, dataUrl);
  imageDataUrlCacheTotalBytes += entryBytes;
  imageMtimeCache.set(canonical, mtimeMs);
  imageSizeCache.set(canonical, size);
  persistDimensionCache();
};

const getCachedImage = (
  filePath: string,
): {
  dimensions: { width: number; height: number };
  dataUrl: string;
  mtimeMs: number;
  size: number | null;
} | null => {
  const canonical = canonicalizeImagePath(filePath);
  const dims = imageDimensionCache.get(canonical);
  const dataUrl = imageDataUrlCache.get(canonical);
  const mtimeMs = imageMtimeCache.get(canonical) ?? 0;
  const size = imageSizeCache.get(canonical) ?? null;
  if (dims && dataUrl) {
    return { dimensions: dims, dataUrl, mtimeMs, size };
  }
  return null;
};

const getCachedDimensions = (filePath: string): { width: number; height: number } | null => {
  const canonical = canonicalizeImagePath(filePath);
  return imageDimensionCache.get(canonical) ?? null;
};

/**
 * Invalidate the cached entry for `filePath`. Bumps the per-key generation so
 * any in-flight shared promise drops its result rather than warming the cache
 * with the now-stale image; clears the in-flight registry so the next
 * subscriber issues a fresh fetch; and fires any mounted subscribers' reset
 * callbacks so already-rendered components re-fetch instead of continuing to
 * display the stale image until they unmount.
 */
export function invalidateImageCacheEntry(filePath: string): void {
  if (!filePath) return;
  const canonical = canonicalizeImagePath(filePath);

  cacheGenerations.set(canonical, (cacheGenerations.get(canonical) ?? 0) + 1);

  const removed = removeImageCacheEntry(canonical);
  if (removed.hadDims) {
    persistDimensionCache();
  }

  // Drop any in-flight entries whose target path canonicalises to the same
  // key, regardless of which documentPath they were issued under.
  for (const key of Array.from(inFlightImageRequests.keys())) {
    const sepIndex = key.indexOf('::');
    if (sepIndex < 0) continue;
    const filePart = key.slice(sepIndex + 2);
    if (canonicalizeImagePath(filePart) === canonical) {
      inFlightImageRequests.delete(key);
    }
  }

  const subs = mountedImageSubscribers.get(canonical);
  if (subs && subs.size > 0) {
    for (const reset of Array.from(subs)) {
      try {
        reset();
      } catch {
        // Defensive — a buggy subscriber must not stop us notifying the rest.
      }
    }
  }

  pruneCacheGenerationsIfDormant(canonical);
}

/**
 * Drop the per-canonical generation token when nothing can still reference
 * it: no cached entry, no mounted subscriber, no in-flight shared promise
 * whose `generationAtStart` could collide with the post-delete default of
 * `0`. The third condition is essential: pruning while a stale in-flight
 * promise was started at gen 0 would let it pass the freshness check (its
 * captured `0` would match the post-delete `?? 0`) and reseed the cache
 * with pre-invalidation data.
 */
function pruneCacheGenerationsIfDormant(canonical: string): void {
  if (imageDataUrlCache.has(canonical)) return;
  const subs = mountedImageSubscribers.get(canonical);
  if (subs && subs.size > 0) return;
  const inFlightCount = inFlightCountByCanonical.get(canonical) ?? 0;
  if (inFlightCount > 0) return;
  cacheGenerations.delete(canonical);
}


/**
 * Component that auto-loads a local image file and displays it inline.
 * Uses cached dimensions and dataUrl when available to prevent layout shift
 * and flashing when virtualized list remounts components.
 * Clicking expands to full-size viewer.
 */
const AutoLoadImage = ({ 
  filePath, 
  alt, 
  onExpand,
  onContextMenu,
  documentPath,
}: { 
  filePath: string; 
  alt: string; 
  onExpand: (path: string) => void;
  onContextMenu?: (event: React.MouseEvent, dataUrl: string | null, filePath: string) => void;
  /** Path to the document containing this image reference. Used to resolve relative paths. */
  documentPath?: string;
}) => {
  // Check cache immediately for both dimensions and dataUrl (before any async work)
  const cached = getCachedImage(filePath);
  const cachedDims = cached?.dimensions ?? getCachedDimensions(filePath);

  const [src, setSrc] = useState<string | null>(cached?.dataUrl ?? null);
  const [errorCode, setErrorCode] = useState<ImagePipelineErrorCode | null>(null);
  const [loading, setLoading] = useState(!cached?.dataUrl);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(cachedDims);
  // Bumped by `reset()` so the fetch effect re-runs even when invalidation
  // happens mid-load and every other state value already matches what reset
  // would assign (e.g. src=null, loading=true). Without this token React 18
  // bails out on the no-op setState calls, the fetch effect dependency
  // array doesn't change, and the component stays stuck in
  // `src=null, loading=true` indefinitely after the in-flight stale result
  // is dropped. See `docs-private/investigations/260519_stale_image_cache_after_agent_overwrite.md`.
  const [forceRefreshCounter, setForceRefreshCounter] = useState(0);

  // Register a reset callback so `invalidateImageCacheEntry` can force this
  // mounted instance to drop its locally-held cached image and re-fetch. The
  // canonical-path key matches the canonicalisation done at write time so
  // ./foo.png and foo.png notify the same subscriber set.
  useEffect(() => {
    const canonical = canonicalizeImagePath(filePath);
    const reset = () => {
      setSrc(null);
      setDimensions(null);
      setErrorCode(null);
      setLoading(true);
      setForceRefreshCounter((n) => n + 1);
    };
    let subs = mountedImageSubscribers.get(canonical);
    if (!subs) {
      subs = new Set();
      mountedImageSubscribers.set(canonical, subs);
    }
    subs.add(reset);
    return () => {
      const current = mountedImageSubscribers.get(canonical);
      if (!current) return;
      current.delete(reset);
      if (current.size === 0) {
        mountedImageSubscribers.delete(canonical);
      }
    };
  }, [filePath]);

  // Lazy module-level subscription bridge: install on first mount so the
  // `library:changed` IPC bus invalidates the inline cache for any path the
  // user's other tools modify. Subscription is idempotent across mounts.
  useEffect(() => {
    ensureLibraryChangedSubscriptionMounted();
  }, []);

  // Background freshness probe: when a cache HIT paints immediately, issue
  // a lightweight stat-file IPC and invalidate the entry if the on-disk
  // mtime is newer than what we cached. The diagnosis doc captures why
  // event-only invalidation is insufficient — Bash and MCP write paths
  // never emit `library:changed` for binary files.
  //
  // The probe runs at most once per mount, and ONLY when the initial render
  // observed a cache hit. After a cache-miss load, the shared promise body
  // already captured the on-disk mtime alongside the bytes, so re-probing
  // would be redundant and risk a spurious stale-classification race.
  const probeShouldRunRef = useRef<boolean>(Boolean(cached?.dataUrl));
  useEffect(() => {
    if (!src) return;
    if (!probeShouldRunRef.current) return;
    probeShouldRunRef.current = false;
    const statApi = (window as { libraryApi?: { statFile?: (req: unknown) => Promise<{ exists: boolean; mtimeMs: number | null; size: number | null }> } }).libraryApi?.statFile;
    if (typeof statApi !== 'function') return;
    let cancelled = false;
    const request = documentPath ? { target: filePath, basePath: documentPath } : filePath;
    // Bound the stat IPC with the same 15s timeout as the read IPC. Without
    // this, a hanging `library:stat-file` would keep the cached render in
    // place indefinitely while the user sees stale pixels — and on the
    // cache-miss code path, `Promise.all([statPromise, readPromise])` would
    // never settle even if the read timed out.
    withRendererTimeout(statApi(request), {
      timeoutMs: IMAGE_IPC_TIMEOUT_MS,
      errorFactory: (ms) => new Error(`library:stat-file timed out after ${ms}ms`),
      onLateSettle: (outcome) => {
        if (outcome.kind === 'success') {
          // eslint-disable-next-line no-console -- renderer late-settle observability hook; captured via main-process `console-message` diagnostics (see main/index.ts), no renderer-logger surface available
          console.info(
            '[Renderer] AutoLoadImage stat-file IPC late success (discarded after timeout)',
            { filePath, documentPath, code: 'stat-file-late-success' },
          );
        } else {
          // eslint-disable-next-line no-console -- renderer late-settle observability hook; captured via main-process `console-message` diagnostics (see main/index.ts), no renderer-logger surface available
          console.info(
            '[Renderer] AutoLoadImage stat-file IPC late error (discarded after timeout)',
            {
              filePath,
              documentPath,
              code: 'stat-file-late-error',
              message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
            },
          );
        }
      },
    })
      .then((result) => {
        if (cancelled) return;
        if (!result?.exists) return;
        if (typeof result.mtimeMs !== 'number') return;
        const canonical = canonicalizeImagePath(filePath);
        const cachedMtime = imageMtimeCache.get(canonical) ?? 0;
        const cachedSize = imageSizeCache.get(canonical) ?? null;
        const newerMtime = result.mtimeMs > cachedMtime;
        // Same-second overwrite catcher: when the filesystem advertises the
        // same mtime as our cache but the file size has changed, treat it as
        // an overwrite. Both sides must be non-null to make the comparison
        // meaningful (a missing cached size predates this contract).
        const sameMtimeDifferentSize =
          result.mtimeMs === cachedMtime
          && typeof result.size === 'number'
          && typeof cachedSize === 'number'
          && result.size !== cachedSize;
        if (newerMtime || sameMtimeDifferentSize) {
          invalidateImageCacheEntry(filePath);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Stat failure (including timeout) is non-fatal — we already painted
        // the cached image. Skip the probe rather than blowing up the render.
        // eslint-disable-next-line no-console -- renderer non-fatal probe failure observability hook; captured via main-process `console-message` diagnostics (see main/index.ts), no renderer-logger surface available
        console.info(
          '[Renderer] AutoLoadImage stat-file probe failed (cache freshness check skipped)',
          {
            filePath,
            documentPath,
            code: 'stat-file-error',
            message: err instanceof Error ? err.message : String(err),
          },
        );
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, src, documentPath]);

  useEffect(() => {
    // Skip loading if we already have cached data
    if (src) return;

    let cancelled = false;
    setLoading(true);
    setErrorCode(null);

    // Use object format with basePath when documentPath is provided (enables relative path resolution)
    const request = documentPath ? { target: filePath, basePath: documentPath } : filePath;
    const key = makeImageRequestKey(filePath, documentPath);
    const existingRequest = inFlightImageRequests.get(key);
    const sharedPromise = existingRequest ?? (() => {
      // The shared promise wraps the FULL pipeline: IPC → decode → saveToCache.
      // By placing saveToCache INSIDE the shared promise body, the positive
      // cache is warmed regardless of subscriber lifecycle (fixes the
      // cache-warming bug where `if (cancelled) return` inside img.onload
      // skipped saveToCache when the sole subscriber unmounted between IPC
      // resolve and Image.onload). See Stage I7 of
      // docs/plans/260422_broken_image_followups_i6_i7.md.
      const canonicalForGen = canonicalizeImagePath(filePath);
      const generationAtStart = cacheGenerations.get(canonicalForGen) ?? 0;
      const promise = (async (): Promise<SharedImageFetchResult> => {
        // I12: Bound the IPC leg with a 15s timeout. Without this, a
        // pathological main-side hang would pin the shared promise forever
        // and starve every later subscriber on the same key. The late-settle
        // observer closes the silent-failure surface where a late successful
        // IPC response would otherwise be silently discarded.
        //
        // DI-A (2026-04-27): Race + late-settle wiring lives in the shared
        // `withRendererTimeout` utility. Logging shape, code values, and the
        // typed `ImagePipelineError` are unchanged — T21/T21a/T21b in
        // MessageMarkdown.test.tsx are the contract over this adoption.
        // See docs/plans/260423_i12_i14_i9_image_pipeline_hardening.md and
        //     docs/plans/260427_di_a_di_c_renderer_timeout_utility_and_telemetry.md.
        // Cache-miss path does one IPC read and stores real on-disk metadata
        // from that same read. This preserves same-mtime+size freshness checks
        // without reintroducing a second IPC.
        const readPromise = withRendererTimeout(
          window.libraryApi.readFileBase64(request),
          {
            timeoutMs: IMAGE_IPC_TIMEOUT_MS,
            errorFactory: (ms) => new ImagePipelineError(
              'ipc-timeout',
              ms,
              `Image file read timed out after ${ms}ms`,
            ),
            onLateSettle: (outcome) => {
              if (outcome.kind === 'success') {
                // Info-level: not a warning (system working as designed);
                // just an observability hook captured via `console-message`
                // in main/index.ts under diagnostics.
                // eslint-disable-next-line no-console -- intentional: image freshness/timeout diagnostics are consumed by the renderer console-message bridge
                console.info(
                  '[Renderer] AutoLoadImage IPC late success (discarded after timeout)',
                  { filePath, documentPath, code: 'ipc-late-success' },
                );
              } else {
                // eslint-disable-next-line no-console -- intentional: image freshness/timeout diagnostics are consumed by the renderer console-message bridge
                console.info(
                  '[Renderer] AutoLoadImage IPC late error (discarded after timeout)',
                  {
                    filePath,
                    documentPath,
                    code: 'ipc-late-error',
                    message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
                  },
                );
              }
            },
          },
        );
        const readResult = parseReadFileBase64Response(await readPromise);
        const base64Data = readResult.base64;
        const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
        const mimeTypes: Record<string, string> = {
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          gif: 'image/gif',
          webp: 'image/webp',
          svg: 'image/svg+xml',
        };
        const mimeType = mimeTypes[ext] ?? 'image/png';
        const dataUrl = `data:${mimeType};base64,${base64Data}`;
        const dims = await decodeImageDimensions(dataUrl);
        const mtimeMs = readResult.mtimeMs;
        const size = readResult.size;
        const currentGeneration = cacheGenerations.get(canonicalForGen) ?? 0;
        if (currentGeneration !== generationAtStart) {
          // An invalidation fired while we were in-flight. Drop this result
          // so the cache isn't reseeded with pre-invalidation data and
          // subscribers don't paint stale pixels. The subscriber reset
          // callbacks fired by `invalidateImageCacheEntry` already drove
          // mounted instances back to a loading state; the next mount will
          // start a fresh shared promise.
          return { dataUrl, dimensions: dims, mtimeMs, size, stale: true };
        }
        saveToCache(filePath, dims, dataUrl, mtimeMs, size);
        return { dataUrl, dimensions: dims, mtimeMs, size, stale: false };
      })();
      inFlightImageRequests.set(key, promise);
      inFlightCountByCanonical.set(
        canonicalForGen,
        (inFlightCountByCanonical.get(canonicalForGen) ?? 0) + 1,
      );
      const clearInFlightRequest = () => {
        if (inFlightImageRequests.get(key) === promise) {
          inFlightImageRequests.delete(key);
        }
      };
      const decrementInFlightCount = () => {
        const next = (inFlightCountByCanonical.get(canonicalForGen) ?? 1) - 1;
        if (next <= 0) {
          inFlightCountByCanonical.delete(canonicalForGen);
          // Now that this shared promise body has settled, the gen token
          // may be safe to prune (F5). Defer the actual check to the
          // helper so the criteria stay single-sourced.
          pruneCacheGenerationsIfDormant(canonicalForGen);
        } else {
          inFlightCountByCanonical.set(canonicalForGen, next);
        }
      };
      // CONTRACT: Owner-of-flight breadcrumb counts IN-FLIGHT FAILURES (once
      // per failed shared promise, regardless of subscriber lifecycle). The
      // subscriber breadcrumb below counts USER-VISIBLE FAILURES (once per
      // mounted subscriber that was still alive at rejection time). These two
      // measure different things; DO NOT deduplicate them. `code` classifies
      // the failure kind: 'workspace-escape' / 'ipc-timeout' / 'decode-timeout' / 'unknown'.
      void promise.catch((err) => {
        const { code, timeoutMs } = describeImageFailure(err);
        console.warn('[Renderer] AutoLoadImage in-flight failed', {
          filePath,
          documentPath,
          message: err instanceof Error ? err.message : String(err),
          code,
          timeoutMs,
        });
        // DI-C (2026-04-27): Emit a discrete Sentry event ONLY for ipc-timeout
        // (the I12 renderer-side bound). This lets us answer from production
        // telemetry whether the 15s renderer timer is actually firing — which
        // would indicate a real main-side hang in `library:read-file-base64`
        // worth investigating, vs. pure insurance.
        //
        // Emitted at the OWNER-OF-FLIGHT site only, not the subscriber site
        // below — multi-subscriber scenarios (T21b) must not multiply the
        // event count.
        //
        // PII: extras are derived/non-PII only. `redactUrlForLogging` strips
        // query strings but NOT user filenames or relative path segments, and
        // the Sentry `beforeBreadcrumb`/`beforeSend` redactor also only
        // strips known-sensitive substrings. Keep raw paths out of the event.
        // See docs/plans/260427_di_a_di_c_renderer_timeout_utility_and_telemetry.md.
        // 'workspace-escape' = user-behavior, 'decode-timeout' = file content,
        // 'unknown' = already breadcrumbed via DI-C — do not capture.
        if (code === 'ipc-timeout') {
          captureRendererMessage('AutoLoadImage IPC timeout', {
            level: 'warning',
            tags: {
              source: 'AutoLoadImage',
              code: 'ipc-timeout',
            },
            extra: {
              timeoutMs,
              fileExtension: filePath.split('.').pop()?.toLowerCase() ?? null,
              hasDocumentPath: Boolean(documentPath),
            },
          });
        }
      });
      void promise.then(clearInFlightRequest, clearInFlightRequest);
      void promise.then(decrementInFlightCount, decrementInFlightCount);
      return promise;
    })();

    sharedPromise
      .then((result) => {
        if (cancelled) return;
        if (result.stale) {
          // Invalidation fired mid-flight. Subscribers were already reset by
          // `invalidateImageCacheEntry` (which clears src → triggers a fresh
          // fetch in the cache-miss effect below). Don't paint the stale
          // image on top of that reset.
          return;
        }
        setDimensions(result.dimensions);
        setSrc(result.dataUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        // Subscriber-facing breadcrumb (distinct from the owner-of-flight one
        // attached at promise creation). Retains Stage 1 T5 semantics;
        // `code` added in Stage I12 for cleaner log filtering.
        const { code, timeoutMs } = describeImageFailure(err);
        console.warn('[Renderer] AutoLoadImage failed', {
          filePath,
          documentPath,
          message: err instanceof Error ? err.message : String(err),
          code,
          timeoutMs,
        });
        setErrorCode(code);
        setLoading(false);
      });

    return () => { cancelled = true; };
    // `forceRefreshCounter` is intentionally in the dep array: when
    // `invalidateImageCacheEntry` fires while the shared promise is still
    // pending, every other state value already matches what `reset()`
    // assigns (src=null, loading=true) and React 18 bails out on the
    // resulting no-op setState calls. The counter forces this effect to
    // re-run so a fresh shared promise is created after the stale result is
    // dropped — without it, the component would stay stuck at
    // `src=null, loading=true` until remount.
  }, [filePath, src, documentPath, forceRefreshCounter]);

  // Calculate display dimensions (max 100% width, max 400px height, maintain aspect ratio)
  const getDisplayStyle = (): React.CSSProperties => {
    if (!dimensions) return { maxWidth: '100%', maxHeight: '400px', minHeight: '100px' };
    
    const maxWidth = 600; // reasonable max for inline
    const maxHeight = 400;
    const { width, height } = dimensions;
    const aspectRatio = width / height;
    
    let displayWidth = Math.min(width, maxWidth);
    let displayHeight = displayWidth / aspectRatio;
    
    if (displayHeight > maxHeight) {
      displayHeight = maxHeight;
      displayWidth = displayHeight * aspectRatio;
    }
    
    return {
      width: displayWidth,
      height: displayHeight,
      maxWidth: '100%'
    };
  };

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu?.(event, src, filePath);
  }, [onContextMenu, src, filePath]);

  // Prevent focus on right-click to avoid browser scroll-into-view behavior
  // which causes jumps in virtualized lists using transform positioning
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button === 2) {
      event.preventDefault();
    }
  }, []);

  if (errorCode) {
    return <ImageError code={errorCode} />;
  }

  const displayStyle = getDisplayStyle();
  const hasCachedSize = dimensions !== null;

  return (
    <button
      type="button"
      onClick={() => !loading && onExpand(filePath)}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
      disabled={loading}
      style={{
        display: 'block',
        background: loading ? 'rgba(30, 41, 59, 0.3)' : 'none',
        border: 'none',
        padding: 0,
        cursor: loading ? 'default' : 'pointer',
        borderRadius: '8px',
        overflow: 'hidden',
        marginTop: '12px',
        ...displayStyle
      }}
      aria-label={loading ? 'Loading image...' : `${alt} (click to expand)`}
    >
      {src ? (
        <img 
          src={src} 
          alt={alt}
          style={{ 
            width: '100%',
            height: '100%',
            borderRadius: '8px',
            display: 'block',
            objectFit: 'contain'
          }} 
        />
      ) : (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'rgba(148, 163, 184, 0.6)',
          fontSize: '0.85rem',
          background: hasCachedSize ? 'rgba(30, 41, 59, 0.2)' : undefined
        }}>
          {hasCachedSize ? '' : 'Loading...'}
        </div>
      )}
    </button>
  );
};

/**
 * Converts a workspace-relative or absolute file path to a rebel-media:// URL
 * for streaming video/audio files via the custom protocol handler.
 *
 * URL shape: `rebel-media://local/<encoded-absolute-path>`. See
 * `getMediaProtocolUrl` in document-editor/utils/protocolUrls.ts for the
 * detailed rationale on why the sentinel host `local` is required (Chromium's
 * standard-scheme URL parser rejects empty authority outright, and any real
 * path segment in the host slot gets lowercased / silently dropped).
 */
const toRebelMediaUrl = (filePath: string, coreDirectory?: string): string => {
  let absolutePath = filePath;
  if (!isAbsolute(filePath) && coreDirectory) {
    absolutePath = join(coreDirectory, filePath);
  }
  const normalized = absolutePath.replace(/\\/g, '/');
  return `rebel-media://local/${encodeURIComponent(normalized)}`;
};

/**
 * Component that renders an inline video player for local video files.
 * Uses rebel-media:// protocol for streaming with byte-range support.
 *
 * Pre-checks file existence with a lightweight range request before mounting
 * the <video> element. This prevents empty 16:9 containers from flickering
 * when many video paths in a conversation point to files that don't exist.
 */
const AutoLoadVideo = ({
  filePath,
  coreDirectory,
}: {
  filePath: string;
  coreDirectory?: string;
}) => {
  const [status, setStatus] = useState<'checking' | 'ready' | 'missing' | 'playback-error'>('checking');
  const mediaUrl = toRebelMediaUrl(filePath, coreDirectory);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    fetch(mediaUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    })
      .then(response => {
        if (cancelled) return;
        setStatus(response.ok || response.status === 206 ? 'ready' : 'missing');
      })
      .catch(() => {
        if (!cancelled) setStatus('missing');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [mediaUrl]);

  const handlePlaybackError = useCallback(() => {
    setStatus('playback-error');
  }, []);

  if (status === 'missing') {
    return (
      <a
        href={filePath}
        className={mediaStyles.fallbackLink}
        onClick={(e) => {
          e.preventDefault();
          // FOX-3422: intentionally not surfacing a failure toast here.
          // AutoLoadVideo is a standalone leaf component with no showToast in
          // scope (threading it through the markdown render map would be a much
          // larger change), and this link only renders when the media is ALREADY
          // known-missing — a reveal failure is the expected case, not a surprise.
          void window.appApi.revealPath(filePath);
        }}
      >
        {filePath}
      </a>
    );
  }

  if (status === 'playback-error') {
    return (
      <span className={mediaStyles.fallbackLink}>
        Can&rsquo;t play {basename(filePath)} in-app.{' '}
        <a
          href={filePath}
          onClick={(e) => {
            e.preventDefault();
            void window.appApi.openPath(filePath);
          }}
        >
          Open in default app
        </a>
      </span>
    );
  }

  if (status === 'checking') {
    return (
      <span className={mediaStyles.fallbackLink} style={{ opacity: 0.5 }}>
        ▶ {basename(filePath)}
      </span>
    );
  }

  return (
    <div className={mediaStyles.container}>
      <div className={mediaStyles.playerWrapper}>
        <video
          src={mediaUrl}
          controls
          playsInline
          preload="metadata"
          onError={handlePlaybackError}
          className={mediaStyles.player}
          style={{ width: '100%', height: '100%' }}
        />
      </div>
    </div>
  );
};

interface MessageMarkdownProps {
  content: string;
  onOpenFile?: (filePath: string) => void;
  /** Callback when user clicks a workspace://folder/ link (folder path with trailing slash) */
  onOpenFolder?: (folderPath: string) => void;
  /** Callback when user clicks a rebel://conversation/{id} link */
  onOpenConversation?: (sessionId: string) => void;
  /** Callback when user clicks any rebel:// URL (for general app navigation) */
  onNavigate?: (url: string) => void;
  /** Callback when user clicks a rebel://help/tutorials/{filename} link */
  onOpenTutorial?: (tutorialPath: string) => void;
  /** Optional toast callback for user feedback */
  showToast?: (options: { title: string }) => void;
  /** Path to the document being rendered. Used to resolve relative image paths. */
  documentPath?: string;
  /** Core directory path for resolving full file paths in context menu */
  coreDirectory?: string;
  /** Callback to open a file/folder in the Library view */
  onOpenInLibrary?: (filePath: string, isFolder: boolean) => void;
}

// ============================================================================
// Regex constants for convertFilePathsToLinks - memoized at module scope
// to avoid recreation on every function call
// ============================================================================

/** Matches file paths in backticks like `./path/file.md` or `src/file.ts` or `UX Audits/file.md` */
const BACKTICK_FILE_PATH_REGEX =
  /`((?:\/|\.\/|\.\.\/|[a-zA-Z0-9_\- ]+\/)[^`\n]+(?:\.[a-zA-Z0-9]{2,6}|\/))`/g;

/** Matches raw rebel://conversation/{id} URLs not already in markdown links */
const REBEL_CONVERSATION_REGEX = /(?<!\]\()(?<!\[)rebel:\/\/conversation\/([a-zA-Z0-9_-]+)/g;

/**
 * Matches bare absolute file paths on their own line (not inside markdown links).
 * Unix: /Users/.../file.ext  Windows: C:\Users\...\file.ext or C:/Users/.../file.ext
 * Requires a file extension to avoid matching plain text like "/etc" or directory-only paths.
 * Lookbehinds reject paths already inside []() link syntax.
 */
const BARE_ABSOLUTE_PATH_REGEX = /(?<!\]\()(?<!\[)(?:^|(?<=\n)|(?<=\s))(\/?(?:\/[^\s*?<>|"]+|[A-Za-z]:[/\\][^\s*?<>|"]+)\.[a-zA-Z0-9]{1,10})(?=[)\s.,;:!?]|$)/gm;

function deriveWorkspaceRoots(coreDirectory: string | undefined, spaces: readonly SpaceInfo[]): string[] {
  if (!coreDirectory) return [];
  const roots = new Set<string>([coreDirectory.replace(/[/\\]$/, '')]);
  for (const space of spaces) {
    const absolutePath = space.absolutePath.replace(/[/\\]$/, '');
    if (absolutePath) {
      roots.add(absolutePath);
      roots.add(dirname(absolutePath).replace(/[/\\]$/, '') || coreDirectory);
    }
    if (space.sourcePath) {
      const sourcePath = space.sourcePath.replace(/[/\\]$/, '');
      if (sourcePath) {
        roots.add(sourcePath);
        roots.add(dirname(sourcePath).replace(/[/\\]$/, '') || coreDirectory);
      }
    }
  }
  return Array.from(roots);
}

/**
 * Thin compatibility shim for callers that care about the Spaces readiness
 * signal while the shared `useSpacesData` hook owns the actual scan/cache.
 */
function useSpacesReady(coreDirectory?: string): {
  spaces: readonly SpaceInfo[];
  spacesReady: boolean;
  spacesError: boolean;
  spacesErrorMessage?: string;
} {
  const { spaces, ready, error, errorMessage } = useSpacesData(coreDirectory);
  return {
    spaces,
    spacesReady: ready,
    spacesError: error,
    spacesErrorMessage: errorMessage,
  };
}

function normalizePath(p: string): string {
  // Normalize separators and resolve .. segments to prevent traversal
  return p.replace(/\\/g, '/').replace(/\/[^/]+\/\.\.\//g, '/').replace(/\/\.\//g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function isPathInWorkspace(filePath: string, workspaceRoots: readonly string[]): boolean {
  const normalized = normalizePath(filePath);
  if (normalized.includes('/../') || normalized.endsWith('/..')) return false;
  return workspaceRoots.some(root => {
    const normalizedRoot = normalizePath(root);
    return normalized.startsWith(normalizedRoot + '/') || normalized === normalizedRoot;
  });
}

/**
 * Context passed to `convertFilePathsToLinks` so each regex replacement can
 * emit the best rebel-URL form via `toBestFileLink` — space URL for files
 * in shareable spaces, library URL otherwise. Pass `null` when the
 * coreDirectory isn't known; in that case we fall back to `formatLibraryUrl`
 * (historical behaviour).
 */
interface ConvertLinkContext {
  coreDirectory: string;
  spaces: readonly SpaceInfo[];
  spacesReady: boolean;
  workspaceRoots: readonly string[];
}

function resolveBestUrl(filePath: string, ctx: ConvertLinkContext | null, kind: FileLinkKind): string {
  if (!ctx) return formatLibraryUrl(filePath);
  return toBestFileLink(filePath, ctx, kind);
}

function getPathDisplayName(filePath: string): string {
  const normalizedPath = filePath.replace(/[/\\]+$/, '');
  return basename(normalizedPath) || normalizedPath || filePath;
}

const convertFilePathsToLinks = (content: string, linkCtx: ConvertLinkContext | null): string => {
  // Short-circuit: if none of the transformable patterns exist, return unchanged.
  // This covers 80%+ of messages (plain text, simple markdown without file paths)
  // and avoids 7 regex passes over the content.
  const workspaceRoots = linkCtx?.workspaceRoots ?? [];
  const hasAbsolutePath = workspaceRoots.some(root => content.includes(root.replace(/\\/g, '/')));
  if (!content.includes('[[') && 
      !content.includes('`') && 
      !content.includes('rebel://conversation/') &&
      !hasAbsolutePath) {
    return content;
  }

  // Step 1: Protect code blocks (triple backticks)
  const codeBlocks: string[] = [];
  let processed = content.replace(/```[\s\S]*?```/g, (match) => {
    const index = codeBlocks.length;
    codeBlocks.push(match);
    return `__CODE_BLOCK_${index}__`;
  });

  // Step 2: Convert wikilinks [[path/file]] or [[path/]] to markdown links
  // Common in Obsidian-style docs. Wikilinks without extension get .md appended
  // unless they end with a trailing slash — those are folder references and
  // must be passed through with `kind: 'folder'` so `toBestFileLink` emits
  // `?type=folder` rather than appending a bogus `.md`.
  processed = processed.replace(/\[\[([^\]]+)\]\]/g, (_, wikPath) => {
    const trimmed = wikPath.trim();
    const isFolder = trimmed.endsWith('/');
    const hasExtension = !isFolder && /\.[a-zA-Z0-9]{2,6}$/.test(trimmed);
    const filePath = isFolder || hasExtension ? trimmed : `${trimmed}.md`;
    const kind: FileLinkKind = isFolder ? 'folder' : 'file';
    return `[${trimmed}](${resolveBestUrl(filePath, linkCtx, kind)})`;
  });

  // Step 3: Convert file paths in backticks to links
  // Handles paths with spaces, special chars like @ and -
  // Examples: `./path/file.md` or `src/file.ts` or `/absolute/path.md`
  // Also handles directory paths like `rebel-system/skills/` (trailing slash)
  // Backend will validate if absolute paths are within workspace
  // Pattern: backticks containing a path-like start (/, ./, ../, or folder/) followed by
  // any non-backtick chars, ending with file extension or trailing slash

  // Track inline images and videos with placeholders (to avoid regex re-matching paths)
  const inlineImages: string[] = [];
  const inlineVideos: string[] = [];

  // Detect whether the original content already contains a markdown image
  // (`![...](path)`) referencing the same path. When the agent emits both a
  // backticked path AND an explicit image embed for the same file, the
  // auto-injection below would otherwise produce a duplicate render — link
  // followed by two identical images. See investigation:
  // rebel://conversation/b57b8395-43bb-4242-b238-8b26f1cdaad3.
  const hasExistingMarkdownImage = (filePath: string): boolean => {
    const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match `![alt](exactPath)` only — anchoring on the exact closing paren
    // avoids false positives where another path happens to contain this one
    // as a suffix (e.g. `logo.png` vs `site/logo.png`).
    const re = new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`);
    return re.test(content);
  };

  // Reset regex lastIndex since we're using global flag
  BACKTICK_FILE_PATH_REGEX.lastIndex = 0;
  processed = processed.replace(
    BACKTICK_FILE_PATH_REGEX,
    (_, filePath) => {
      const kind: FileLinkKind = filePath.endsWith('/') ? 'folder' : 'file';
      const link = `[${filePath}](${resolveBestUrl(filePath, linkCtx, kind)})`;
      // For image paths, insert placeholder that will be restored later —
      // unless the content already has a markdown image embed for the same
      // path, in which case we just emit the link and let the existing
      // `![alt](path)` render the image once.
      if (isImagePath(filePath)) {
        if (hasExistingMarkdownImage(filePath)) {
          return link;
        }
        const index = inlineImages.length;
        inlineImages.push(`![](${formatLibraryUrl(filePath)})`);
        return `${link}\n\n__INLINE_IMAGE_${index}__`;
      }
      // For video paths, render only the inline video embed (no separate text link).
      // AutoLoadVideo handles both success (player) and error (fallback link).
      if (isVideoPath(filePath)) {
        const index = inlineVideos.length;
        inlineVideos.push(`[▶ ${basename(filePath)}](${resolveBestUrl(filePath, linkCtx, 'file')})`);
        return `__INLINE_VIDEO_${index}__`;
      }
      return link;
    }
  );

  // Step 4: Protect remaining inline code (single backticks)
  const inlineCodes: string[] = [];
  processed = processed.replace(/`[^`\n]+`/g, (match) => {
    const index = inlineCodes.length;
    inlineCodes.push(match);
    return `__INLINE_CODE_${index}__`;
  });

  // Step 4.5: Convert bare absolute file paths to clickable library:// links
  // Only links paths within the workspace (coreDirectory or symlinked Space source paths).
  // Handles paths like /Users/.../file.mp3 or C:\Users\...\file.docx that aren't
  // in backticks or markdown link syntax. Code blocks and inline code are already
  // protected by placeholders at this point.
  if (workspaceRoots.length > 0) {
    BARE_ABSOLUTE_PATH_REGEX.lastIndex = 0;
    processed = processed.replace(BARE_ABSOLUTE_PATH_REGEX, (match, filePath) => {
      const trimmedPath = filePath.trim();
      if (!isPathInWorkspace(trimmedPath, workspaceRoots)) return match;
      const fileName = basename(trimmedPath);
      return `[${fileName}](${resolveBestUrl(trimmedPath, linkCtx, 'file')})`;
    });
  }

  // Step 4.6: Convert raw rebel://conversation/{id} URLs to clickable markdown links
  // Matches URLs not already inside markdown link syntax [text](url) or as link text [url](...)
  // Lookbehinds: not preceded by ]( (link target) or [ (link text start)
  // Reset regex lastIndex since we're using global flag
  REBEL_CONVERSATION_REGEX.lastIndex = 0;
  processed = processed.replace(REBEL_CONVERSATION_REGEX, (match, sessionId) => {
    return `[${match}](rebel://conversation/${sessionId})`;
  });

  // Step 5: Restore inline code
  // Note: Plain file path regex conversion (filePathRegex) was removed because it
  // corrupted existing markdown links. File path links are now handled by the
  // remarkWorkspaceLinks plugin operating on the AST level.
  processed = processed.replace(/__INLINE_CODE_(\d+)__/g, (_, index) => {
    return inlineCodes[parseInt(index, 10)];
  });

  // Step 6: Restore code blocks
  processed = processed.replace(/__CODE_BLOCK_(\d+)__/g, (_, index) => {
    return codeBlocks[parseInt(index, 10)];
  });

  // Step 7: Restore inline images (placed right after their links)
  processed = processed.replace(/__INLINE_IMAGE_(\d+)__/g, (_, index) => {
    return inlineImages[parseInt(index, 10)];
  });

  // Step 8: Restore inline videos (placed right after their links)
  processed = processed.replace(/__INLINE_VIDEO_(\d+)__/g, (_, index) => {
    return inlineVideos[parseInt(index, 10)];
  });

  return processed;
};

// ============================================================================
// Collapsible Section Component
// ============================================================================

/**
 * URL transform function for nested collapsible content.
 *
 * The transform is shared by collapsed anchors and images, so it preserves
 * image/file/dangerous schemes long enough for the renderers below to make the
 * element-specific decision: CollapsedA omits unsafe hrefs, while CollapsedImg
 * still allows legitimate data:image/* inline images and blocks file:/dangerous
 * image schemes via findBlockedUrlScheme.
 */
const collapsibleUrlTransform = (url: string): string => {
  const trimmed = url.trimStart();
  const classification = classifyMarkdownUrl(trimmed);

  switch (classification.category) {
    case 'library':
    case 'workspace':
    case 'rebel':
    case 'file':
    case 'data-image':
    case 'blocked-dangerous':
      return trimmed;
    case 'empty':
    case 'relative':
    case 'hash':
    case 'protocol-relative':
    case 'windows-drive':
    case 'http':
    case 'https':
    case 'default-safe-scheme':
    case 'unknown-scheme':
      break;
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }

  return defaultUrlTransform(trimmed);
};

const getCollapsedAnchorHref = (href: string | undefined): string | undefined => {
  if (!href) {
    return undefined;
  }

  const classification = classifyMarkdownUrl(href);

  switch (classification.category) {
    case 'relative':
    case 'hash':
    case 'http':
    case 'https':
    case 'default-safe-scheme':
    case 'library':
    case 'workspace':
    case 'rebel':
      return href;
    case 'empty':
    case 'protocol-relative':
    case 'windows-drive':
    case 'file':
    case 'data-image':
    case 'blocked-dangerous':
    case 'unknown-scheme':
      return undefined;
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }
};

const shouldPreserveMessageMainUrlForDispatch = (
  classification: ReturnType<typeof classifyMarkdownUrl>,
): boolean => {
  switch (classification.category) {
    case 'protocol-relative':
    case 'http':
    case 'https':
    case 'default-safe-scheme':
    case 'library':
    case 'workspace':
    case 'rebel':
    case 'file':
    case 'data-image':
    case 'blocked-dangerous':
    case 'unknown-scheme':
      return true;
    case 'empty':
    case 'relative':
    case 'hash':
    case 'windows-drive':
      return false;
    default: {
      const exhaustive: never = classification;
      return exhaustive;
    }
  }
};

const messageMainUrlTransform = (url: string): string => {
  const leadingTrimmed = url.trimStart();
  const classification = classifyMarkdownUrl(leadingTrimmed, MESSAGE_MAIN_MARKDOWN_URL_CONTEXT);

  if (shouldPreserveMessageMainUrlForDispatch(classification)) {
    return leadingTrimmed;
  }

  return defaultUrlTransform(leadingTrimmed);
};

interface CollapsibleSectionProps {
  summary: string;
  body: string;
  defaultOpen?: boolean;
  /** Link click handler passed from parent MessageMarkdown */
  onLinkClick?: (event: React.MouseEvent<HTMLAnchorElement>, href?: string) => void;
  /** Image expand handler passed from parent MessageMarkdown */
  onImageExpand?: (filePath: string) => void;
  /** Image context menu handler passed from parent MessageMarkdown */
  onImageContextMenu?: (event: React.MouseEvent, dataUrl: string | null, filePath?: string) => void;
  /** Document path for relative image resolution */
  documentPath?: string;
  /** Workspace root — required for rebel://space/ emission */
  coreDirectory?: string;
}

type CollapsedCallbacks = Pick<
  CollapsibleSectionProps,
  'onLinkClick' | 'onImageExpand' | 'onImageContextMenu' | 'documentPath'
>;

/**
 * Renders a collapsible section using native <details>/<summary>.
 * Lazily renders body content only when expanded for performance.
 * Body content is rendered through ReactMarkdown with same plugins and link handlers.
 */
const CollapsibleSection = ({ 
  summary, 
  body, 
  defaultOpen = false,
  onLinkClick,
  onImageExpand,
  onImageContextMenu,
  documentPath,
  coreDirectory,
}: CollapsibleSectionProps) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const { spaces: nestedSpaces, spacesReady: nestedSpacesReady } = useSpacesReady(coreDirectory);
  const nestedRemarkLibraryLinks = useMemo<[typeof remarkLibraryLinks, RemarkLibraryLinksOptions]>(
    () => [
      remarkLibraryLinks,
      { coreDirectory, spaces: nestedSpaces, spacesReady: nestedSpacesReady },
    ],
    [coreDirectory, nestedSpaces, nestedSpacesReady],
  );
  const { source: processedBody, remarkPlugins: nestedPlugins } = useMemo(
    () => preprocessMarkdownForRender(body, { additionalPlugins: [nestedRemarkLibraryLinks] }),
    [body, nestedRemarkLibraryLinks],
  );

  const handleToggle = useCallback((event: React.SyntheticEvent<HTMLDetailsElement>) => {
    setIsOpen(event.currentTarget.open);
  }, []);

  // Same stability pattern as the outer markdown components: keep the
  // ReactMarkdown components map referentially stable so React doesn't remount
  // <a>/<img> subtrees on every CollapsibleSection re-render — that would
  // collapse text selections inside expanded code/details blocks.
  // See `docs-private/investigations/260427_text_selection_unstable_v2.md`.
  const collapsedCallbacksRef = useRef<CollapsedCallbacks | null>(null);
  collapsedCallbacksRef.current = { onLinkClick, onImageExpand, onImageContextMenu, documentPath };
  const collapsedComponents = useMemo(() => ({
    a: function CollapsedA({ href, children }: { href?: string; children?: ReactNode }) {
      const cb: CollapsedCallbacks = collapsedCallbacksRef.current ?? {};
      const safeHref = getCollapsedAnchorHref(href);
      return (
        <a
          href={safeHref}
          onClick={(e) => {
            if (safeHref) {
              cb.onLinkClick?.(e, safeHref);
            }
          }}
        >
          {children}
        </a>
      );
    },
    img: function CollapsedImg({ src, alt }: { src?: string; alt?: string }) {
      const cb: CollapsedCallbacks = collapsedCallbacksRef.current ?? {};
      const blockedScheme = findBlockedUrlScheme(src);
      if (blockedScheme) {
        console.warn('[Renderer] MessageMarkdown (collapsed) img blocked (dangerous scheme)', {
          scheme: blockedScheme,
          src: redactUrlForLogging(src),
        });
        return <img hidden alt={alt || 'Blocked image'} />;
      }
      const isExternalUrl = src?.startsWith('http://') || src?.startsWith('https://') || src?.startsWith('data:');
      if (src && !isExternalUrl && cb.onImageExpand) {
        const libraryPath = extractLibraryPath(src);
        const filePath = libraryPath ?? src;
        return (
          <AutoLoadImage
            filePath={filePath}
            alt={alt || 'Image'}
            onExpand={cb.onImageExpand}
            onContextMenu={cb.onImageContextMenu ?? (() => undefined)}
            documentPath={cb.documentPath ?? undefined}
          />
        );
      }
      return <img src={src} alt={alt} style={{ maxWidth: '100%', borderRadius: '8px' }} />;
    },
  }), []);

  return (
    <details 
      className="markdown-collapsible" 
      open={isOpen} 
      onToggle={handleToggle}
    >
      <summary className="markdown-collapsible__summary">
        <ChevronRight 
          size={16} 
          className="markdown-collapsible__chevron" 
          aria-hidden 
        />
        <span>{summary}</span>
      </summary>
      {isOpen && body && (
        <div className="markdown-collapsible__body">
          <ReactMarkdown
            remarkPlugins={nestedPlugins}
            urlTransform={collapsibleUrlTransform}
            components={collapsedComponents}
          >
            {processedBody}
          </ReactMarkdown>
        </div>
      )}
    </details>
  );
};

// ============================================================================
// Code Block with Copy Affordance
// ============================================================================

/**
 * Wraps a <pre> code block with a copy-to-clipboard button in the top-right.
 * Rendered for every fenced code block that isn't a special language (collapse,
 * JSON) so users can grab long prompts, snippets, etc. without hunting for the
 * message-level copy icon in the header.
 *
 * Stops click propagation so the parent message doesn't interpret the click as
 * "focus this turn".
 */
const PreWithCopy = ({ children, text }: { children: ReactNode; text: string }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const handleCopy = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      if (!text) return;
      try {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout(() => {
          setCopied(false);
          timerRef.current = null;
        }, 1500);
      } catch {
        // Clipboard unavailable - silently fail; the tooltip re-explains the control
      }
    },
    [text],
  );

  return (
    <div className="markdown-pre-wrap">
      <pre>{children}</pre>
      <Tooltip content={copied ? 'Copied' : 'Copy'} placement="top" delayShow={300}>
        <button
          type="button"
          onClick={handleCopy}
          disabled={!text}
          aria-label={copied ? 'Copied to clipboard' : 'Copy code'}
          className="markdown-pre-copy"
          data-copied={copied ? 'true' : undefined}
        >
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
      </Tooltip>
    </div>
  );
};

// ============================================================================
// Block Content Detection
// ============================================================================

const blockTags = new Set<string>(['pre', 'div', 'table', 'ul', 'ol', 'blockquote']);

const containsBlockContent = (node: ReactNode): boolean => {
  if (!isValidElement(node)) return false;

  if (typeof node.type === 'string') {
    return blockTags.has(node.type);
  }

  const props = (node.props ?? {}) as { inline?: boolean; node?: { tagName?: string }; children?: ReactNode };

  if (props.inline === false) {
    return true;
  }

  const markdownNode = props.node as { tagName?: string } | undefined;
  if (markdownNode?.tagName && blockTags.has(markdownNode.tagName)) {
    return true;
  }

  const grandchildren = Children.toArray(props.children);
  return grandchildren.some(containsBlockContent);
};

type ImageViewerState = {
  isOpen: boolean;
  src: string | null;
  alt: string;
  isLoading: boolean;
  error: string | null;
};

/** Threshold for showing plain text fallback while markdown processes (in characters) */
const DEFERRED_CONTENT_THRESHOLD = 500;

/** Threshold for two-phase rendering (lightweight first, then enhanced) */
const TWO_PHASE_THRESHOLD = 1500;

type EnhancedMarkdownRender = ReturnType<typeof preprocessMarkdownForRender>;

const ENHANCED_MARKDOWN_CACHE_LIMIT = 80;
const enhancedMarkdownCache = new Map<string, EnhancedMarkdownRender>();

function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function linkContextCacheKey(linkCtx: ConvertLinkContext | null): string {
  if (!linkCtx) return 'no-link-context';
  const spacesKey = linkCtx.spaces
    .map((space) => `${space.name}:${space.absolutePath}:${space.sourcePath ?? ''}`)
    .join('|');
  return [
    linkCtx.coreDirectory,
    linkCtx.spacesReady ? 'ready' : 'not-ready',
    linkCtx.workspaceRoots.join('|'),
    spacesKey,
  ].join('::');
}

function getCachedEnhancedMarkdown(
  cacheKey: string,
  compute: () => EnhancedMarkdownRender,
): EnhancedMarkdownRender {
  const cached = enhancedMarkdownCache.get(cacheKey);
  if (cached) {
    enhancedMarkdownCache.delete(cacheKey);
    enhancedMarkdownCache.set(cacheKey, cached);
    return cached;
  }
  const computed = compute();
  enhancedMarkdownCache.set(cacheKey, computed);
  if (enhancedMarkdownCache.size > ENHANCED_MARKDOWN_CACHE_LIMIT) {
    const oldestKey = enhancedMarkdownCache.keys().next().value;
    if (oldestKey) enhancedMarkdownCache.delete(oldestKey);
  }
  return computed;
}

// ============================================================================
// Two-Phase Rendering Helpers
// requestIdleCallback with fallback for environments that don't support it
// ============================================================================

const scheduleIdle = (callback: () => void, options?: { timeout?: number }): number => {
  if ('requestIdleCallback' in window) {
    return window.requestIdleCallback(callback, options);
  }
  // Fallback: use setTimeout with small delay to yield to browser
  return setTimeout(callback, 100) as unknown as number;
};

const cancelIdle = (id: number): void => {
  if ('requestIdleCallback' in window) {
    window.cancelIdleCallback(id);
  } else {
    clearTimeout(id);
  }
};

/**
 * Renders chat / message Markdown via `react-markdown` with rich link, image,
 * and collapsible-block handling.
 *
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 🚨 SELECTION-STABILITY CONTRACT — DO NOT BREAK 🚨  (REBEL-4ZV / FOX-3174)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * The `<ReactMarkdown components={…}>` map below MUST stay referentially
 * stable across re-renders. ReactMarkdown treats each entry (`p`, `a`, `img`,
 * `code`, `pre`, `li`, `ul`, `ol`, `strong`, `em`, `table`) as a "component
 * type". A new function identity per render = new component type = REMOUNT
 * of every paragraph/anchor/image subtree, which destroys the underlying
 * text nodes and collapses any live user selection on `mouseup` / right-click.
 *
 * Rules for anyone touching this file:
 *
 *   1. NEVER write inline arrow functions in `components={{ ... }}` (e.g.
 *      `p: ({children}) => <p>{children}</p>`). Use `markdownComponents`
 *      below — it's a `useMemo([])` block of named functions.
 *
 *   2. NEVER close over `useState` values, props, or `useCallback` results
 *      inside the component bodies in `markdownComponents`. They run inside
 *      a `useMemo([])` so closures are captured ONCE. All dynamic data MUST
 *      flow through `preCallbacksRef.current`, which is refreshed each
 *      render (see assignment below).
 *
 *   3. The same rule applies to the inner `CollapsibleSection` component —
 *      its nested `<ReactMarkdown>` also uses a stable `collapsedComponents`
 *      via `useMemo([])` + `collapsedCallbacksRef`.
 *
 *   4. The regression test
 *      `__tests__/MessageMarkdown.componentsStability.test.tsx` pins this
 *      contract by asserting paragraph + anchor DOM identity is preserved
 *      across re-renders that defeat `React.memo`. Run it after any change
 *      to the components map.
 *
 * See `docs-private/postmortems/260427_text_selection_disappears_on_right_click_postmortem.md`
 * and `docs/project/UI_CONVERSATIONS.md § Text-Selection Stability Contract`.
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 */

interface PreCallbacks {
  handleLinkClick?: (event: React.MouseEvent<HTMLAnchorElement>, href?: string) => void;
  openImageViewer?: (filePath: string) => void | Promise<void>;
  handleImageContextMenu?: (event: React.MouseEvent, dataUrl: string | null, filePath?: string) => void;
  handleLinkContextMenu?: (event: React.MouseEvent, href: string | undefined) => void;
  documentPath?: string;
  coreDirectory?: string;
  showToast?: (options: { title: string }) => void;
}

export const MessageMarkdown = memo(({ content, onOpenFile, onOpenFolder, onOpenConversation, onNavigate, onOpenTutorial, showToast, documentPath, coreDirectory, onOpenInLibrary }: MessageMarkdownProps) => {
  // Read the cloud base URL from settings so the link context menu can offer a
  // "Copy web link" action that works for recipients without Rebel installed.
  // `useSettingsSafe` returns null outside the provider (e.g. in tests).
  const settingsContext = useSettingsSafe();
  const cloudBaseUrl =
    settingsContext?.settings?.cloudInstance?.mode === 'cloud'
      ? settingsContext.settings.cloudInstance.cloudUrl
      : undefined;

  // Subscribe to the spaces cache so we rerender once `scanSpaces()` resolves
  // and can upgrade already-rendered messages from library:// to space://
  // links when they belong to shareable spaces.
  const { spaces: cachedSpaces, spacesReady } = useSpacesReady(coreDirectory);
  const workspaceRoots = useMemo(
    () => deriveWorkspaceRoots(coreDirectory, cachedSpaces),
    [coreDirectory, cachedSpaces],
  );
  const linkCtx = useMemo<ConvertLinkContext | null>(
    () => coreDirectory
      ? { coreDirectory, spaces: cachedSpaces, spacesReady, workspaceRoots }
      : null,
    [coreDirectory, cachedSpaces, spacesReady, workspaceRoots],
  );

  // Build a tuple [plugin, options] for the remarkLibraryLinks plugin so
  // explicit markdown links (e.g. `[Doc](SharedSpace/Q1.md)`) also use
  // `toBestFileLink`. react-markdown / unified calls `plugin(options)` to
  // get the transformer — we never call the factory directly.
  // Memoized against inputs so ReactMarkdown doesn't reparse on every render.
  // Kept above early returns to satisfy react-hooks/rules-of-hooks.
  const remarkLibraryLinksPlugin = useMemo<[typeof remarkLibraryLinks, RemarkLibraryLinksOptions]>(
    () => [
      remarkLibraryLinks,
      { coreDirectory, spaces: cachedSpaces, spacesReady },
    ],
    [coreDirectory, cachedSpaces, spacesReady],
  );

  const trimmed = content.trim();
  
  // Defer expensive markdown processing to keep UI responsive during message entry.
  // React will show the previous value while processing the new one in background.
  const deferredContent = useDeferredValue(trimmed);
  const isPending = trimmed !== deferredContent;
  
  // Two-phase rendering for long content:
  // 1. First render lightweight markdown (fast, no custom link handlers)
  // 2. Then enhance with full features when browser is idle
  const needsTwoPhase = trimmed.length > TWO_PHASE_THRESHOLD;
  
  // Content key to detect actual content changes (not just reference changes)
  // This prevents state thrashing when parent re-renders with same content
  const contentKey = `${trimmed.length}-${trimmed.slice(0, 50)}`;
  const contentKeyRef = useRef<string>(contentKey);
  
  // Phase tracking - start enhanced if content is short
  const [isEnhanced, setIsEnhanced] = useState(!needsTwoPhase);
  const shouldRenderEnhanced = !(isPending && trimmed.length > DEFERRED_CONTENT_THRESHOLD) && (isEnhanced || !needsTwoPhase);
  
  useEffect(() => {
    // Skip if content hasn't actually changed and we're already enhanced
    if (contentKeyRef.current === contentKey && isEnhanced) {
      return;
    }
    contentKeyRef.current = contentKey;
    
    // Short content: enhance immediately
    if (!needsTwoPhase) {
      setIsEnhanced(true);
      return;
    }
    
    // Long content: start lightweight, enhance when browser is idle
    setIsEnhanced(false);
    
    const id = scheduleIdle(
      () => setIsEnhanced(true),
      { timeout: 1000 } // Force enhancement within 1s even if browser stays busy
    );
    
    return () => cancelIdle(id);
  }, [contentKey, needsTwoPhase, isEnhanced]);

  const enhancedMarkdown = useMemo(
    () => {
      if (!shouldRenderEnhanced) return null;
      const content = deferredContent || '';
      const cacheKey = [
        content.length,
        hashString(content),
        hashString(linkContextCacheKey(linkCtx)),
      ].join(':');
      return getCachedEnhancedMarkdown(
        cacheKey,
        () => preprocessMarkdownForRender(
          convertFilePathsToLinks(convertHtmlDetailsToCollapse(content), linkCtx),
          { additionalPlugins: [remarkLibraryLinksPlugin] },
        ),
      );
    },
    [deferredContent, linkCtx, remarkLibraryLinksPlugin, shouldRenderEnhanced],
  );
  
  const [imageViewer, setImageViewer] = useState<ImageViewerState>({
    isOpen: false,
    src: null,
    alt: '',
    isLoading: false,
    error: null
  });
  const { target: imageContextMenu, open: openImageContextMenu, close: closeImageContextMenu } = useImageContextMenu();
  const [linkContextMenu, setLinkContextMenu] = useState<LinkContextMenuTarget | null>(null);
  const linkContextMenuRequestRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const handleImageContextMenu = useCallback((
    event: React.MouseEvent,
    dataUrl: string | null,
    filePath?: string
  ) => {
    openImageContextMenu(event, {
      dataUrl: dataUrl ?? undefined,
      filePath,
      fileName: filePath ? basename(filePath) : undefined,
    });
  }, [openImageContextMenu]);

  const handleLinkContextMenu = useCallback((
    event: React.MouseEvent,
    href: string | undefined
  ) => {
    if (event.defaultPrevented) return;
    if (!href) return;
    
    const x = event.clientX;
    const y = event.clientY;

    // Show the file context menu for library:// / workspace:// / rebel://library/ links,
    // and resolve shareable rebel://space/ links into the same workspace-relative target.
    const libraryPath = extractLibraryPath(href);
    if (libraryPath === null) {
      if (!href.toLowerCase().startsWith('rebel://space/')) return;

      event.preventDefault();
      event.stopPropagation();

      const requestId = linkContextMenuRequestRef.current + 1;
      linkContextMenuRequestRef.current = requestId;

      void resolveLink(href, {
        spaceResolver: rendererDesktopSpaceResolver,
        surface: 'renderer',
      }).then((action) => {
        if (!isMountedRef.current || linkContextMenuRequestRef.current !== requestId) {
          return;
        }
        if (action.kind !== 'open-library-file' && action.kind !== 'open-library-folder') {
          return;
        }

        const relativePath = action.relativePath;
        const fullPath = isAbsolute(relativePath)
          ? relativePath
          : coreDirectory
            ? join(coreDirectory, relativePath)
            : null;

        setLinkContextMenu({
          x,
          y,
          relativePath,
          libraryUrl: href,
          fullPath,
          isFolder: action.kind === 'open-library-folder',
        });
      });

      return;
    }
    
    event.preventDefault();
    event.stopPropagation();
    linkContextMenuRequestRef.current += 1;
    
    // Strip fragment/query from path for operations
    let relativePath = libraryPath;
    const hashIndex = relativePath.indexOf('#');
    const queryIndex = relativePath.indexOf('?');
    const separatorIndex =
      hashIndex >= 0 && queryIndex >= 0
        ? Math.min(hashIndex, queryIndex)
        : hashIndex >= 0
          ? hashIndex
          : queryIndex;
    if (separatorIndex >= 0) {
      relativePath = relativePath.slice(0, separatorIndex);
    }
    
    const isFolder = relativePath.endsWith('/');
    // If the path is already absolute, use it directly; otherwise join with coreDirectory
    const fullPath = isAbsolute(relativePath)
      ? relativePath
      : coreDirectory
        ? join(coreDirectory, relativePath)
        : null;
    
    setLinkContextMenu({
      x,
      y,
      relativePath,
      libraryUrl: href,
      fullPath,
      isFolder,
    });
  }, [coreDirectory]);

  const closeLinkContextMenu = useCallback(() => {
    linkContextMenuRequestRef.current += 1;
    setLinkContextMenu(null);
  }, []);

  /**
   * Try to open a file in the workspace viewer, falling back to folder navigation
   * (if path has no extension) or system file browser.
   */
  const openFileWithFallback = useCallback(
    async (filePath: string) => {
      if (onOpenFile) {
        try {
          await onOpenFile(filePath);
          return;
        } catch {
          // File couldn't be opened - check if it might be a folder
          // (paths without extensions are likely folders when file open fails)
          const hasExtension = /\.[a-zA-Z0-9]{2,6}$/.test(filePath);
          if (!hasExtension && onOpenFolder) {
            // Try opening as folder (add trailing slash for consistency)
            const folderPath = filePath.endsWith('/') ? filePath : `${filePath}/`;
            onOpenFolder(folderPath);
            return;
          }
          // Show a friendly message — don't navigate away from the conversation
          const fileName = filePath.split('/').pop() ?? filePath;
          showToast?.({ title: `Could not open "${fileName}" — the file may have been moved or deleted` });
          return;
        }
      }
      // FOX-3422: surface a toast when the reveal fails instead of swallowing.
      void window.appApi.revealPath(filePath).then(
        (result) => showPathOpenFailureToast(result, showToast),
        (error) => showPathOpenFailureToast(error, showToast),
      );
    },
    [onOpenFile, onOpenFolder, showToast]
  );

  const openImageViewer = useCallback(async (filePath: string) => {
    setImageViewer({
      isOpen: true,
      src: null,
      alt: basename(filePath) || 'Image',
      isLoading: true,
      error: null
    });

    try {
      // Use object format with basePath when documentPath is provided (enables relative path resolution)
      const request = documentPath ? { target: filePath, basePath: documentPath } : filePath;
      const readResult = parseReadFileBase64Response(await window.libraryApi.readFileBase64(request));
      const mimeType = getImageMimeType(filePath);
      setImageViewer((prev) => ({
        ...prev,
        src: `data:${mimeType};base64,${readResult.base64}`,
        isLoading: false
      }));
    } catch (err) {
      setImageViewer((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to load image'
      }));
    }
  }, [documentPath]);

  const openFileUrlWithFallback = useCallback((url: string) => {
    const parsed = parseFileUrl(url);
    const filePath = parsed?.path ?? url;

    if (isImagePath(filePath)) {
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      if (ext === 'svg' && onOpenFile) {
        void openFileWithFallback(filePath);
      } else {
        void openImageViewer(filePath);
      }
      return;
    }

    void openFileWithFallback(filePath);
  }, [onOpenFile, openFileWithFallback, openImageViewer]);

  const linkDispatcher = useMemo(() => createMarkdownLinkHandler({
    onOpenFile: (filePath) => {
      void openFileWithFallback(filePath);
    },
    onOpenFileUrl: (url) => {
      openFileUrlWithFallback(url);
    },
    onOpenImage: (filePath) => {
      void openImageViewer(filePath);
    },
    onOpenFolder: (filePath) => {
      if (onOpenFolder) {
        onOpenFolder(filePath);
        return;
      }

      // FOX-3422: surface a toast when the reveal fails instead of swallowing.
      void window.appApi.revealPath(filePath).then(
        (result) => showPathOpenFailureToast(result, showToast),
        (error) => showPathOpenFailureToast(error, showToast),
      );
    },
    onOpenConversation: onOpenConversation ?? (() => undefined),
    onOpenTutorial: onOpenTutorial ?? (() => undefined),
    onNavigate: onNavigate ?? (() => undefined),
    onBlocked: (url, reason) => {
      console.warn(`[MessageMarkdown] Blocked (${reason}):`, url);
    },
  }), [
    onOpenConversation,
    onOpenFolder,
    onOpenTutorial,
    onNavigate,
    openFileUrlWithFallback,
    openFileWithFallback,
    openImageViewer,
    showToast,
  ]);

  const closeImageViewer = useCallback(() => {
    setImageViewer({
      isOpen: false,
      src: null,
      alt: '',
      isLoading: false,
      error: null
    });
  }, []);

  // Global ESC key handler for image viewer - useEffect ensures it works regardless of focus
  useEffect(() => {
    if (!imageViewer.isOpen) return;
    
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeImageViewer();
      }
    };
    
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [imageViewer.isOpen, closeImageViewer]);

  // Ref for callbacks used by the memoized pre component — prevents
  // CollapsibleSection remounting (and losing open/close state) when
  // MessageMarkdown re-renders and the inline `components` object gets
  // a new reference. The ref is populated below (just before `return`) on
  // every render, so consumers inside `StablePre` can assume `.current` is
  // non-null at render time.
  const preCallbacksRef = useRef<PreCallbacks | null>(null);

  // Stable pre component — same function reference across renders so React
  // doesn't treat it as a new component type and remount <pre> subtrees.
  // Reads dynamic callbacks from preCallbacksRef at render time.
  const StablePre = useMemo(() => function MarkdownPre({ children }: { children?: ReactNode }) {
    const childArray = Children.toArray(children);
    if (childArray.length === 1 && isValidElement(childArray[0])) {
      const codeElement = childArray[0] as React.ReactElement<{ className?: string; children?: ReactNode }>;
      if (codeElement.type === 'code' || (codeElement.props as { node?: { tagName?: string } }).node?.tagName === 'code') {
        const className = codeElement.props.className;
        const { isCollapse, defaultOpen } = isCollapseLanguage(className);

        if (isCollapse) {
          const codeChildren = codeElement.props.children;
          const textContent = typeof codeChildren === 'string'
            ? codeChildren
            : Children.toArray(codeChildren).map(c => typeof c === 'string' ? c : '').join('');

          const { summary, body } = parseCollapseBlock(textContent);
          const cb = preCallbacksRef.current;
          if (cb) {
            return (
              <CollapsibleSection
                summary={summary}
                body={body}
                defaultOpen={defaultOpen}
                onLinkClick={cb.handleLinkClick}
                onImageExpand={cb.openImageViewer}
                onImageContextMenu={cb.handleImageContextMenu}
                documentPath={cb.documentPath}
                coreDirectory={cb.coreDirectory}
              />
            );
          }
        }

        if (isJsonLanguage(className)) {
          const jsonText = extractCodeText(codeElement.props.children);
          if (isRenderableJsonObject(jsonText)) {
            return <JsonDocumentView content={jsonText} />;
          }
        }

        // Default fenced code block — attach a copy affordance in the top-right
        // so users can grab the whole block without selecting it by hand.
        const codeText = extractCodeText(codeElement.props.children);
        if (isDocumentLanguage(className, codeText.length)) {
          const cb = preCallbacksRef.current;
          if (cb) {
            return (
              <DocumentBlock
                content={codeText}
                language={className?.replace('language-', '') ?? ''}
                showToast={cb.showToast}
                coreDirectory={cb.coreDirectory}
              />
            );
          }
        }

        return <PreWithCopy text={codeText}>{children}</PreWithCopy>;
      }
    }
    return <PreWithCopy text="">{children}</PreWithCopy>;
  }, []);

  // Stable markdown components map. Created ONCE for the lifetime of this
  // MessageMarkdown instance and never reassigned. ReactMarkdown's reconciliation
  // treats each entry as a component "type"; a new function identity here forces
  // every <p>/<a>/<img>/etc. subtree to remount on every render, which destroys
  // text nodes and collapses any live user selection.
  //
  // Dynamic callbacks (handleLinkClick, openImageViewer, …) live on
  // `preCallbacksRef`, which is refreshed each render below. The component
  // bodies read the LATEST callbacks from the ref at invocation time. State
  // values that drive markup (coreDirectory, documentPath) are also routed
  // through the ref so the outer functions don't need to close over them.
  //
  // See `docs-private/investigations/260427_text_selection_unstable_v2.md`.
  const markdownComponents = useMemo(() => ({
    p: function MarkdownP({ children }: { children?: ReactNode }) {
      const childArray = Children.toArray(children);
      const hasBlockChild = childArray.some(containsBlockContent);

      if (hasBlockChild) {
        return <>{children}</>;
      }

      // Check if a child is an inline video player (AutoLoadVideo renders a div).
      // If so, unwrap from <p> to avoid invalid block-in-inline HTML.
      if (childArray.some((child) => isValidElement(child) && child.type === AutoLoadVideo)) {
        return <>{children}</>;
      }

      // Check for embeddable media URLs (YouTube, Vimeo, etc.).
      // Only auto-embed when a bare URL is the sole content of the paragraph.
      if (childArray.length === 1) {
        const child = childArray[0];
        if (isValidElement(child)) {
          const childProps = child.props as { href?: string; children?: ReactNode; node?: { tagName?: string } };
          const href = childProps.href;
          const isLink = childProps.node?.tagName === 'a' || typeof href === 'string';
          if (isLink && href && (href.startsWith('http://') || href.startsWith('https://'))) {
            const linkChildren = Children.toArray(childProps.children);
            if (
              linkChildren.length === 1 &&
              typeof linkChildren[0] === 'string' &&
              linkChildren[0].trim() === href.trim() &&
              isEmbeddableMediaUrl(href)
            ) {
              return <MediaEmbed url={href} />;
            }
          }
        }
      }

      return <p>{children}</p>;
    },
    table: function MarkdownTable({ children }: { children?: ReactNode }) {
      return (
        <div className="markdown-table-wrapper">
          <table>{children}</table>
        </div>
      );
    },
    ul: function MarkdownUl({ children }: { children?: ReactNode }) {
      return <ul>{children}</ul>;
    },
    ol: function MarkdownOl({ children }: { children?: ReactNode }) {
      return <ol>{children}</ol>;
    },
    li: function MarkdownLi({ children }: { children?: ReactNode }) {
      return <li>{children}</li>;
    },
    strong: function MarkdownStrong({ children }: { children?: ReactNode }) {
      return <strong>{children}</strong>;
    },
    em: function MarkdownEm({ children }: { children?: ReactNode }) {
      return <em>{children}</em>;
    },
    pre: StablePre,
    code: function MarkdownCode(
      props: React.ClassAttributes<HTMLElement> & React.HTMLAttributes<HTMLElement>,
    ) {
      const { className, children, ...rest } = props;
      return (
        <code className={className} {...rest}>
          {children}
        </code>
      );
    },
    a: function MarkdownA({ href, children }: { href?: string; children?: ReactNode }) {
      const cb: PreCallbacks = preCallbacksRef.current ?? {};
      const currentCoreDirectory: string | undefined = cb.coreDirectory ?? undefined;
      const onLinkClick = cb.handleLinkClick;
      const onLinkContextMenu = cb.handleLinkContextMenu;

      // Support library:// / workspace:// / rebel://library/ (all three accepted; rebel://library/ is canonical)
      const libraryFilePath = href ? extractLibraryPath(href) : null;
      const isLibraryLink = libraryFilePath !== null;

      // Render inline video player only for auto-generated play-button links
      // (▶ prefix from convertFilePathsToLinks). Regular text links to video
      // files render as normal clickable links to avoid double-rendering every
      // backticked .mp4 path as both a text link AND a video player.
      if (isLibraryLink && libraryFilePath && isVideoPath(libraryFilePath)) {
        const linkText = Children.toArray(children)
          .filter((c): c is string => typeof c === 'string')
          .join('');
        if (linkText.trimStart().startsWith('▶')) {
          return <AutoLoadVideo filePath={libraryFilePath} coreDirectory={currentCoreDirectory} />;
        }
      }

      const isConversationLink = href?.toLowerCase().startsWith('rebel://conversation/');
      const isTutorialLink = href?.toLowerCase().startsWith('rebel://help/tutorials/');
      const isSpaceLink = href?.toLowerCase().startsWith('rebel://space/');
      const spaceTarget = isSpaceLink && href ? parseNavigationUrl(href) : null;
      const spaceName = spaceTarget?.type === 'space' ? spaceTarget.spaceName : undefined;
      const spacePath = spaceTarget?.type === 'space'
        ? spaceTarget.filePath ?? spaceTarget.folderPath
        : undefined;
      const isSpaceFileReference = Boolean(spaceName && spacePath);
      const hasFileContextMenu = isLibraryLink || isSpaceLink;
      // rebel://library/ is a workspace-file reference (Stage H) — handled
      // by isLibraryLink above, NOT as generic rebel-nav. Exclude it here
      // so the link renders with the library/file icon treatment rather
      // than the external/nav styling.
      const isRebelNavLink =
        href?.toLowerCase().startsWith('rebel://') &&
        !isConversationLink &&
        !isTutorialLink &&
        !isSpaceLink &&
        !isLibraryLink;
      const isExternalLink = href?.startsWith('http://') || href?.startsWith('https://');
      const markdownUrlClassification = href
        ? classifyMarkdownUrl(href, MESSAGE_MAIN_MARKDOWN_URL_CONTEXT)
        : null;
      const shouldNeutralizeHref = Boolean(
        markdownUrlClassification &&
        (
          (
            !markdownUrlClassification.isSafe &&
            markdownUrlClassification.category !== 'windows-drive'
          ) ||
          markdownUrlClassification.category === 'default-safe-scheme' ||
          (
            (markdownUrlClassification.category === 'http' ||
              markdownUrlClassification.category === 'https') &&
            !isExternalLink
          )
        ),
      );
      const isInternalLink = isLibraryLink || isConversationLink || isRebelNavLink || isTutorialLink || isSpaceLink;

      // Get privacy for library links
      let privacy: 'private' | 'shared' | 'unknown' = 'unknown';
      if (isLibraryLink && libraryFilePath) {
        privacy = getFilePrivacy(libraryFilePath);
      }

      const isFileReferenceLink = isLibraryLink || isSpaceFileReference;
      const fileDisplayName = isLibraryLink && libraryFilePath
        ? getPathDisplayName(libraryFilePath)
        : spacePath
          ? getPathDisplayName(spacePath)
          : undefined;
      const fileScopeLabel = isLibraryLink
        ? privacy === 'private'
          ? 'Private'
          : privacy === 'shared'
            ? 'Shared'
            : undefined
        : spaceName;
      const fileScopePrivacy = isLibraryLink && (privacy === 'private' || privacy === 'shared')
        ? privacy
        : null;
      const fileReferenceIcon = isFileReferenceLink
        ? fileScopePrivacy === 'private'
          ? 'private'
          : fileScopePrivacy === 'shared' || isSpaceFileReference
            ? 'shared'
            : null
        : null;
      const fullFileLabel = isLibraryLink && libraryFilePath
        ? libraryFilePath
        : spaceName && spacePath
          ? `${spaceName}/${spacePath}`
          : undefined;
      const fullFileTitlePart = fullFileLabel && fullFileLabel !== fileDisplayName
        ? ` - ${fullFileLabel}`
        : '';
      const fileReferenceTitle = fileDisplayName
        ? `${fileDisplayName}${fileScopeLabel ? ` - ${fileScopeLabel}` : ''}${fullFileTitlePart}`
        : undefined;

      const linkClassName = [
        'markdown-link',
        isFileReferenceLink ? 'markdown-link--file' : '',
        isLibraryLink ? 'markdown-link--workspace' : '', // keep CSS class for backwards compat
        isConversationLink ? 'markdown-link--conversation' : '',
        isTutorialLink ? 'markdown-link--tutorial' : '',
        isSpaceLink ? 'markdown-link--space' : '',
        isRebelNavLink ? 'markdown-link--navigation' : '',
        isExternalLink ? 'markdown-link--external' : '',
        privacy === 'private' ? 'markdown-link--private' : '',
        privacy === 'shared' ? 'markdown-link--shared' : ''
      ]
        .filter(Boolean)
        .join(' ');

      const privacyIcon = privacy !== 'unknown' && isLibraryLink ? (
        <Tooltip
          content={privacy === 'private'
            ? 'Private — only you can see this'
            : 'Shared — visible to others with folder access'
          }
          placement="top"
          delayShow={300}
        >
          <span className="markdown-link__privacy-icon">
            {privacy === 'private' ? (
              <Lock size={13} aria-hidden />
            ) : (
              <Globe size={13} aria-hidden />
            )}
          </span>
        </Tooltip>
      ) : null;

      const conversationIcon = isConversationLink ? (
        <span className="markdown-link__conversation-icon">
          <MessageSquare size={13} aria-hidden />
        </span>
      ) : null;

      const tutorialIcon = isTutorialLink ? (
        <span className="markdown-link__tutorial-icon">
          <BookOpen size={13} aria-hidden />
        </span>
      ) : null;

      const spaceIcon = isSpaceLink ? (
        <span className="markdown-link__space-icon">
          <Globe size={13} aria-hidden />
        </span>
      ) : null;

      const navigationIcon = isRebelNavLink ? (
        <span className="markdown-link__navigation-icon">
          <ExternalLink size={13} aria-hidden />
        </span>
      ) : null;

      return (
        <a
          href={isInternalLink || shouldNeutralizeHref ? '#' : href}
          data-href={href}
          data-full-path={isFileReferenceLink ? fullFileLabel : undefined}
          aria-label={fileReferenceTitle ? `Open ${fileReferenceTitle}` : undefined}
          onClick={(e) => {
            if (isInternalLink) {
              e.preventDefault();
              e.stopPropagation();
            }
            onLinkClick?.(e, href);
          }}
          onContextMenu={hasFileContextMenu && onLinkContextMenu ? (e) => onLinkContextMenu(e, href) : undefined}
          target={isExternalLink ? "_blank" : undefined}
          rel={isExternalLink ? "noopener noreferrer" : undefined}
          className={linkClassName}
        >
          {isFileReferenceLink && fileDisplayName ? (
            <>
              {fileScopeLabel ? (
                <span className="markdown-link__scope-meta">
                  {fileReferenceIcon ? (
                    <span className="markdown-link__scope-icon">
                      {fileReferenceIcon === 'private' ? (
                        <Lock size={11} aria-hidden />
                      ) : (
                        <Globe size={11} aria-hidden />
                      )}
                    </span>
                  ) : null}
                  {fileScopeLabel}
                  <ChevronRight size={11} className="markdown-link__scope-separator" aria-hidden />
                </span>
              ) : null}
              <span className="markdown-link__filename">{fileDisplayName}</span>
            </>
          ) : (
            <>
              {privacyIcon}
              {conversationIcon}
              {tutorialIcon}
              {spaceIcon}
              {navigationIcon}
              {children}
            </>
          )}
        </a>
      );
    },
    img: function MarkdownImg({ src, alt }: { src?: string; alt?: string }) {
      const cb: PreCallbacks = preCallbacksRef.current ?? {};
      const onExpand = cb.openImageViewer;
      const onContextMenuImg = cb.handleImageContextMenu;
      const currentDocumentPath: string | undefined = cb.documentPath ?? undefined;

      const blockedScheme = findBlockedUrlScheme(src);
      if (blockedScheme) {
        console.warn('[Renderer] MessageMarkdown img blocked (dangerous scheme)', {
          scheme: blockedScheme,
          src: redactUrlForLogging(src),
        });
        return <img hidden alt={alt || 'Blocked image'} />;
      }
      // Handle local file paths - load via IPC and display inline.
      // This includes: absolute paths (/...), library:// / workspace:// / rebel://library/ URLs, and relative paths.
      const isExternalUrl = src?.startsWith('http://') || src?.startsWith('https://') || src?.startsWith('data:');
      if (src && !isExternalUrl) {
        const libraryPath = extractLibraryPath(src);
        const filePath = libraryPath ?? src;
        return (
          <AutoLoadImage
            filePath={filePath}
            alt={alt || 'Image'}
            onExpand={onExpand ?? (() => undefined)}
            onContextMenu={onContextMenuImg ?? (() => undefined)}
            documentPath={currentDocumentPath}
          />
        );
      }
      return <img src={src} alt={alt} style={{ maxWidth: '100%', borderRadius: '8px' }} />;
    },
  // StablePre is `useMemo(..., [])` so its identity is stable for the lifetime
  // of this MessageMarkdown instance — including it here keeps eslint happy
  // without causing repeated factory invocations. All other dynamic data flows
  // through preCallbacksRef, which is updated each render below.
  }), [StablePre]);

  if (!trimmed) return null;
  
  // For long content that's still processing, show lightweight markdown immediately.
  // This prevents UI freeze while React processes the heavy markdown render.
  // Uses same renderer as StreamingTextDisplay for visual consistency.
  // Links are rendered as non-interactive spans to prevent dead clicks.
  // Short messages render inline without the fallback to avoid visual flicker.
  if (isPending && trimmed.length > DEFERRED_CONTENT_THRESHOLD) {
    return (
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Render links as styled spans - non-interactive during processing
            // Preserves text selection while preventing clicks on non-functional links
            a: ({ children }) => (
              <span style={{ color: 'var(--color-link)', cursor: 'default' }}>
                {children}
              </span>
            ),
          }}
        >
          {trimmed}
        </ReactMarkdown>
      </div>
    );
  }
  
  // Two-phase rendering: Show lightweight markdown first for long content
  // This prevents UI freeze when streaming ends and final message renders.
  // Full features (custom links, images, collapsibles) load when browser is idle.
  if (!isEnhanced && needsTwoPhase) {
    return (
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            // Render links as styled spans - non-interactive during lightweight phase
            // Preserves text selection while preventing clicks on non-functional links
            a: ({ children }) => (
              <span style={{ color: 'var(--color-link)', cursor: 'default' }}>
                {children}
              </span>
            ),
          }}
        >
          {trimmed}
        </ReactMarkdown>
      </div>
    );
  }
  
  // Preprocess content: convert raw HTML <details> to collapse fences, then file paths to links
  // Only computed when we're rendering the full enhanced version (after early returns above)
  // This ensures regex preprocessing is deferred along with the full render
  const { source: processedContent, remarkPlugins } = enhancedMarkdown ?? { source: '', remarkPlugins: [] };
  
  const handleLinkClick = (event: React.MouseEvent<HTMLAnchorElement>, href?: string) => {
    if (!href) return;

    const result = linkDispatcher(href);
    if (result.action === 'handled' || result.action === 'blocked') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (result.action === 'open-external') {
      event.preventDefault();
      event.stopPropagation();
      window.appApi.openUrl(result.url).catch((error) => {
        console.error('Failed to open URL:', error);
      });
    }
  };

  // Update the ref with current callbacks — must be after handleLinkClick is defined.
  // The `a`/`img`/`pre` markdown components are stable function references (created
  // once via `useMemo([], …)`); they read the latest callbacks from this ref each
  // render. This keeps the entire `components` object identity stable, which is
  // what stops ReactMarkdown from remounting every paragraph/link/image on every
  // re-render of MessageMarkdown — and remounting was destroying live text
  // selections on `mouseup` / right-click. See
  // `docs-private/investigations/260427_text_selection_unstable_v2.md`.
  preCallbacksRef.current = {
    handleLinkClick,
    openImageViewer,
    handleImageContextMenu,
    handleLinkContextMenu,
    documentPath,
    coreDirectory,
    showToast,
  };

  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        urlTransform={messageMainUrlTransform}
        components={markdownComponents}
      >
        {processedContent}
      </ReactMarkdown>

      {imageViewer.isOpen ? createPortal(
        <div
          className={styles.overlay}
          onClick={closeImageViewer}
          role="dialog"
          aria-modal="true"
          aria-label="Image viewer"
        >
          <div className={styles.overlayContent} onClick={(e) => e.stopPropagation()}>
            {imageViewer.isLoading ? (
              <div className={styles.loading}>Loading image...</div>
            ) : imageViewer.error ? (
              <div className={styles.errorOverlay}>
                <span aria-hidden>⚠️</span>
                <span>{imageViewer.error}</span>
              </div>
            ) : imageViewer.src ? (
              <img
                src={imageViewer.src}
                alt={imageViewer.alt}
                onContextMenu={(e) => handleImageContextMenu(e, imageViewer.src)}
                onError={() => setImageViewer(prev => ({ ...prev, error: 'Failed to display image. The file may be corrupted or use an unsupported format.', src: null }))}
              />
            ) : null}
            <button
              type="button"
              className={styles.closeButton}
              onClick={closeImageViewer}
              aria-label="Close image viewer"
            >
              ✕
            </button>
          </div>
        </div>,
        document.body
      ) : null}

      <ImageContextMenu
        target={imageContextMenu}
        onClose={closeImageContextMenu}
        showToast={showToast}
      />

      <LinkContextMenu
        target={linkContextMenu}
        onClose={closeLinkContextMenu}
        showToast={showToast}
        onOpenInPreview={onOpenFile}
        onOpenInLibrary={onOpenInLibrary}
        cloudBaseUrl={cloudBaseUrl}
      />
    </div>
  );
});

MessageMarkdown.displayName = 'MessageMarkdown';
