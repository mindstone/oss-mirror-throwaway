/**
 * Shared date utilities for goals/values staleness detection.
 */

/** Default threshold for considering a review "stale" */
export const STALE_THRESHOLD_DAYS = 90;

/**
 * Parse a date string and return the timestamp, or null if invalid.
 */
export const parseDate = (dateStr: string): number | null => {
  try {
    const timestamp = new Date(dateStr).getTime();
    if (Number.isNaN(timestamp)) {
      return null;
    }
    return timestamp;
  } catch {
    return null;
  }
};

/**
 * Check if a date string is stale (older than threshold days).
 * Returns true if date is invalid or stale.
 */
export const isStale = (dateStr: string, thresholdDays: number = STALE_THRESHOLD_DAYS): boolean => {
  const timestamp = parseDate(dateStr);
  if (timestamp === null) {
    return true; // Invalid date = stale
  }
  const now = Date.now();
  const diffMs = now - timestamp;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  return diffDays > thresholdDays;
};

/**
 * Calculate days since a review date.
 * Returns null if date is invalid.
 */
export const getDaysSinceReview = (dateStr: string): number | null => {
  const timestamp = parseDate(dateStr);
  if (timestamp === null) {
    return null;
  }
  const now = Date.now();
  const diffMs = now - timestamp;
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  // Clamp to 0 if somehow in the future
  return Math.max(0, days);
};
