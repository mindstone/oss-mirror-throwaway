/**
 * Meeting Transcript Context — Builds prompt context from a live meeting session.
 *
 * When `meetingSessionId` is present in an agent turn request, this service reads
 * the session's rolling transcript and conversation state from the transcription
 * engine, then formats them as a context block to prepend to the user's prompt.
 *
 * This keeps the transcript data server-side (avoids sending large transcripts
 * over mobile data) and provides the agent with meeting context for Q&A.
 *
 * @see docs/plans/260412_mobile_live_meeting_experience.md — Stage 4
 */

import { createScopedLogger } from '@core/logger';
import { hashSessionId } from '@shared/trackingTypes';
import {
  getRollingTranscript,
  getConversationState,
} from './transcription';

const log = createScopedLogger({ service: 'meeting-transcript-context' });

/** Maximum words of transcript to include in the context (~5000 tokens). */
const MAX_TRANSCRIPT_WORDS = 4000;

export type TranscriptContextResult =
  | { kind: 'context'; text: string }
  | { kind: 'unknown-session'; reason: 'no-meeting-id' | 'no-engine-state' }
  | { kind: 'empty-transcript' };

interface BuildMeetingTranscriptContextArgs {
  meetingSessionId?: string;
  recordingActive?: boolean;
}

/**
 * Build meeting transcript context for injection into an agent turn prompt.
 *
 * Reads the session's rolling transcript (from incremental chunk transcription)
 * and conversation state (topic, summary, questions, decisions). Returns a
 * formatted context string to prepend to the user's prompt, or null if no
 * transcript is available.
 *
 * @param args.meetingSessionId - Cloud meeting session ID from chunk upload lifecycle
 * @param args.recordingActive - Whether a live meeting recording is active for this turn
 * @returns Transcript context result for recording-aware prompt enrichment; null when no recording context
 */
export function buildMeetingTranscriptContext(
  args: BuildMeetingTranscriptContextArgs,
): TranscriptContextResult | null {
  const recordingActive = args.recordingActive ?? false;
  const meetingSessionId = args.meetingSessionId;

  if (!recordingActive && !meetingSessionId) {
    return null;
  }

  if (recordingActive && !meetingSessionId) {
    log.info({ reason: 'no-meeting-id' }, 'Recording is active but meeting session id is missing');
    return { kind: 'unknown-session', reason: 'no-meeting-id' };
  }

  if (!meetingSessionId) {
    return null;
  }

  const transcript = getRollingTranscript(meetingSessionId);
  if (transcript === undefined) {
    log.info(
      { meetingSessionIdHash: hashSessionId(meetingSessionId), reason: 'no-engine-state' },
      'No transcription engine state for meeting session',
    );
    return { kind: 'unknown-session', reason: 'no-engine-state' };
  }

  const hasAlphanumericContent = /[a-zA-Z0-9]/.test(transcript);
  if (!hasAlphanumericContent) {
    log.info(
      { meetingSessionIdHash: hashSessionId(meetingSessionId) },
      'Transcript state exists but has no alphanumeric content yet',
    );
    return { kind: 'empty-transcript' };
  }

  const transcriptWords = transcript.trim().split(/\s+/).filter(Boolean);
  const conversationState = getConversationState(meetingSessionId);

  // Truncate transcript to last ~4000 words to fit token limits
  const truncatedTranscript = transcriptWords.length > MAX_TRANSCRIPT_WORDS
    ? transcriptWords.slice(-MAX_TRANSCRIPT_WORDS).join(' ')
    : transcript;

  const parts: string[] = [];

  // Conversation state block (if available)
  if (conversationState) {
    const stateParts: string[] = [];
    if (conversationState.currentTopic) {
      stateParts.push(`Topic: ${conversationState.currentTopic}`);
    }
    if (conversationState.summary) {
      stateParts.push(`Key points: ${conversationState.summary}`);
    }
    if (conversationState.openQuestions?.length) {
      stateParts.push(`Open questions: ${conversationState.openQuestions.join('; ')}`);
    }
    if (conversationState.recentDecisions?.length) {
      stateParts.push(`Recent decisions: ${conversationState.recentDecisions.join('; ')}`);
    }
    if (stateParts.length > 0) {
      parts.push(`[CONVERSATION STATE]\n${stateParts.join('\n')}\n[/CONVERSATION STATE]`);
    }
  }

  // Transcript block
  parts.push(`[MEETING TRANSCRIPT SO FAR]\n${truncatedTranscript}\n[/MEETING TRANSCRIPT]`);

  const context = parts.join('\n\n').trim();

  log.info(
    {
      meetingSessionIdHash: hashSessionId(meetingSessionId),
      transcriptWords: transcriptWords.length,
      truncated: transcriptWords.length > MAX_TRANSCRIPT_WORDS,
      hasConversationState: Boolean(conversationState),
    },
    'Built meeting transcript context for agent turn',
  );

  return { kind: 'context', text: context };
}
