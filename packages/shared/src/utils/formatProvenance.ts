import type { InboxSource } from '../types/inbox';

/**
 * Format the provenance prefix for an inbox item source.
 * Returns the "From: X" part without the time component
 * (time formatting uses date-fns which is renderer-only).
 */
export function formatProvenanceLabel(source: InboxSource | null | undefined): string {
  if (!source) return 'Added';

  switch (source.kind) {
    case 'automation':
      return `From: ${source.automationName} automation`;
    case 'role':
      return `From: ${source.roleName}`;
    case 'meeting':
      return `From: ${source.meetingTitle || 'meeting'}`;
    case 'conversation':
      return 'From: your conversation';
    case 'text':
    case 'workspace':
      return `From: ${source.label || ('path' in source ? source.path?.split(/[/\\]/).pop() : 'file') || 'file'}`;
    default:
      return 'Added';
  }
}
