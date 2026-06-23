import type { InboxItem } from '@shared/types';
import type { ToastProps } from '@renderer/components/ui';

export type InboxActionType =
  | 'execute'
  | 'archive'
  | 'done'
  | 'dismiss'
  | 'schedule'
  | 'batch-done'
  | 'batch-archive'
  | 'batch-dismiss'
  | 'batch-schedule';

export const UNDO_EXPIRY_DESTRUCTIVE_MS = 28_000;
const DURATION_REVERSIBLE_MS = 8_000;

function truncateTitle(title: string, maxLen = 50): string {
  return title.length > maxLen ? `${title.slice(0, maxLen - 3)}…` : title;
}

function deriveExecuteTitle(items: InboxItem[]): string {
  const item = items[0];
  if (!item) return 'Running';

  const hasEmailRef = item.references?.some(r => r.kind === 'email');
  if (hasEmailRef || item.source?.kind === 'automation') {
    const label = item.source && 'automationName' in item.source
      ? item.source.automationName
      : undefined;
    if (hasEmailRef) return 'Email sent';
    if (label) return `Running: ${truncateTitle(label)}`;
  }

  return `Running: ${truncateTitle(item.title)}`;
}

function isDestructive(action: InboxActionType): boolean {
  return action === 'execute';
}

/**
 * Constructs toast parameters for inbox post-action feedback.
 *
 * Includes an "Undo" action button when `undoCallback` is provided.
 * Execute actions additionally get a "View conversation" secondary button.
 */
export function buildActionToast(params: {
  action: InboxActionType;
  items: InboxItem[];
  undoCallback?: () => void;
  viewCallback?: () => void;
  /** Label for the target (e.g. "Today" for schedule actions). */
  targetLabel?: string;
}): Omit<ToastProps, 'id'> {
  const { action, items, undoCallback, viewCallback, targetLabel } = params;
  const count = items.length;

  let title: string;
  let description: string | undefined;
  switch (action) {
    case 'execute':
      title = deriveExecuteTitle(items);
      break;
    case 'archive':
      title = 'Archived';
      break;
    case 'done':
      title = 'Marked done';
      if (count === 1) description = truncateTitle(items[0].title);
      break;
    case 'dismiss':
      title = 'Deleted';
      if (count === 1) description = truncateTitle(items[0].title);
      break;
    case 'schedule':
      title = `Moved to ${targetLabel ?? 'group'}`;
      if (count === 1) description = truncateTitle(items[0].title);
      break;
    case 'batch-done':
      title = `Marked ${count} items done`;
      break;
    case 'batch-archive':
      title = `Archived ${count} items`;
      break;
    case 'batch-dismiss':
      title = `Deleted ${count} items`;
      break;
    case 'batch-schedule':
      title = `Moved ${count} items to ${targetLabel ?? 'group'}`;
      break;
  }

  const toast: Omit<ToastProps, 'id'> = {
    title,
    description,
    duration: isDestructive(action) ? UNDO_EXPIRY_DESTRUCTIVE_MS : DURATION_REVERSIBLE_MS,
    ...(undoCallback ? { action: { label: 'Undo', onClick: undoCallback } } : {}),
  };

  if (action === 'execute' && viewCallback) {
    toast.cancel = { label: 'View conversation', onClick: viewCallback };
  }

  return toast;
}
