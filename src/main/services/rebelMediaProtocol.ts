/**
 * Pure helpers for the `rebel-media://` custom protocol handler.
 *
 * The handler itself lives as a closure in `src/main/index.ts` (it needs the
 * Electron `protocol.handle` registration + a Node read stream for the body).
 * These helpers carry the *contract-bearing* parts — the extension→MIME map and
 * the response status/header computation (incl. byte-range handling) — out into
 * a pure, dependency-free module so they can be unit-tested deterministically
 * without registering an Electron protocol or touching the real filesystem.
 *
 * PDFs are served through this protocol (not a renderer-owned `blob:` URL):
 * under the packaged renderer's `file://` origin the in-app PDF preview rendered
 * a blank panel (viewer chrome attaches, document stays grey). The precise cause
 * — whether Chromium's out-of-process PDF viewer (MimeHandlerView) cannot fetch a
 * `blob:file://…` source — is runtime-UNCONFIRMED, but a privileged
 * `application/pdf` response over `rebel-media://` is origin-independent and
 * fetchable, which is the robust packaged path. See
 * `docs/plans/260619_pdf-viewer-blank/PLAN.md`.
 */

/**
 * Extension → MIME type map for the `rebel-media://` protocol. Keys are
 * lowercase extensions including the leading dot (e.g. `.pdf`).
 */
export const REBEL_MEDIA_MIME_TYPES: Readonly<Record<string, string>> = {
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  // Documents
  '.pdf': 'application/pdf',
  // Subtitles
  '.vtt': 'text/vtt',
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

/**
 * Resolve the MIME type for a lowercase file extension (including the dot).
 * Unknown extensions fall back to `application/octet-stream`.
 */
export const getRebelMediaMimeType = (ext: string): string =>
  REBEL_MEDIA_MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';

/**
 * A single resolved byte range over a file: inclusive `[start, end]`.
 */
export interface RebelMediaByteRange {
  start: number;
  end: number;
}

/**
 * Outcome of parsing a `Range` request header against a known file size.
 *
 * - `kind: 'full'`    — no (or empty) Range header → serve the whole file (200).
 * - `kind: 'partial'` — a single satisfiable range → serve 206.
 * - `kind: 'unsatisfiable'` — malformed / multi-range / out-of-bounds → 416.
 */
export type RebelMediaRangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; range: RebelMediaByteRange }
  | { kind: 'unsatisfiable' };

/**
 * Parse a `Range` request header against a file of `fileSize` bytes.
 *
 * Supports a single `bytes=<start>-<end>` spec, an open-ended `bytes=<start>-`,
 * and a suffix spec `bytes=-<n>` (last n bytes). Multi-range (comma-separated)
 * and malformed/out-of-bounds specs are reported as unsatisfiable (HTTP 416).
 */
export const parseRebelMediaRange = (
  rangeHeader: string | null,
  fileSize: number,
): RebelMediaRangeResult => {
  if (!rangeHeader) return { kind: 'full' };

  // Reject multi-range requests (comma-separated) — only single ranges supported.
  if (rangeHeader.includes(',')) return { kind: 'unsatisfiable' };

  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return { kind: 'unsatisfiable' };

  const startStr = match[1];
  const endStr = match[2];
  let start = startStr === '' ? NaN : parseInt(startStr, 10);
  let end = endStr === '' ? NaN : parseInt(endStr, 10);

  // Suffix-byte-range-spec: "bytes=-500" means the last 500 bytes.
  if (Number.isNaN(start) && !Number.isNaN(end)) {
    start = Math.max(fileSize - end, 0);
    end = fileSize - 1;
  } else {
    if (Number.isNaN(start) || start < 0 || start >= fileSize) {
      return { kind: 'unsatisfiable' };
    }
    if (Number.isNaN(end) || end >= fileSize) {
      end = fileSize - 1;
    }
  }

  if (end < start) return { kind: 'unsatisfiable' };

  return { kind: 'partial', range: { start, end } };
};

/**
 * The status + headers for a `rebel-media://` response, computed purely from the
 * file size, content type, and parsed range. The handler attaches the streaming
 * body (or a null body for 416) separately.
 */
export interface RebelMediaResponseInit {
  status: number;
  headers: Record<string, string>;
}

/**
 * Build the response status + headers for a `rebel-media://` request.
 *
 * Mirrors the three cases the handler serves:
 *  - full file        → 200 with `Content-Type`, `Content-Length`, `Accept-Ranges`.
 *  - partial (range)  → 206 with `Content-Range` + the chunk `Content-Length`.
 *  - unsatisfiable    → 416 with a `Content-Range: bytes (star)/<size>` header.
 */
export const buildRebelMediaResponseInit = (
  rangeResult: RebelMediaRangeResult,
  fileSize: number,
  contentType: string,
): RebelMediaResponseInit => {
  if (rangeResult.kind === 'unsatisfiable') {
    return {
      status: 416,
      headers: { 'Content-Range': `bytes */${fileSize}` },
    };
  }

  if (rangeResult.kind === 'full') {
    return {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
      },
    };
  }

  const { start, end } = rangeResult.range;
  const chunkSize = end - start + 1;
  return {
    status: 206,
    headers: {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': String(chunkSize),
      'Accept-Ranges': 'bytes',
    },
  };
};
