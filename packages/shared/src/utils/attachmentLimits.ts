/**
 * Shared attachment constants — single source of truth.
 *
 * Consumed by:
 * - Desktop renderer via `@shared/attachmentLimits` (re-exports from here)
 * - Main process via `@shared/attachmentLimits`
 * - Cloud-client via `@rebel/shared`
 * - Mobile via `@rebel/shared`
 *
 * Platform-specific overrides (e.g. desktop allows larger images/PDFs) are
 * applied locally in each platform's attachment hook.
 */

// ---------------------------------------------------------------------------
// Size limits (web/mobile defaults — desktop overrides some of these)
// ---------------------------------------------------------------------------

/** Max extracted text per attachment (~250k tokens at ~4 chars/token). */
export const MAX_EXTRACTED_TEXT_BYTES = 1024 * 1024; // 1MB

/** Max number of file attachments per message. */
export const MAX_FILE_ATTACHMENTS = 5;

/** Max image size — 5MB for web/mobile. Desktop overrides to 10MB. */
export const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/** Max PDF size — 5MB for web/mobile. Desktop overrides to 32MB (Anthropic limit). */
export const MAX_PDF_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/** Max text file size — 2MB for web/mobile. Desktop overrides to 5MB. */
export const MAX_TEXT_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2MB

/** Max total payload size (WS maxPayload 10MB; base64 inflates ~33%; leaves room for JSON envelope). */
export const MAX_TOTAL_PAYLOAD_BYTES = 8 * 1024 * 1024; // 8MB

/** Max HEIC image size (HEIC files are large but highly compressed). */
export const MAX_HEIC_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * @deprecated Used historically as an aggressive resize cap; see
 * `IMAGE_HARD_DIMENSION_LIMIT` for the new limit-only resize policy.
 * Retained for back-compat.
 */
export const OPTIMAL_MAX_DIMENSION = 1568;

/**
 * Anthropic's hard ceiling for image dimensions; images larger than this are
 * unconditionally rejected by the API. We resize down to this only when the
 * source exceeds it — otherwise images are sent at native resolution to
 * preserve OCR-quality text legibility.
 *
 * See `docs-private/investigations/260428_screenshot_text_unreadable.md` for the
 * limit-only resize design (FOX-3173 / REBEL-4ZQ).
 */
export const IMAGE_HARD_DIMENSION_LIMIT = 8000;

/**
 * Anthropic's hard per-image limit on the base64-encoded source.
 * Source: HTTP 400 invalid_request_error
 *   "messages.X.content.Y.image.source.base64: image exceeds 5 MB maximum: <N> bytes > 5242880 bytes"
 *
 * Note: this is checked on the base64 string, NOT the original file.
 * Base64 inflates ~33%, so any original >~3.75 MB risks exceeding this.
 *
 * Used by the byte-aware second-pass resize that runs after the dimension cap
 * to keep outbound images under this ceiling.
 */
export const ANTHROPIC_IMAGE_BYTE_LIMIT = 5 * 1024 * 1024;

/**
 * Compute the next max-dimension for the byte-aware downscale ladder.
 * Strategy: scale dimensions by sqrt(target/current) with a 5% safety margin,
 * floored at 512 px to avoid ridiculously small images.
 */
export function nextDimensionForByteTarget(
  currentMaxDimension: number,
  currentSizeBytes: number,
  targetMaxBytes: number,
  safetyMargin = 0.95,
  minDimension = 512,
): number {
  if (currentSizeBytes <= targetMaxBytes) return currentMaxDimension;
  const ratio = Math.sqrt(targetMaxBytes / currentSizeBytes) * safetyMargin;
  return Math.max(minDimension, Math.floor(currentMaxDimension * ratio));
}

// ---------------------------------------------------------------------------
// MIME type arrays
// ---------------------------------------------------------------------------

/** Image MIME types accepted by the Anthropic API. */
export const VALID_IMAGE_MIME_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Text-based MIME types we explicitly recognise (beyond `text/*`).
 * Uses the desktop superset — includes types like `application/sql`,
 * `application/x-sh`, and `application/x-python` that web/mobile may
 * not encounter but are harmless to accept.
 */
export const TEXT_BASED_MIME_TYPES: readonly string[] = [
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/x-yaml',
  'application/x-sh',
  'application/x-python',
  'application/sql',
];

// ---------------------------------------------------------------------------
// File extension arrays
// ---------------------------------------------------------------------------

/**
 * File extensions treated as text even when the MIME type is generic.
 * Uses the desktop superset — exhaustive list covering all common
 * programming languages, config formats, and markup languages.
 */
export const TEXT_FILE_EXTENSIONS: readonly string[] = [
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.csv',
  '.tsv',
  '.log',
  '.ini',
  '.conf',
  '.config',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  '.py',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.svg',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.vue',
  '.svelte',
  '.sql',
  '.graphql',
  '.gql',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.scala',
  '.rb',
  '.php',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.cxx',
  '.cs',
  '.fs',
  '.fsx',
  '.lua',
  '.r',
  '.pl',
  '.pm',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.hs',
  '.lhs',
  '.ml',
  '.mli',
  '.clj',
  '.cljs',
  '.cljc',
  '.dart',
  '.nim',
  '.zig',
  '.v',
  '.toml',
  '.lock',
  '.gitignore',
  '.dockerignore',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
];
