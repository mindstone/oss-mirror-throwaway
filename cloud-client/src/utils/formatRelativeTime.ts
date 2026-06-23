// cloud-client/src/utils/formatRelativeTime.ts

import { formatRelativeTime as _fmt } from '@rebel/shared';

/**
 * Format a timestamp as a human-readable relative time string.
 * Supports both past and future timestamps.
 *
 * Past: "Just now", "Xm ago", "Xh ago", "Yesterday", "Xd ago"
 * Future: "Any moment", "in Xm", "in Xh", "Tomorrow", "in Xd"
 * Beyond 7 days: locale date string (e.g. "Feb 14")
 */
export const formatRelativeTime = (epoch: number): string =>
  _fmt(epoch, { direction: 'both' });
