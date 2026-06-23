/**
 * Pure helpers for approval-content state derivation across desktop, cloud,
 * and mobile surfaces.
 *
 * Conflict detection, change-type derivation, binary-extension heuristics,
 * and read-error classification — all pure functions with no React, Zustand,
 * Electron, or other platform imports.
 *
 * Consumed by:
 * - `cloud-client/src/hooks/useApprovalContent.ts` (shared React hook)
 * - Indirectly by `src/renderer/features/inbox/components/*` (desktop dialogs)
 * - Indirectly by `mobile/src/components/approval/*` (mobile sheets, Stage 6)
 *
 * See `docs/plans/260416_centralize_approval_and_diff_viewing_ux.md` Stage 2.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * The error kinds the content-fetching layer can surface to UI.
 * `missing` is reserved for ENOENT-style "remote does not exist" — this is
 * NOT a user-visible error; it is handled as `isNewFile: true` at the hook
 * layer. The other kinds (permission, network, binary, other) ARE
 * user-visible errors that should surface in the dialog.
 */
export type ApprovalContentErrorKind =
  | 'missing'
  | 'permission'
  | 'network'
  | 'binary'
  | 'other';

export interface ApprovalContentError {
  kind: ApprovalContentErrorKind;
  detail: string;
}

/**
 * Semantic description of the staged change relative to the remote/original.
 * - `create`: remote does not exist (new file).
 * - `modify`: remote exists; staged content is a replacement.
 * - `delete`: staged content is explicitly null (tombstone). Reserved for
 *   future use; current code paths never emit this.
 */
export type ApprovalChangeType = 'create' | 'modify' | 'delete';

// =============================================================================
// detectConflict
// =============================================================================

/**
 * Detect whether the staged content differs from the remote/original content.
 *
 * Semantics:
 * - When BOTH sides are non-null: returns true iff they differ.
 * - When EITHER side is null: returns false. A missing original (ENOENT or
 *   intentional new file) is NOT a conflict by itself — it's a create.
 *   A missing staged is a delete — also not a conflict by itself.
 *
 * This is an extraction of the implicit conflict-detection logic currently
 * inline in `MemoryPreviewDialog` (`hasDiff = originalContent !== null &&
 * originalContent !== content`) and makes it reusable across surfaces.
 */
export function detectConflict(staged: string | null, original: string | null): boolean {
  if (staged === null || original === null) return false;
  return staged !== original;
}

// =============================================================================
// detectChangeType
// =============================================================================

/**
 * Derive the semantic change type from the fetched content state.
 *
 * @param staged - The staged/incoming content (null if tombstone).
 * @param _original - The remote/original content (included in signature for
 *                    symmetry and future expansion; currently unused because
 *                    `existsOnDisk` is the authoritative signal).
 * @param existsOnDisk - Whether the remote file exists (false when ENOENT
 *                       or metadata says new-file).
 */
export function detectChangeType(
  staged: string | null,
  _original: string | null,
  existsOnDisk: boolean,
): ApprovalChangeType {
  if (!existsOnDisk) return 'create';
  if (staged === null) return 'delete';
  return 'modify';
}

// =============================================================================
// isLikelyBinary
// =============================================================================

/**
 * Extensions whose content cannot be correctly represented as UTF-8 text.
 * The `readWorkspaceFile`/`memory:staging-get-content` IPC calls return
 * text — inspecting bytes client-side isn't possible — so we rely on the
 * extension as a fallback heuristic.
 *
 * Lower-case, with leading dot. Covers images, PDFs, archives, audio, video,
 * executables, fonts, design files, Office compound formats, and local DBs.
 */
const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff',
  '.heic', '.heif', '.avif',
  // Vector / layered design files (SVG is text but commonly treated as media;
  // we still allow diffing it because it's UTF-8 — so we DO NOT add it here.)
  '.psd', '.ai', '.sketch', '.fig', '.xd',
  // Documents
  '.pdf',
  // Office compound formats (binary containers)
  '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt',
  '.odt', '.ods', '.odp',
  // Archives
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.tbz2', '.7z', '.rar', '.xz',
  // Audio
  '.mp3', '.m4a', '.wav', '.ogg', '.flac', '.aac', '.wma',
  // Video
  '.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v', '.wmv', '.flv',
  // Executables / object files
  '.exe', '.dll', '.so', '.dylib', '.bin', '.class', '.jar', '.o',
  '.app', '.dmg', '.pkg', '.deb', '.rpm',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Local DBs
  '.db', '.sqlite', '.sqlite3', '.mdb',
]);

/**
 * Extension-based heuristic for binary/non-text content.
 *
 * Accepts:
 * - A full path: `/foo/bar/image.png` → true
 * - A relative path: `assets/logo.svg` → false
 * - A bare extension with leading dot: `.zip` → true
 * - A bare extension without leading dot: `pdf` → true (treated as the
 *   extension `.pdf`)
 * - Empty string: false
 * - Paths with no extension: false (we can't say without bytes, so assume
 *   text — caller will attempt read and surface a real error if wrong).
 *
 * Case-insensitive (`.JPG` === `.jpg`).
 */
export function isLikelyBinary(pathOrExtension: string): boolean {
  if (!pathOrExtension) return false;

  const normalized = pathOrExtension.toLowerCase();
  // Strip query/fragment if present (defensive — should not reach here but
  // cheap to handle).
  const withoutQuery = normalized.split(/[?#]/)[0];

  // Extract the basename to avoid matching a dot in a parent directory path
  // (e.g., "/foo.bar/notes" should NOT be treated as ".bar/notes").
  const slashIdx = Math.max(withoutQuery.lastIndexOf('/'), withoutQuery.lastIndexOf('\\'));
  const basename = slashIdx >= 0 ? withoutQuery.slice(slashIdx + 1) : withoutQuery;

  const lastDot = basename.lastIndexOf('.');
  let ext: string;
  if (lastDot < 0) {
    // No dot: treat the whole thing as a bare extension (defensive).
    ext = '.' + basename;
  } else if (lastDot === 0) {
    // Leading dot only, or dotfile: take as-is for ".zip"; for ".gitignore"
    // this returns "." + "gitignore" → ".gitignore" which is not in the
    // allowlist → false. Works as intended.
    ext = basename;
  } else {
    ext = basename.slice(lastDot);
  }

  return BINARY_EXTENSIONS.has(ext);
}

// =============================================================================
// classifyReadError
// =============================================================================

const PERMISSION_PATTERNS: readonly RegExp[] = [
  /\beacces\b/i,
  /\beperm\b/i,
  /permission denied/i,
];

const NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /\benoent\b/i,
  /no such file/i,
  /\bnot found\b/i,
  /file does not exist/i,
];

const NETWORK_PATTERNS: readonly RegExp[] = [
  /failed to fetch/i,
  /network request failed/i,
  /\betimedout\b/i,
  /\becon(nreset|nrefused)\b/i,
  /fetch .*failed/i,
  /\btimed? out\b/i,
  /\bnetwork\b.*\b(error|failure|unreachable)\b/i,
];

/**
 * Classify an unknown error into one of {@link ApprovalContentErrorKind}.
 *
 * Strategy:
 * 1. Honor an explicit Node-style `code` field if present (most reliable on
 *    desktop where the error originates from `fs`).
 * 2. Fall back to pattern-matching `err.message` for errors that traversed
 *    IPC (the `code` field is frequently stripped during serialization).
 * 3. Default to `other` when no pattern matches — never return `missing`
 *    speculatively; ENOENT must be explicit.
 */
export function classifyReadError(err: unknown): ApprovalContentError {
  const message = err instanceof Error
    ? err.message
    : String(err ?? 'Unknown error');

  const code = (err && typeof err === 'object' && 'code' in err)
    ? String((err as { code?: unknown }).code ?? '')
    : '';

  if (code === 'ENOENT' || NOT_FOUND_PATTERNS.some((p) => p.test(message))) {
    return { kind: 'missing', detail: message };
  }
  if (code === 'EACCES' || code === 'EPERM' || PERMISSION_PATTERNS.some((p) => p.test(message))) {
    return { kind: 'permission', detail: message };
  }
  // AbortError must classify as 'other' — callers should check aborted before
  // reading this. We still set a reasonable detail string.
  if (err instanceof Error && err.name === 'AbortError') {
    return { kind: 'other', detail: message };
  }
  if (NETWORK_PATTERNS.some((p) => p.test(message))) {
    return { kind: 'network', detail: message };
  }
  return { kind: 'other', detail: message };
}
