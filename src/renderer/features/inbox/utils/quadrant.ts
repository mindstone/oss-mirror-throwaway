import type { InboxItem, InboxQuadrant } from '@shared/types';

/**
 * Determine the Eisenhower quadrant for an inbox item.
 * Quadrants:
 * - do-now: urgent + important (red)
 * - schedule: important, not urgent (orange)
 * - delegate: urgent, not important (yellow)
 * - consider: neither urgent nor important (gray)
 *
 * @deprecated Eisenhower UI removed in FOX-2760. Use temporal grouping and confidence instead.
 */
export const getQuadrant = (item: InboxItem): InboxQuadrant => {
  const urgent = item.urgent ?? false;
  const important = item.important ?? true; // Default to important

  if (urgent && important) return 'do-now';
  if (!urgent && important) return 'schedule';
  if (urgent && !important) return 'delegate';
  return 'consider';
};

/**
 * Get urgent/important values for a quadrant.
 *
 * @deprecated Eisenhower UI removed in FOX-2760. Use temporal grouping and confidence instead.
 */
export const quadrantToFlags = (quadrant: InboxQuadrant): { urgent: boolean; important: boolean } => {
  switch (quadrant) {
    case 'do-now':
      return { urgent: true, important: true };
    case 'schedule':
      return { urgent: false, important: true };
    case 'delegate':
      return { urgent: true, important: false };
    case 'consider':
      return { urgent: false, important: false };
  }
};

/**
 * Quadrant display metadata.
 * Icons are Lucide icon names for a more polished look.
 *
 * @deprecated Eisenhower UI removed in FOX-2760. Use temporal grouping and confidence instead.
 */
export const QUADRANT_META: Record<InboxQuadrant, {
  label: string;
  shortLabel: string;
  icon: 'flame' | 'calendar-clock' | 'forward' | 'circle-dashed';
  colorClass: string;
  accentColor: string;
  bgTint: string;
  description: string;
  emptyMessage: string;
}> = {
  'do-now': {
    label: 'Do Now',
    shortLabel: 'Do',
    icon: 'flame',
    colorClass: 'quadrantDoNow',
    accentColor: '#EF4444',
    bgTint: 'rgba(239, 68, 68, 0.04)',
    description: 'Urgent + Important',
    emptyMessage: "The fire's out. For now.",
  },
  'schedule': {
    label: 'Schedule',
    shortLabel: 'Plan',
    icon: 'calendar-clock',
    colorClass: 'quadrantSchedule',
    accentColor: '#F97316',
    bgTint: 'rgba(249, 115, 22, 0.04)',
    description: 'Important, not urgent',
    emptyMessage: 'No grand plans pending.',
  },
  'delegate': {
    label: 'Delegate',
    shortLabel: 'Delegate',
    icon: 'forward',
    colorClass: 'quadrantDelegate',
    accentColor: '#EAB308',
    bgTint: 'rgba(234, 179, 8, 0.04)',
    description: 'Urgent, not important',
    emptyMessage: 'Nothing to delegate.',
  },
  'consider': {
    label: 'Consider',
    shortLabel: 'Consider',
    icon: 'circle-dashed',
    colorClass: 'quadrantConsider',
    accentColor: '#6B7280',
    bgTint: 'rgba(107, 114, 128, 0.04)',
    description: 'Neither urgent nor important',
    emptyMessage: 'Blissfully empty.',
  },
};

/**
 * Get all quadrants in display order (top-left, top-right, bottom-left, bottom-right).
 *
 * @deprecated Eisenhower UI removed in FOX-2760. Use temporal grouping and confidence instead.
 */
export const QUADRANT_ORDER: InboxQuadrant[] = ['do-now', 'schedule', 'delegate', 'consider'];

/**
 * Random Inbox Zero celebration messages in Rebel's voice.
 */
export const INBOX_ZERO_MESSAGES = [
  "Action Zero. I have nothing for you. This feels... strange.",
  "All clear. The silence is deafening. Enjoy it.",
  "Nothing pending. Either you're very efficient, or I'm not trying hard enough.",
  "The board is empty. A rare moment of peace in an otherwise chaotic universe.",
  "Congratulations. You've achieved the impossible. Don't get used to it.",
];

/**
 * Get a random Inbox Zero message.
 */
export const getInboxZeroMessage = (): string => {
  const index = Math.floor(Math.random() * INBOX_ZERO_MESSAGES.length);
  return INBOX_ZERO_MESSAGES[index];
};
