/**
 * Shared BTS (Behind The Scenes) Response Parsing Utilities
 *
 * Centralizes duplicated response extraction, code fence removal, and transcript
 * hashing patterns used across meeting bot services (liveCoachService,
 * conversationStateService, transcriptStorage).
 *
 * See: docs/plans/260407_meeting_bot_infrastructure_cleanup.md (Stage 4)
 */

import type { BehindTheScenesResponse } from '@core/services/behindTheScenesClient';

/**
 * Strip markdown code fences from text.
 * Handles ```language\n...\n``` wrapping commonly returned by LLMs.
 */
export function removeCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) {
    return trimmed;
  }
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*\n?/, '')
    .replace(/\n?```$/, '')
    .trim();
}

/**
 * Extract text content from a BTS response.
 * Checks structured_output first (stringifies if needed), then falls back to
 * the first text content block.
 * Returns null if no text content is found.
 */
export function extractTextFromBtsResponse(response: BehindTheScenesResponse): string | null {
  if (response.structured_output != null) {
    if (typeof response.structured_output === 'string') {
      if (response.structured_output.trim().length > 0) {
        return response.structured_output;
      }
      // Empty string — fall through to text content blocks
    } else {
      try {
        return JSON.stringify(response.structured_output);
      } catch {
        // Fall through to text content
      }
    }
  }
  const textEntry = response.content.find(
    (entry) => entry.type === 'text' && typeof entry.text === 'string'
  );
  return textEntry?.text ?? null;
}

/**
 * Simple hash of transcript tail for change detection.
 * Uses a configurable window of the transcript end.
 * Not cryptographic — just for detecting content changes between polling intervals.
 */
export function hashTranscriptTail(transcript: string, windowSize = 500): string {
  const tail = transcript.slice(-windowSize);
  let hash = 0;
  for (let i = 0; i < tail.length; i++) {
    const char = tail.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit integer
  }
  return hash.toString(36);
}
