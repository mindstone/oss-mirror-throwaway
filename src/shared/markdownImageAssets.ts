/**
 * Shared policies and helpers for markdown image assets.
 * Used by both renderer (validation before IPC) and main (validation before write).
 */

export const ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export const MAX_IMAGE_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export const MAX_BATCH_IMAGE_COUNT = 5;
export const MAX_BATCH_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20 MB

export const IMAGE_MIME_TO_EXTENSION: Record<AllowedImageMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function isReservedWindowsAssetName(name: string): boolean {
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(
    name.trim().replace(/[.\s]+$/g, ""),
  );
}

/**
 * Sanitize an image filename stem or document basename to be safe for asset folder and file names.
 * Removes path separators, control chars, markdown-hostile characters, and trims dots/spaces.
 */
export function sanitizeAssetIdentifier(
  name: string,
  fallback: string,
): string {
  // Remove control characters, path separators, quotes, brackets, and newlines
  let safe = name.replace(/[\x00-\x1F\x7F\\/:"*?<>|\[\]()]/g, "-");
  // Markdown image destinations are simplest and most portable without whitespace.
  safe = safe.replace(/\s+/g, "-");
  // Collapse multiple dashes
  safe = safe.replace(/-+/g, "-");
  // Trim dots, spaces, and dashes from ends
  safe = safe.replace(/^[.\s-]+|[.\s-]+$/g, "");

  if (isReservedWindowsAssetName(safe)) {
    return fallback;
  }

  if (!safe) return fallback;

  // Limit length to avoid overlong names
  if (safe.length > 100) {
    safe = safe.substring(0, 100).replace(/[.\s-]+$/, "");
  }

  return safe || fallback;
}

/** Check if a given MIME type is in the allowed list for new imports. */
export function isAllowedImageMimeType(
  mimeType: string,
): mimeType is AllowedImageMimeType {
  return ALLOWED_IMAGE_MIME_TYPES.includes(mimeType as AllowedImageMimeType);
}

/** Check if an existing data URL is considered a safe allowed bitmap format. */
export function isAllowedDataUrlMimeType(dataUrl: string): boolean {
  const match = dataUrl.trimStart().match(/^data:([^;,]+)(?:[;,]|$)/i);
  if (!match) return false;
  return isAllowedImageMimeType(match[1].toLowerCase());
}
