/**
 * Shared file attachment utilities — pure validation, categorisation,
 * and size estimation functions.
 *
 * Consumed by:
 * - Desktop renderer `useFileAttachments` hook
 * - Cloud-client `useWebFileAttachments` hook
 * - Mobile `useMobileFileAttachments` hook (future)
 *
 * All functions are pure (no DOM, File API, or platform-specific dependencies).
 * Constants (MIME types, size limits) live in `./attachmentLimits.ts`.
 */

import {
  VALID_IMAGE_MIME_TYPES,
  TEXT_BASED_MIME_TYPES,
  TEXT_FILE_EXTENSIONS,
} from './attachmentLimits';

// ---------------------------------------------------------------------------
// Size estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the decoded byte size of a base64-encoded string.
 * Approximates the binary payload size from base64 character length.
 *
 * NOTE: This is the DECODED size, not the base64 string size. Use
 * `getBase64EncodedByteLength` when comparing against API limits that
 * are checked on the base64 source itself (e.g., Anthropic's 5 MB
 * per-image limit).
 */
export function estimateBase64Bytes(base64: string): number {
  return Math.ceil((base64.length * 3) / 4);
}

/**
 * Get the byte length of a base64-encoded STRING (not the decoded payload).
 *
 * Use this when comparing against API limits checked on the base64 source.
 * Anthropic's 5 MB per-image limit is one such case — the API rejects with:
 *   "messages.X.content.Y.image.source.base64: image exceeds 5 MB maximum:
 *    <N> bytes > 5242880 bytes"
 * where `<N>` is the base64 string byte length, not the decoded PNG size.
 *
 * Base64 is ASCII-only so character length equals byte length.
 *
 * For decoded payload size, use `estimateBase64Bytes` instead.
 */
export function getBase64EncodedByteLength(base64: string): number {
  return base64.length;
}

/** Minimal attachment shape for payload estimation. */
export interface AttachmentPayloadInfo {
  type: string;
  base64Data?: string;
  contentSizeBytes?: number;
}

/**
 * Estimate the transport payload size of a file attachment.
 *
 * For text file attachments, returns `contentSizeBytes`.
 * For image/document/binary attachments, returns the base64 string length
 * (JSON-serialised base64 is already ~33% larger than binary).
 */
export function estimateAttachmentPayloadBytes(att: AttachmentPayloadInfo): number {
  if (att.type === 'textfile' && att.contentSizeBytes != null) return att.contentSizeBytes;
  return att.base64Data?.length ?? 0;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a file size is within the allowed limit.
 */
export function validateFileSize(sizeBytes: number, maxBytes: number): boolean {
  return sizeBytes <= maxBytes;
}

// ---------------------------------------------------------------------------
// MIME / extension categorisation
// ---------------------------------------------------------------------------

/**
 * Check whether a MIME type is a recognised image type (Anthropic API compatible).
 */
export function isValidImageMimeType(mimeType: string): boolean {
  return VALID_IMAGE_MIME_TYPES.includes(mimeType);
}

/**
 * Detect HEIC/HEIF files by MIME type or file extension.
 * Accepts primitive strings for platform-agnostic usage.
 */
export function isHeicFileType(name: string, type: string): boolean {
  const heicMimeTypes = ['image/heic', 'image/heif'];
  if (heicMimeTypes.includes(type.toLowerCase())) return true;
  const lowerName = name.toLowerCase();
  return lowerName.endsWith('.heic') || lowerName.endsWith('.heif');
}

/**
 * Check whether a MIME type indicates text-based content.
 * Matches any `text/*` MIME type or known text-like application types
 * (e.g., `application/json`, `application/xml`).
 */
export function isTextBasedMimeType(mimeType: string): boolean {
  return mimeType.startsWith('text/') || TEXT_BASED_MIME_TYPES.includes(mimeType);
}

/**
 * Check whether a file name has a text-file extension
 * (e.g., `.ts`, `.py`, `.md`, `.json`).
 */
export function isTextFileByExtension(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();
  return TEXT_FILE_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

/**
 * Check whether a file is text-based, by MIME type or extension.
 * Combined check — use when you have both name and type available.
 */
export function isTextBasedFile(name: string, mimeType: string): boolean {
  return isTextBasedMimeType(mimeType) || isTextFileByExtension(name);
}

// ---------------------------------------------------------------------------
// File categorisation
// ---------------------------------------------------------------------------

/** High-level file category shared across all platforms. */
export type FileCategory = 'image' | 'document' | 'textfile' | 'unknown';

/**
 * Categorise a file by name and MIME type.
 *
 * Returns one of:
 * - `'image'` — recognised image MIME or HEIC/HEIF
 * - `'document'` — PDF
 * - `'textfile'` — text-based MIME or text-file extension
 * - `'unknown'` — none of the above (platform hooks handle this case)
 */
export function categorizeFile(name: string, mimeType: string): FileCategory {
  if (isHeicFileType(name, mimeType)) return 'image';
  if (isValidImageMimeType(mimeType)) return 'image';
  if (mimeType === 'application/pdf') return 'document';
  if (isTextBasedFile(name, mimeType)) return 'textfile';
  return 'unknown';
}
