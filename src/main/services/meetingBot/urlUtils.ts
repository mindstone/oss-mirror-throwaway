/**
 * URL Utilities for Meeting Bot
 *
 * Provides URL matching and deduplication utilities for meeting URLs.
 * Handles variations in meeting URLs from different platforms (Zoom, Meet, Teams).
 */

import { createScopedLogger } from '@core/logger';
import { extractMeetingId } from '@rebel/shared';

const log = createScopedLogger({ service: 'meeting-bot-url' });

// Re-export the canonical shared implementation
export { extractMeetingId };

/**
 * Check if two meeting URLs refer to the same meeting.
 * Handles URL variations like different Zoom subdomains, query parameters, etc.
 *
 * @example
 * urlsMatchSameMeeting(
 *   'https://us02web.zoom.us/j/123',
 *   'https://company.zoom.us/j/123'
 * ) // true
 *
 * urlsMatchSameMeeting(
 *   'https://meet.google.com/abc-xyz',
 *   'https://meet.google.com/abc-xyz?authuser=0'
 * ) // true
 */
export function urlsMatchSameMeeting(url1: string, url2: string): boolean {
  // Handle null/empty URLs
  if (!url1 || !url2) return false;

  const id1 = extractMeetingId(url1);
  const id2 = extractMeetingId(url2);

  // If both URLs have extractable IDs, compare them
  if (id1 && id2) {
    const matches = id1 === id2;
    if (matches && url1 !== url2) {
      // Log when URL normalization matched URLs that differ
      log.debug({ url1: redactUrl(url1), url2: redactUrl(url2), meetingId: id1 }, 'URL normalization matched different URLs');
    }
    return matches;
  }

  // Fallback to exact match if extraction failed
  return url1 === url2;
}

/**
 * Redact sensitive parts of a URL for logging (e.g., password parameter).
 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Remove pwd parameter if present
    if (parsed.searchParams.has('pwd')) {
      parsed.searchParams.set('pwd', '[REDACTED]');
    }
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

/** Default dedup time window: 2 hours */
const DEFAULT_DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;

/**
 * Check if two timestamps are within the dedup time window.
 * Used to prevent duplicate scheduling of recurring meetings with same URL.
 *
 * @param scheduledAt - When the bot was scheduled (ISO string)
 * @param meetingStartTime - When the meeting starts (ISO string)
 * @param windowMs - Time window in milliseconds (default: 2 hours)
 * @returns true if timestamps are within the window
 */
export function isWithinDedupWindow(
  scheduledAt: string,
  meetingStartTime: string,
  windowMs: number = DEFAULT_DEDUP_WINDOW_MS
): boolean {
  try {
    const scheduled = new Date(scheduledAt).getTime();
    const start = new Date(meetingStartTime).getTime();

    // Handle invalid dates
    if (isNaN(scheduled) || isNaN(start)) {
      return false;
    }

    return Math.abs(scheduled - start) < windowMs;
  } catch {
    return false;
  }
}
