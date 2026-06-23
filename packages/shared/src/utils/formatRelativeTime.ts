/**
 * Unified relative time formatting utility.
 *
 * All 9 call sites across the codebase are served by this single function
 * with sensible defaults — the zero-options call covers the most common case
 * (legacy memory panel pattern).
 */

/**
 * Options for formatting a timestamp as a human-readable relative time string.
 * All options have sensible defaults — the zero-options call covers the most common case.
 */
export interface FormatRelativeTimeOptions {
  /**
   * Whether to handle future timestamps ("in 5m", "Tomorrow").
   * When 'past', future timestamps return "Just now" / "just now".
   * @default 'past'
   */
  direction?: 'past' | 'both';

  /**
   * Capitalize special strings: "Just now" vs "just now", "Yesterday" vs "yesterday".
   * @default true
   */
  capitalize?: boolean;

  /**
   * Show minute-level precision for durations under 1 hour.
   * When false, anything < 1h shows as "Just now" / "just now".
   * @default true
   */
  includeMinutes?: boolean;

  /**
   * Show "Yesterday"/"yesterday" (and "Tomorrow" when direction is 'both')
   * for timestamps exactly 1 day away.
   * @default true
   */
  includeYesterday?: boolean;

  /**
   * Use abbreviated day suffix: "3d ago" vs "3 days ago".
   * Also affects future: "in 3d" vs "in 3 days".
   * @default true
   */
  abbreviateDays?: boolean;

  /**
   * Show week-level precision ("2w ago") for 7–29 day-old timestamps.
   * Only takes effect when absoluteDateAfterDays is > 7 or false.
   * @default false
   */
  includeWeeks?: boolean;

  /**
   * Show month-level precision ("3mo ago") for 30+ day-old timestamps.
   * Only takes effect when absoluteDateAfterDays is > 30 or false.
   * @default false
   */
  includeMonths?: boolean;

  /**
   * After this many days, show an absolute locale date string (e.g. "Feb 14")
   * instead of a relative duration. Set to `false` to never show an absolute date.
   * @default 7
   */
  absoluteDateAfterDays?: number | false;
}

/**
 * Format a timestamp as a human-readable relative time string.
 *
 * Default (no options): capitalized, past-only, minutes through days,
 * "Yesterday", locale date after 7 days.
 *
 * @example
 * formatRelativeTime(Date.now() - 30_000)          // "Just now"
 * formatRelativeTime(Date.now() - 5 * 60_000)      // "5m ago"
 * formatRelativeTime(Date.now() - 3 * 3_600_000)   // "3h ago"
 * formatRelativeTime(Date.now() - 86_400_000)       // "Yesterday"
 * formatRelativeTime(Date.now() - 3 * 86_400_000)  // "3d ago"
 * formatRelativeTime(Date.now() - 10 * 86_400_000) // "Feb 24"
 */
export function formatRelativeTime(
  timestamp: number,
  options: FormatRelativeTimeOptions = {},
): string {
  const {
    direction = 'past',
    capitalize = true,
    includeMinutes = true,
    includeYesterday = true,
    abbreviateDays = true,
    includeWeeks = false,
    includeMonths = false,
    absoluteDateAfterDays = 7,
  } = options;

  if (!Number.isFinite(timestamp)) {
    return capitalize ? 'Just now' : 'just now';
  }

  const diff = Date.now() - timestamp;
  const isPast = diff >= 0;
  const absDiff = Math.abs(diff);

  // If future and direction is past-only, treat as "just now"
  if (!isPast && direction === 'past') {
    return capitalize ? 'Just now' : 'just now';
  }

  const mins = Math.floor(absDiff / 60_000);
  const hours = Math.floor(absDiff / 3_600_000);
  const days = Math.floor(absDiff / 86_400_000);

  // Helper for locale date fallback
  const localeDate = (): string =>
    new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });

  // < 1 minute
  if (mins < 1) {
    if (!isPast) return capitalize ? 'Any moment' : 'any moment';
    return capitalize ? 'Just now' : 'just now';
  }

  // < 1 hour (minutes)
  if (mins < 60) {
    if (!includeMinutes) {
      if (!isPast) return capitalize ? 'Any moment' : 'any moment';
      return capitalize ? 'Just now' : 'just now';
    }
    return isPast ? `${mins}m ago` : `in ${mins}m`;
  }

  // < 24 hours
  if (hours < 24) {
    return isPast ? `${hours}h ago` : `in ${hours}h`;
  }

  // --- From here: days >= 1 ---

  // Check absolute date threshold.
  // "Yesterday"/"Tomorrow" can pass through only when days === 1, includeYesterday
  // is enabled, and the threshold is strictly > 1 day.
  if (absoluteDateAfterDays !== false && days >= absoluteDateAfterDays) {
    const yesterdayPassThrough = days === 1 && includeYesterday && absoluteDateAfterDays > 1;
    if (!yesterdayPassThrough) {
      return localeDate();
    }
  }

  // 1 day — Yesterday/Tomorrow
  if (days === 1 && includeYesterday) {
    if (isPast) return capitalize ? 'Yesterday' : 'yesterday';
    return capitalize ? 'Tomorrow' : 'tomorrow';
  }

  // Months (30+ days)
  if (includeMonths && days >= 30) {
    const months = Math.floor(days / 30);
    return isPast ? `${months}mo ago` : `in ${months}mo`;
  }

  // Weeks (7+ days)
  if (includeWeeks && days >= 7) {
    const weeks = Math.floor(days / 7);
    return isPast ? `${weeks}w ago` : `in ${weeks}w`;
  }

  // Days
  const dayStr = abbreviateDays
    ? `${days}d`
    : `${days} day${days === 1 ? '' : 's'}`;
  return isPast ? `${dayStr} ago` : `in ${dayStr}`;
}
