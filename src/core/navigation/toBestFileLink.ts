/**
 * toBestFileLink — choose the best rebel-URL form for a file/folder reference.
 *
 * Given a path (absolute or workspace-relative) that appears inside a chat
 * message, decide whether to emit:
 *   - `rebel://space/{SpaceName}/{relative}` — for files inside a *shareable*
 *     space (cross-user portable), or
 *   - `rebel://library/{workspace-relative}` — for private spaces,
 *     chief-of-staff, files outside any space, or when the spaces cache
 *     hasn't loaded yet (fail-closed).
 *
 * Pure + sync: called per-render by MessageMarkdown's 4 preprocessor sites
 * and by `remarkLibraryLinks`. No IPC, no I/O. `pathe`-based path ops keep
 * this safe to bundle in the renderer.
 *
 * See docs/plans/260418_finish_cross_surface_links_closeout.md — Stage 1
 * for the full algorithm rationale and review history (escape-guard fix,
 * symlink-source-path rebasing, etc.).
 */

import { isAbsolute, resolve } from 'pathe';
import type { SpaceInfo } from '@shared/ipc/schemas/library';
import {
  matchPathToSpace,
  isShareableSpace,
  resolveMatchRoot,
  getCanonicalSpaceName,
} from '@core/services/spacePathMatcher';
import { relativePortablePath, toPortablePath } from '@core/utils/portablePath';
import {
  formatLibraryUrl,
  formatNavigationUrl,
} from '@shared/navigation/urlParser';

/**
 * Minimum context `toBestFileLink` needs. Pass `spacesReady=false` on first
 * render (before the spaces cache populates) so we fall back to library form
 * rather than guessing with an empty array.
 */
export interface BestFileLinkContext {
  /** Absolute path to the workspace root (same value as `settings.coreDirectory`). */
  coreDirectory: string;
  /** Spaces scanned from the workspace — empty until the scanSpaces IPC resolves. */
  spaces: readonly SpaceInfo[];
  /**
   * Tri-state readiness. `false` means the spaces cache isn't populated yet —
   * we MUST NOT emit `rebel://space/` (might produce the wrong form for a
   * file that IS in a shared space but hasn't been matched yet). Emit library
   * form instead; re-renders flip this to `true` once data arrives.
   */
  spacesReady: boolean;
}

/** File vs folder — affects the emitted `rebel://space/` URL suffix. */
export type FileLinkKind = 'file' | 'folder';

/**
 * Return the best rebel-URL for `input`. `input` may be:
 *   - URL-encoded (e.g. `My%20Doc.md`) — we decode first
 *   - workspace-relative (`Exec/Q1.md`)
 *   - absolute (`/Users/.../Core/Exec/Q1.md` or `C:/Users/...`)
 *   - symlinked via `space.sourcePath` (Google Drive, etc.)
 *
 * Always returns a valid `rebel://` URL (or `""` for empty input). Never
 * throws; never emits a space URL for a private or unmatched path.
 *
 * @param input - raw path as it appears in the source markdown
 * @param ctx - core dir + spaces snapshot + readiness flag
 * @param kind - `'file'` (default) or `'folder'` (adds `?type=folder`)
 */
export function toBestFileLink(
  input: string,
  ctx: BestFileLinkContext,
  kind: FileLinkKind = 'file',
): string {
  // Step 1: URL-decode (remark-library-links already decodes, but the
  // preprocessors hand us raw strings too — so normalize here once).
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    decoded = input;
  }

  // Step 2: Empty guard — return empty string so downstream `[text](…)`
  // substitution produces a harmless `[text]()` that remark drops.
  if (!decoded || !decoded.trim()) {
    return '';
  }

  // Step 3: Match to a space (returns null if no match or if spaces is empty).
  const match = matchPathToSpace(decoded, ctx.spaces, ctx.coreDirectory);

  // Step 4: Fail-closed to library form when the spaces cache isn't ready
  // OR the path didn't match any space.
  if (!ctx.spacesReady || !match) {
    return toLibraryFallback(decoded, ctx.coreDirectory);
  }

  // Step 5: Derive the absolute input + match root + both candidate relative
  // paths. We compute both up front so escape-guards can fire before we pick
  // a branch.
  const absoluteInput = isAbsolute(decoded)
    ? toPortablePath(decoded)
    : resolve(ctx.coreDirectory, decoded);
  const matchRoot = resolveMatchRoot(match, absoluteInput);
  const spaceRelativePath = relativePortablePath(matchRoot, absoluteInput);
  const libraryFallbackPath = relativePortablePath(ctx.coreDirectory, absoluteInput);

  // Step 6 + 7: Shareability gate → emit space or library form with an
  // escape guard that preserves the ORIGINAL input (via `toPortablePath(input)`)
  // whenever `spaceRelativePath` escapes the matched space. The plan calls
  // this out explicitly (Must-fix #2, 260418): silently normalizing a
  // `..`-bearing path into a clean URL hides the escape intent from any
  // downstream reader and defeats traversal detection.
  //
  // Note on `libraryFallbackPath`: for SYMLINKED shareable spaces the
  // input can legitimately sit OUTSIDE `coreDirectory` (the symlink target
  // is in `~/Library/CloudStorage/...`). In that case `libraryFallbackPath`
  // starts with `..` but `spaceRelativePath` is clean — that's a valid
  // space-URL emission, NOT an escape. So we gate the space-URL emission
  // on `spaceRelativePath` only, and the library-fallback branch uses
  // `libraryFallbackPath.startsWith('..')` as a separate, preserved-escape
  // check.
  if (!isShareableSpace(match)) {
    // Private space (chief-of-staff, frontmatter.sharing='private', etc.):
    // always emit a library URL. If EITHER relative path shows an escape
    // (`..`-prefixed), preserve the original input — covers both
    // in-workspace `..` traversal and symlinked-space inputs whose
    // library fallback would otherwise be a `..`-prefixed escape string.
    if (libraryFallbackPath.startsWith('..') || spaceRelativePath.startsWith('..')) {
      return formatLibraryUrl(toPortablePath(input));
    }
    return formatLibraryUrl(libraryFallbackPath);
  }

  // Shareable space: emit space-relative URL unless the space-relative
  // path itself escapes (e.g., `SharedSpace/../other.md`). A `..`-prefixed
  // `libraryFallbackPath` alone is expected for symlinked spaces and is
  // NOT an escape.
  if (spaceRelativePath.startsWith('..')) {
    return formatLibraryUrl(toPortablePath(input));
  }

  const spaceName = getCanonicalSpaceName(match);
  if (kind === 'folder') {
    return formatNavigationUrl({
      type: 'space',
      spaceName,
      folderPath: spaceRelativePath,
    });
  }
  return formatNavigationUrl({
    type: 'space',
    spaceName,
    filePath: spaceRelativePath,
  });
}

/**
 * Build a `rebel://library/` URL for a decoded input that either did not
 * match any space, or was called before the spaces cache loaded. Workspace-
 * relative when the path sits under `coreDirectory`; otherwise we emit the
 * original input (portable-slashed) — still a library URL but not
 * workspace-relative. `formatLibraryUrl` URL-encodes for us.
 *
 * Escape preservation: when `decoded` contains `..` traversal segments, emit
 * the original input rather than the relative form. `relativePortablePath`
 * (and `matchPathToSpace`, post Run B) normalize `..` before computing, which
 * silently collapses `Exec/../other.md` into a clean `other.md` and hides the
 * escape intent from any downstream reader. Plan must-fix #2 (260418) and
 * postmortem `260330_safe_link_traversal_escape_silenced` cover the rationale.
 */
function toLibraryFallback(decoded: string, coreDirectory: string): string {
  if (hasTraversalSegment(decoded)) {
    return formatLibraryUrl(toPortablePath(decoded));
  }

  const absoluteInput = isAbsolute(decoded)
    ? toPortablePath(decoded)
    : resolve(coreDirectory, decoded);
  const fallbackRel = relativePortablePath(coreDirectory, absoluteInput);
  if (!fallbackRel.startsWith('..')) {
    return formatLibraryUrl(fallbackRel);
  }
  return formatLibraryUrl(toPortablePath(decoded));
}

/**
 * True iff `input` contains a `..` segment that would be collapsed by path
 * normalization. Matches `..` only when bounded by `/` or string ends so a
 * filename literally named `..notes.md` does not count as traversal.
 */
function hasTraversalSegment(input: string): boolean {
  if (input === '..') return true;
  if (input.startsWith('../')) return true;
  if (input.endsWith('/..')) return true;
  return input.includes('/../');
}
