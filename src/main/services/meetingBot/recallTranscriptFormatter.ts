/**
 * Recall transcript formatter (shared helper)
 *
 * Turns Recall's downloaded transcript artifact (an array of speaker segments)
 * into the "Speaker: text\n…" string + participants + duration the desktop
 * consumes.
 *
 * DUPLICATION FLAG: this is a line-for-line reproduction of the worker's
 * formatter at `meeting-bot-worker/src/index.ts:2178-2204`. The worker is a
 * SEPARATE deploy package (`meeting-bot-worker/`) and cannot be imported across
 * the boundary cleanly, so the logic is duplicated here for the Direct (BYOK)
 * path. If you change the segment shape or formatting on either side, update
 * BOTH copies so they don't drift.
 */

/** A single transcript segment as Recall returns it in the downloaded artifact. */
export interface RecallTranscriptSegment {
  participant?: { name?: string };
  words?: Array<{
    text: string;
    start_timestamp?: { relative?: number };
    end_timestamp?: { relative?: number };
  }>;
}

/** The consumed shape: text transcript + participants + duration (seconds). */
export interface FormattedRecallTranscript {
  transcript: string;
  participants: string[];
  duration: number;
}

/**
 * Format Recall transcript segments into "Speaker: text" lines.
 *
 * Reproduces worker `index.ts:2178-2204` exactly:
 * - one line per segment with non-empty text, prefixed `${speaker}: `
 * - speaker defaults to `'Unknown'`
 * - participants = the set of speakers that actually said something
 * - duration = max `end_timestamp.relative` across all words, rounded
 */
export function formatRecallSegments(
  segments: RecallTranscriptSegment[],
): FormattedRecallTranscript {
  const transcriptLines: string[] = [];
  const participants = new Set<string>();
  let totalDuration = 0;

  for (const segment of segments) {
    const speaker = segment.participant?.name || 'Unknown';
    const text = segment.words?.map(w => w.text).join(' ') || '';
    if (text) {
      participants.add(speaker);
      transcriptLines.push(`${speaker}: ${text}`);
    }

    const lastWord = segment.words?.[segment.words.length - 1];
    const endTime = lastWord?.end_timestamp?.relative;
    if (typeof endTime === 'number' && endTime > totalDuration) {
      totalDuration = endTime;
    }
  }

  return {
    transcript: transcriptLines.join('\n'),
    participants: Array.from(participants),
    duration: Math.round(totalDuration),
  };
}
