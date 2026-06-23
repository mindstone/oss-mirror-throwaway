/**
 * External Meeting Transcript Providers
 *
 * Common types and interfaces for importing transcripts from external providers
 * like Fireflies and Fathom.
 */

/** Supported external transcript providers */
export type ExternalProvider = 'fireflies' | 'fathom';

/**
 * Normalized transcript data from external providers.
 * This format is used by all adapters to ensure consistent processing.
 */
export interface ExternalTranscript {
  /** Provider's unique ID for this transcript */
  externalId: string;
  /** Which provider this came from */
  provider: ExternalProvider;
  /** Meeting title */
  title: string;
  /** Participant names/emails */
  participants: string[];
  /** Meeting start time (ISO timestamp) */
  startTime: string;
  /** Duration in seconds */
  duration: number;
  /** Formatted transcript: "[HH:MM:SS] Speaker: text\n" */
  transcript: string;
  /** Provider's summary (if available) */
  summary?: string;
  /** Provider's action items (if available) */
  actionItems?: string[];
  /** Meeting URL (Zoom/Meet/Teams link) */
  meetingUrl?: string;
  /** Calendar event ID (for matching) */
  calendarId?: string;
}

/**
 * Result from testing a provider connection.
 */
export interface ConnectionTestResult {
  success: boolean;
  error?: string;
  /** User-friendly message */
  message?: string;
}

/**
 * Result from fetching transcripts.
 */
export interface FetchTranscriptsResult {
  success: boolean;
  transcripts: ExternalTranscript[];
  error?: string;
  /** Pagination cursor for next fetch (if applicable) */
  nextCursor?: string;
}

/**
 * Error classification for retry logic.
 */
export type ErrorClassification =
  | 'auth_invalid'    // 401, 403 - disable provider, surface to user
  | 'rate_limited'    // 429 - backoff using server-provided reset time
  | 'transient'       // 500, 502, 503, 504, timeouts - retry with backoff
  | 'client_error'    // 400 - log and skip (bad request, don't retry)
  | 'not_found';      // 404 - transcript doesn't exist, don't retry

/**
 * Classify an error for appropriate retry handling.
 */
export function classifyError(status: number, code?: string): ErrorClassification {
  if (status === 401 || status === 403 || code === 'forbidden') return 'auth_invalid';
  if (status === 429 || code === 'too_many_requests') return 'rate_limited';
  if (status === 404 || code === 'object_not_found') return 'not_found';
  if (status === 400 || code === 'invalid_arguments') return 'client_error';
  if (status >= 500) return 'transient';
  return 'client_error';
}

/**
 * Retry configuration per error classification.
 */
export const RETRY_STRATEGIES: Record<ErrorClassification, {
  retries: number;
  initialDelayMs?: number;
  backoffMultiplier?: number;
  useServerDelay?: boolean;
  fallbackDelayMs?: number;
}> = {
  auth_invalid: { retries: 0 },
  rate_limited: { retries: 1, useServerDelay: true, fallbackDelayMs: 60_000 },
  transient: { retries: 3, initialDelayMs: 1000, backoffMultiplier: 2 },
  not_found: { retries: 0 },
  client_error: { retries: 0 },
};

/**
 * Provider adapter interface.
 * Each external provider must implement this interface.
 */
export interface ProviderAdapter {
  /** Provider name */
  readonly name: ExternalProvider;

  /**
   * Test if the API key is valid.
   */
  testConnection(): Promise<ConnectionTestResult>;

  /**
   * Fetch transcripts since the given timestamp.
   * @param since - Fetch transcripts created after this date
   * @param cursor - Pagination cursor from previous fetch
   */
  fetchTranscripts(since: Date, cursor?: string): Promise<FetchTranscriptsResult>;
}

/**
 * Format timestamp in seconds to HH:MM:SS format.
 */
export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Parse various timestamp formats to seconds.
 * Handles: "HH:MM:SS", "MM:SS", seconds number, milliseconds number.
 */
export function parseTimestampToSeconds(value: string | number): number {
  if (typeof value === 'number') {
    // If > 1e6, assume milliseconds
    return value >= 1e6 ? value / 1000 : value;
  }

  const trimmed = value.trim();

  // Try parsing as number first
  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && numeric >= 0) {
    return numeric >= 1e6 ? numeric / 1000 : numeric;
  }

  // Try HH:MM:SS or MM:SS format
  const parts = trimmed.split(':').map(Number);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }

  return 0;
}
