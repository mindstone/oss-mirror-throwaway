import { Buffer } from 'node:buffer';
import { CONTENT_REF_THRESHOLD_BYTES } from '@core/contentStore';

export interface TruncationResult {
  text: string;
  wasTruncated: boolean;
  originalBytes: number;
  keptBytes: number;
  marker: string;
}

function utf8SafeHead(bytes: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) {
    end -= 1;
  }
  return bytes.slice(0, end).toString('utf8');
}

function utf8SafeTail(bytes: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return bytes.slice(start).toString('utf8');
}

export function truncateForBudget(
  content: string,
  budgetBytes: number,
  _contentId: string,
): TruncationResult {
  const originalBytes = Buffer.byteLength(content, 'utf8');
  if (originalBytes <= budgetBytes) {
    return {
      text: content,
      wasTruncated: false,
      originalBytes,
      keptBytes: originalBytes,
      marker: '',
    };
  }

  const omittedBytes = Math.max(0, originalBytes - budgetBytes);
  const omittedKb = Math.max(1, Math.round(omittedBytes / 1024));
  const marker = `\n\n[... ${omittedKb} kb of tool output truncated to fit context budget (full output retained in session) ...]\n\n`;

  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const targetHead = Math.floor(budgetBytes * 0.4);
  const targetTail = Math.floor(budgetBytes * 0.4);
  const overflow = Math.max(0, markerBytes + targetHead + targetTail - budgetBytes);
  const headBytes = Math.max(0, targetHead - Math.ceil(overflow / 2));
  const tailBytes = Math.max(0, targetTail - Math.floor(overflow / 2));

  const contentBytes = Buffer.from(content, 'utf8');
  const head = utf8SafeHead(contentBytes, headBytes);
  const tail = utf8SafeTail(contentBytes, tailBytes);
  const text = `${head}${marker}${tail}`;
  const keptBytes = Buffer.byteLength(text, 'utf8');

  return {
    text,
    wasTruncated: true,
    originalBytes,
    keptBytes,
    marker,
  };
}

/**
 * Universal tool-output byte cap shared by Stage 1 (fresh tool results in
 * `executeToolUse`) and Stage 2 (historical / content_ref-hydrated tool results
 * at the provider translator boundary). Aliased to `CONTENT_REF_THRESHOLD_BYTES`
 * (200 KiB) so there is a single source of truth, no new magic number.
 *
 * See docs/plans/260529_guard-large-tool-outputs/PLAN.md (Stages 1 & 2).
 */
export const UNIVERSAL_TOOL_OUTPUT_CAP_BYTES = CONTENT_REF_THRESHOLD_BYTES;

/**
 * Slice the head of `output` to at most `maxBytes` UTF-8 bytes without splitting
 * a multi-byte character. Backs off to the previous code-point boundary if the
 * naive byte cut would land mid-character.
 */
export const sliceHeadByUtf8Bytes = (output: string, maxBytes: number): string => {
  if (Buffer.byteLength(output, 'utf8') <= maxBytes) return output;
  const buf = Buffer.from(output, 'utf8');
  return utf8SafeHead(buf, maxBytes);
};

export interface BoundedToolOutput {
  output: string;
  /** True when the output was over the cap and replaced with a preview. */
  truncated: boolean;
  /** Original UTF-8 byte size, regardless of whether truncation occurred. */
  originalBytes: number;
}

/**
 * Deterministic byte cap for a single tool result's `output`.
 *
 * The ONE shared truncation transform for the guard-large-tool-outputs fix:
 * - Stage 1 calls it on freshly executed tool results in `executeToolUse`.
 * - Stage 2 calls it on tool_result content reconstructed from history at the
 *   provider translator boundary (raw persisted strings/text blocks AND
 *   content_ref-hydrated text), so replayed megabytes can never reach a provider.
 *
 * Invariants:
 * - Unconditional and self-contained: works with NO workspace/cwd; NEVER falls
 *   back to emitting raw inline output.
 * - Byte-based: caps by `Buffer.byteLength(output, 'utf8')`, not char count.
 * - UTF-8-safe: the preview never splits a multi-byte character.
 * - Idempotent: re-bounding an already-bounded string is a no-op (the second
 *   pass is under the cap, so it passes through untouched).
 * - `materialized` outputs (already a bounded preview, e.g. Bash) are returned
 *   untouched — never re-wrapped. Structured flag, no prose sniffing.
 *
 * The bounded result (preview + note) is guaranteed to stay at or below
 * `maxBytes`.
 */
export const boundToolOutputForSafety = (
  output: string,
  materialized: boolean,
  maxBytes: number = UNIVERSAL_TOOL_OUTPUT_CAP_BYTES,
): BoundedToolOutput => {
  const originalBytes = Buffer.byteLength(output, 'utf8');
  if (materialized || originalBytes <= maxBytes) {
    return { output, truncated: false, originalBytes };
  }

  // Reserve room for the note so the bounded result (preview + note) stays at or
  // below the cap. The note's own byte length depends on the numbers it embeds,
  // so we compute it first against the known totals.
  const buildNote = (omittedBytes: number): string =>
    `\n\n[output truncated: ${omittedBytes} bytes omitted of ${originalBytes} total — re-read with offset/limit]`;
  // Upper bound on the note size: use the worst-case omitted count (== original
  // bytes) for the reservation so we never exceed the cap after appending.
  const noteReserveBytes = Buffer.byteLength(buildNote(originalBytes), 'utf8');
  const previewBudget = Math.max(0, maxBytes - noteReserveBytes);
  const preview = sliceHeadByUtf8Bytes(output, previewBudget);
  const omittedBytes = originalBytes - Buffer.byteLength(preview, 'utf8');
  return {
    output: `${preview}${buildNote(omittedBytes)}`,
    truncated: true,
    originalBytes,
  };
};
