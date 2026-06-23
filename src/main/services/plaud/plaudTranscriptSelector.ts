/**
 * Plaud Transcript Selector
 *
 * Decides whether to use Plaud's server-side transcript (`source_list`) or
 * fall back to local STT (Whisper / ElevenLabs / Parakeet).
 *
 * Background:
 *   The Plaud sync path was double-billing the user — Plaud's cloud already
 *   transcribed the audio (returned in `source_list` on `/files/{id}`) and the
 *   sync service downloaded the MP3 and transcribed it again locally. This
 *   selector + formatter is the read side of fixing that. See
 *   `docs/plans/260522_plaud-mcp-fix-first/PLAN.md` Stage 2.
 *
 * Defensive parsing:
 *   `source_list` is `unknown[]` on `PlaudFileDetails` because Plaud's public
 *   schema doesn't lock the shape. We Zod-parse at the boundary so a future
 *   Plaud schema change degrades to `invalid` (fall through to local STT)
 *   rather than crashing or silently writing junk.
 *
 * Markdown safety:
 *   Plaud transcript text is third-party content — segments could contain
 *   active Markdown (links, images, HTML, code fences, control chars). We
 *   escape Markdown specials and strip ASCII control bytes before joining,
 *   so a malicious or surprising transcript can't inject a clickable link or
 *   render an image when the meeting note is opened in any Markdown viewer.
 *
 * Completeness heuristic:
 *   Plaud's API doesn't expose an explicit "transcript ready" flag, so we
 *   classify `plaud_complete` vs `not_ready` by duration coverage when
 *   timestamps are available, and accept the array as-is when timestamps
 *   are absent (every segment must still pass Zod validation).
 */

import { z } from 'zod';
import type { PlaudFile, PlaudFileDetails } from './types';

export const PlaudTranscriptSegmentSchema = z
  .object({
    text: z.string().trim().min(1).max(50_000),
    start_time: z.number().optional(),
    end_time: z.number().optional(),
    speaker_id: z.union([z.string(), z.number()]).optional(),
  })
  .passthrough();

export type PlaudTranscriptSegment = z.infer<typeof PlaudTranscriptSegmentSchema>;
export const MAX_RAW_SOURCE_LIST_LENGTH = 50_000;

export const PlaudTranscriptSegmentArraySchema = z
  .array(PlaudTranscriptSegmentSchema)
  .max(MAX_RAW_SOURCE_LIST_LENGTH);

export type PlaudTranscriptDecision =
  | { kind: 'plaud_complete'; segments: PlaudTranscriptSegment[]; coverageRatio: number }
  | { kind: 'not_ready'; reason: string; coverageRatio?: number }
  | { kind: 'fallback_local'; reason: string }
  | { kind: 'invalid'; reason: string };

export const COMPLETE_COVERAGE_THRESHOLD = 0.9;
export const IMPLAUSIBLE_COVERAGE_THRESHOLD = 1.25;
export const NOT_READY_FALLBACK_GRACE_MS = 60 * 60 * 1000;

export function selectPlaudTranscriptSource(
  details: PlaudFileDetails,
  file: PlaudFile,
  now: Date = new Date(),
): PlaudTranscriptDecision {
  const rawList = details.source_list;
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return { kind: 'fallback_local', reason: 'plaud_source_list_absent' };
  }
  if (rawList.length > MAX_RAW_SOURCE_LIST_LENGTH) {
    return { kind: 'invalid', reason: 'plaud_source_list_too_large' };
  }

  // Ignore pure-whitespace segments so a transcript with a single noisy blank
  // chunk can still be accepted if meaningful segments exist.
  const nonWhitespaceRawList = rawList.filter((segment) => {
    if (!segment || typeof segment !== 'object' || !('text' in segment)) {
      return true;
    }
    const { text } = segment as { text?: unknown };
    if (typeof text !== 'string') {
      return true;
    }
    return text.trim().length > 0;
  });
  if (nonWhitespaceRawList.length === 0) {
    return { kind: 'invalid', reason: 'plaud_transcript_empty_after_format' };
  }

  const parsed = PlaudTranscriptSegmentArraySchema.safeParse(nonWhitespaceRawList);
  if (!parsed.success) {
    const message = parsed.error.message;
    return {
      kind: 'invalid',
      reason: `plaud_source_list_malformed: ${message.slice(0, 200)}`,
    };
  }

  const segments = parsed.data;
  const formattedTranscript = formatPlaudTranscriptFromSourceList(segments);
  if (formattedTranscript.length === 0) {
    return { kind: 'invalid', reason: 'plaud_transcript_empty_after_format' };
  }

  // Plaud `duration` is in milliseconds (per types.ts), and segment timestamps
  // appear to be in seconds based on the official MCP's get_transcript output.
  // We convert one side so they're comparable. If Plaud changes either unit,
  // an implausible coverage ratio is treated as invalid (safe — local STT).
  const fileDurationMs = typeof file.duration === 'number' ? file.duration : 0;
  const fileDurationSec = fileDurationMs / 1000;

  const allTimestamped = segments.every(
    (s) =>
      typeof s.start_time === 'number' &&
      typeof s.end_time === 'number' &&
      s.end_time > s.start_time,
  );

  if (allTimestamped && fileDurationSec > 0) {
    const totalCoveredSec = segments.reduce((acc, s) => {
      const start = s.start_time ?? 0;
      const end = s.end_time ?? 0;
      return acc + Math.max(0, end - start);
    }, 0);
    const coverageRatio = totalCoveredSec / fileDurationSec;
    if (coverageRatio > IMPLAUSIBLE_COVERAGE_THRESHOLD) {
      return { kind: 'invalid', reason: 'plaud_coverage_implausible' };
    }
    if (coverageRatio >= COMPLETE_COVERAGE_THRESHOLD) {
      return { kind: 'plaud_complete', segments, coverageRatio };
    }

    const createdAtMs = Date.parse(file.created_at);
    if (!Number.isFinite(createdAtMs)) {
      return { kind: 'fallback_local', reason: 'plaud_not_ready_missing_created_at' };
    }
    const ageMs = now.getTime() - createdAtMs;
    if (ageMs >= NOT_READY_FALLBACK_GRACE_MS) {
      return { kind: 'fallback_local', reason: 'plaud_not_ready_grace_elapsed' };
    }

    return { kind: 'not_ready', reason: 'plaud_coverage_below_threshold', coverageRatio };
  }

  // No usable timestamps but every segment Zod-validated. Accept.
  // This is strictly safer than the pre-amendment "non-empty array" check
  // because each segment must have non-empty `text` per Zod validation above.
  return { kind: 'plaud_complete', segments, coverageRatio: 1 };
}

const MARKDOWN_SPECIALS = /([\\`*_{}[\]()<>#+\-!|=~&:\/\.])/g;
const ASCII_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// Bidi / formatting Unicode characters that can re-order or hide rendered text.
// e.g. U+202E RIGHT-TO-LEFT OVERRIDE, U+200B ZERO WIDTH SPACE, U+FEFF BOM.
const UNICODE_FORMATTING_CHARS = /[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;

function escapePlaudPlaintext(text: string): string {
  // Collapse embedded newlines/carriage returns to a single space first so a
  // segment text containing "Title\n===" can't form a setext heading even if
  // a future renderer interprets `=` more liberally than current escapes.
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(ASCII_CONTROL_CHARS, '')
    .replace(UNICODE_FORMATTING_CHARS, '')
    .replace(MARKDOWN_SPECIALS, '\\$1');
}

export function formatPlaudTranscriptFromSourceList(
  segments: PlaudTranscriptSegment[],
): string {
  return segments
    .map((s) => escapePlaudPlaintext(s.text.trim()))
    .filter((t) => t.length > 0)
    .join('\n\n');
}
