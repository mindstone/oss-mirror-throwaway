import type { InboxItemStatus } from '../types/inbox';

/**
 * Derives status from the legacy `archived` boolean for items that
 * predate the status field. Status field takes precedence when present.
 * Legacy archived=true maps to 'completed' (the old "archive" meant "done").
 */
export function deriveInboxStatus(item: { status?: InboxItemStatus; archived?: boolean }): InboxItemStatus {
  if (item.status) return item.status;
  return item.archived ? 'completed' : 'active';
}
