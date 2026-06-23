/**
 * Remark plugin to transform relative and absolute file paths in Markdown
 * links AND images to canonical rebel:// URLs.
 *
 * Link visitor: emits `rebel://space/{name}/{path}` when the file lives in a
 * shareable space (cross-user portable), or `rebel://library/{workspace-relative}`
 * otherwise. Selection via `toBestFileLink`.
 *
 * Image visitor: ALWAYS emits `rebel://library/{path}` via `formatLibraryUrl`,
 * NEVER `rebel://space/`. The downstream `<img>` renderer in
 * `MessageMarkdown.tsx` decodes via `extractLibraryPath`, which does not
 * recognise `rebel://space/`. Keeping the two visitors independent is
 * intent-critical — see Stage I6 of
 * `docs/plans/260422_broken_image_followups_i6_i7.md`.
 *
 * This operates on the AST level, avoiding regex corruption issues that can occur
 * when trying to manipulate raw Markdown text containing links.
 *
 * Note: For backwards compatibility, the click handlers in MessageMarkdown.tsx
 * accept library:// / workspace:// / rebel://library/ forms. This plugin emits
 * the canonical rebel://space/ or rebel://library/ forms.
 *
 * Reference-style nodes (`linkReference`, `imageReference`, `definition`) are
 * intentionally NOT visited — a single `definition` can be shared by both a
 * link reference and an image reference, which would force an unresolvable
 * formatter choice. See Stage I6 of the planning doc, and follow-up I11.
 *
 * See docs/plans/260418_finish_cross_surface_links_closeout.md — Stage 1
 * (link visitor) and docs/plans/260422_broken_image_followups_i6_i7.md —
 * Stage I6 (image visitor).
 */
import { visit } from 'unist-util-visit';
import type { Root, Link, Image } from 'mdast';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import { toBestFileLink } from '@core/navigation';
import { formatLibraryUrl } from '@shared/navigation/urlParser';

/**
 * Factory args for `remarkLibraryLinks`. `coreDirectory`, `spaces`, and
 * `spacesReady` are sourced from MessageMarkdown's module-level cache so the
 * plugin uses the same data as the regex preprocessors (single source of
 * truth). When any piece is missing — e.g., plugin is used in a standalone
 * test without a coreDirectory — we degrade to emitting plain library URLs
 * (the historical behaviour).
 */
export interface RemarkLibraryLinksOptions {
  coreDirectory?: string;
  spaces?: readonly SpaceInfo[];
  spacesReady?: boolean;
}

// URI scheme pattern (e.g., http:, mailto:, workspace:)
const URI_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

// Windows drive letter pattern (e.g., C:, D:)
const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

/**
 * Check if URL looks like a Windows drive path (e.g., C:\path or C:/path)
 */
function isWindowsDrivePath(url: string): boolean {
  return WINDOWS_DRIVE_RE.test(url);
}

/**
 * Check if URL has a protocol scheme (excluding Windows drive letters)
 */
function isProtocolUrl(url: string): boolean {
  return URI_SCHEME_RE.test(url) && !isWindowsDrivePath(url);
}

/**
 * Determine if a URL should be transformed to canonical rebel://library/ form.
 * Returns true for relative paths, absolute paths, and Windows paths.
 * Returns false for empty, anchor-only, protocol-relative, and protocol URLs.
 */
function shouldTransform(url: string): boolean {
  if (!url || url === '') return false; // empty URL
  if (url.startsWith('#')) return false; // anchor-only
  if (url.startsWith('//')) return false; // protocol-relative URL
  if (isProtocolUrl(url)) return false; // http:, mailto:, workspace:, etc.
  // Transform relative paths, absolute paths, and Windows paths
  return true;
}

/**
 * Remark plugin that transforms file path links to the best canonical rebel://
 * URL — `rebel://space/{name}/...` for shareable-space files,
 * `rebel://library/{workspace-relative}` otherwise.
 *
 * Example:
 *   [Doc](docs/file.md) → [Doc](rebel://library/docs%2Ffile.md)
 *   [Doc](SharedSpace/Q1.md) → [Doc](rebel://space/SharedSpace/Q1.md)
 *   [Section](docs/file.md#heading) → [Section](rebel://library/docs%2Ffile.md#heading)
 *
 * Pass `coreDirectory`, `spaces`, `spacesReady` to enable space-URL emission;
 * without them (or with `spacesReady=false`) the plugin falls back to library
 * form.
 */
export const remarkLibraryLinks = (options: RemarkLibraryLinksOptions = {}) => (tree: Root) => {
  const { coreDirectory, spaces, spacesReady } = options;
  const canChooseSpaceForm = typeof coreDirectory === 'string' && coreDirectory.length > 0;

  // INTENT: `linkReference` / `imageReference` / `definition` nodes are
  // intentionally NOT rewritten here. A single `definition` can be shared by
  // both link and image references, but links prefer `toBestFileLink` while
  // images require `formatLibraryUrl`, so we cannot choose one formatter
  // consistently without breaking one surface. Tracked as follow-up I11.
  visit(tree, 'link', (node: Link) => {
    let url = node.url;

    if (!shouldTransform(url)) {
      return;
    }

    // Handle already-encoded URLs by decoding first
    try {
      url = decodeURIComponent(url);
    } catch {
      // If decoding fails, use URL as-is
    }

    // Split on # or ? to preserve fragment/query (avoid encoding them)
    // Find the first occurrence of either separator
    const hashIndex = url.indexOf('#');
    const queryIndex = url.indexOf('?');
    const separatorIndex =
      hashIndex >= 0 && queryIndex >= 0
        ? Math.min(hashIndex, queryIndex)
        : hashIndex >= 0
          ? hashIndex
          : queryIndex;
    const basePath = separatorIndex >= 0 ? url.slice(0, separatorIndex) : url;
    const suffix = separatorIndex >= 0 ? url.slice(separatorIndex) : null;
    const kind = basePath.endsWith('/') ? 'folder' : 'file';

    // Encode the path but not the fragment/query suffix
    const encoded = canChooseSpaceForm
      ? toBestFileLink(
          basePath,
          {
            coreDirectory,
            spaces: spaces ?? [],
            spacesReady: spacesReady ?? false,
          },
          kind,
        )
      : formatLibraryUrl(basePath);

    // `toBestFileLink` may emit a `rebel://space/...?type=folder` URL with
    // its own query string for folders — don't re-append user suffix in
    // that case (avoids duplicated `?` segments). Library-form emissions
    // and file-space emissions have no intrinsic suffix, so append the
    // original fragment/query unchanged.
    const emittedHasQuery = encoded.includes('?');
    const finalUrl = suffix
      ? emittedHasQuery
        ? encoded
        : `${encoded}${suffix}`
      : encoded;
    node.url = finalUrl;
  });

  visit(tree, 'image', (node: Image) => {
    if (!shouldTransform(node.url)) {
      return;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(node.url);
    } catch {
      decoded = node.url;
    }

    // INTENT (intent-critical — see docs/plans/260422_broken_image_followups_i6_i7.md,
    // Stage I6). Image emission MUST use formatLibraryUrl (rebel://library/),
    // never toBestFileLink (which can emit rebel://space/... for shareable spaces).
    // The downstream img renderer in MessageMarkdown.tsx decodes via
    // extractLibraryPath, which does NOT recognise rebel://space/. Emitting a
    // space-URL here would silently break images in shareable spaces. Links
    // legitimately use toBestFileLink because link click routing DOES handle
    // rebel://space/. A future agent "unifying" the two visitors on either
    // formatter would regress one surface or the other. Guarded by test T12.
    //
    // Defensive: `formatLibraryUrl` calls `encodeURIComponent`, which throws
    // on malformed Unicode (e.g. lone surrogates). Fall back to the original
    // URL rather than crashing the whole markdown render.
    try {
      node.url = formatLibraryUrl(decoded);
    } catch (error) {
      // Leave `node.url` untouched. The downstream `<img>` renderer in
      // `MessageMarkdown` still routes non-`http:`/`data:` URLs through
      // `AutoLoadImage`, so the image will most likely fail to load rather
      // than render "externally". Surface the swallow so this path stays
      // observable per the "Silent failure is a bug" policy in AGENTS.md.
      console.warn('[Renderer] remarkLibraryLinks image fallback', {
        url: node.url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
