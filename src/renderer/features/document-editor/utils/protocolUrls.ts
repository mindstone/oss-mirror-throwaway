import { basename, join } from 'pathe';

/**
 * Convert a tutorial file path to the rebel-tutorial:// protocol URL.
 * Uses triple-slash format (no host) so pathname parsing works correctly.
 * e.g., "rebel-system/help-for-humans/tutorials/foo.html" -> "rebel-tutorial:///tutorials/foo.html"
 */
export const getTutorialProtocolUrl = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  const helpForHumansPrefix = 'rebel-system/help-for-humans/';
  if (normalized.startsWith(helpForHumansPrefix)) {
    const relativePath = normalized.slice(helpForHumansPrefix.length);
    return `rebel-tutorial:///${relativePath}`;
  }
  return `rebel-tutorial:///tutorials/${basename(filePath)}`;
};

/**
 * Convert a workspace-relative path to the rebel-html:// protocol URL.
 * Uses triple-slash format and URL encoding for proper path handling.
 * e.g., "work/project/file.html" -> "rebel-html:///work%2Fproject%2Ffile.html"
 */
export const getHtmlProtocolUrl = (filePath: string): string => {
  const normalized = filePath.replace(/\\/g, '/');
  return `rebel-html:///${encodeURIComponent(normalized)}`;
};

/**
 * Convert a workspace-relative path to rebel-media:// URL for streaming.
 * Used for video/audio files that need range-request support.
 *
 * Requires `coreDirectory` (workspace root) to construct the absolute path.
 *
 * URL shape: `rebel-media://local/<encoded-absolute-path>`. The full absolute
 * path is percent-encoded into a single path segment, with the literal host
 * sentinel `local` filling the authority slot. The sentinel matters because:
 *
 * 1. `rebel-media` is registered with `standard: true`, and Chromium's
 *    standard-scheme URL parser **rejects** the empty-authority triple-slash
 *    form (`rebel-media:///%2F...`) outright — both `new URL()` and the
 *    media-element loader treat it as a "Media load rejected by URL safety
 *    check". So we cannot use a triple-slash form here.
 * 2. With a non-sentinel host (e.g. the raw drive-letter `C` or a real path
 *    segment like `Users`), Chromium silently promotes part of the path into
 *    the host slot and lowercases it, dropping segments — the original bug.
 *
 * `local` is a multi-character non-drive-letter token that round-trips safely
 * through Chromium and unambiguously signals "decode the pathname as an
 * absolute file path" to the protocol handler.
 */
export const getMediaProtocolUrl = (
  relativePath: string,
  coreDirectory: string,
): string => {
  const isAbsolute = relativePath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(relativePath);
  const absolutePath = isAbsolute ? relativePath : join(coreDirectory, relativePath);
  const normalized = absolutePath.replace(/\\/g, '/');
  return `rebel-media://local/${encodeURIComponent(normalized)}`;
};
