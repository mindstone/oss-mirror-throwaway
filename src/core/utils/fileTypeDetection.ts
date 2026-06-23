/**
 * First-bytes file-type detection for the built-in `Read` tool.
 *
 * IMPORTANT: every check here operates on a SMALL header buffer (the first N
 * bytes), never the whole file. `Read` reads only a header slice to classify a
 * file so an 8.9 MB image is never fully decoded just to discover it's an image.
 * (The previous `isBinaryFile` in `searchFilesTool.ts` was private, null-byte
 * only, and read the whole file.)
 *
 * See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 3.
 */
import {
  ANTHROPIC_IMAGE_BYTE_LIMIT,
  IMAGE_HARD_DIMENSION_LIMIT,
} from '@shared/attachmentLimits';
import { ignoreBestEffortCleanup } from '@shared/utils/intentionalSwallow';

/** Number of header bytes `Read` needs to classify a file (covers WEBP at offset 8-12). */
export const FILE_TYPE_HEADER_BYTES = 16;

/** Bytes scanned for the binary (non-image) heuristic. */
const BINARY_SCAN_BYTES = 512;

export type DetectedImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/**
 * Detect a supported image type from magic bytes in a header buffer.
 * - PNG:  89 50 4E 47
 * - JPEG: FF D8 FF
 * - GIF:  47 49 46 38 ("GIF8")
 * - WEBP: "RIFF" .... "WEBP"  (RIFF at 0-3, WEBP at 8-11)
 *
 * Returns the MIME type, or null if the header does not match a supported image.
 */
export const detectImageMimeType = (header: Buffer): DetectedImageType | null => {
  if (header.length >= 4
    && header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return 'image/png';
  }
  if (header.length >= 3
    && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }
  if (header.length >= 4
    && header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) {
    return 'image/gif';
  }
  if (header.length >= 12
    && header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 // "RIFF"
    && header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) { // "WEBP"
    return 'image/webp';
  }
  return null;
};

/**
 * Conservative binary detector that scans only the first bytes of a buffer.
 *
 * Treats content as binary if it contains a NUL byte (a strong text/binary
 * signal) OR an unusually high ratio of non-printable control bytes. Tabs,
 * newlines, carriage returns, and form-feed are treated as printable so normal
 * UTF-8 text (incl. files with BOMs and emoji) is never misclassified.
 */
export const isBinaryHeader = (header: Buffer): boolean => {
  const scanLength = Math.min(header.length, BINARY_SCAN_BYTES);
  if (scanLength === 0) {
    return false; // empty file → treat as (empty) text
  }
  let suspicious = 0;
  for (let i = 0; i < scanLength; i++) {
    const byte = header[i];
    if (byte === 0) {
      return true; // NUL byte → definitively binary
    }
    // Allow common text control chars: tab(9) LF(10) CR(13) FF(12) and ESC(27).
    const isAllowedControl = byte === 9 || byte === 10 || byte === 12 || byte === 13 || byte === 27;
    if (byte < 32 && !isAllowedControl) {
      suspicious += 1;
    }
  }
  // >10% non-text control bytes in the header → binary.
  return suspicious / scanLength > 0.1;
};

export interface ImageDimensions {
  width: number;
  height: number;
}

const parseWebpDimensions = (buf: Buffer): ImageDimensions | null => {
  if (buf.length < 16) return null;
  const format = buf.toString('ascii', 12, 16);
  if (format === 'VP8 ') {
    // Lossy: dimensions in the frame header (14-bit each) at offset 26.
    if (buf.length < 30) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  if (format === 'VP8L') {
    // Lossless: 1 signature byte (0x2f) then 14+14 bits packed.
    if (buf.length < 25 || buf[20] !== 0x2f) return null;
    const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (format === 'VP8X') {
    // Extended: 24-bit (minus 1) canvas width/height at offset 24/27.
    if (buf.length < 30) return null;
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  return null;
};

const parseJpegDimensions = (buf: Buffer): ImageDimensions | null => {
  // Walk JPEG marker segments looking for a Start-Of-Frame (SOFn) marker, which
  // carries height(2) width(2) big-endian after a 1-byte precision field.
  let offset = 2; // skip SOI (FF D8)
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0..SOF15 except DHT(C4), DAC(CC), and RSTn(D0-D7).
    const isSof = marker >= 0xc0 && marker <= 0xcf
      && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height };
    }
    // Standalone markers (no length): SOI/EOI/RSTn/TEM — advance past the marker.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    // Segment with a 2-byte length following the marker.
    const segLen = buf.readUInt16BE(offset + 2);
    if (segLen < 2) return null;
    offset += 2 + segLen;
  }
  return null;
};

const parseImageDimensionsRaw = (
  buf: Buffer,
  mimeType: DetectedImageType,
): ImageDimensions | null => {
  switch (mimeType) {
    case 'image/png':
      // IHDR is the first chunk: 8-byte sig, 4-byte len, 4-byte type "IHDR",
      // then width(4) height(4) big-endian. width starts at offset 16.
      if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      return null;
    case 'image/gif':
      // Logical screen descriptor: width(2) height(2) little-endian at offset 6.
      if (buf.length >= 10) {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      return null;
    case 'image/webp':
      return parseWebpDimensions(buf);
    case 'image/jpeg':
      return parseJpegDimensions(buf);
    default:
      return null;
  }
};

/**
 * Best-effort image dimension parser. Operates on the full image buffer (cheap
 * — the bytes are already in memory before we decide whether to send a vision
 * block) and reads width/height straight from the container header without
 * decoding pixels.
 *
 * Supports PNG, GIF, WEBP (VP8 / VP8L / VP8X), and JPEG (scans for the first
 * SOF marker). Returns null when the dimensions can't be located — callers
 * MUST treat null conservatively (the encoded-size cap is the primary guard;
 * an unparseable dimension should not, on its own, force a placeholder).
 */
export const parseImageDimensions = (
  buf: Buffer,
  mimeType: DetectedImageType,
): ImageDimensions | null => {
  try {
    return parseImageDimensionsRaw(buf, mimeType);
  } catch (error) {
    // A malformed/truncated header can make a bounded read throw. Treat as
    // "unknown dimensions" — the encoded-size cap remains the primary guard.
    ignoreBestEffortCleanup(error, {
      operation: 'parseImageDimensions',
      reason: 'Malformed image header; dimension parse is best-effort, fall back to unknown.',
    });
    return null;
  }
};

/**
 * Exact byte length of a base64 string (ignoring whitespace), without decoding.
 * Each 4-char group encodes 3 bytes; `=` padding counts toward the length.
 */
const base64StringByteLength = (data: string): number => {
  // The provider limit is on the literal base64 string length. Strip nothing —
  // `data` is the exact payload we'd send.
  return data.length;
};

export type ImageGuardVerdict =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * Universal safety guard for an inline image content block destined for a
 * vision-capable provider, regardless of which tool/MCP/fallback produced it.
 *
 * Enforces the SAME limits as `Read`'s friendly per-tool guard:
 *  - encoded base64 length ≤ `ANTHROPIC_IMAGE_BYTE_LIMIT` (the provider checks
 *    the encoded string, which inflates ~33% over decoded bytes);
 *  - pixel dimensions ≤ `IMAGE_HARD_DIMENSION_LIMIT` (best-effort; an
 *    unparseable header is NOT treated as a failure — the byte cap is primary).
 *
 * This is the universal backstop the model-facing boundary applies to ANY
 * image block (mirroring the universal text cap), so an oversized image from a
 * non-Read source can't reach a provider and trigger a rejection.
 *
 * See docs/plans/260529_guard-large-tool-outputs/PLAN.md § Stage 4 (#2).
 */
export const checkInlineImageWithinLimits = (
  data: string,
  mimeType: string,
): ImageGuardVerdict => {
  const encodedBytes = base64StringByteLength(data);
  if (encodedBytes > ANTHROPIC_IMAGE_BYTE_LIMIT) {
    return {
      ok: false,
      reason: `base64-encoded size ${Math.round(encodedBytes / 1024)} KiB exceeds the `
        + `${Math.round(ANTHROPIC_IMAGE_BYTE_LIMIT / 1024)} KiB provider limit`,
    };
  }

  const detected = mimeType === 'image/png' || mimeType === 'image/jpeg'
    || mimeType === 'image/gif' || mimeType === 'image/webp'
    ? (mimeType as DetectedImageType)
    : null;
  if (detected) {
    // `Buffer.from(_, 'base64')` is lenient (never throws — invalid chars are
    // skipped), and `parseImageDimensions` is itself try/caught, so no guard
    // is needed here.
    const decoded = Buffer.from(data, 'base64');
    const dimensions = parseImageDimensions(decoded, detected);
    if (
      dimensions
      && (dimensions.width > IMAGE_HARD_DIMENSION_LIMIT
        || dimensions.height > IMAGE_HARD_DIMENSION_LIMIT)
    ) {
      return {
        ok: false,
        reason: `dimensions ${dimensions.width}x${dimensions.height}px exceed the `
          + `${IMAGE_HARD_DIMENSION_LIMIT}px provider limit`,
      };
    }
  }

  return { ok: true };
};

/**
 * Text placeholder for an inline image block that a VISION-capable provider would
 * accept by capability but which exceeds the provider's encoded-size / pixel
 * limits and would be rejected. Shared by the fresh model-facing boundary
 * (`buildModelFacingToolResultContent`) AND the history/replay translators so an
 * oversized image is reduced to the SAME placeholder whether it is freshly
 * produced or replayed from persisted history.
 *
 * `index` is the zero-based position of the image among the result's image
 * blocks (rendered 1-based for humans).
 */
export const buildOversizedImagePlaceholder = (index: number, reason: string): string =>
  `[Image ${index + 1} omitted — ${reason}. The image was too large to send inline; `
  + `re-read it from disk to view a downscaled version if needed.]`;

/**
 * Shared instruction suffix appended to EVERY vision-unsupported placeholder
 * (both builders below + the screenshot variants in agentLoop.ts). Without it,
 * non-vision models tend to silently work around the missing image — guessing
 * its contents or quietly pressing on — instead of surfacing the limitation to
 * whoever invoked them. One const so the copy cannot drift across the call
 * sites; exact-string tests assert on this const rather than re-inlining it.
 * NOT used by the malformed-image placeholder (model IS vision-capable there).
 */
export const VISION_UNSUPPORTED_REPORT_INSTRUCTION =
  'You cannot see this image — do not guess or assume its contents. '
  + 'Tell whoever invoked you (the user or the orchestrating agent) that you could not view it '
  + 'because the current model lacks vision, and that switching to a vision-capable model would let it be seen.';

/**
 * Text placeholder for an inline image block dropped because the ACTIVE model
 * is not vision-capable (so an image block would error). Shared by the fresh
 * boundary and the replay translators. Mirrors the fresh-path message but is
 * generic over the source tool (history may not carry a screenshot path).
 * Copy says "model", not "provider": gating is per-MODEL since 260610
 * (supportsImageContent(model)), and switching models on the SAME provider
 * can restore vision. Ends with the shared report-to-caller instruction so
 * the model reports the limitation instead of silently working around it.
 */
export const buildVisionUnsupportedImagePlaceholder = (index: number): string =>
  `[Image ${index + 1} omitted — vision is not supported by the current model; `
  + `re-read it from disk to view it with a vision-capable model. `
  + `${VISION_UNSUPPORTED_REPORT_INSTRUCTION}]`;

/**
 * Text placeholder for a USER-ATTACHED (direct) image block bound for a model
 * that can't view images. Sibling of `buildVisionUnsupportedImagePlaceholder`
 * (tool-result copy says "re-read it from disk", which is wrong for a pasted
 * screenshot/attachment — there is no path to re-read). Shared by both wire
 * translators (anthropicClient `toAnthropicMessages`, openaiTranslators
 * `buildDirectUserContentParts`). SUBSTITUTE, never drop — postmortem
 * 260506_openai_translator_user_image_block_drop. Substitution is
 * translate-time only: persisted history keeps the real image, so switching
 * to a vision-capable model re-sends actual images. Ends with the shared
 * report-to-caller instruction so the model reports the limitation instead of
 * silently working around it.
 */
export const buildVisionUnsupportedAttachmentPlaceholder = (index: number): string =>
  `[Image attachment ${index + 1} omitted — the current model can't view images. `
  + `Switch to a vision-capable model to include it. `
  + `${VISION_UNSUPPORTED_REPORT_INSTRUCTION}]`;

/**
 * Text placeholder for a direct user image block whose payload is MALFORMED
 * (fails the strict base64 shape check) while the model IS vision-capable.
 * Before 260610 Stage 5 this corner silently dropped the block — the exact
 * shape of postmortem 260506_openai_translator_user_image_block_drop, which
 * established SUBSTITUTE, never drop for this path. The model must be told an
 * attachment existed even when we can't send it.
 */
export const buildUnsendableImageAttachmentPlaceholder = (index: number): string =>
  `[Image attachment ${index + 1} omitted — the attachment data was malformed and could not be sent. `
  + `Ask the user to re-attach the image if it matters.]`;
